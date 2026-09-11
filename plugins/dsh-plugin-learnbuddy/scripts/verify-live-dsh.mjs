// 交付端到端证据（人工执行，不参与 npm test）：
// 起两个真实网关实例（隔离端口，不占用线上 3088）代理到**真实 DSH**，
// 用真实 ws 客户端 + 真实 HTTP 验证验收标准。
//
// task-09 追加：所有浏览器场景都**显式携带** Host/Origin/Sec-Fetch-*，
// 复刻真实浏览器行为。此前只测「不带 Origin」才拿到 101 的路径，
// 恰好是缺口（带 Origin -> 403）被漏掉的原因。
//
// 运行（在 plugins/dsh-plugin-learnbuddy 目录下）：
//   node scripts/verify-live-dsh.mjs
//
// 前置：
//   1) 本机 DSH 已在 127.0.0.1:3080 运行
//   2) $DSH_HOME/.credentials.yaml（默认 ~/.dsh/）含 client-connection/browser-session secret
//   3) 能 resolve 到 @deepseek-ai/dsh 自带的 ws 包（本机全局安装路径，见 DS_REQUIRE_ROOT）
//
// 期望输出：全部 PASS（开关关闭仍 401/403 / 开启后带 Origin 也 200 + 101 / 业务路由零回归）。
import http from "node:http";
import { createRequire } from "node:module";
import { DshSessionInjector } from "../src/services/dsh-session-injector.js";
import { createGateway } from "../server.js";
import { DatabaseStore } from "../src/db/store.js";

/** ws 包从 DSH 全局安装处借（本插件刻意保持零依赖） */
const DS_REQUIRE_ROOT = process.env.DSH_PACKAGE_ROOT || "C:/Users/15775/.npm-global/node_modules/@deepseek-ai/dsh/";
const require = createRequire(DS_REQUIRE_ROOT);
const WebSocket = require("ws");

const DSH = { host: "127.0.0.1", port: 3080, authority: "127.0.0.1:3080" };

/** 公网 authority（Leader task-09 实测用的部署）：浏览器据此发 Host/Origin */
const PUBLIC_AUTHORITY = process.env.PUBLIC_AUTHORITY || "129.204.52.57:3088";
const PUBLIC_ORIGIN = `http://${PUBLIC_AUTHORITY}`;

/** 真实浏览器发往网关的请求头（HTTP 与 WebSocket 各有一套 Sec-Fetch-* 取值） */
function browserHeaders({ websocket = false, ...extra } = {}) {
  return {
    Host: PUBLIC_AUTHORITY,
    Origin: PUBLIC_ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": websocket ? "websocket" : "cors",
    "Sec-Fetch-Dest": websocket ? "websocket" : "empty",
    ...extra
  };
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** 用真实 ws 客户端探一次握手，返回 "open" / "http <code>" / "error ..." */
function wsProbe(url, options = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, options);
    const t = setTimeout(() => { ws.terminate(); resolve("timeout"); }, 8000);
    ws.on("open", () => { clearTimeout(t); ws.close(); resolve("open"); });
    ws.on("unexpected-response", (_req, res) => { clearTimeout(t); res.resume(); resolve(`http ${res.statusCode}`); });
    ws.on("error", (e) => { clearTimeout(t); resolve(`error ${e.message}`); });
  });
}

// ---- 网关 A：开关关闭（现状） ----
const offGateway = createGateway({
  dshPort: DSH.port,
  dshAuthority: DSH.authority,
  webDistDir: "./web/dist",
  store: new DatabaseStore(":memory:"),
  sessionInject: new DshSessionInjector({ enabled: false, env: {}, authority: DSH.authority, warn: () => {} }),
  warn: () => {}
});
await new Promise((r) => offGateway.server.listen(0, "127.0.0.1", r));
const offPort = offGateway.server.address().port;

// ---- 网关 B：开关开启（本任务交付） ----
const onGateway = createGateway({
  dshPort: DSH.port,
  dshAuthority: DSH.authority,
  webDistDir: "./web/dist",
  store: new DatabaseStore(":memory:"),
  sessionInject: new DshSessionInjector({ enabled: true, env: {}, authority: DSH.authority, warn: () => {} }),
  warn: () => {}
});
await new Promise((r) => onGateway.server.listen(0, "127.0.0.1", r));
const onPort = onGateway.server.address().port;

console.log(`网关(关闭) :${offPort}   网关(开启) :${onPort}   目标 DSH ${DSH.authority}`);
console.log(`模拟浏览器 authority=${PUBLIC_AUTHORITY}（被代理时会改写成 ${DSH.authority}）\n`);

// 0) 根因复现：直连真实 DSH（不经网关）时，公网 Origin 会被信任栅栏回 403
const directCross = await get(DSH.port, "/api/nonexistent", { Host: DSH.authority, Origin: PUBLIC_ORIGIN });
check("复现根因：直连 DSH + 公网 Origin -> 403（isTrustedApiRequest 同源校验）", directCross.status === 403, `status=${directCross.status}`);
const directSame = await get(DSH.port, "/api/nonexistent", { Host: DSH.authority, Origin: `http://${DSH.authority}` });
check("对照：直连 DSH + Origin 与 Host 同源 -> 非 403（403 确由 Origin 不同源触发）", directSame.status !== 403, `status=${directSame.status}`);
const directNoOrigin = await get(DSH.port, "/api/nonexistent", { Host: DSH.authority });
check("对照：直连 DSH 不带 Origin -> 非 403（旧测试只覆盖了这条路径）", directNoOrigin.status !== 403, `status=${directNoOrigin.status}`);

// 1) 默认关闭 = 现状
const offRes = await get(offPort, "/?learnbuddy=embedded");
check("开关默认关闭时 /?learnbuddy=embedded 仍为 401（行为与现状一致）", offRes.status === 401, `status=${offRes.status}`);

// 2) 开启后公网入口 200（不再是 401）
const onRes = await get(onPort, "/?learnbuddy=embedded", browserHeaders({ "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Mode": "navigate" }));
check("开启注入后 /?learnbuddy=embedded（带公网 Origin）返回 200 HTML", onRes.status === 200 && onRes.body.includes("<html"), `status=${onRes.status} bytes=${onRes.body.length}`);

// 3) 主前端资源路径也通
const idx = await get(onPort, "/", browserHeaders({ "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" }));
check("开启注入后 /（带公网 Origin）返回 200", idx.status === 200, `status=${idx.status}`);

// 4) WebSocket /api/remote.mux：关闭时 401（此前带 Origin 会先被 403 拦下）
const wsOff = await wsProbe(`ws://127.0.0.1:${offPort}/api/remote.mux`);
check("开关关闭时 /api/remote.mux WebSocket 被拒（401）", wsOff === "http 401", wsOff);

// 5) WebSocket /api/remote.mux：开启 + 不带 Origin 时 101（不回退既有能力）
const wsOnNoOrigin = await wsProbe(`ws://127.0.0.1:${onPort}/api/remote.mux`);
check("开启注入后 /api/remote.mux（不带 Origin）握手 101", wsOnNoOrigin === "open", wsOnNoOrigin);

// 6) 关键用例：开启 + 真实浏览器头（公网 Origin + Sec-Fetch-Site）必须 101
const wsOnBrowser = await wsProbe(`ws://127.0.0.1:${onPort}/api/remote.mux`, {
  origin: PUBLIC_ORIGIN,
  headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "websocket", "Sec-Fetch-Dest": "websocket" }
});
check("开启注入后 /api/remote.mux（真实浏览器公网 Origin）握手 101", wsOnBrowser === "open", wsOnBrowser);

// 7) 关键用例：开启 + 公网 Origin 的 /api/* 不得再 403（真实 DSH 对未知路由回 404，鉴权失败回 401）
const apiCrossOrigin = await get(onPort, "/api/nonexistent", browserHeaders());
check("开启注入后 /api/*（真实浏览器公网 Origin）不再是 403", apiCrossOrigin.status !== 403, `status=${apiCrossOrigin.status}`);

// 8) 不得放宽：关闭 + 公网 Origin 的 upgrade 仍必须 403
const wsOffBrowser = await wsProbe(`ws://127.0.0.1:${offPort}/api/remote.mux`, {
  origin: PUBLIC_ORIGIN,
  headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "websocket", "Sec-Fetch-Dest": "websocket" }
});
check("开关关闭时带公网 Origin 的 upgrade 仍是 403（没有放宽成「都放行」）", wsOffBrowser === "http 403", wsOffBrowser);

// 9) 业务路由与静态托管零回归（业务 API 由网关自己处理，不经过 DSH）
const api = await get(onPort, "/api/learnbuddy/materials", browserHeaders());
let apiOk = false;
try {
  apiOk = api.status === 200 && JSON.parse(api.body).ok === true;
} catch { /* ignore */ }
check("开启注入后 /api/learnbuddy/materials 仍由网关处理", apiOk, `status=${api.status}`);

await new Promise((r) => offGateway.server.close(r));
await new Promise((r) => onGateway.server.close(r));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length === 0 ? 0 : 1);
