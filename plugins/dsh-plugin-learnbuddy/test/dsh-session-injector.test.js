/**
 * 网关注入 DSH 会话鉴权 + WebSocket upgrade 代理测试
 *
 * 覆盖：
 * 1. dsh-session-injector 纯函数：cookie 名推导、HMAC 签名、凭据文档解析
 * 2. 开关语义：未设置 / 显式 false / 显式 true 的行为差异
 * 3. 开启注入后：GET /?learnbuddy=embedded 由 401 变为 200（公网可用内嵌助手）
 * 4. 401 刷新重试：上游换了签名密钥时能重读凭据并重试一次
 * 5. WebSocket upgrade 代理：/api/remote.mux 返回 101 + 双向帧转发 + 注入凭据
 * 6. WS 未鉴权时透传 401
 * 7. 回归：/learnbuddy/ 静态托管、/api/learnbuddy/* 业务路由在开关注入开启后仍正常
 *
 * 全部使用真实 HTTP Server / 真实 TCP socket / 真实临时文件（不 mock fs 与 http）。
 * 假 DSH 复刻 dsh-client-connection 的鉴权算法（见 docs/DSH-AUTH-REVERSE-ENGINEERING.md）：
 * cookie 名 sha256(authority)、payload `v1.<b64url(json)>.<b64url(hmac-sha256)>`、
 * authority 必须等于 Host、时间窗必须有效。
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { createGateway, DSH_AUTHORITY } from "../server.js";
import { DatabaseStore } from "../src/db/store.js";
import { StorageService } from "../src/services/storage.js";
import {
  DshSessionInjector,
  SESSION_INJECT_ENV,
  DSH_BROWSER_SESSION_RECORD,
  cookieNameForAuthority,
  extractBrowserSessionSecret,
  isSessionInjectEnabled,
  mintSessionCookie,
  normalizeSecret,
  readBrowserSessionSecret,
  shouldRefreshCredentials,
  verifySessionCookie
} from "../src/services/dsh-session-injector.js";

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

const INDEX_MARKER = "LEARNBUDDY_WS_INDEX_MARKER_7C21";
const INDEX_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>LearnBuddy</title></head><body><div id="root">${INDEX_MARKER}</div></body></html>\n`;

/** 新的 32 字节 base64url 签名密钥（与 DSH randomBytes(32) 同构） */
function newSecret() {
  return randomBytes(32).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** 写一个与 dsh-credentials-local 布局一致的凭据文档 */
function writeCredentials(file, secret) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-test\nrecords:\n  ${DSH_BROWSER_SESSION_RECORD}:\n    kind: grant\n    payload:\n      version: 1\n      secret: ${secret}\n`, "utf-8");
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/** 关闭服务：node:http 的 server.close() 只等所有连接结束。
 * 已升级为 WebSocket 的 socket 不在 closeAllConnections 的跟踪集内，会让 close()
 * 永远挂住，所以这里显式记录 TCP 连接并销毁它们。 */
function close(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
    for (const socket of sockets) socket.destroy();
    // 兜底：关闭期间新建的连接（例如尚未完成的握手）也一并断掉
    const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 100);
    timer.unref?.();
  });
}

/** 真实 HTTP 请求，返回 status/headers/body */
function rawRequest(port, rawPath, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, raw, body: raw.toString("utf-8") });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 假 DSH：复刻 dsh-client-connection 的会话鉴权
// ---------------------------------------------------------------------------

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-5AB0DC85B11";

/** 从 Cookie 头里取指定 cookie 的值（对应 dsh-client-connection cookieValue L284-290） */
function readCookie(headerValue, name) {
  if (typeof headerValue !== "string") return undefined;
  for (const segment of headerValue.split(";")) {
    const at = segment.indexOf("=");
    if (at === -1 || segment.slice(0, at).trim() !== name) continue;
    return segment.slice(at + 1).trim();
  }
  return undefined;
}

/**
 * 复刻 BrowserAuth.isAuthenticated（dsh-client-connection L431-441）：
 * authority 必须等于 Host、cookie 名由 authority 派生、HMAC 由持久化密钥签名、时间窗有效。
 */
function authenticate(headers, secret, { maxAgeDays = 30 } = {}) {
  const host = headers.host;
  let authority;
  try {
    authority = new URL(`http://${host}`).host;
  } catch {
    return false;
  }
  const value = readCookie(headers.cookie, cookieNameForAuthority(authority));
  if (value === undefined) return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const [, body, encodedSignature] = parts;
  const secretBytes = normalizeSecret(secret);
  if (secretBytes === undefined) return false;
  const actual = Buffer.from(String(encodedSignature).replaceAll("-", "+").replaceAll("_", "/"), "base64");
  const expected = createHmac("sha256", secretBytes).update(body).digest();
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return false;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(String(body).replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf-8"));
  } catch {
    return false;
  }
  if (payload?.version !== 1 || payload.authority !== authority) return false;
  const now = Date.now();
  return payload.issuedAt <= now
    && payload.expiresAt > now
    && payload.expiresAt > payload.issuedAt
    && payload.expiresAt - payload.issuedAt <= maxAgeDays * 24 * 60 * 60 * 1000;
}

/**
 * 起一个假 DSH Web：
 * - `/` 与 `/index.html`：需要有效会话 cookie，否则 401（复刻 authorizeIndex + frontend-static）
 * - `/api/*`：需要有效会话 cookie，否则 401
 * - `/api/remote.mux`：WebSocket upgrade，需要有效 cookie，否则 raw socket 回 401
 * - 其它路径：200 + 回显（便于验证代理与 Host 覆盖）
 */
async function startFakeDsh({ getSecret, maxAgeDays = 30 }) {
  const state = { secret: getSecret(), httpRequests: [], wsUpgrades: [], authFailures: 0 };

  const server = http.createServer((req, res) => {
    state.httpRequests.push({ url: req.url, method: req.method, headers: { ...req.headers } });
    if (!authenticate(req.headers, state.secret, { maxAgeDays })) {
      state.authFailures += 1;
      res.writeHead(401, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
      res.end("dsh web authentication required; reopen the URL printed by dsh web.\n");
      return;
    }
    if (req.url === "/" || req.url === "/index.html" || req.url.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(INDEX_HTML);
      return;
    }
    if (req.url.startsWith("/api/")) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, via: "fake-dsh", path: req.url }));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(`FAKE_DSH:${req.url}`);
  });

  // WebSocket upgrade：复刻 api-gateway 的 requestRejection + ws 握手 + 双向转发
  server.on("upgrade", (req, socket, head) => {
    state.wsUpgrades.push({ url: req.url, headers: { ...req.headers } });
    if (!authenticate(req.headers, state.secret, { maxAgeDays })) {
      state.authFailures += 1;
      socket.end([
        "HTTP/1.1 401 Unauthorized",
        "Connection: close",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Length: 12",
        "",
        "unauthorized"
      ].join("\r\n"));
      return;
    }
    const key = req.headers["sec-websocket-key"];
    const accept = createHash("sha1").update(`${key}${WS_MAGIC}`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n"));

    const decoder = new FrameDecoder();
    const handleData = (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.opcode === 0x8) {
          socket.end(encodeFrame(frame.payload, 0x8));
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(frame.payload, 0xa));
          continue;
        }
        if (frame.opcode === 0x1) socket.write(encodeFrame(frame.payload, 0x1));
      }
    };
    if (head && head.length > 0) handleData(head);
    socket.on("data", handleData);
    socket.on("error", () => socket.destroy());
  });

  const port = await listen(server);
  return {
    server,
    port,
    state,
    authority: `127.0.0.1:${port}`,
    setSecret: (secret) => { state.secret = secret; },
    close: () => close(server)
  };
}

// ---------------------------------------------------------------------------
// 极简 WebSocket 帧编解码（客户端侧必须掩码，服务端侧不掩码）
// ---------------------------------------------------------------------------

function encodeFrame(payload, opcode = 0x1, { mask = true } = {}) {
  const data = Buffer.from(payload);
  const length = data.length;
  const header = [];
  header.push(0x80 | opcode);
  const maskBit = mask ? 0x80 : 0x00;
  if (length < 126) header.push(maskBit | length);
  else if (length < 65536) header.push(maskBit | 126, (length >> 8) & 0xff, length & 0xff);
  else header.push(maskBit | 127, 0, 0, 0, 0, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff);
  if (!mask) return Buffer.concat([Buffer.from(header), data]);
  const maskKey = randomBytes(4);
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) masked[i] = data[i] ^ maskKey[i % 4];
  return Buffer.concat([Buffer.from(header), maskKey, masked]);
}

/** 增量帧解码器：TCP 任意分片下都能正确切帧 */
class FrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const frames = [];
    for (;;) {
      const frame = this.take();
      if (frame === undefined) break;
      frames.push(frame);
    }
    return frames;
  }

  take() {
    const buf = this.buffer;
    if (buf.length < 2) return undefined;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < offset + 2) return undefined;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return undefined;
      length = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }
    let maskKey;
    if (masked) {
      if (buf.length < offset + 4) return undefined;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + length) return undefined;
    let payload = Buffer.from(buf.subarray(offset, offset + length));
    if (masked) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
    }
    this.buffer = buf.subarray(offset + length);
    return { opcode, payload };
  }
}

/**
 * 原始 WebSocket 客户端：手写握手 + 帧读写，验证网关是否真的转发了 101 与字节流。
 * @returns {Promise<{status:number, headers:object, acceptValid:boolean, sendText, nextFrame, close}>}
 */
function wsConnect(port, wsPath, { headers = {}, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1").update(`${key}${WS_MAGIC}`).digest("base64");
    let handshakeDone = false;
    let raw = Buffer.alloc(0);
    const frames = [];
    const waiters = [];
    const timer = setTimeout(() => reject(new Error("wsConnect 握手超时")), timeoutMs);

    const flush = () => {
      while (waiters.length > 0 && frames.length > 0) waiters.shift()(frames.shift());
    };

    socket.on("connect", () => {
      const lines = [
        `GET ${wsPath} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13"
      ];
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });

    socket.on("data", (chunk) => {
      if (handshakeDone) {
        for (const frame of new FrameDecoder().push(chunk)) {
          frames.push(frame);
        }
        flush();
        return;
      }
      raw = Buffer.concat([raw, chunk]);
      const end = raw.indexOf("\r\n\r\n");
      if (end === -1) return;
      const headText = raw.subarray(0, end).toString("utf-8");
      const rest = raw.subarray(end + 4);
      const [statusLine, ...headerLines] = headText.split("\r\n");
      const status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(statusLine)?.[1] || 0);
      const responseHeaders = {};
      for (const line of headerLines) {
        const at = line.indexOf(":");
        if (at === -1) continue;
        responseHeaders[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
      }
      handshakeDone = true;
      clearTimeout(timer);
      if (rest.length > 0) {
        for (const frame of new FrameDecoder().push(rest)) frames.push(frame);
      }
      flush();
      resolve({
        status,
        headers: responseHeaders,
        acceptValid: responseHeaders["sec-websocket-accept"] === expectedAccept,
        sendText: (text) => socket.write(encodeFrame(Buffer.from(String(text), "utf-8"), 0x1)),
        sendPing: (payload = "hb") => socket.write(encodeFrame(Buffer.from(String(payload), "utf-8"), 0x9)),
        nextFrame: () => (frames.length > 0
          ? Promise.resolve(frames.shift())
          : new Promise((res, rej) => {
            const wait = setTimeout(() => rej(new Error("等待 WebSocket 帧超时")), timeoutMs);
            waiters.push((frame) => { clearTimeout(wait); res(frame); });
          })),
        close: () => { socket.destroy(); }
      });
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** 直接读原始 socket 的 HTTP 响应（用于验证 upgrade 被拒时的状态码与响应体） */
function rawUpgradeRequest(port, wsPath, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const key = randomBytes(16).toString("base64");
    let raw = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("rawUpgradeRequest 超时")); }, 5000);
    const finish = () => {
      clearTimeout(timer);
      const headEnd = raw.indexOf("\r\n\r\n");
      const head = raw.subarray(0, headEnd).toString("utf-8");
      const body = raw.subarray(headEnd + 4).toString("utf-8");
      const status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(head)?.[1] || 0);
      const contentLength = Number(/content-length:\s*(\d+)/iu.exec(head)?.[1] || 0);
      // 非 101 响应要等 body 读完，否则断言会看到半截
      if (status !== 101 && Buffer.byteLength(body) < contentLength) return;
      resolve({ status, head, body, text: raw.toString("utf-8") });
      socket.destroy();
    };
    socket.on("connect", () => {
      const lines = [
        `GET ${wsPath} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13"
      ];
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      raw = Buffer.concat([raw, chunk]);
      if (raw.indexOf("\r\n\r\n") === -1) return;
      finish();
    });
    socket.on("end", () => {
      if (raw.indexOf("\r\n\r\n") !== -1) finish();
    });
    socket.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

let tmpRoot;
let distDir;
/** 每次建网关前都新造一个：注入器缓存凭据，避免用例间串味 */
function makeCredsFile(name, secret) {
  const file = path.join(tmpRoot, `${name}.credentials.yaml`);
  writeCredentials(file, secret);
  return file;
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "learnbuddy-dsh-inject-"));
  distDir = path.join(tmpRoot, "web-dist");
  fs.mkdirSync(path.join(distDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(distDir, "index.html"), INDEX_HTML, "utf-8");
  fs.writeFileSync(path.join(distDir, "assets", "app.js"), "export const x=1;\n", "utf-8");
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * 组合一个真实网关 + 真实假 DSH
 * @returns {Promise<{gateway, port, dsh, close}>}
 */
async function startHarness({ secret, enabled = true, credsFile, sessionInject, dshMaxAgeDays = 30 } = {}) {
  const dshSecret = secret || newSecret();
  const dsh = await startFakeDsh({ getSecret: () => dshSecret, maxAgeDays: dshMaxAgeDays });
  const file = credsFile || makeCredsFile(`cred-${Math.random().toString(36).slice(2)}`, dshSecret);

  const injector = sessionInject === undefined
    ? new DshSessionInjector({
      enabled,
      credentialsFile: file,
      authority: dsh.authority,
      warn: () => {}
    })
    : sessionInject;

  const gateway = createGateway({
    dshPort: dsh.port,
    dshAuthority: dsh.authority,
    webDistDir: distDir,
    store: new DatabaseStore(":memory:"),
    storage: new StorageService({ baseDir: path.join(tmpRoot, "uploads") }),
    sessionInject: injector,
    warn: () => {}
  });
  const port = await listen(gateway.server);
  return {
    gateway,
    port,
    dsh,
    injector,
    credsFile: file,
    dshSecret,
    close: async () => {
      await close(gateway.server);
      await dsh.close();
    }
  };
}

// ---------------------------------------------------------------------------
// 1. 纯函数：cookie 名推导 / 签名 / 凭据文档解析
// ---------------------------------------------------------------------------

test("cookie 名由 authority 派生：dsh-auth-<base64url(sha256(authority))>", () => {
  const name = cookieNameForAuthority("127.0.0.1:3080");
  assert.match(name, /^dsh-auth-[A-Za-z0-9_-]{43}$/u);
  assert.equal(name, `dsh-auth-${createHash("sha256").update("127.0.0.1:3080").digest("base64url")}`);
  // authority 不同 -> cookie 名不同（DSH 用它把 cookie 绑到 Host）
  assert.notEqual(name, cookieNameForAuthority("example.com:3088"));
});

test("mintSessionCookie 产出的 cookie 能被同一密钥验签，且换密钥即失效", () => {
  const secret = newSecret();
  const other = newSecret();
  const cookie = mintSessionCookie({ authority: "127.0.0.1:3080", secret });
  assert.equal(cookie.name, cookieNameForAuthority("127.0.0.1:3080"));
  assert.match(cookie.value, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assert.equal(cookie.payload.version, 1);
  assert.equal(cookie.payload.authority, "127.0.0.1:3080");
  assert.ok(cookie.payload.expiresAt > cookie.payload.issuedAt);

  assert.equal(verifySessionCookie(cookie.value, secret), true);
  assert.equal(verifySessionCookie(cookie.value, other), false);
  assert.equal(verifySessionCookie(`${cookie.value}x`, secret), false);
  assert.equal(verifySessionCookie("garbage", secret), false);
  assert.throws(() => mintSessionCookie({ authority: "127.0.0.1:3080", secret: "not-a-secret" }), /32 字节/u);
});

test("extractBrowserSessionSecret 能从凭据文档中取出密钥，且拒绝非法密钥", () => {
  const secret = newSecret();
  const text = `version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-x\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: ${secret}\n`;
  assert.equal(extractBrowserSessionSecret(text), secret);

  // 引号风格 / CRLF / 行尾注释
  assert.equal(extractBrowserSessionSecret(`records:\n  "client-connection/browser-session":\n    payload:\n      secret: '${secret}'\n`), secret);
  assert.equal(extractBrowserSessionSecret(`records:\r\n  client-connection/browser-session:\r\n    payload:\r\n      secret: ${secret}\r\n`), secret);

  // 缺记录 / 密钥长度不对 -> undefined（而不是抛异常）
  assert.equal(extractBrowserSessionSecret("version: 1\nrefs:\n  A: b\n"), undefined);
  assert.equal(extractBrowserSessionSecret("records:\n  client-connection/browser-session:\n    payload:\n      secret: short\n"), undefined);

  // 读文件路径同样生效
  const file = makeCredsFile("extract-ok", secret);
  assert.equal(readBrowserSessionSecret({ credentialsFile: file, warn: () => {} }), secret);
  const warnings = [];
  assert.equal(readBrowserSessionSecret({ credentialsFile: path.join(tmpRoot, "nope.yaml"), warn: (m) => warnings.push(m) }), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /读取凭据文档失败/u);
});

test("开关解析：只有 1/true/yes/on 开启，其余一律关闭（默认关闭）", () => {
  assert.equal(isSessionInjectEnabled({}), false);
  assert.equal(isSessionInjectEnabled({ [SESSION_INJECT_ENV]: "" }), false);
  assert.equal(isSessionInjectEnabled({ [SESSION_INJECT_ENV]: "0" }), false);
  assert.equal(isSessionInjectEnabled({ [SESSION_INJECT_ENV]: "false" }), false);
  assert.equal(isSessionInjectEnabled({ [SESSION_INJECT_ENV]: "TRUE" }), true);
  assert.equal(isSessionInjectEnabled({ [SESSION_INJECT_ENV]: " 1 " }), true);
  assert.equal(isSessionInjectEnabled({ [SESSION_INJECT_ENV]: "yes" }), true);
  assert.equal(isSessionInjectEnabled({ [SESSION_INJECT_ENV]: "on" }), true);
  const injector = new DshSessionInjector({ env: {}, credentialsFile: makeCredsFile("off", newSecret()) });
  assert.equal(injector.enabled, false);
  assert.equal(injector.headers({}), undefined, "默认关闭时不得产出 Cookie");
});

test("shouldRefreshCredentials：文档 mtime 变化才需要重读", () => {
  assert.equal(shouldRefreshCredentials({ mtimeMs: 1 }, 1), false);
  assert.equal(shouldRefreshCredentials({ mtimeMs: 1 }, 2), true);
  assert.equal(shouldRefreshCredentials({ mtimeMs: 1 }, undefined), false, "文档暂不可读时保留缓存");
  assert.equal(shouldRefreshCredentials({}, 5), true);
  assert.equal(shouldRefreshCredentials(undefined, 5), true);
});

// ---------------------------------------------------------------------------
// 2. 开关关闭：行为与现状一致
// ---------------------------------------------------------------------------

test("开关关闭：公网 /?learnbuddy=embedded 仍是 401，且不得携带任何注入 Cookie", async () => {
  const secret = newSecret();
  const credsFile = makeCredsFile("disabled", secret);
  const h = await startHarness({ secret, credsFile, enabled: false });
  try {
    const res = await rawRequest(h.port, "/?learnbuddy=embedded");
    assert.equal(res.status, 401, "默认关闭时必须保持现状 401");
    assert.match(res.body, /authentication required/u);
    assert.equal(h.dsh.state.authFailures, 1);

    const seen = h.dsh.state.httpRequests.at(-1);
    assert.equal(seen.headers.cookie, undefined, "关闭时不得注入 Cookie");
    assert.equal(seen.headers.host, h.dsh.authority, "Host 必须覆盖为 127.0.0.1:<dshPort>");
  } finally {
    await h.close();
  }
});

test("显式 sessionInject=false：即使凭据文件可用也不注入", async () => {
  const secret = newSecret();
  const h = await startHarness({ secret, enabled: true, sessionInject: false });
  try {
    const res = await rawRequest(h.port, "/?learnbuddy=embedded");
    assert.equal(res.status, 401);
    assert.equal(h.dsh.state.httpRequests.at(-1).headers.cookie, undefined);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 3. 开启注入：401 -> 200（公网可用内嵌助手）
// ---------------------------------------------------------------------------

test("开启注入：GET /?learnbuddy=embedded 返回 200 HTML（不再是 401），且 Host 覆盖仍为 127.0.0.1:<port>", async () => {
  const secret = newSecret();
  const h = await startHarness({ secret, enabled: true });
  try {
    const res = await rawRequest(h.port, "/?learnbuddy=embedded");
    assert.equal(res.status, 200, "注入后内嵌助手入口必须 200");
    assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
    assert.match(res.body, new RegExp(INDEX_MARKER));

    const seen = h.dsh.state.httpRequests.at(-1);
    assert.equal(seen.headers.host, h.dsh.authority);
    assert.equal(h.dsh.state.authFailures, 0);

    // 注入的 cookie 与 authority 对齐、且能被同一密钥验签
    const value = readCookie(seen.headers.cookie, cookieNameForAuthority(h.dsh.authority));
    assert.ok(value, "Cookie 头里应有按 authority 派生的 dsh-auth-* cookie");
    assert.equal(verifySessionCookie(value, secret), true);
  } finally {
    await h.close();
  }
});

test("开启注入：注入的 cookie 载荷为 {version,authority,issuedAt,expiresAt} 且时间窗有效", async () => {
  const secret = newSecret();
  const h = await startHarness({ secret, enabled: true });
  try {
    const before = Date.now();
    const res = await rawRequest(h.port, "/api/whatever");
    assert.equal(res.status, 200);
    const after = Date.now();

    const raw = h.dsh.state.httpRequests.at(-1).headers.cookie;
    const value = readCookie(raw, cookieNameForAuthority(h.dsh.authority));
    const [, body] = value.split(".");
    const payload = JSON.parse(Buffer.from(body.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf-8"));

    assert.deepEqual(Object.keys(payload).sort(), ["authority", "expiresAt", "issuedAt", "version"]);
    assert.equal(payload.version, 1);
    assert.equal(payload.authority, h.dsh.authority, "payload.authority 必须等于覆盖后的 Host");
    assert.ok(payload.issuedAt >= before && payload.issuedAt <= after);
    assert.equal(payload.expiresAt - payload.issuedAt, 30 * 24 * 60 * 60 * 1000, "默认 30 天寿命需与 DSH cookieMaxAgeDays 一致");
  } finally {
    await h.close();
  }
});

test("开启注入：浏览器自带的无关键 Cookie 会被替换为注入凭据", async () => {
  const secret = newSecret();
  const h = await startHarness({ secret, enabled: true });
  try {
    const res = await rawRequest(h.port, "/?learnbuddy=embedded", { headers: { Cookie: "other=1; theme=dark" } });
    assert.equal(res.status, 200);
    const cookie = h.dsh.state.httpRequests.at(-1).headers.cookie;
    assert.match(cookie, /^dsh-auth-[A-Za-z0-9_-]{43}=v1\./u);
    assert.ok(!cookie.includes("theme=dark"));
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 4. 401 刷新重试
// ---------------------------------------------------------------------------

test("401 刷新重试：上游换密钥后，网关重读凭据文档并重试一次成功", async () => {
  const oldSecret = newSecret();
  const newSecretValue = newSecret();
  const credsFile = makeCredsFile("rotating", oldSecret);
  const warned = [];
  const injector = new DshSessionInjector({
    enabled: true,
    credentialsFile: credsFile,
    authority: "placeholder",
    warn: (m) => warned.push(m)
  });
  injector.loadCredential(true);
  const h = await startHarness({ secret: oldSecret, credsFile, enabled: true, sessionInject: injector });
  injector.authority = h.dsh.authority;
  try {
    // 写入新密钥后把 mtime 复位成缓存里的旧值：注入器不会提前热更新（缓存仍视为有效），
    // 于是首次请求带着已被 DSH 吊销的旧签名 -> 上游 401 -> 走刷新重试分支。
    writeCredentials(credsFile, newSecretValue);
    const restored = new Date(Math.floor(injector.cached.mtimeMs));
    fs.utimesSync(credsFile, restored, restored);
    injector.cached.mtimeMs = fs.statSync(credsFile).mtimeMs;
    h.dsh.setSecret(newSecretValue);
    const failuresBefore = h.dsh.state.authFailures;

    // 记录网关实际发出的两次注入凭据（原始 + 重试），用于证明重试用的是新密钥
    const originalHeaders = injector.headers.bind(injector);
    const attempts = [];
    injector.headers = (request) => {
      const value = originalHeaders(request);
      attempts.push(value);
      return value;
    };

    const res = await rawRequest(h.port, "/?learnbuddy=embedded");
    assert.equal(res.status, 200, "刷新凭据后重试必须成功");
    assert.match(res.body, new RegExp(INDEX_MARKER));
    assert.equal(injector.refreshCount, 1, "应恰好触发一次刷新重试");
    assert.equal(h.dsh.state.authFailures, failuresBefore + 1, "重试前应恰好被上游拒绝一次");
    assert.equal(h.dsh.state.httpRequests.length, 2, "上游只应收到原始 + 一次重试两次请求");

    const last = h.dsh.state.httpRequests.at(-1);
    const value = readCookie(last.headers.cookie, cookieNameForAuthority(h.dsh.authority));
    assert.equal(verifySessionCookie(value, newSecretValue), true, "重试用的必须是新密钥签的 cookie");
    assert.equal(verifySessionCookie(value, oldSecret), false);

    // 两次尝试的凭据：原始用旧密钥（必然被拒），重试用新密钥
    assert.equal(attempts.length, 2, "网关应恰好注入两次凭据（原始 + 重试）");
    const valueOf = (header) => readCookie(header, cookieNameForAuthority(h.dsh.authority));
    assert.equal(verifySessionCookie(valueOf(attempts[0]), oldSecret), true, "首次必须带旧签名（这正是 401 的原因）");
    assert.equal(verifySessionCookie(valueOf(attempts[0]), newSecretValue), false);
    assert.equal(verifySessionCookie(valueOf(attempts[1]), newSecretValue), true, "重试必须换成新签名");
    injector.headers = originalHeaders;
  } finally {
    await h.close();
  }
});

test("401 重试仍失败：不无限重试，透传 401 并记录告警", async () => {
  const secret = newSecret();
  const otherSecret = newSecret();
  const warned = [];
  const dsh = await startFakeDsh({ getSecret: () => otherSecret }); // 永远用另一把密钥
  const credsFile = makeCredsFile("stale", secret);
  const injector = new DshSessionInjector({
    enabled: true,
    credentialsFile: credsFile,
    authority: dsh.authority,
    warn: (m) => warned.push(m)
  });
  const gateway = createGateway({
    dshPort: dsh.port,
    dshAuthority: dsh.authority,
    webDistDir: distDir,
    store: new DatabaseStore(":memory:"),
    storage: new StorageService({ baseDir: path.join(tmpRoot, "uploads2") }),
    sessionInject: injector,
    warn: (m) => warned.push(m)
  });
  const port = await listen(gateway.server);
  try {
    const res = await rawRequest(port, "/?learnbuddy=embedded");
    assert.equal(res.status, 401, "凭据始终不可用时必须如实透传 401");
    assert.equal(injector.refreshCount, 1, "只刷新重试一次");
    assert.equal(dsh.state.authFailures, 2, "上游被请求两次（原始 + 一次重试）");
    assert.ok(warned.some((m) => /401/u.test(m)), "应记录 401 透传告警");
  } finally {
    await close(gateway.server);
    await dsh.close();
  }
});

test("凭据文档缺失：开启注入但读不到密钥时如实降级（401 + 告警，不伪造）", async () => {
  const warnings = [];
  const injector = new DshSessionInjector({
    enabled: true,
    credentialsFile: path.join(tmpRoot, "does-not-exist.yaml"),
    authority: "127.0.0.1:1",
    warn: (m) => warnings.push(m)
  });
  assert.equal(injector.isAvailable(), false);
  assert.equal(injector.headers({}), undefined);
  assert.equal(injector.handleUnauthorized({ attempt: 0 }).retry, false);
  assert.ok(warnings.some((m) => /读取凭据文档失败/u.test(m)));

  // 告警文案必须显式点出安全风险
  const lines = injector.describeStartup(() => {});
  assert.match(lines[0], /安全告警/u);
  assert.match(lines[0], new RegExp(SESSION_INJECT_ENV));
  const offLines = new DshSessionInjector({ enabled: false, env: {} }).describeStartup(() => {});
  assert.match(offLines[0], /已关闭（默认）/u);
});

// ---------------------------------------------------------------------------
// 5. WebSocket upgrade 代理
// ---------------------------------------------------------------------------

test("WebSocket upgrade 代理：/api/remote.mux 握手返回 101，承载正确 Accept，并双向转发帧", async () => {
  const secret = newSecret();
  const h = await startHarness({ secret, enabled: true });
  try {
    const client = await wsConnect(h.port, "/api/remote.mux");
    assert.equal(client.status, 101, "网关必须完成 WebSocket 101 握手");
    assert.equal(client.headers.upgrade, "websocket");
    assert.equal(client.acceptValid, true, "Sec-WebSocket-Accept 必须与客户端 key 匹配（不能是伪造的 101）");

    // 上行 -> 下游 回显（真正双向转发，而不是只回握手）
    client.sendText("ping-from-learnbuddy");
    const echo = await client.nextFrame();
    assert.equal(echo.opcode, 0x1);
    assert.equal(echo.payload.toString("utf-8"), "ping-from-learnbuddy");

    // 控制帧（ping -> pong）也要透传
    client.sendPing("hb-1");
    const pong = await client.nextFrame();
    assert.equal(pong.opcode, 0xa);
    assert.equal(pong.payload.toString("utf-8"), "hb-1");

    // 上游确实收到了带注入凭据的 upgrade 请求
    const upgrade = h.dsh.state.wsUpgrades.at(-1);
    assert.equal(upgrade.url, "/api/remote.mux");
    assert.equal(upgrade.headers.host, h.dsh.authority);
    assert.equal(
      verifySessionCookie(readCookie(upgrade.headers.cookie, cookieNameForAuthority(h.dsh.authority)), secret),
      true,
      "WebSocket upgrade 也必须携带有效会话凭据"
    );
    client.close();
  } finally {
    await h.close();
  }
});

test("WebSocket upgrade：开关关闭时上游 401 被透传（不会伪造 101）", async () => {
  const h = await startHarness({ secret: newSecret(), enabled: false });
  try {
    const res = await rawUpgradeRequest(h.port, "/api/remote.mux");
    assert.equal(res.status, 401, "未注入凭据时 upgrade 必须如实 401");
    assert.match(res.text, /unauthorized/u);
  } finally {
    await h.close();
  }
});

test("WebSocket upgrade：DSH 未启动时客户端收到 502 而不是挂死", async () => {
  const deadPort = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const gateway = createGateway({
    dshPort: deadPort,
    dshAuthority: `127.0.0.1:${deadPort}`,
    webDistDir: distDir,
    store: new DatabaseStore(":memory:"),
    storage: new StorageService({ baseDir: path.join(tmpRoot, "uploads3") }),
    sessionInject: false,
    warn: () => {}
  });
  const port = await listen(gateway.server);
  try {
    const res = await rawUpgradeRequest(port, "/api/remote.mux");
    assert.equal(res.status, 502);
  } finally {
    await close(gateway.server);
  }
});

// ---------------------------------------------------------------------------
// 6. 回归：静态托管与业务路由不受影响
// ---------------------------------------------------------------------------

test("回归：注入开启时 /learnbuddy/ 静态托管、SPA 回落、缺失 assets 均不受影响", async () => {
  const h = await startHarness({ secret: newSecret(), enabled: true });
  try {
    const home = await rawRequest(h.port, "/learnbuddy/");
    assert.equal(home.status, 200);
    assert.equal(home.headers["content-type"], "text/html; charset=utf-8");
    assert.match(home.body, new RegExp(INDEX_MARKER));
    assert.equal(home.headers["cache-control"], "no-cache");

    const asset = await rawRequest(h.port, "/learnbuddy/assets/app.js");
    assert.equal(asset.status, 200);
    assert.equal(asset.headers["content-type"], "application/javascript; charset=utf-8");
    assert.equal(asset.body, "export const x=1;\n");

    const spa = await rawRequest(h.port, "/learnbuddy/assignments/deep/route");
    assert.equal(spa.status, 200);
    assert.match(spa.body, new RegExp(INDEX_MARKER));

    const missing = await rawRequest(h.port, "/learnbuddy/assets/nope.js");
    assert.equal(missing.status, 404);
    assert.ok(!/<html/i.test(missing.body));

    // 静态托管流量不得被转发到 DSH
    assert.ok(!h.dsh.state.httpRequests.some((r) => String(r.url).startsWith("/learnbuddy/")));
  } finally {
    await h.close();
  }
});

test("回归：注入开启时 /api/learnbuddy/* 业务路由仍由本网关处理（不转发给 DSH）", async () => {
  const h = await startHarness({ secret: newSecret(), enabled: true });
  try {
    const materials = await rawRequest(h.port, "/api/learnbuddy/materials");
    assert.equal(materials.status, 200);
    assert.equal(materials.headers["content-type"], "application/json; charset=utf-8");
    const json = JSON.parse(materials.body);
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.materials));

    const loginBody = JSON.stringify({ username: "user", password: "123" });
    const login = await rawRequest(h.port, "/api/learnbuddy/auth/login", {
      method: "POST",
      body: loginBody,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(loginBody) }
    });
    assert.equal(login.status, 200);
    assert.equal(JSON.parse(login.body).ok, true);

    assert.equal(h.dsh.state.httpRequests.filter((r) => String(r.url).startsWith("/api/learnbuddy")).length, 0);
  } finally {
    await h.close();
  }
});

test("回归：DSH 未启动时普通 HTTP 仍回 502 JSON（既有行为不变）", async () => {
  const deadPort = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const gateway = createGateway({
    dshPort: deadPort,
    dshAuthority: `127.0.0.1:${deadPort}`,
    webDistDir: distDir,
    store: new DatabaseStore(":memory:"),
    storage: new StorageService({ baseDir: path.join(tmpRoot, "uploads4") }),
    sessionInject: true,
    warn: () => {}
  });
  const port = await listen(gateway.server);
  try {
    const res = await rawRequest(port, "/?learnbuddy=embedded");
    assert.equal(res.status, 502);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.match(body.error, /DSH/u);
  } finally {
    await close(gateway.server);
  }
});

test("导出契约：默认网关 authority 与 DSH_PORT 对齐，且 createGateway 允许指定 dshAuthority", async () => {
  assert.match(DSH_AUTHORITY, /^127\.0\.0\.1:\d+$/u);
  assert.equal(DSH_AUTHORITY, `127.0.0.1:${Number(process.env.DSH_PORT) || 3080}`);
  const h = await startHarness({ secret: newSecret(), enabled: true });
  try {
    assert.equal(h.gateway.proxy.dshAuthority, h.dsh.authority);
    const headers = h.gateway.proxy.buildProxyHeaders({ headers: { host: "learnbuddy.example.com", cookie: "keep=1" } }, undefined);
    assert.equal(headers.host, h.dsh.authority, "Host 必须被覆盖为 DSH authority");
    assert.equal(headers.cookie, "keep=1", "未提供注入凭据时保留原 Cookie（关闭语义）");
    const injected = h.gateway.proxy.buildProxyHeaders({ headers: { host: "learnbuddy.example.com" } }, "dsh-auth-x=y");
    assert.equal(injected.cookie, "dsh-auth-x=y");
  } finally {
    await h.close();
  }
});
