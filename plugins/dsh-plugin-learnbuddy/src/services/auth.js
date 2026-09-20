/**
 * 认证基础服务（身份绑定）
 *
 * 设计要点（对应《Agent 友好 / MCP 友好 契约层规范》的「身份契约」）：
 *   1. 密码**只存哈希**，用 Node 内置 `node:crypto` 的 scrypt，零新依赖；
 *   2. 会话令牌是**服务端随机生成并落库**的，不是可预测的字符串拼接；
 *   3. 令牌校验**只认服务端记录**，调用方无法通过任何入参声明身份。
 *
 * 为什么不用 `token-${userId}-${Date.now()}` 那种拼法：
 *   那种令牌不含任何秘密，任何人按同样规则都能造一个出来，等于没认证。
 */
import crypto from "node:crypto";

/** 会话有效期（小时）。演示期取 12 小时，够一个工作日。 */
export const SESSION_TTL_HOURS = 12;

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

/**
 * 生成密码哈希。
 * 存储格式：`scrypt$<salt-hex>$<hash-hex>`（自带算法标识，便于以后换算法时兼容旧值）
 *
 * @param {string} password 明文密码
 * @returns {string} 可直接入库的哈希串
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const derived = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * 校验密码。
 *
 * 不抛异常、不区分「用户不存在」与「密码错误」（由调用方统一返回同一种错误），
 * 避免通过错误信息枚举出系统里有哪些账号。
 *
 * @param {string} password 明文密码
 * @param {string} stored 入库的哈希串
 * @returns {boolean}
 */
export function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[1], "hex");
    expected = Buffer.from(parts[2], "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length);
  } catch {
    return false;
  }
  // 长度必须一致，否则 timingSafeEqual 会抛错
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/** 生成不可预测的会话令牌（64 位十六进制字符）。 */
export function issueToken() {
  return crypto.randomBytes(32).toString("hex");
}

/** 计算会话过期时间（UTC ISO 8601，与项目时间口径一致）。 */
export function sessionExpiry(now = new Date()) {
  return new Date(now.getTime() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
}

/**
 * 从请求头解析访问令牌。
 *
 * 只认 `Authorization: Bearer <token>`。**不接受**任何查询参数或请求体里的
 * `userId` / `role` 之类的自报身份——那是本次修复要根除的做法。
 *
 * @param {import("node:http").IncomingMessage & { url?: string }} req
 * @returns {string} 令牌；没有则为空串
 */
export function readBearerToken(req) {
  const raw = req && req.headers ? req.headers["authorization"] : "";
  if (typeof raw !== "string") return "";
  const matched = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return matched ? matched[1].trim() : "";
}

/**
 * 从查询参数读取令牌（**仅供文件预览/下载这两个无法自定义请求头的场景使用**）。
 *
 * 为什么开这个口子：`<img src>` 与 `<a href>` 由浏览器发起，无法附加 Authorization 头。
 * 令牌本身仍是服务端签发并校验的，不等于「自报身份」。
 *
 * @param {URL} url
 * @returns {string}
 */
export function readQueryToken(url) {
  const token = url && url.searchParams ? url.searchParams.get("token") : "";
  return typeof token === "string" ? token.trim() : "";
}

/**
 * 把请求解析成可信的 `Actor`。
 *
 * 为什么放在这里而不是各路由里：`api.js` 与 `teaching.js` 是两个独立的中间件，
 * 各自实现一套解析迟早会改一处漏一处。身份判定必须只有一份实现。
 *
 * @param {{getSessionActor: (token: string) => object|null}} store
 * @param {import("node:http").IncomingMessage} req
 * @param {{queryToken?: string}} [options]
 * @returns {{ok: true, user: object} | {ok: false, status: number, error: string}}
 */
export function resolveActorFromRequest(store, req, options = {}) {
  const token = readBearerToken(req) || options.queryToken || "";
  if (!token) {
    return { ok: false, status: 401, error: "未登录：缺少访问令牌" };
  }
  const user = store.getSessionActor(token);
  if (!user) {
    return { ok: false, status: 401, error: "登录已失效，请重新登录" };
  }
  return { ok: true, user };
}
