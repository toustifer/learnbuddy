/**
 * LearnBuddy Gateway Server (Node.js)
 * 
 * 作用：
 * 1. 监听 0.0.0.0:3088（公网可访问）
 * 2. 自动挂载并处理 /api/learnbuddy/* 全部业务接口（Mock 状态与真实交互）
 * 3. 代理其它请求转发给本地 127.0.0.1:3080 (DSH Web 核心)
 * 4. 支持单入口登录（user/123）、课件列表、答疑卡优先匹配、AutoGrader 多模态评分
 */

import http from "node:http";
import { registerLearnBuddyRoutes } from "./src/routes/api.js";

const PORT = 3088;
const DSH_PORT = 3080;

// 构造简易的 webServer 上下文给路由中间件使用
const middlewares = [];
const fakeCtx = {
  webServer: {
    use: (fn) => middlewares.push(fn)
  }
};

registerLearnBuddyRoutes(fakeCtx);

const server = http.createServer(async (req, res) => {
  // 依次通过中间件
  let handled = false;
  for (const mw of middlewares) {
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    if (!nextCalled && res.writableEnded) {
      handled = true;
      break;
    }
  }

  if (handled || res.writableEnded) return;

  // 其它流量透明反向代理给 DSH Web (127.0.0.1:3080)
  const proxyReq = http.request({
    hostname: "127.0.0.1",
    port: DSH_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${DSH_PORT}`
    }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: false,
      error: "DSH 服务暂未启动或正在重启中",
      detail: err.message
    }));
  });

  req.pipe(proxyReq, { end: true });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[LearnBuddy Gateway] Server listening on http://0.0.0.0:${PORT}`);
  console.log(`[LearnBuddy Gateway] Proxying backend to DSH http://127.0.0.1:${DSH_PORT}`);
});
