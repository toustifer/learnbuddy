import { fileURLToPath, pathToFileURL } from "node:url";
import { registerTeachingRoutes } from "../plugins/dsh-plugin-learnbuddy/src/routes/teaching.js";
import { registerSpeechRoutes } from "../plugins/dsh-plugin-learnbuddy/src/routes/speech.js";

// Add this release's routes to the existing gateway without copying its backend or data.
export function attachReleaseRoutes(gateway) {
  const extra = [];
  const server = { use: (handler) => extra.push(handler) };
  const readJson = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) throw Object.assign(new Error("请求内容过大。"), { status: 413 });
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
    catch { throw Object.assign(new Error("请求格式不正确。"), { status: 400 }); }
  };
  const sendJson = (res, status, data) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  };
  registerTeachingRoutes(server, { store: gateway.store, readJson, sendJson });
  registerSpeechRoutes(server, { sendJson });
  gateway.middlewares.unshift(...extra);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (!process.env.LEARNBUDDY_BASE_GATEWAY) throw new Error("LEARNBUDDY_BASE_GATEWAY must point to the existing server.js");
  process.env.LEARNBUDDY_WEB_DIST ||= fileURLToPath(new URL("../plugins/dsh-plugin-learnbuddy/web/dist/", import.meta.url));
  // The original module exposes its server but also starts it unless TEST is set.
  const previousTest = process.env.TEST;
  process.env.TEST = "1";
  let gateway;
  try { gateway = await import(pathToFileURL(process.env.LEARNBUDDY_BASE_GATEWAY).href); }
  finally {
    if (previousTest === undefined) delete process.env.TEST;
    else process.env.TEST = previousTest;
  }
  attachReleaseRoutes(gateway);
  const port = Number(process.env.PORT || 3088);
  gateway.server.listen(port, process.env.LEARNBUDDY_BIND_HOST || "0.0.0.0", () => {
    console.log(`LearnBuddy release ready on port ${port}; existing gateway and data retained.`);
  });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
    gateway.server.close(() => { gateway.store.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
