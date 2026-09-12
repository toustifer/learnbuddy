import http from "node:http";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("本地教学服务需要 Node.js 24 或更新版本。");
const envFile = fileURLToPath(new URL(".env.local", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const dataDir = fileURLToPath(new URL(".dsh-preview/teaching-data/", import.meta.url));
await mkdir(dataDir, { recursive: true });
const { DatabaseStore } = await import("../src/db/store.js");
const { StorageService } = await import("../src/services/storage.js");
const { registerLearnBuddyRoutes } = await import("../src/routes/api.js");
const store = new DatabaseStore({ path: dataDir + "/learnbuddy.sqlite" });
const storage = new StorageService({ uploadDir: dataDir + "/uploads" });
const middlewares = [];
registerLearnBuddyRoutes({ webServer: { use: (handler) => middlewares.push(handler) } }, { store, storage });
const server = http.createServer(async (req, res) => {
  try {
    for (const middleware of middlewares) {
      let nextCalled = false;
      await middleware(req, res, () => { nextCalled = true; });
      if (!nextCalled || res.headersSent || res.writableEnded) return;
    }
    res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "接口不存在。" }));
  } catch {
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "教学服务暂时无法完成请求。" }));
  }
});
const port = Number(process.env.LEARNBUDDY_LOCAL_API_PORT || 3091);
server.listen(port, "127.0.0.1", () => console.log(`本机教学服务已启动：127.0.0.1:${port}（独立教学样例库）`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => { store.close(); process.exit(0); }));
