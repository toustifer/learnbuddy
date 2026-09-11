/**
 * LearnBuddy Gateway Server (Node.js)
 *
 * 作用：
 * 1. 监听 0.0.0.0:3088（公网可访问）
 * 2. 托管 /learnbuddy/* 前端静态产物（index.html + assets/*，含 SPA fallback），公网入口
 * 3. 自动挂载并处理 /api/learnbuddy/* 全部业务接口（含文件存储、静态原件预览、附件下载与数据库持久化）
 * 4. 代理其它请求转发给本地 127.0.0.1:3080 (DSH Web 核心)
 *    - HTTP：http.request + req.pipe（既有行为）
 *    - WebSocket：server.on("upgrade") 透传 Upgrade，使 /api/remote.mux 等路径可返回 101
 * 5. 可选：为转发到 DSH 的请求注入浏览器会话凭据（Cookie），使内嵌助手免 token 可用
 *    - 由 LEARNBUDDY_DSH_SESSION_INJECT=1 显式开启，默认关闭（见 src/services/dsh-session-injector.js）
 * 6. 支持单入口登录（user/123）、课件持久化管理、答疑卡优先匹配、AutoGrader 多模态评分
 */

import http from "node:http";
import { pathToFileURL } from "node:url";
import { registerLearnBuddyRoutes, getOrCreateDefaultStore } from "./src/routes/api.js";
import { registerStaticHosting } from "./src/routes/static-hosting.js";
import { defaultStorage } from "./src/services/storage.js";
import { DshSessionInjector, isSessionInjectEnabled, SESSION_INJECT_ENV } from "./src/services/dsh-session-injector.js";

export const PORT = Number(process.env.PORT) || 3088;
export const DSH_PORT = Number(process.env.DSH_PORT) || 3080;
/** 反向代理目标主机（DSH 只监听 loopback） */
export const DSH_HOST = process.env.DSH_HOST || "127.0.0.1";
/** 代理到 DSH 时覆盖的 Host 头；必须与 DSH 签发的 cookie authority 一致 */
export const DSH_AUTHORITY = `127.0.0.1:${DSH_PORT}`;

/**
 * 构造网关（可被 server.js 顶层与测试共同使用）
 *
 * @param {object} [options]
 * @param {number} [options.port] 监听端口
 * @param {number} [options.dshPort] DSH 端口
 * @param {string} [options.dshHost] DSH 主机
 * @param {string} [options.webDistDir] 前端托管根目录
 * @param {object} [options.store] 业务数据存储
 * @param {object} [options.storage] 文件存储服务
 * @param {DshSessionInjector|false} [options.sessionInject] 会话注入器；false 表示关闭
 * @param {(msg:string)=>void} [options.log]
 * @param {(msg:string)=>void} [options.warn]
 * @returns {{server: import("node:http").Server, middlewares: Function[], webDistDir: string|undefined, injector: DshSessionInjector|undefined, proxy: object}}
 */
export function createGateway(options = {}) {
  const dshPort = Number.isFinite(options.dshPort) ? options.dshPort : DSH_PORT;
  const dshHost = options.dshHost || DSH_HOST;
  const dshAuthority = options.dshAuthority || `127.0.0.1:${dshPort}`;
  const log = typeof options.log === "function" ? options.log : console.log.bind(console);
  const warn = typeof options.warn === "function" ? options.warn : console.warn.bind(console);

  /** @type {DshSessionInjector|undefined} */
  const injector = options.sessionInject === false
    ? undefined
    : options.sessionInject instanceof DshSessionInjector
      ? options.sessionInject
      : new DshSessionInjector({
        enabled: options.sessionInject === true ? true : isSessionInjectEnabled(),
        authority: dshAuthority,
        warn,
        log
      });

  const middlewares = [];
  const fakeCtx = {
    webServer: {
      use: (fn) => middlewares.push(fn)
    }
  };

  const store = options.store || getOrCreateDefaultStore();
  const storage = options.storage || defaultStorage;

  // 前端静态托管优先挂载：
  // - 只接管 /learnbuddy/*，并显式放行 /api/learnbuddy/* 给下面的业务路由
  // - 托管根目录可配置：LEARNBUDDY_WEB_DIST > 默认 plugins/dsh-plugin-learnbuddy/web/dist
  //   （前端 dist 产物由发布流程单独投放，不在本仓 git 内）
  const webDistDir = registerStaticHosting(fakeCtx, {
    webDistDir: options.webDistDir || process.env.LEARNBUDDY_WEB_DIST,
    warn
  });

  registerLearnBuddyRoutes(fakeCtx, { store, storage });

  /**
   * 构造转发到 DSH 的请求头：
   * - Host 覆盖为 127.0.0.1:<dshPort>，与 DSH cookie 的 authority 对齐
   * - 可选注入会话凭据 Cookie（默认关闭）
   * - 剥掉会破坏连接语义的逐跳头
   */
  function buildProxyHeaders(req, cookieHeader) {
    const headers = { ...req.headers };
    headers.host = dshAuthority;
    delete headers["proxy-connection"];
    delete headers["keep-alive"];
    if (cookieHeader !== undefined) headers.cookie = cookieHeader;
    return headers;
  }

  /** 立即回 502（DSH 未启动 / 正在重启） */
  function sendBadGateway(res, error) {
    if (res.headersSent || res.writableEnded) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: false,
      error: "DSH 服务暂未启动或正在重启中",
      detail: error ? error.message : undefined
    }));
  }

  /**
   * 反向代理一次 HTTP 请求到 DSH
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   * @param {{attempt?:number, bodyForwarded?:boolean}} [state] 重试状态
   */
  function proxyHttp(req, res, state = {}) {
    const attempt = state.attempt || 0;
    const bodyForwarded = state.bodyForwarded === true;
    const cookieHeader = injector ? injector.headers(req) : undefined;

    const proxyReq = http.request({
      hostname: dshHost,
      port: dshPort,
      path: req.url,
      method: req.method,
      headers: buildProxyHeaders(req, cookieHeader)
    }, (proxyRes) => {
      // 401：重读凭据后重试一次（凭据过期 / DSH 换了密钥 / 凭据文档刚生成）
      if (proxyRes.statusCode === 401 && injector) {
        const decision = injector.handleUnauthorized({ attempt });
        proxyRes.resume(); // 丢弃 401 响应体，避免连接悬挂
        if (decision.retry) {
          // 带 body 的请求已把流消费掉，无法无损重放：只对无 body 的方法重试
          // （内嵌助手入口 GET /?learnbuddy=embedded 正是这一路径）
          if (!bodyForwarded) {
            proxyHttp(req, res, { attempt: attempt + 1, bodyForwarded });
            return;
          }
        }
        warn(
          `[LearnBuddy Gateway] DSH 返回 401，未重试（${decision.reason})；透传 401 给公网客户端。` +
          `请确认 ${SESSION_INJECT_ENV}=1 且凭据文档可用。`
        );
      }
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on("error", (err) => sendBadGateway(res, err));

    // 先记录 body 是否已被消费：401 分支据此判断能否无损重放
    const hasBody = Number(req.headers["content-length"] || 0) > 0 || req.headers["transfer-encoding"] !== undefined;
    if (hasBody) state.bodyForwarded = true;
    req.pipe(proxyReq, { end: true });
  }

  const server = http.createServer(async (req, res) => {
    // 依次通过中间件
    let handled = false;
    for (const mw of middlewares) {
      let nextCalled = false;
      await mw(req, res, () => { nextCalled = true; });
      if (!nextCalled && (res.writableEnded || res.headersSent)) {
        handled = true;
        break;
      }
    }

    if (handled || res.writableEnded || res.headersSent) return;

    // 其它流量透明反向代理给 DSH Web (127.0.0.1:3080)
    proxyHttp(req, res);
  });

  /**
   * WebSocket upgrade 代理：
   * DSH 的 /api/remote.mux 走 WebSocket，光是 http.request + req.pipe 无法完成 101 握手。
   * 这里把 Upgrade 请求原样转发到 DSH（含注入的鉴权 Cookie），
   * 并在收到上游 101 后把两个 socket 双向对接（head 中的已读字节也要先写过去）。
   */
  server.on("upgrade", (req, clientSocket, head) => {
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      warn(`[LearnBuddy Gateway] WebSocket upgrade 失败 (${req.url}): ${message}`);
      if (clientSocket.writable) {
        const body = String(message);
        clientSocket.end([
          "HTTP/1.1 502 Bad Gateway",
          "Connection: close",
          "Content-Type: text/plain; charset=utf-8",
          `Content-Length: ${String(Buffer.byteLength(body))}`,
          "",
          body
        ].join("\r\n"));
      } else {
        clientSocket.destroy();
      }
    };

    const cookieHeader = injector ? injector.headers(req) : undefined;

    const proxyReq = http.request({
      hostname: dshHost,
      port: dshPort,
      path: req.url,
      method: req.method,
      headers: buildProxyHeaders(req, cookieHeader)
    });

    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      if (settled) {
        proxySocket.destroy();
        return;
      }
      settled = true;
      // 原样回写上游 101 握手响应（Sec-WebSocket-Accept 等头由 DSH 生成）
      clientSocket.write(formatUpgradeHead(proxyRes));
      if (proxyHead && proxyHead.length > 0) clientSocket.write(proxyHead);
      if (head && head.length > 0) proxySocket.write(head);

      // 两端必须成对销毁：只 pipe 不联动会留下半开 socket，既占 fd 又让
      // http server 的 _connections 永不归零（server.close() 会永久挂住）。
      //
      // 注意：pipe() 会 pause 源 socket，被 pause 的 socket 即使 destroy() 也可能
      // 不发 "close"（Node 的 known 行为），所以这里用 resetAndDestroy()（回 RST，
      // 立刻确定性关闭）兜底 destroy()+resume()。
      const hardClose = (socket) => {
        if (socket.destroyed) return;
        if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
        else {
          socket.destroy();
          socket.resume();
        }
      };
      const teardown = () => {
        hardClose(clientSocket);
        hardClose(proxySocket);
      };
      clientSocket.on("close", teardown);
      clientSocket.on("end", teardown);
      clientSocket.on("error", teardown);
      proxySocket.on("close", teardown);
      proxySocket.on("end", teardown);
      proxySocket.on("error", teardown);
      proxySocket.pipe(clientSocket);
      clientSocket.pipe(proxySocket);
    });

    // 上游没有升级（例如 401/403/404）：把状态码、响应头与响应体透传给客户端
    proxyReq.on("response", (proxyRes) => {
      if (settled) return;
      settled = true;
      const lines = [`HTTP/1.1 ${String(proxyRes.statusCode)} ${proxyRes.statusMessage || ""}`.trimEnd()];
      const headers = { ...proxyRes.headers, connection: "close" };
      delete headers["transfer-encoding"];
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
        else lines.push(`${key}: ${String(value)}`);
      }
      lines.push("", "");
      clientSocket.write(lines.join("\r\n"));
      // 必须把 body 也转过去：只写头会让带 content-length 的响应缺一段 body，
      // 客户端会一直等到超时。
      const closeClient = () => {
        if (!clientSocket.destroyed) clientSocket.destroy();
      };
      proxyRes.on("error", closeClient);
      proxyRes.on("end", closeClient);
      clientSocket.on("error", () => proxyRes.destroy());
      proxyRes.pipe(clientSocket);
    });

    proxyReq.on("error", (err) => fail(err.message));
    proxyReq.end();

    // 客户端在握手期间断开
    clientSocket.on("error", () => proxyReq.destroy());
  });

  return { server, middlewares, webDistDir, injector, proxy: { buildProxyHeaders, dshAuthority } };

  /** 序列化上游 101 响应头（node 不提供现成的 writeHead 对 raw socket） */
  function formatUpgradeHead(proxyRes) {
    const lines = [`HTTP/1.1 ${String(proxyRes.statusCode)} ${proxyRes.statusMessage || "Switching Protocols"}`];
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
      else lines.push(`${key}: ${String(value)}`);
    }
    lines.push("", "");
    return lines.join("\r\n");
  }
}

// ---------------------------------------------------------------------------
// 顶层单例：保持既有 server.js 的导出契约（middlewares / server / webDistDir / store / storage）
// ---------------------------------------------------------------------------

export const store = getOrCreateDefaultStore();
export const storage = defaultStorage;

const defaultGateway = createGateway({ store, storage });

export const middlewares = defaultGateway.middlewares;
export const webDistDir = defaultGateway.webDistDir;
export const server = defaultGateway.server;
/** 默认网关使用的会话注入器（可能未启用；用于启动日志与运维诊断） */
export const sessionInjector = defaultGateway.injector;

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain || (!process.env.TEST && process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT)) {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[LearnBuddy Gateway] Server listening on http://0.0.0.0:${PORT}`);
    console.log(`[LearnBuddy Gateway] Serving frontend at http://0.0.0.0:${PORT}/learnbuddy/ (dist: ${webDistDir})`);
    console.log(`[LearnBuddy Gateway] Proxying backend to DSH http://${DSH_AUTHORITY} (HTTP + WebSocket upgrade)`);
    if (sessionInjector) sessionInjector.describeStartup((msg) => console.log(msg));
  });
}
