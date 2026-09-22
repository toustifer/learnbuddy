/**
 * 文档 → PDF 预览转换
 *
 * ## 为什么需要
 *
 * 教师复核报告时应当看到**学生交的那份原件本身**，而不是我们把正文切好重新排过的文本
 * （版式、表格、图表位置都在原件里，重排会丢）。PDF / 图片浏览器能直接渲染，
 * **但 Word 这类格式不行** —— 浏览器只会下载或显示一片空白。
 *
 * 另外，报告页数此前只能**按段落结构估算**（`pagesEstimated: true`），
 * 而"第几页"是教师核对证据时真正会用的坐标。转成 PDF 之后就能拿到**真实页数**。
 *
 * ## 做法
 *
 * 用 LibreOffice 的**无头模式**转 PDF，产物按 blobId 缓存到独立目录，
 * 同一个文件只转一次。转换是**尽力而为**：失败不让调用方崩，
 * 只如实返回失败原因 —— 拿不到预览就退回"打开原件"，不糊一个空白框。
 *
 * ## 已知取舍
 *
 * - 转换要起一个 soffice 进程，**首次约 1~3 秒**（缓存后为 0）
 * - 页数从 PDF 里数 `/Type /Page` 与 `/Count` 取较大值；对极少见的
 *   全压缩对象流 PDF 可能低估 —— 所以只在**真的转成功**时才敢标 `pagesEstimated: false`
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";

/** 浏览器能直接内嵌渲染的格式 —— 这些不需要转换 */
export const INLINE_PREVIEWABLE = /\.(pdf|png|jpe?g|gif|webp|bmp|svg)$/i;

/** 能交给 LibreOffice 转的格式 */
const CONVERTIBLE = new Set([
  "doc", "docx", "odt", "rtf", "txt",
  "ppt", "pptx", "odp",
  "xls", "xlsx", "ods", "csv"
]);

const DEFAULT_TIMEOUT_MS = 90_000;

/** 取小写扩展名（不带点） */
export function extensionOf(name) {
  const m = String(name || "").match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "";
}

/** 这份文件浏览器能不能直接内嵌渲染 */
export const isInlinePreviewable = (name) => INLINE_PREVIEWABLE.test(String(name || ""));

/** 这份文件能不能转成 PDF */
export const isConvertible = (name) => CONVERTIBLE.has(extensionOf(name));

/**
 * 预览缓存目录。
 * **故意放在 uploads 之外** —— uploads 是内容寻址的原件库，
 * 往里塞派生产物会干扰 blobId 的解析与备份口径。
 */
export function previewDir(uploadDir, override) {
  return override || process.env.LEARNBUDDY_PREVIEW_DIR || path.resolve(uploadDir, "..", "previews");
}

/** 某个 blob 的缓存 PDF 路径 */
export function previewPathFor(uploadDir, blobId, override) {
  const safe = String(blobId).replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(previewDir(uploadDir, override), `${safe}.preview.pdf`);
}

/**
 * 数一份 PDF 的真实页数。
 *
 * 取 `/Type /Page` 出现次数与 `/Count N` 的**较大值**：
 * 前者在页对象未压缩时准确，后者来自页树；两者都读到就更稳。
 * 读不出来返回 null —— **不猜**。
 */
export function countPdfPages(pdfPath) {
  try {
    const buf = fs.readFileSync(pdfPath);
    const byType = (buf.toString("latin1").match(/\/Type\s*\/Page(?![s])/g) || []).length;
    const counts = [...buf.toString("latin1").matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
    const byCount = counts.length ? Math.max(...counts) : 0;
    const pages = Math.max(byType, byCount);
    return pages > 0 ? pages : null;
  } catch {
    return null;
  }
}

/** job 级隔离的 soffice profile，避免并发转换互相踩 */
function uniqueProfileDir() {
  return path.join(os.tmpdir(), `lo-profile-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

function runSoffice(sourcePath, outDir, { sofficeBin, timeoutMs }) {
  return new Promise((resolve) => {
    const profile = uniqueProfileDir();
    const args = [
      `-env:UserInstallation=file://${profile}`,
      "--headless",
      "--norestore",
      "--nolockcheck",
      "--nodefault",
      "--convert-to", "pdf",
      "--outdir", outDir,
      sourcePath
    ];
    execFile(sofficeBin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      // profile 是一次性的，用完删掉
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 无所谓 */ }
      if (err) {
        resolve({ ok: false, error: `${err.message}${stderr ? ` | ${String(stderr).slice(0, 200)}` : ""}` });
        return;
      }
      resolve({ ok: true, stdout: String(stdout || "") });
    });
  });
}

/**
 * 确保某份文件有一份可内嵌的 PDF 预览（必要时转换，转换结果按 blobId 缓存）。
 *
 * @param {object} options
 * @param {string} options.blobId       原件标识（同时用作缓存键）
 * @param {string} options.sourcePath   原件绝对路径
 * @param {string} options.uploadDir    原件目录（用于定位缓存目录）
 * @param {string} [options.previewDirOverride]
 * @param {string} [options.sofficeBin] 默认 `soffice`
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ok:boolean, pdfPath?:string, cached?:boolean, pages?:number|null, error?:string}>}
 */
export async function ensurePdfPreview({
  blobId,
  sourcePath,
  uploadDir,
  previewDirOverride,
  sofficeBin = process.env.LEARNBUDDY_SOFFICE_BIN || "soffice",
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  if (!blobId || !sourcePath) return { ok: false, error: "缺少 blobId 或原件路径" };
  if (!fs.existsSync(sourcePath)) return { ok: false, error: "原件不存在" };

  const target = previewPathFor(uploadDir, blobId, previewDirOverride);

  // 命中缓存：连同页数一起复用
  if (fs.existsSync(target)) {
    return { ok: true, pdfPath: target, cached: true, pages: countPdfPages(target) };
  }

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "lb-preview-"));
  try {
    const run = await runSoffice(sourcePath, outDir, { sofficeBin, timeoutMs });
    if (!run.ok) return { ok: false, error: run.error || "转换失败" };

    // soffice 按源文件名产出 <base>.pdf
    const base = path.basename(sourcePath).replace(/\.[^.]+$/, "");
    const produced = path.join(outDir, `${base}.pdf`);
    if (!fs.existsSync(produced)) return { ok: false, error: "转换未产出 PDF" };

    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 先写临时再改名的原子落盘：避免并发时读到半截文件
    const tmp = `${target}.${process.pid}.tmp`;
    fs.copyFileSync(produced, tmp);
    fs.renameSync(tmp, target);

    return { ok: true, pdfPath: target, cached: false, pages: countPdfPages(target) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* 无所谓 */ }
  }
}
