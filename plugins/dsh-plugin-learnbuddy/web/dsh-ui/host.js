import { readFile } from "node:fs/promises";

// DSH discovers the browser module through this package's dsh.client manifest.
// Only the built workbench is served here; business routes and agent policy stay owned by the backend.
export const name = "learnbuddy-ui";
export const inject = ["webServer"];

export function apply(ctx) {
  if (process.env.LEARNBUDDY_PREVIEW_WORKSPACE) {
    ctx.on("webserver/index-inject", (rows) =>
      rows.push({
        kind: "global",
        name: "__LEARNBUDDY_UI__",
        value: { previewWorkspace: process.env.LEARNBUDDY_PREVIEW_WORKSPACE },
      }),
    );
  }
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: "/learnbuddy",
        handler: async (req, res) => {
          if (!["GET", "HEAD"].includes(req.method)) {
            res.writeHead(405, { Allow: "GET, HEAD" });
            res.end();
            return;
          }
          const pathname = new URL(req.url, "http://localhost").pathname;
          const file =
            pathname === "/learnbuddy" || pathname === "/learnbuddy/"
              ? "index.html"
              : pathname.slice("/learnbuddy/".length);
          // Serve only the explicit Vite outputs, never arbitrary project files or fallback HTML for assets.
          if (
            file !== "index.html" &&
            !/^assets\/[A-Za-z0-9_-]+\.(js|css)$/.test(file)
          ) {
            res.writeHead(404);
            res.end();
            return;
          }
          try {
            const body = await readFile(
              new URL(`../dist/${file}`, import.meta.url),
            );
            const contentType = file.endsWith(".js")
              ? "text/javascript"
              : file.endsWith(".css")
                ? "text/css"
                : "text/html";
            res.writeHead(200, {
              "Content-Type": `${contentType}; charset=utf-8`,
              "Content-Length": body.byteLength,
              "X-Content-Type-Options": "nosniff",
              "Cache-Control":
                file === "index.html"
                  ? "no-cache"
                  : "public, max-age=31536000, immutable",
            });
            res.end(req.method === "HEAD" ? undefined : body);
          } catch {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(
              req.method === "HEAD"
                ? undefined
                : "LearnBuddy 页面尚未构建，请先运行 npm run build。",
            );
          }
        },
      }),
    "learnbuddy: static workbench",
  );
  ctx.effect(
    () =>
      ctx.webServer.tapIndex((html) =>
        html.replace(
          /<title>[^<]*<\/title>/,
          "<title>LearnBuddy · DSH 学习助手</title>",
        ),
      ),
    "learnbuddy: page title",
  );
}
