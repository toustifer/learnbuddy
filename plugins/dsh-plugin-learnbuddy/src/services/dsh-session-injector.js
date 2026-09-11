/**
 * DSH 会话凭据注入服务 (dsh-session-injector)
 *
 * 背景：
 *   LearnBuddy 公网网关 (plugins/dsh-plugin-learnbuddy/server.js) 监听 0.0.0.0:3088，
 *   把非 /learnbuddy/* 、非 /api/learnbuddy/* 的请求反向代理到本机 DSH Web
 *   (127.0.0.1:3080)。前端里的伴学助手 iframe 指向 `location.origin/?learnbuddy=embedded`，
 *   经网关转发后被 DSH 自身的浏览器会话鉴权拦下，公网实测返回 401。
 *
 * DSH 鉴权机制（证据见 docs/DSH-AUTH-REVERSE-ENGINEERING.md，行号取自本机安装包
 * @deepseek-ai/dsh@0.1.5-rc.1 的 dsh-client-connection/lib/index.js）：
 *   1. `dsh web` 启动时随机生成一次性 launch token（进程内 WeakMap，按 ctx.root 记忆，
 *      不落盘、不可由启动方确定性提供）：
 *        processLaunchToken()  L240-246（randomBytes(32)）
 *        BrowserAuth.launchToken  L350
 *   2. 浏览器访问 `http://host/?token=<launchToken>` 时，DSH 用 Host 头推导 authority，
 *      签发 cookie 并 303 跳转到干净 `/`：
 *        requestAuthority(headers)  L253-261（new URL(`http://${host}`).host）
 *        authorizeIndex(req,res)    L386-425（校验 token -> set-cookie）
 *        sessionCookie(...)         L292-294（Max-Age / Path=/ / HttpOnly / SameSite=Strict）
 *   3. cookie 名由 authority 派生，payload 用持久化密钥 HMAC-SHA256 签名：
 *        cookieName(authority) = "dsh-auth-" + base64url(sha256(authority))   L280-282
 *        encodeCookie(payload, secret) = `v1.<base64url(json)>.<base64url(hmac)>` L298-301
 *        payload = { version:1, authority, issuedAt, expiresAt }               L395-400
 *   4. 校验：authority 必须与当前 Host 完全一致、签名必须由持久化密钥生成、时间窗有效
 *        isAuthenticated(request)  L431-441
 *   5. 关键结论 —— **签名密钥是持久化凭据而不是 launch token**：
 *        AUTH_RECORD_KEY = credentialKey("client-connection","browser-session")  L219
 *        BrowserAuth.create -> initializeSecret(credentials)                     L321-338 / L362-364
 *        Secret 存在 `$DSH_HOME/.credentials.yaml` 的
 *        `records["client-connection/browser-session"].payload.secret`（base64url，32 字节），
 *        由 dsh-credentials-local 读写（CREDENTIALS_FILENAME L49，records 解析 L203-210）。
 *
 *   => 网关只要读到该 secret，就能离线为 authority `127.0.0.1:3080` 签出合法 cookie，
 *      浏览器完全不需要携带 token。这是**确定性来源**（配置文件），不依赖嗅探启动日志。
 *      每次转发都刷新 issuedAt/expiresAt，因此只在 cookie 寿命内有效；
 *      遇到 401 时重读 secrets 再重试一次（handleUnauthorized）。
 *
 * 安全边界：
 *   本能力默认关闭，只有显式设置 LEARNBUDDY_DSH_SESSION_INJECT=1 才启用。开启后
 *   公网任意访问者都能以本机身份使用 DSH Web（含本地执行能力），属于已知风险，
 *   开关存在的意义就是让部署方可随时关闭。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** 启用会话注入的显式环境变量开关（默认关闭） */
export const SESSION_INJECT_ENV = "LEARNBUDDY_DSH_SESSION_INJECT";

/** DSH cookie 名前缀（dsh-client-connection L223） */
export const DSH_COOKIE_PREFIX = "dsh-auth-";

/** DSH cookie 载荷版本（dsh-client-connection L224） */
export const DSH_COOKIE_PAYLOAD_VERSION = 1;

/** 持久化签名密钥的凭据记录键（dsh-client-connection L219） */
export const DSH_BROWSER_SESSION_RECORD = "client-connection/browser-session";

/** 凭据文档默认文件名（dsh-credentials-local L49） */
export const DSH_CREDENTIALS_FILENAME = ".credentials.yaml";

/** 签名密钥长度（dsh-client-connection L221 SECRET_BYTES） */
export const DSH_SECRET_BYTES = 32;

/** 默认 cookie 寿命（天）；DSH client-connection 的 cookieMaxAgeDays 默认为 30（L740） */
export const DEFAULT_COOKIE_MAX_AGE_DAYS = 30;

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

/**
 * 解析 DSH home 目录：options.dshHome > $DSH_HOME > ~/.dsh
 * （对应 dsh-home-paths L73-76 resolveDshHome 的优先级）
 * @param {object} [options]
 * @param {string} [options.dshHome] 显式 DSH home
 * @param {NodeJS.ProcessEnv} [options.env] 环境变量映射（默认 process.env）
 * @returns {string} 绝对路径
 */
export function resolveDshHome(options = {}) {
  const env = options.env || process.env;
  const configured = options.dshHome;
  if (typeof configured === "string" && configured.trim() !== "") {
    return path.resolve(configured);
  }
  const fromEnv = env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), ".dsh");
}

/**
 * 解析凭据文档路径：options.credentialsFile > <dshHome>/.credentials.yaml
 * @param {object} [options]
 * @returns {string}
 */
export function resolveCredentialsFile(options = {}) {
  const explicit = options.credentialsFile;
  if (typeof explicit === "string" && explicit.trim() !== "") {
    return path.resolve(explicit);
  }
  return path.join(resolveDshHome(options), DSH_CREDENTIALS_FILENAME);
}

/**
 * base64url 编码（与 dsh-client-connection L231-233 encodeBase64Url 字节级一致）
 * @param {Buffer|string} value
 * @returns {string}
 */
export function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/**
 * base64url 解码；非法输入返回 undefined（对应 L234-239 decodeBase64Url）
 * @param {string} value
 * @returns {Buffer|undefined}
 */
export function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return undefined;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/") + padding, "base64");
  return encodeBase64Url(decoded) === value ? decoded : undefined;
}

/**
 * 由 authority 推导 cookie 名（对应 dsh-client-connection L280-282）
 * @param {string} authority 形如 `127.0.0.1:3080`
 * @returns {string} `dsh-auth-<base64url(sha256(authority))>`
 */
export function cookieNameForAuthority(authority) {
  return DSH_COOKIE_PREFIX + encodeBase64Url(createHash("sha256").update(authority).digest());
}

/**
 * 用持久化密钥为 authority 签一个 DSH 浏览器会话 cookie
 * （对应 dsh-client-connection L292-301：sessionCookie + encodeCookie）
 * @param {object} params
 * @param {string} params.authority cookie 名与受众绑定的 authority
 * @param {string|Buffer} params.secret base64url 字符串或 32 字节 Buffer
 * @param {number} [params.issuedAt] 签发时间（默认 now）
 * @param {number} [params.expiresAt] 过期时间（默认 issuedAt + maxAgeDays）
 * @param {number} [params.maxAgeDays] cookie 寿命（天）
 * @returns {{name:string, value:string, cookieHeader:string, payload:object, expiresAt:number}}
 */
export function mintSessionCookie({ authority, secret, issuedAt, expiresAt, maxAgeDays = DEFAULT_COOKIE_MAX_AGE_DAYS }) {
  if (typeof authority !== "string" || authority === "") throw new TypeError("mintSessionCookie: authority 必须是非空字符串");
  const secretBytes = normalizeSecret(secret);
  if (secretBytes === undefined) throw new TypeError("mintSessionCookie: secret 必须是 32 字节的 base64url 密钥");
  const issued = Number.isSafeInteger(issuedAt) ? issuedAt : Date.now();
  const expires = Number.isSafeInteger(expiresAt) ? expiresAt : issued + maxAgeDays * DAY_MILLISECONDS;
  const payload = {
    version: DSH_COOKIE_PAYLOAD_VERSION,
    authority,
    issuedAt: issued,
    expiresAt: expires
  };
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = createHmac("sha256", secretBytes).update(body).digest();
  const value = `v1.${body}.${encodeBase64Url(signature)}`;
  const name = cookieNameForAuthority(authority);
  return {
    name,
    value,
    cookieHeader: `${name}=${value}`,
    payload,
    expiresAt: expires
  };
}

/**
 * 把 base64url 字符串规范化为 32 字节 Buffer；不合法返回 undefined
 * （对应 dsh-client-connection L262-267 canonicalSecret）
 * @param {unknown} value
 * @returns {Buffer|undefined}
 */
export function normalizeSecret(value) {
  if (Buffer.isBuffer(value)) return value.byteLength === DSH_SECRET_BYTES ? value : undefined;
  if (typeof value !== "string") return undefined;
  const decoded = decodeBase64Url(value);
  if (decoded === undefined || decoded.byteLength !== DSH_SECRET_BYTES) return undefined;
  return decoded;
}

/**
 * 从 `$DSH_HOME/.credentials.yaml` 文本中提取 browser-session 签名密钥
 * （对应 dsh-credentials-local L203-210 records 解析 + L136-157 文档布局）
 *
 * 这里不引入 YAML 依赖：凭据文档由 DSH 自己原子写入，只需定位 records 段里
 * `client-connection/browser-session` 的 payload.secret 标量。解析失败返回 undefined。
 * @param {string} text 凭据文档全文
 * @returns {string|undefined} base64url 密钥
 */
export function extractBrowserSessionSecret(text) {
  if (typeof text !== "string" || text === "") return undefined;
  const lines = text.split(/\r?\n/u);
  const recordLine = /^(\s*)(["']?)client-connection\/browser-session\2\s*:\s*$/u;

  let recordIndex = -1;
  let recordIndent = "";
  for (let i = 0; i < lines.length; i += 1) {
    const matched = recordLine.exec(lines[i]);
    if (matched) {
      recordIndex = i;
      recordIndent = matched[1];
      break;
    }
  }
  if (recordIndex === -1) return undefined;

  // 记录块结束于下一个缩进 <= 记录键缩进的非空行
  let blockEnd = lines.length;
  for (let i = recordIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = /^\s*/u.exec(line)[0];
    if (indent.length <= recordIndent.length) {
      blockEnd = i;
      break;
    }
  }

  const secretLine = /^\s*(?:secret|"secret"|'secret')\s*:\s*(.*?)\s*$/u;
  for (let i = recordIndex + 1; i < blockEnd; i += 1) {
    const matched = secretLine.exec(lines[i]);
    if (!matched) continue;
    let raw = matched[1];
    if (raw.length === 0) return undefined;
    // 去掉 YAML 标量的引号与行尾注释
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1);
    } else {
      raw = raw.split(" #")[0].trim();
    }
    return normalizeSecret(raw) === undefined ? undefined : raw;
  }
  return undefined;
}

/**
 * 从磁盘读取 DSH browser-session 签名密钥
 * @param {object} [options]
 * @param {string} [options.credentialsFile] 显式凭据文档路径
 * @param {string} [options.dshHome] DSH home
 * @param {NodeJS.ProcessEnv} [options.env] 环境变量映射
 * @param {(msg:string)=>void} [options.warn] 告警输出
 * @returns {string|undefined} base64url 密钥；文件缺失/格式不符时返回 undefined 并告警
 */
export function readBrowserSessionSecret(options = {}) {
  const warn = typeof options.warn === "function" ? options.warn : console.warn.bind(console);
  const file = resolveCredentialsFile(options);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    warn(
      `[DSH SessionInject] 读取凭据文档失败: ${file} (${error && error.code ? error.code : String(error)})。` +
      "请确认 DSH 已在该 DSH_HOME 下启动过至少一次（启动时才会生成 browser-session 签名密钥）。"
    );
    return undefined;
  }
  const secret = extractBrowserSessionSecret(text);
  if (secret === undefined) {
    warn(
      `[DSH SessionInject] 凭据文档 ${file} 中未找到可用的 ${DSH_BROWSER_SESSION_RECORD}.payload.secret。` +
      "DSH 尚未启动过、或凭据文档布局已变更。"
    );
    return undefined;
  }
  return secret;
}

/**
 * 从 cookie 串中取出指定 cookie 的值（对应 dsh-client-connection L284-290 cookieValue）
 * @param {string} headerValue Cookie 头原文
 * @param {string} name cookie 名
 * @returns {string|undefined}
 */
export function cookieValueFromHeader(headerValue, name) {
  if (typeof headerValue !== "string") return undefined;
  for (const segment of headerValue.split(";")) {
    const at = segment.indexOf("=");
    if (at === -1 || segment.slice(0, at).trim() !== name) continue;
    return segment.slice(at + 1).trim();
  }
  return undefined;
}

/**
 * 校验一个 cookie 值是否被指定密钥签过名（网关侧自检；等价于 DSH decodeCookie L302-320）
 * @param {string} value `v1.<body>.<sig>`
 * @param {string|Buffer} secret base64url 密钥或 32 字节 Buffer
 * @returns {boolean}
 */
export function verifySessionCookie(value, secret) {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const [, body, encodedSignature] = parts;
  if (!body || !encodedSignature) return false;
  const secretBytes = normalizeSecret(secret);
  if (secretBytes === undefined) return false;
  const actual = decodeBase64Url(encodedSignature);
  if (actual === undefined) return false;
  const expected = createHmac("sha256", secretBytes).update(body).digest();
  if (actual.byteLength !== expected.byteLength) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * 后续转发是否需要重新读取凭据：凭据文档被写入（mtimeMs 变化）或当前凭据来源是缓存。
 * @param {{mtimeMs:number|undefined}} current 已加载凭据的文档 mtime
 * @param {number|undefined} diskMtimeMs 磁盘当前 mtime
 * @returns {boolean}
 */
export function shouldRefreshCredentials(current, diskMtimeMs) {
  if (current === undefined || current.mtimeMs === undefined) return true;
  if (diskMtimeMs === undefined) return false; // 文档暂不可读：保留缓存，避免抖动
  return diskMtimeMs !== current.mtimeMs;
}

/**
 * DSH 会话注入器
 *
 * 职责：
 *   1. 从确定性来源（$DSH_HOME/.credentials.yaml）读取 browser-session 签名密钥
 *   2. 为转发到 DSH 的请求产出 Cookie 头（authority 与 Host 覆盖保持一致）
 *   3. 遇 401 时重读密钥并重试一次（handleUnauthorized）
 *   4. 由 LEARNBUDDY_DSH_SESSION_INJECT 显式开关控制，默认关闭
 */
export class DshSessionInjector {
  /**
   * @param {object} [options]
   * @param {boolean} [options.enabled] 是否启用（默认取 LEARNBUDDY_DSH_SESSION_INJECT）
   * @param {NodeJS.ProcessEnv} [options.env]
   * @param {string} [options.dshHome]
   * @param {string} [options.credentialsFile]
   * @param {string} [options.authority] cookie 名/受众绑定的 authority（默认 127.0.0.1:3080）
   * @param {number} [options.maxAgeDays] cookie 寿命（天，默认 30，需与 DSH cookieMaxAgeDays 一致）
   * @param {number} [options.maxRetries] 401 刷新的最大重试次数（默认 1）
   * @param {(msg:string)=>void} [options.warn]
   * @param {(msg:string)=>void} [options.log]
   * @param {(now:number)=>number} [options.now]
   */
  constructor(options = {}) {
    const env = options.env || process.env;
    this.env = env;
    this.enabled = options.enabled !== undefined ? Boolean(options.enabled) : isSessionInjectEnabled(env);
    this.dshHome = resolveDshHome(options);
    this.credentialsFile = resolveCredentialsFile(options);
    this.authority = options.authority || "127.0.0.1:3080";
    this.maxAgeDays = Number.isFinite(options.maxAgeDays) && options.maxAgeDays > 0
      ? options.maxAgeDays
      : DEFAULT_COOKIE_MAX_AGE_DAYS;
    this.maxRetries = Number.isSafeInteger(options.maxRetries) && options.maxRetries >= 0 ? options.maxRetries : 1;
    this.warn = typeof options.warn === "function" ? options.warn : console.warn.bind(console);
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.now = typeof options.now === "function" ? options.now : Date.now;

    /** @type {{secret:string, mtimeMs:number|undefined, loadedAt:number}|undefined} */
    this.cached = undefined;
    /** 已就 401 重试的次数（跨请求累计，仅供诊断/测试） */
    this.refreshCount = 0;
  }

  /** cookie 名（由 authority 派生） */
  get cookieName() {
    return cookieNameForAuthority(this.authority);
  }

  /**
   * 读取（并按 mtime 复检）磁盘上的签名密钥；文档变更时热更新缓存
   * @param {boolean} [force] 强制重读
   * @returns {{secret:string, mtimeMs:number|undefined, loadedAt:number}|undefined}
   */
  loadCredential(force = false) {
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(this.credentialsFile).mtimeMs;
    } catch {
      mtimeMs = undefined;
    }

    if (!force && this.cached !== undefined && this.cached.secret !== undefined) {
      if (!shouldRefreshCredentials(this.cached, mtimeMs)) return this.cached;
      const refreshed = readBrowserSessionSecret({
        credentialsFile: this.credentialsFile,
        warn: (msg) => this.warn(msg)
      });
      if (refreshed === undefined) return this.cached; // 重读失败：保留上一次可用凭据
      this.cached = { secret: refreshed, mtimeMs, loadedAt: this.now() };
      this.log(`[DSH SessionInject] 凭据文档已变更，已热更新签名密钥 (${this.cookieName})`);
      return this.cached;
    }

    const secret = readBrowserSessionSecret({
      credentialsFile: this.credentialsFile,
      warn: (msg) => this.warn(msg)
    });
    if (secret === undefined) return undefined;
    this.cached = { secret, mtimeMs, loadedAt: this.now() };
    return this.cached;
  }

  /** 强制重读凭据（DSH 重启不改变密钥，只有凭据文档变更才需要） */
  refreshCredentials() {
    return this.loadCredential(true);
  }

  /**
   * 生成该请求要注入的 Cookie 头值
   * @param {{authority?:string}|undefined} [_request] 预留：当前实现以固定 authority 签名
   * @returns {string|undefined} `dsh-auth-<hash>=v1...`；关闭或无凭据时返回 undefined
   */
  headers(_request) {
    if (!this.enabled) return undefined;
    const credential = this.loadCredential(false);
    if (credential === undefined) return undefined;
    const issuedAt = this.now();
    const cookie = mintSessionCookie({
      authority: this.authority,
      secret: credential.secret,
      issuedAt,
      maxAgeDays: this.maxAgeDays
    });
    return cookie.cookieHeader;
  }

  /** 该请求是否具备注入能力（关闭/无凭据时为 false） */
  isAvailable() {
    if (!this.enabled) return false;
    try {
      return this.headers() !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * 收到 401 后的处理：重读凭据并判断是否值得重试一次
   * @param {object} [context]
   * @param {number} [context.attempt] 已尝试次数（从 0 起）
   * @returns {{retry:boolean, cookieHeader?:string, reason:string}}
   */
  handleUnauthorized(context = {}) {
    const attempt = Number.isSafeInteger(context.attempt) ? context.attempt : 0;
    if (!this.enabled) return { retry: false, reason: "inject-disabled" };
    if (attempt >= this.maxRetries) return { retry: false, reason: "retry-exhausted" };

    this.log(`[DSH SessionInject] 上游返回 401，重读凭据后重试（第 ${attempt + 1} 次）: ${this.credentialsFile}`);
    const credential = this.refreshCredentials();
    if (credential === undefined) return { retry: false, reason: "credential-unavailable" };

    // 只有在确实拿到新凭据、即将重试时才计数（重试次数上限由 attempt 控制）
    this.refreshCount += 1;
    const issuedAt = this.now();
    const cookie = mintSessionCookie({
      authority: this.authority,
      secret: credential.secret,
      issuedAt,
      maxAgeDays: this.maxAgeDays
    });
    return { retry: true, cookieHeader: cookie.cookieHeader, reason: "refreshed" };
  }

  /**
   * 启动时打印一次性状态（开启时打印安全告警）
   * @param {(msg:string)=>void} [write] 输出函数（默认 console.log / console.warn）
   * @returns {string[]} 打印过的行
   */
  describeStartup(write) {
    const lines = [];
    const emit = typeof write === "function" ? write : (msg) => console.log(msg);
    if (!this.enabled) {
      lines.push(
        `[DSH SessionInject] 已关闭（默认）。公网访问 DSH 内嵌助手将返回 401；` +
        `如需开启请设置 ${SESSION_INJECT_ENV}=1 后重启网关。`
      );
    } else {
      lines.push(
        `[DSH SessionInject] ⚠️ 安全告警：已开启 DSH 会话注入（${SESSION_INJECT_ENV}=1）。` +
        "公网任意访问者都可以以本机身份使用 DSH Web（含本机读写与命令执行能力），" +
        "请仅在临时联调期间开启，用完立即关闭。"
      );
      lines.push(
        `[DSH SessionInject] 凭据来源: ${this.credentialsFile} -> ${DSH_BROWSER_SESSION_RECORD}.payload.secret；` +
        `cookie: ${this.cookieName}；authority: ${this.authority}`
      );
    }
    for (const line of lines) emit(line);
    return lines;
  }
}

/**
 * 是否启用会话注入：显式 options.enabled > 环境变量
 * 环境变量只认 "1"/"true"/"yes"/"on"（大小写不敏感），其余一律视为关闭。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isSessionInjectEnabled(env = process.env) {
  const raw = env ? env[SESSION_INJECT_ENV] : undefined;
  if (typeof raw !== "string") return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** 便于测试复用的内部常量（不对外承诺稳定性） */
export const __internals = { DAY_MILLISECONDS };
