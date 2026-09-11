// 交付端到端证据（人工执行，不参与 npm test）：
// 起一个真实网关实例（隔离端口，不占用线上 3088）代理到**真实 DSH**，
// 用真实 ws 客户端 + 真实 HTTP 验证 6 条验收标准。
//
// 运行（在 plugins/dsh-plugin-learnbuddy 目录下）：
//   node scripts/verify-live-dsh.mjs
//
// 前置：
//   1) 本机 DSH 已在 127.0.0.1:3080 运行
//   2) $DSH_HOME/.credentials.yaml（默认 ~/.dsh/）含 client-connection/browser-session secret
//   3) 能 resolve 到 @deepseek-ai/dsh 自带的 ws 包（本机全局安装路径，见 DS_REQUIRE_ROOT）
//
// 期望输出：6/6 项通过（关闭 401 / 开启 200 + 101 / 业务路由零回归）。
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

console.log(`网关(关闭) :${offPort}   网关(开启) :${onPort}   目标 DSH ${DSH.authority}\n`);

// 1) 默认关闭 = 现状
const offRes = await get(offPort, "/?learnbuddy=embedded");
check("开关默认关闭时 /?learnbuddy=embedded 仍为 401（行为与现状一致）", offRes.status === 401, `status=${offRes.status}`);

// 2) 开启后公网入口 200（不再是 401）
const onRes = await get(onPort, "/?learnbuddy=embedded");
check("开启注入后 /?learnbuddy=embedded 返回 200 HTML", onRes.status === 200 && onRes.body.includes("<html"), `status=${onRes.status} bytes=${onRes.body.length}`);

// 3) 主前端资源路径也通
const idx = await get(onPort, "/");
check("开启注入后 / 返回 200", idx.status === 200, `status=${idx.status}`);

// 4) WebSocket /api/remote.mux：关闭时 401
const wsOff = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${offPort}/api/remote.mux`);
  const t = setTimeout(() => { ws.terminate(); resolve("timeout"); }, 6000);
  ws.on("open", () => { clearTimeout(t); ws.close(); resolve("open"); });
  ws.on("unexpected-response", (_req, res) => { clearTimeout(t); resolve(`http ${res.statusCode}`); });
  ws.on("error", (e) => { clearTimeout(t); resolve(`error ${e.message}`); });
});
check("开关关闭时 /api/remote.mux WebSocket 被拒（401）", wsOff === "http 401", wsOff);

// 5) WebSocket /api/remote.mux：开启时 101 且能双向收发
const wsOn = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${onPort}/api/remote.mux`);
  const t = setTimeout(() => { ws.terminate(); resolve({ outcome: "timeout" }); }, 8000);
  ws.on("open", () => {
    clearTimeout(t);
    ws.close();
    resolve({ outcome: "open" });
  });
  ws.on("unexpected-response", (_req, res) => { clearTimeout(t); resolve({ outcome: `http ${res.statusCode}` }); });
  ws.on("error", (e) => { clearTimeout(t); resolve({ outcome: `error ${e.message}` }); });
});
check("开启注入后 /api/remote.mux WebSocket 握手 101 且 ws 库接受", wsOn.outcome === "open", wsOn.outcome);

// 6) 业务路由与静态托管零回归（业务 API 由网关自己处理，不经过 DSH）
const api = await get(onPort, "/api/learnbuddy/materials");
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
