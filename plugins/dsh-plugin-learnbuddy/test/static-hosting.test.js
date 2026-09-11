/**
 * LearnBuddy 前端静态托管 (src/routes/static-hosting.js) 测试
 *
 * 全部使用真实 node:http Server + 真实临时目录（不 mock fs/http），验证：
 * - /learnbuddy/ 与 /learnbuddy/index.html
 * - /learnbuddy/assets/*.js|.css|.png 的 MIME 与内容一致性
 * - /learnbuddy/assets/ 缺失文件必须 404 且 body 不是 HTML（禁止 SPA 回落污染 JS）
 * - SPA fallback：任意前端路由回落 index.html 200
 * - 路径穿越防护（明文与 URL 编码变体）
 * - 托管目录缺失时安全降级（404 + 告警 + 不影响 API）
 * - HEAD 请求、Cache-Control 条件缓存
 * - server.js 集成回归：/api/learnbuddy/* 业务路由 + 未命中请求反向代理
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  registerStaticHosting,
  resolveWebDistDir,
  getWebMimeType,
  DEFAULT_WEB_DIST_DIR,
  ASSETS_CACHE_CONTROL,
  INDEX_CACHE_CONTROL
} from "../src/routes/static-hosting.js";

const INDEX_MARKER = "LEARNBUDDY_INDEX_MARKER_0x5F3A";
const INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><title>LearnBuddy</title></head>
  <body><div id="root">${INDEX_MARKER}</div><script src="/learnbuddy/assets/index-abc123.js"></script></body>
</html>
`;
const JS_CONTENT = `console.log("${INDEX_MARKER}-js");export const answer=42;\n`;
const CSS_CONTENT = `.learnbuddy-root{color:#0af}\n`;
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

/** 造一个真实的前端发布目录 */
function makeDistDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learnbuddy-web-dist-"));
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), INDEX_HTML, "utf-8");
  fs.writeFileSync(path.join(dir, "assets", "index-abc123.js"), JS_CONTENT, "utf-8");
  fs.writeFileSync(path.join(dir, "assets", "index-abc123.css"), CSS_CONTENT, "utf-8");
  fs.writeFileSync(path.join(dir, "assets", "logo.png"), PNG_BYTES);
  return dir;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * 用原始 path 发请求（避免 URL 规范化吞掉 ../ 变体），返回 status/headers/body
 */
function rawRequest(port, rawPath, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: rawPath, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            raw,
            body: raw.toString("utf-8")
          });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 复刻 server.js 的中间件驱动循环，构造一个只含静态托管（+可选假业务路由）的真实服务 */
function createHarness({ webDistDir, warn } = {}) {
  const middlewares = [];
  const warnings = [];
  const ctx = { webServer: { use: (fn) => middlewares.push(fn) } };

  const resolvedRoot = registerStaticHosting(ctx, {
    webDistDir,
    warn: warn || ((msg) => warnings.push(String(msg)))
  });

  // 模拟业务路由：只接管 /api/learnbuddy/*
  ctx.webServer.use(async (req, res, next) => {
    const p = (req.url || "").split("?")[0];
    if (p.startsWith("/api/learnbuddy")) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, via: "fake-api", path: p }));
      return;
    }
    if (next) next();
  });

  const server = http.createServer(async (req, res) => {
    for (const mw of middlewares) {
      let nextCalled = false;
      await mw(req, res, () => { nextCalled = true; });
      if (!nextCalled && (res.writableEnded || res.headersSent)) return;
    }
    if (!res.writableEnded && !res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("NO_MIDDLEWARE_HANDLED");
    }
  });

  return { server, warnings, resolvedRoot };
}

// ---------------------------------------------------------------------------
// 静态托管主链路
// ---------------------------------------------------------------------------

let distDir;
let harness;

before(async () => {
  distDir = makeDistDir();
  harness = createHarness({ webDistDir: distDir });
  await listen(harness.server);
});

after(async () => {
  await close(harness.server);
  fs.rmSync(distDir, { recursive: true, force: true });
});

const port = () => harness.server.address().port;

test("托管根目录解析优先级：options > LEARNBUDDY_WEB_DIST > 默认 web/dist", () => {
  const prev = process.env.LEARNBUDDY_WEB_DIST;
  try {
    delete process.env.LEARNBUDDY_WEB_DIST;
    assert.equal(resolveWebDistDir({}), DEFAULT_WEB_DIST_DIR);
    assert.match(DEFAULT_WEB_DIST_DIR, /web[\\/]dist$/);

    process.env.LEARNBUDDY_WEB_DIST = path.join(os.tmpdir(), "env-dist");
    assert.equal(resolveWebDistDir({}), path.resolve(path.join(os.tmpdir(), "env-dist")));
    assert.equal(
      resolveWebDistDir({ webDistDir: path.join(os.tmpdir(), "opt-dist") }),
      path.resolve(path.join(os.tmpdir(), "opt-dist"))
    );
  } finally {
    if (prev === undefined) delete process.env.LEARNBUDDY_WEB_DIST;
    else process.env.LEARNBUDDY_WEB_DIST = prev;
  }
});

test("MIME 判定：js/css/png/svg/woff2 各自正确", () => {
  assert.equal(getWebMimeType("index-abc.js"), "application/javascript; charset=utf-8");
  assert.equal(getWebMimeType("index-abc.css"), "text/css; charset=utf-8");
  assert.equal(getWebMimeType("logo.png"), "image/png");
  assert.equal(getWebMimeType("icon.svg"), "image/svg+xml");
  assert.equal(getWebMimeType("font.woff2"), "font/woff2");
  assert.equal(getWebMimeType("index.html"), "text/html; charset=utf-8");
  assert.equal(getWebMimeType("mystery.bin"), "application/octet-stream");
});

test("GET /learnbuddy/ 返回 index.html (200 + text/html)", async () => {
  const res = await rawRequest(port(), "/learnbuddy/");
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
  assert.match(res.body, new RegExp(INDEX_MARKER));
  assert.equal(res.headers["cache-control"], INDEX_CACHE_CONTROL);
});

test("GET /learnbuddy/index.html 与裸 /learnbuddy 同样返回首页", async () => {
  for (const p of ["/learnbuddy/index.html", "/learnbuddy"]) {
    const res = await rawRequest(port(), p);
    assert.equal(res.status, 200, `${p} 应为 200`);
    assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
    assert.match(res.body, new RegExp(INDEX_MARKER));
  }
});

test("GET /learnbuddy/assets/<hash>.js 返回 200 + application/javascript 且内容与磁盘一致", async () => {
  const res = await rawRequest(port(), "/learnbuddy/assets/index-abc123.js");
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "application/javascript; charset=utf-8");
  assert.equal(res.body, JS_CONTENT);
  assert.equal(res.body, fs.readFileSync(path.join(distDir, "assets", "index-abc123.js"), "utf-8"));
  assert.equal(res.headers["cache-control"], ASSETS_CACHE_CONTROL);
  assert.equal(Number(res.headers["content-length"]), Buffer.byteLength(JS_CONTENT));
});

test("带缓存打散 query 的资源 URL（?v=hash）仍能正确命中", async () => {
  const res = await rawRequest(port(), "/learnbuddy/assets/index-abc123.js?v=9f2c1a");
  assert.equal(res.status, 200);
  assert.equal(res.body, JS_CONTENT);

  const html = await rawRequest(port(), "/learnbuddy/?from=qr");
  assert.equal(html.status, 200);
  assert.match(html.body, new RegExp(INDEX_MARKER));
});

test("GET /learnbuddy/assets/<hash>.css 返回 200 + text/css", async () => {
  const res = await rawRequest(port(), "/learnbuddy/assets/index-abc123.css");
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/css; charset=utf-8");
  assert.equal(res.body, CSS_CONTENT);
});

test("GET /learnbuddy/assets/logo.png 返回 200 + image/png 且字节一致", async () => {
  const res = await rawRequest(port(), "/learnbuddy/assets/logo.png");
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "image/png");
  assert.ok(res.raw.equals(PNG_BYTES));
});

test("GET /learnbuddy/assets/not-exist.js 必须 404 且 body 不是 HTML", async () => {
  const res = await rawRequest(port(), "/learnbuddy/assets/not-exist.js");
  assert.equal(res.status, 404);
  assert.match(res.headers["content-type"], /text\/plain/);
  assert.ok(!/<html|<script|<!doctype/i.test(res.body), `缺失 assets 不得回落 HTML，实际: ${res.body}`);
  assert.ok(!res.body.includes(INDEX_MARKER));
});

test("GET /learnbuddy/assets/ 下深层缺失文件同样 404，不回落", async () => {
  const res = await rawRequest(port(), "/learnbuddy/assets/chunks/vendor-xyz.js");
  assert.equal(res.status, 404);
  assert.ok(!/<html/i.test(res.body));
});

test("SPA fallback：/learnbuddy/library 与深层前端路由回落 index.html 200", async () => {
  for (const p of ["/learnbuddy/library", "/learnbuddy/assignments/xxx", "/learnbuddy/some/deep/route"]) {
    const res = await rawRequest(port(), p);
    assert.equal(res.status, 200, `${p} 应回落 200`);
    assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
    assert.match(res.body, new RegExp(INDEX_MARKER));
    assert.equal(res.headers["cache-control"], INDEX_CACHE_CONTROL);
  }
});

test("路径穿越防护：明文 ../ 变体一律 404", async () => {
  for (const p of [
    "/learnbuddy/../../etc/passwd",
    "/learnbuddy/assets/../../../../etc/passwd",
    "/learnbuddy/../server.js"
  ]) {
    const res = await rawRequest(port(), p);
    assert.equal(res.status, 404, `${p} 必须 404`);
    assert.ok(!res.body.includes("root:"), "不得泄露 /etc/passwd 内容");
  }
});

test("路径穿越防护：URL 编码 %2e%2e / %2f / %5c 变体一律 404", async () => {
  for (const p of [
    "/learnbuddy/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "/learnbuddy/%2e%2e/%2e%2e/etc/passwd",
    "/learnbuddy/..%5c..%5cwindows%5csystem32",
    "/learnbuddy/%252e%252e%252fetc%252fpasswd",
    "/learnbuddy/assets/%2e%2e%2f%2e%2e%2fserver.js"
  ]) {
    const res = await rawRequest(port(), p);
    assert.equal(res.status, 404, `${p} 必须 404`);
  }
});

test("HEAD /learnbuddy/assets/*.js 返回 200 且无 body", async () => {
  const res = await rawRequest(port(), "/learnbuddy/assets/index-abc123.js", { method: "HEAD" });
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "application/javascript; charset=utf-8");
  assert.equal(Number(res.headers["content-length"]), Buffer.byteLength(JS_CONTENT));
  assert.equal(res.body, "");
});

test("HEAD /learnbuddy/ 返回 200 且无 body", async () => {
  const res = await rawRequest(port(), "/learnbuddy/", { method: "HEAD" });
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(Number(res.headers["content-length"]), Buffer.byteLength(INDEX_HTML));
  assert.equal(res.body, "");
});

test("HEAD 缺失 assets 返回 404 且无 body", async () => {
  const res = await rawRequest(port(), "/learnbuddy/assets/not-exist.js", { method: "HEAD" });
  assert.equal(res.status, 404);
  assert.equal(res.body, "");
});

test("/api/learnbuddy/* 不被静态托管拦截，仍交给业务路由", async () => {
  const res = await rawRequest(port(), "/api/learnbuddy/materials");
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
  const json = JSON.parse(res.body);
  assert.equal(json.ok, true);
  assert.equal(json.via, "fake-api");
});

test("非 /learnbuddy 路径完全透传（交给后续反向代理）", async () => {
  const res = await rawRequest(port(), "/some/other/path");
  assert.equal(res.status, 500);
  assert.equal(res.body, "NO_MIDDLEWARE_HANDLED");
});

test("托管目录不存在时：404 + 告警 + 服务不崩溃且 API 不受影响", async () => {
  const missingDir = path.join(os.tmpdir(), `learnbuddy-missing-${Date.now()}-${process.pid}`);
  assert.ok(!fs.existsSync(missingDir));

  const local = createHarness({ webDistDir: missingDir });
  await listen(local.server);
  try {
    const port2 = local.server.address().port;

    const res = await rawRequest(port2, "/learnbuddy/");
    assert.equal(res.status, 404);
    assert.match(res.headers["content-type"], /text\/plain/);
    assert.ok(!/<html/i.test(res.body));

    const assetRes = await rawRequest(port2, "/learnbuddy/assets/index-abc123.js");
    assert.equal(assetRes.status, 404);

    assert.ok(local.warnings.length >= 1, "应记录托管目录缺失告警");
    assert.match(local.warnings[0], /托管目录不存在/);

    // 服务未崩溃，业务 API 照常
    const api = await rawRequest(port2, "/api/learnbuddy/materials");
    assert.equal(api.status, 200);
    assert.equal(JSON.parse(api.body).ok, true);
  } finally {
    await close(local.server);
  }
});

test("缺失 assets 请求不会因目录缺失而变成 HTML 回落", async () => {
  const missingDir = path.join(os.tmpdir(), `learnbuddy-missing2-${Date.now()}-${process.pid}`);
  const local = createHarness({ webDistDir: missingDir });
  await listen(local.server);
  try {
    const res = await rawRequest(local.server.address().port, "/learnbuddy/assets/app.js");
    assert.equal(res.status, 404);
    assert.ok(!/<html/i.test(res.body));
  } finally {
    await close(local.server);
  }
});

// ---------------------------------------------------------------------------
// server.js 真实集成：静态托管挂载 + 业务 API 回归 + 反向代理回归
// ---------------------------------------------------------------------------

test("server.js 集成：/learnbuddy/ 静态托管 + /api/learnbuddy/* 回归 + 未命中请求反向代理", async () => {
  // 造一个假 DSH 后端，验证未命中 /learnbuddy/ 的请求仍走反向代理
  const dshStub = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`DSH_STUB:${req.url}`);
  });
  const dshPort = await listen(dshStub);

  const prevDist = process.env.LEARNBUDDY_WEB_DIST;
  const prevDsh = process.env.DSH_PORT;
  const prevDb = process.env.LEARNBUDDY_DB_PATH;
  const tmpDb = path.join(os.tmpdir(), `learnbuddy-test-${Date.now()}-${process.pid}.db`);

  process.env.LEARNBUDDY_WEB_DIST = distDir;
  process.env.DSH_PORT = String(dshPort);
  process.env.LEARNBUDDY_DB_PATH = tmpDb;

  let mod;
  try {
    mod = await import("../server.js");
    assert.equal(mod.webDistDir, path.resolve(distDir), "server.js 应按 LEARNBUDDY_WEB_DIST 解析托管根目录");

    await listen(mod.server);
    const gwPort = mod.server.address().port;

    // 1) 公网前端入口
    const home = await rawRequest(gwPort, "/learnbuddy/");
    assert.equal(home.status, 200);
    assert.equal(home.headers["content-type"], "text/html; charset=utf-8");
    assert.match(home.body, new RegExp(INDEX_MARKER));

    // 2) 前端静态资源
    const asset = await rawRequest(gwPort, "/learnbuddy/assets/index-abc123.js");
    assert.equal(asset.status, 200);
    assert.equal(asset.headers["content-type"], "application/javascript; charset=utf-8");
    assert.equal(asset.body, JS_CONTENT);

    // 3) SPA 深链
    const spa = await rawRequest(gwPort, "/learnbuddy/assignments/xxx");
    assert.equal(spa.status, 200);
    assert.match(spa.body, new RegExp(INDEX_MARKER));

    // 4) 缺失 assets 必须 404，不能回落 HTML
    const missingAsset = await rawRequest(gwPort, "/learnbuddy/assets/not-exist.js");
    assert.equal(missingAsset.status, 404);
    assert.ok(!/<html/i.test(missingAsset.body));

    // 5) 业务 API 回归
    const materials = await rawRequest(gwPort, "/api/learnbuddy/materials");
    assert.equal(materials.status, 200);
    assert.equal(materials.headers["content-type"], "application/json; charset=utf-8");
    const materialsJson = JSON.parse(materials.body);
    assert.equal(materialsJson.ok, true);
    assert.ok(Array.isArray(materialsJson.materials));

    const loginBody = JSON.stringify({ username: "user", password: "123" });
    const login = await rawRequest(gwPort, "/api/learnbuddy/auth/login", {
      method: "POST",
      body: loginBody,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(loginBody) }
    });
    assert.equal(login.status, 200);
    assert.equal(JSON.parse(login.body).ok, true);

    // 6) 未命中 /learnbuddy/ 的请求仍反向代理给 DSH
    const proxied = await rawRequest(gwPort, "/dsh/whatever?x=1");
    assert.equal(proxied.status, 200);
    assert.equal(proxied.body, "DSH_STUB:/dsh/whatever?x=1");

    const proxiedRoot = await rawRequest(gwPort, "/");
    assert.equal(proxiedRoot.status, 200);
    assert.equal(proxiedRoot.body, "DSH_STUB:/");
  } finally {
    if (mod?.server?.listening) await close(mod.server);
    await close(dshStub);
    // DatabaseStore 仍持有 SQLite 句柄，删除失败可忽略（临时目录由系统回收）
    try {
      fs.rmSync(tmpDb, { force: true });
    } catch {
      /* EBUSY: 连接未关闭 */
    }
    if (prevDist === undefined) delete process.env.LEARNBUDDY_WEB_DIST; else process.env.LEARNBUDDY_WEB_DIST = prevDist;
    if (prevDsh === undefined) delete process.env.DSH_PORT; else process.env.DSH_PORT = prevDsh;
    if (prevDb === undefined) delete process.env.LEARNBUDDY_DB_PATH; else process.env.LEARNBUDDY_DB_PATH = prevDb;
  }
});
