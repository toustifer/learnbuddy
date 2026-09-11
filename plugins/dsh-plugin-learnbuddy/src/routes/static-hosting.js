/**
 * LearnBuddy 前端静态资源托管路由
 *
 * 背景：
 *   公网网关 http://<host>:3088/learnbuddy/ 之前只挂了 /api/learnbuddy/* 业务接口，
 *   前端产物（index.html + assets/index-*.js|css）没有对应的静态托管，导致 404。
 *
 * 关键设计：
 * 1. 托管根目录可配置：options.webDistDir > process.env.LEARNBUDDY_WEB_DIST > 默认 web/dist。
 *    前端 dist 产物不入 git（web/ 目录为空是预期情况），因此绝不能硬编码或去构建前端。
 * 2. 只接管 /learnbuddy/*，显式排除 /api/learnbuddy/*，保证业务路由优先命中。
 * 3. SPA fallback：/learnbuddy/ 下任意前端路由回落 index.html；
 *    但 /learnbuddy/assets/ 下的缺失文件必须 404（绝不能回落成 HTML，否则浏览器会把
 *    HTML 当成 JS 执行并抛 MIME 错误）。
 * 4. 路径穿越防护：../、..\、%2e%2e、%2f、%5c 等编码变体一律拒绝，
 *    并且解析后的绝对路径必须仍在托管根目录内（双重校验）。
 * 5. 托管目录不存在时安全降级：404 + console.warn，服务不崩溃、不影响 API。
 * 6. 支持 HEAD、以及 Cache-Control（assets 长缓存 / index.html no-cache）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 前端 URL 命名空间前缀 */
export const LEARNBUDDY_WEB_PREFIX = "/learnbuddy";

/** 业务 API 前缀：静态托管必须让路 */
export const LEARNBUDDY_API_PREFIX = "/api/learnbuddy";

/** assets 目录下的静态资源走长缓存；缺失文件不回落 */
export const ASSETS_PREFIX = "/assets/";

/**
 * 前端 Web 产物 MIME 判定表
 * （参考 src/services/storage.js 的 getMimeType 写法，但覆盖 web 场景所需类型）
 */
export const WEB_MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".cjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf"
};

/** assets 命中的静态资源使用不可变长缓存 */
export const ASSETS_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** index.html（含 SPA 回落）必须每次协商，避免发版后用户拿到旧壳 */
export const INDEX_CACHE_CONTROL = "no-cache";

/**
 * 根据文件路径/扩展名判定前端资源 MIME
 * @param {string} filenameOrExt 文件名或扩展名
 * @returns {string}
 */
export function getWebMimeType(filenameOrExt) {
  if (!filenameOrExt) return "application/octet-stream";
  const ext = (path.extname(filenameOrExt) || filenameOrExt).toLowerCase();
  return WEB_MIME_TYPES[ext] || "application/octet-stream";
}

/**
 * 默认托管根目录：plugins/dsh-plugin-learnbuddy/web/dist
 * 前端产物由发布流程单独投放（不在 git 内），可用 LEARNBUDDY_WEB_DIST 覆盖。
 */
export const DEFAULT_WEB_DIST_DIR = path.resolve(__dirname, "../../web/dist");

/**
 * 解析最终生效的托管根目录（绝对路径）
 * 优先级：options.webDistDir > process.env.LEARNBUDDY_WEB_DIST > 默认约定路径
 * @param {object} [options]
 * @returns {string}
 */
export function resolveWebDistDir(options = {}) {
  const configured = options.webDistDir || process.env.LEARNBUDDY_WEB_DIST || DEFAULT_WEB_DIST_DIR;
  return path.resolve(configured);
}

/** 判断路径是否落在 /learnbuddy 命名空间内（含裸 /learnbuddy） */
function isUnderLearnBuddy(p) {
  return p === LEARNBUDDY_WEB_PREFIX || p.startsWith(`${LEARNBUDDY_WEB_PREFIX}/`);
}

/** 安全 stat：任何异常都视为“不存在” */
function safeStat(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

/** 统一的 404 响应（纯文本，绝不返回 HTML，避免污染 SPA / JS 加载） */
function sendNotFound(res, message = "Not Found") {
  const body = String(message);
  res.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

/**
 * 注册 LearnBuddy 前端静态托管中间件
 *
 * @param {object} ctx 宿主上下文（需提供 ctx.webServer.use）
 * @param {object} [options]
 * @param {string} [options.webDistDir] 显式指定托管根目录（最高优先级）
 * @param {(msg: string) => void} [options.warn] 自定义告警输出（默认 console.warn）
 * @returns {string|undefined} 实际生效的托管根目录绝对路径
 */
export function registerStaticHosting(ctx, options = {}) {
  if (!ctx || !ctx.webServer || typeof ctx.webServer.use !== "function") {
    return undefined;
  }

  const webDistDir = resolveWebDistDir(options);
  const warn = typeof options.warn === "function" ? options.warn : console.warn.bind(console);
  const indexPath = path.join(webDistDir, "index.html");

  // 托管目录缺失时只告警一次，避免每个请求刷屏
  let missingRootWarned = false;

  ctx.webServer.use(async (req, res, next) => {
    const rawUrl = req.url || "/";
    const rawPath = rawUrl.split("?")[0].split("#")[0];

    // 1) 业务 API 显式让路：/api/learnbuddy/* 必须交给 registerLearnBuddyRoutes
    if (rawPath === LEARNBUDDY_API_PREFIX || rawPath.startsWith(`${LEARNBUDDY_API_PREFIX}/`)) {
      if (next) next();
      return;
    }

    // 2) 解码路径（用于识别 %2e%2e / %2f / %5c 等编码穿越变体）
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      if (isUnderLearnBuddy(rawPath)) {
        return sendNotFound(res, "Bad Request: 非法路径编码");
      }
      if (next) next();
      return;
    }

    // 3) 只接管 /learnbuddy 命名空间，其余请求原样透传给反向代理
    if (!isUnderLearnBuddy(rawPath) && !isUnderLearnBuddy(decodedPath)) {
      if (next) next();
      return;
    }

    // 4) 静态托管只处理 GET / HEAD，其它方法保持既有语义
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (next) next();
      return;
    }

    // 5) 路径穿越防护：任何 .. / ..\ / %2e%2e / %2f / %5c 变体一律拒绝
    if (
      decodedPath.includes("\0") ||
      decodedPath.includes("..") ||
      decodedPath.includes("\\") ||
      decodedPath.includes("%2e") ||
      decodedPath.includes("%2f") ||
      decodedPath.includes("%5c")
    ) {
      return sendNotFound(res, "Not Found");
    }

    // 6) 相对路径归一化：/learnbuddy -> "/"，/learnbuddy/x -> "/x"
    let relPath = decodedPath.slice(LEARNBUDDY_WEB_PREFIX.length);
    if (!relPath) relPath = "/";
    if (!relPath.startsWith("/")) {
      return sendNotFound(res, "Not Found");
    }

    const isAssetRequest = relPath === "/assets" || relPath.startsWith(ASSETS_PREFIX);

    // 7) 托管目录缺失：404 降级 + 告警，服务与 API 不受影响
    const rootStat = safeStat(webDistDir);
    if (!rootStat || !rootStat.isDirectory()) {
      if (!missingRootWarned) {
        missingRootWarned = true;
        warn(
          `[LearnBuddy StaticHosting] 前端托管目录不存在或不可读: ${webDistDir}。` +
          "请发布前端产物到该目录，或通过 LEARNBUDDY_WEB_DIST 指定实际发布目录。"
        );
      }
      return sendNotFound(res, "Not Found: 前端产物尚未发布");
    }

    // 8) 解析目标文件并做根目录包含校验（第二道穿越防线）
    let targetPath = relPath === "/" ? indexPath : path.join(webDistDir, relPath);
    const rootResolved = path.resolve(webDistDir);
    const resolved = path.resolve(targetPath);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      return sendNotFound(res, "Not Found");
    }

    let stat = safeStat(resolved);
    let filePath = resolved;
    let isIndex = resolved === path.resolve(indexPath);

    if (!stat || !stat.isFile()) {
      // 8.1 /learnbuddy/assets/** 缺失必须 404，绝不回落 HTML
      if (isAssetRequest) {
        return sendNotFound(res, `Not Found: ${relPath}`);
      }

      // 8.2 SPA fallback：前端路由一律回落 index.html
      const indexStat = safeStat(indexPath);
      if (!indexStat || !indexStat.isFile()) {
        return sendNotFound(res, "Not Found: index.html 缺失");
      }
      filePath = indexPath;
      stat = indexStat;
      isIndex = true;
    }

    // 9) 输出：MIME + 条件缓存 + HEAD 支持
    res.writeHead(200, {
      "Content-Type": getWebMimeType(filePath),
      "Content-Length": stat.size,
      "Cache-Control": isIndex ? INDEX_CACHE_CONTROL : ASSETS_CACHE_CONTROL,
      "Access-Control-Allow-Origin": "*"
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    await new Promise((resolve) => {
      const stream = fs.createReadStream(filePath);
      stream.on("error", () => {
        if (!res.writableEnded) res.destroy();
        resolve();
      });
      res.on("finish", resolve);
      res.on("close", resolve);
      res.on("error", resolve);
      stream.pipe(res);
    });
  });

  return webDistDir;
}

export default registerStaticHosting;
