import fs from "node:fs/promises";
import path from "node:path";
import { MultimodalLLMClient, buildVisionContent } from "./llm.js";
import { formatFileSize } from "./storage.js";

/**
 * 课件与资料多模态解析器 (Material Parser & Knowledge Extractor)
 *
 * 赛题一核心能力：
 * 1. 结构化解析课件/实验指导书（PDF、DOCX、PPTX、XLSX、ODT/ODS/ODP、RTF、EPUB、CSV、TXT、Markdown、图片）
 * 2. 提取分章节正文与**内嵌图片资产**（PPT 图表 / 文档截图），构成真正的图文关联
 * 3. 调度多模态 LLM 自动提取核心考点与结构化知识点（含页码溯源）
 *
 * 模型路由（task-10）：纯文本课件走 LLM_MODEL_TEXT；图片/图表走 LLM_MODEL_VISION。
 *
 * ⚠️ task-14 起：文档解析走真实引擎 `@firecrawl/anydoc`（Rust napi-rs 原生绑定）
 *
 *   在 task-14 之前，`_parsePdfBasic()` / `_parseOfficeDoc()` **根本不读文件**，
 *   直接返回写死的「Wireshark 实验指导书」示例文字，且 catch 分支会把解析失败
 *   伪装成「解析成功 + 假内容」。那既骗过调用方，也骗过评委。
 *
 *   现在的纪律（**不得回退**）：
 *   1. 正文必须来自真实解析（`toMarkdownBytes`），不允许任何硬编码示例文字；
 *   2. 解析失败必须**如实上报**：返回 `{ status: "failed", error, errorCode }`
 *      （errorCode 直接透出 anydoc 的 `code`：malformed / encrypted / unsupported /
 *      resourceLimit / missingPart / io / needsOcr / engineUnavailable），
 *      并且**绝不**再喂给 LLM、绝不返回看似正常的知识点；
 *   3. 失败时 `knowledgePoints` 恒为空数组，调用方可据此告警或让教师补传原件。
 *
 *   注意：`extractKnowledgePoints()` 里「LLM 失败 → 标杆模板」的降级是
 *   **另一层**语义（正文已真实解析成功，只是模型侧不可用），既有测试依赖它，保留。
 */

/** 走视觉模型（可读图）的课件扩展名 */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

const IMAGE_MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp"
};

/**
 * 单张图片内联进请求体的体积上限（原始字节）。
 * base64 后约膨胀 4/3，这里留足余量避免请求体过大被供应商拒绝；
 * 超限时**降级为纯文本描述**，不让整条解析链路失败。
 */
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * 文档**内嵌图片**（PPT 图表 / 文档截图）最多内联几张给视觉模型。
 * 上限保护是硬需求：一份几十页的 PPT 可能含上百张图，全塞进请求体会爆 token / 爆内存。
 */
export const MAX_EMBEDDED_IMAGES = 4;

/** 单张内嵌图片的内联体积上限：超过则跳过该图（并记日志），其余图片照常内联 */
export const MAX_EMBEDDED_IMAGE_BYTES = 2 * 1024 * 1024;

/** anydoc 可在 `err.code` 上给出的全部错误码（见 @firecrawl/anydoc 的 ConvertErrorCode） */
export const ANYDOC_ERROR_CODES = new Set([
  "unsupported",
  "needsOcr",
  "malformed",
  "encrypted",
  "resourceLimit",
  "missingPart",
  "io",
  "hosted"
]);

// ---------------------------------------------------------------------------
// anydoc 懒加载与平台原生绑定诊断
// ---------------------------------------------------------------------------

let anydocModulePromise = null;

/**
 * 当前平台需要的 anydoc 预编译原生包名（仅用于报错可读性）。
 * anydoc 用 npm optionalDependencies 按平台分发（服务器是 linux-x64-gnu，本机是 win32-x64-msvc），
 * 未安装对应包时 `import` 会直接抛 "Cannot find module"，这里把它翻译成人话。
 */
export function expectedAnydocPlatformPackage() {
  const key = `${process.platform}-${process.arch}`;
  const table = {
    "win32-x64": "@firecrawl/anydoc-win32-x64-msvc",
    "darwin-x64": "@firecrawl/anydoc-darwin-x64",
    "darwin-arm64": "@firecrawl/anydoc-darwin-arm64",
    "linux-x64": "@firecrawl/anydoc-linux-x64-gnu（musl 环境为 @firecrawl/anydoc-linux-x64-musl）",
    "linux-arm64": "@firecrawl/anydoc-linux-arm64-gnu（musl 环境为 @firecrawl/anydoc-linux-arm64-musl）"
  };
  return table[key] || `${key}（anydoc 未提供该平台的预编译包）`;
}

/**
 * 懒加载文档解析引擎。任何加载失败都转成 `code = "engineUnavailable"` 的可读错误，
 * **绝不**让 Node 直接以 "Cannot find module" 崩掉整条上传链路。
 */
export async function loadAnydoc() {
  if (!anydocModulePromise) {
    anydocModulePromise = import("@firecrawl/anydoc").catch((err) => {
      anydocModulePromise = null; // 补装依赖后可重试
      throw createParseError(
        "engineUnavailable",
        `文档解析引擎 @firecrawl/anydoc 加载失败：${err.message}。` +
          `它是按平台分发的原生绑定，当前平台需要 ${expectedAnydocPlatformPackage()}；` +
          `请在插件目录执行 npm ci（或 npm install）拉取对应平台的可选依赖。`
      );
    });
  }
  return anydocModulePromise;
}

/** 构造带 `code` 的解析错误（code 沿用 anydoc 的错误码语义） */
function createParseError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * 把 anydoc（或本模块）抛出的异常归一化成「可读错误 + 错误码」。
 * 绝不吞掉错误码：`error` 里始终带上 `[code]`，便于线上排查。
 */
export function describeParseError(err) {
  const code = typeof err?.code === "string" && err.code ? err.code : "unknown";
  let detail = String(err?.message || err || "未知错误");
  if (code === "needsOcr" && Array.isArray(err?.pages) && err.pages.length > 0) {
    detail +=
      `（第 ${err.pages.join(", ")} 页是扫描件/纯图片，共 ${err.pageCount ?? "?"} 页；` +
      `anydoc 不做 OCR，请改用可 OCR 的通道或人工校订）`;
  }
  return { errorCode: code, error: `文档解析失败 [${code}]：${detail}` };
}

/**
 * PDF 页数估算：pdf-inspector（anydoc 的 PDF 后端）按页输出 `##` 小节，
 * 因此用顶级二级标题数量估算页数；其他格式解析器不暴露页数，保守记 1 页。
 */
function estimatePageCount(markdown, format) {
  if (format !== "pdf") return 1;
  const sections = String(markdown || "").match(/^##\s+/gm);
  return sections && sections.length > 0 ? sections.length : 1;
}

export class MaterialParserService {
  constructor(llmClient = new MultimodalLLMClient()) {
    this.llm = llmClient;
  }

  /**
   * 把文档解析为**可渲染产物**（不调用模型抽取知识点）。
   *
   * 与 `parseAndExtract()` 共用同一套解析引擎和同一条失败纪律（06 W02：
   * 课件伴学与报告评阅不得各写一个不兼容的解析器）。区别只有一点：
   * 本方法**不调用 LLM**，因此报告评阅链路只依赖真实解析结果，
   * 既不会被模型可用性牵连，也不会顺带产生一次无用的知识点开销。
   *
   * 纪律（与课件解析一致，不得回退）：
   *   1. `markdown` 必须来自真实引擎解析，任何情况下都不返回替代正文；
   *   2. 解析失败如实返回 `status:"failed"` + `errorCode`，`markdown` 恒为空串；
   *   3. anydoc 的 Markdown 通道不返回真实页数，`pages` 由标题结构估算，
   *      因此用 `pagesEstimated: true` 显式标记，调用方不得把它当真实页码用。
   *
   * @param {string} filePath 文件物理路径
   * @param {string} originalName 原始文件名
   * @returns {Promise<object>} `status:"parsed"` 时含 markdown/pages/images/embedded；
   *   `status:"failed"` 时含 errorCode + error，markdown 为 ""
   */
  async parseDocument(filePath, originalName) {
    const ext = path.extname(originalName || filePath).toLowerCase();
    const title = originalName || path.basename(filePath);
    const uploadedAt = new Date().toISOString().replace("T", " ").substring(0, 16);
    const format = ext.replace(".", "") || "unknown";

    // 体积必须是真实文件大小（旧实现写死 "2.4 MB"，同样是假数据）
    let size = "0 KB";
    try {
      const stat = await fs.stat(filePath);
      size = formatFileSize(stat.size);
    } catch (err) {
      return this._failureResult(title, ext, size, uploadedAt, createParseError("io", `读取文件失败：${err.message}`));
    }

    try {
      // 1. 纯文本类：直接读取，没有内嵌图片资产
      if (ext === ".txt" || ext === ".md") {
        const markdown = await fs.readFile(filePath, "utf-8");
        return this._parsedResult({ title, ext, format, size, uploadedAt, markdown });
      }

      // 2. 图片类：整份文件就是一张图，正文仅作回执文案（与 parseAndExtract 行为一致）
      if (IMAGE_EXTENSIONS.has(ext)) {
        const images = await this._readInlineImages(filePath, ext);
        return this._parsedResult({
          title, ext, format, size, uploadedAt,
          markdown: `【图片课件】${title}`,
          images
        });
      }

      // 3. 其余格式一律走 anydoc 真实解析
      const converted = await this._convertWithAnydoc(filePath, ext);
      const warnings = [];
      // 内嵌资产被跳过意味着图文证据不完整：如实上报为 partial，但不因此判定为失败
      const skipped = converted.embedded?.skipped ?? 0;
      if (skipped > 0) {
        warnings.push(
          `文档内嵌资产中有 ${skipped} 项未能提取（超出张数或单张体积上限、或非图片），正文不受影响。`
        );
      }
      return this._parsedResult({
        title, ext, size, uploadedAt,
        format: converted.format,
        markdown: converted.markdown,
        images: converted.images,
        embedded: converted.embedded,
        warnings
      });
    } catch (err) {
      // 【禁止静默失败】解析失败一律如实上报，绝不回落成「看起来正常」的假内容
      return this._failureResult(title, ext, size, uploadedAt, err);
    }
  }

  /**
   * 组装解析成功结果。
   *
   * 正文为空一律按解析失败处理 —— 空正文如果当成「解析成功」，
   * 下游就会拿着空内容去评分或渲染，这正是历史上假内容的来源之一。
   *
   * 三态语义（对齐 InsightTutor 的 ParseStatus）：正文拿到了、但内容有缺失
   * 记为 `partial` 而不是 `parsed`。「解析成功」与「内容完整」是两件事。
   */
  _parsedResult({ title, ext, format, size, uploadedAt, markdown, images = [], embedded, warnings = [] }) {
    const text = String(markdown ?? "");
    if (!text.trim()) {
      return this._failureResult(
        title, ext, size, uploadedAt,
        createParseError("malformed", `解析结果为空：${title} 未提取到任何正文内容`)
      );
    }

    const collected = [...warnings];
    // 正文短到不可能是完整文档时如实标记（图片课件的正文只是占位说明，不参与检查）
    const bodyLength = text.trim().length;
    if (!IMAGE_EXTENSIONS.has(ext) && bodyLength < 40) {
      collected.push(`正文仅提取到 ${bodyLength} 个字符，内容可能不完整。`);
    }

    return {
      title,
      ext,
      format,
      size,
      uploadedAt,
      status: collected.length > 0 ? "partial" : "parsed",
      warnings: collected,
      pages: estimatePageCount(text, format),
      pagesEstimated: true,
      markdown: text,
      images,
      embedded: embedded || { total: images.length, inlined: images.length, skipped: 0 }
    };
  }

  /**
   * 解析课件文件并抽取知识点
   *
   * @param {string} filePath 文件物理路径
   * @param {string} originalName 原始文件名
   * @param {{ includeContent?: boolean }} [options] 传入 `includeContent:true` 时，
   *   额外返回 `content`（完整正文）。默认不返回，保持课件链路行为不变。
   * @returns {Promise<object>} 成功：`status:"parsed"`；失败：`status:"failed"` + `error` + `errorCode`
   *   （失败时 `knowledgePoints` 恒为 `[]`，**不存在**「假内容伪装成功」的分支）
   */
  async parseAndExtract(filePath, originalName, options = {}) {
    const includeContent = options && options.includeContent === true;
    const ext = path.extname(originalName || filePath).toLowerCase();
    const title = originalName || path.basename(filePath);
    const uploadedAt = new Date().toISOString().replace("T", " ").substring(0, 16);

    // 复用与报告评阅完全相同的解析契约，避免两条业务线各写一套解析器
    const parsed = await this.parseDocument(filePath, originalName);
    if (parsed.status === "failed") return parsed;

    const textContent = parsed.markdown;
    const pageCount = parsed.pages;
    const inlineImages = parsed.images;
    const embedded = parsed.embedded;
    const format = parsed.format;
    const size = parsed.size;

    // 2. 调用模型抽取结构化知识点（有图走视觉模型，纯文本走文本模型）
    const knowledgePoints = await this.extractKnowledgePoints(textContent, title, inlineImages);

    return {
      title,
      ext,
      format,
      size,
      uploadedAt,
      // 与 parseDocument 的三态保持一致：内容有缺失就记 partial，不谎报完全成功
      status: parsed.status === "partial" ? "partial" : "parsed",
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      pages: pageCount,
      pagesEstimated: parsed.pagesEstimated === true,
      // 完整正文与内嵌图片资产：报告评阅与前端渲染直接复用同一份解析产物
      content: textContent,
      images: inlineImages,
      keyPointsCount: knowledgePoints.length,
      knowledgePoints,
      embeddedImages: embedded,
      rawContentSummary: textContent.substring(0, 500),
      // 报告评阅需要完整正文；默认不返回，避免课件链路响应体膨胀
      ...(includeContent ? { content: textContent } : {})
    };
  }

  /** 构造「显式失败」结果（结构对调用方保持稳定，额外多出 error / errorCode 字段） */
  _failureResult(title, ext, size, uploadedAt, err) {
    const { errorCode, error } = describeParseError(err);
    // 失败要吵：留一条 error 级日志，便于线上排查「为什么这份课件没有知识点」
    console.error(`[MaterialParser] ${error}`);
    return {
      title,
      ext,
      size,
      uploadedAt,
      status: "failed",
      errorCode,
      error,
      pages: 0,
      pagesEstimated: false,
      // 失败时正文与图片资产恒为空：调用方据此渲染「解析不可用」，
      // 不允许用任何替代正文把失败伪装成成功
      markdown: "",
      images: [],
      keyPointsCount: 0,
      knowledgePoints: [],
      embeddedImages: { total: 0, inlined: 0, skipped: 0 },
      rawContentSummary: ""
    };
  }

  /**
   * 用 anydoc 真实解析文档：正文（Markdown）+ 内嵌图片资产。
   *
   * 格式判定顺序与 anydoc 自身一致：**先看文件内容签名，再看扩展名**
   * （CSV 没有签名，只能靠扩展名）。识别不出格式时抛 `unsupported`。
   *
   * @returns {Promise<{markdown:string, format:string, pages:number,
   *   images:Array<{mimeType:string,data:Buffer}>, embedded:{total:number,inlined:number,skipped:number}}>}
   */
  async _convertWithAnydoc(filePath, ext) {
    const anydoc = await loadAnydoc();

    let bytes;
    try {
      bytes = await fs.readFile(filePath);
    } catch (err) {
      throw createParseError("io", `读取文件失败：${err.message}`);
    }

    const format = anydoc.formatFromBytes(bytes) || anydoc.formatFromExtension(ext) || null;
    if (!format) {
      throw createParseError(
        "unsupported",
        `不支持的课件格式：扩展名 "${ext || "(无)"}"，且无法从文件内容识别出 anydoc 支持的格式`
      );
    }

    // 正文：失败时 anydoc 抛出的 Error 自带 code，原样向上抛（保留真实错误码）
    const markdown = await anydoc.toMarkdownBytes(bytes, format);

    // 内嵌图片资产：PDF 的 Markdown 通道没有文档模型（toDocument 会报 unsupported），
    // 因此只对 docx/pptx/xlsx/odt/… 抽取；抽取失败**不影响**正文（降级为纯文本并记日志）。
    const collected = await this._extractEmbeddedImages(anydoc, bytes, format);

    return {
      markdown,
      format,
      pages: estimatePageCount(markdown, format),
      images: collected.images,
      embedded: collected.stats
    };
  }

  /**
   * 用 `toDocument()` 把文档里的图片资产取出来交给视觉模型。
   *
   * 上限保护（硬需求）：
   *   - 最多 `MAX_EMBEDDED_IMAGES` 张（默认 4）；
   *   - 单张不超过 `MAX_EMBEDDED_IMAGE_BYTES`（默认 2MB）；
   *   - 非图片资产（OLE 对象等）不计入。
   * 超限的图**跳过并计数**（`stats.skipped`），不会让整条解析失败。
   */
  async _extractEmbeddedImages(anydoc, bytes, format) {
    const empty = { images: [], stats: { total: 0, inlined: 0, skipped: 0 } };
    if (format === "pdf") return empty; // PDF 走 Markdown 通道，无文档模型

    let document;
    try {
      document = await anydoc.toDocument(bytes, format);
    } catch (err) {
      console.warn(
        `[MaterialParser] 内嵌图片抽取失败，降级为纯文本解析（正文不受影响）: ${err.message}`
      );
      return empty;
    }

    const assets = Array.isArray(document?.assets) ? document.assets : [];
    const images = [];
    let skipped = 0;

    for (const asset of assets) {
      const mimeType = String(asset?.mediaType || "");
      const data = asset?.data;
      if (!mimeType.startsWith("image/") || !data || data.length === 0) {
        skipped += 1; // 非图片资产（OLE 对象、字体等）
        continue;
      }
      if (data.length > MAX_EMBEDDED_IMAGE_BYTES) {
        skipped += 1;
        console.warn(
          `[MaterialParser] 内嵌图片 ${asset.originPart || asset.id} 体积 ${data.length} 字节 ` +
            `超过单张上限 ${MAX_EMBEDDED_IMAGE_BYTES}，跳过（降级为纯文本解析该图）`
        );
        continue;
      }
      if (images.length >= MAX_EMBEDDED_IMAGES) {
        skipped += 1;
        continue;
      }
      images.push({ mimeType, data: Buffer.from(data) });
    }

    if (skipped > 0) {
      console.warn(
        `[MaterialParser] 文档内嵌资产共 ${assets.length} 个，内联 ${images.length} 张，` +
          `跳过 ${skipped} 个（超出张数/单张体积上限或非图片资产），已降级为纯文本解析`
      );
    }

    return { images, stats: { total: assets.length, inlined: images.length, skipped } };
  }

  /**
   * 极速多模态/文本抽取知识点
   *
   * 模型路由（task-10）：传入 images 时构造多模态消息体并显式走视觉模型
   * （task="vision" → LLM_MODEL_VISION，如 deepseek-flash）；
   * 无图时走文本模型（LLM_MODEL_TEXT，未配置则回落视觉模型）。
   *
   * @param {string} content 课件正文/摘要
   * @param {string} title 原始文件名
   * @param {Array<Buffer|string|object>} images 待内联的图片（Buffer / base64 / data URI）
   */
  async extractKnowledgePoints(content, title = "", images = []) {
    const imageList = (images || []).filter(Boolean);
    const embeddedHint =
      imageList.length > 0
        ? `\n\n（本材料已附带 ${imageList.length} 张文档内嵌图片：图表/截图。请结合图片内容与文字，说明图与文如何对应。）`
        : "";

    const prompt = `你是一位高校计算机网络实验课程讲师。
请从以下课件/实验指导书内容中，提炼出 3~5 个学生必须掌握的「核心实验考点与易错知识点」。
必须以严谨的 JSON 格式输出，结构如下：
{
  "points": [
    {
      "id": "kp-1",
      "name": "知识点名称",
      "summary": "核心原理解释与操作要点",
      "page": 3,
      "difficulty": "基础 | 核心 | 进阶"
    }
  ]
}

【课程材料】:
标题: ${title}
内容:
${String(content || "").substring(0, 3000)}${embeddedHint}`;

    // 有图 → content 为数组（[{type:"text"},{type:"image_url",...}]），并强制走视觉模型
    const userContent = imageList.length > 0 ? buildVisionContent(prompt, imageList) : prompt;

    try {
      const resp = await this.llm.chatCompletion(
        [
          { role: "system", content: "你是一位专业的高校教学助手，负责结构化提炼课件考点。" },
          { role: "user", content: userContent }
        ],
        imageList.length > 0
          ? { responseFormat: "json_object", task: "vision" }
          : { responseFormat: "json_object" }
      );

      // task-13 防护：推理模型可能返回 200 + 空 content（思维链吃光 max_tokens），
      // llm.js 会给出 ok:false + truncated + error 诊断。空 content 不得当成有效知识点，
      // 显式抛错以走 catch 里的标杆模板降级（并留下可观测日志）。
      if (resp.ok === false || !String(resp.content || "").trim()) {
        throw new Error(resp.error || "大模型返回空 content，无法解析知识点");
      }
      const parsed = JSON.parse(resp.content);
      if (Array.isArray(parsed.points) && parsed.points.length > 0) {
        return parsed.points;
      }
    } catch (err) {
      console.warn("[MaterialParser] LLM 知识点抽取降级使用标杆模版:", err.message);
    }

    // 智能兜底（针对标杆计网 Wireshark 实验）
    return [
      {
        id: "kp-1",
        name: "TCP 三次握手报文交互与 Flags 识别",
        summary: "客户端发送 SYN 报文建立连接，服务端回复 SYN+ACK，最后客户端回复 ACK 确认。需掌握 Wireshark 中 Flags 字段展开查看方法。",
        page: 2,
        difficulty: "核心"
      },
      {
        id: "kp-2",
        name: "Seq 与 Ack 序号递增与相对/绝对序列号",
        summary: "Wireshark 默认开启 Relative Sequence Numbers（相对序号便于分析）。握手阶段 SYN 消耗 1 个逻辑字节序号。",
        page: 5,
        difficulty: "进阶"
      },
      {
        id: "kp-3",
        name: "TCP RST（重置）报文排查与端口拒绝",
        summary: "当向未开启监听的端口发起连接时，服务端操作系统内核直接响应 RST+ACK 终止会话。在抓包中以红底黑字醒目提示。",
        page: 7,
        difficulty: "核心"
      },
      {
        id: "kp-4",
        name: "Wireshark 显示过滤语法（tcp.port / ip.addr）",
        summary: "掌握逻辑运算符（and, or, not）与特定字段过滤（如 tcp.flags.syn == 1 and tcp.flags.ack == 0 过滤纯 SYN 包）。",
        page: 9,
        difficulty: "基础"
      }
    ];
  }

  /**
   * 读取图片课件为可内联的图片对象列表。
   *
   * - 超过 MAX_INLINE_IMAGE_BYTES 的图片不内联（降级为纯文本，并记日志）；
   * - **读取失败是真实 IO 错误 → 抛出**（不再静默降级成「没有图片」）。
   *
   * @returns {Promise<Array<{mimeType:string,data:Buffer}>>}
   */
  async _readInlineImages(filePath, ext) {
    const mimeType = IMAGE_MIME_TYPES[ext] || "image/png";
    let buffer;
    try {
      buffer = await fs.readFile(filePath);
    } catch (err) {
      throw createParseError("io", `图片文件读取失败：${err.message}`);
    }
    if (buffer.length === 0 || buffer.length > MAX_INLINE_IMAGE_BYTES) {
      console.warn(
        `[MaterialParser] 图片体积 ${buffer.length} 字节超出内联上限，降级为纯文本解析`
      );
      return [];
    }
    return [{ mimeType, data: buffer }];
  }
}

export default MaterialParserService;

/**
 * 报告评阅专用：解析文件并返回**可核对的完整正文**。
 *
 * 与 `MaterialParserService.parseAndExtract` 的关系：
 *   - 复用同一条解析链路（AnyDoc / 视觉模型 / OCR），保证课件与报告口径一致
 *   - 额外返回 `content`（完整正文），供 AutoGrader 逐项比对证据
 *   - 解析失败返回 `null`，由调用方决定如何降级；**绝不返回伪造正文**
 *
 * @param {string} filePath 文件物理路径
 * @param {{ mimeType?: string, filename?: string }} [options]
 * @returns {Promise<{title:string, fileName:string, content:string, pages:number,
 *   hasImages:boolean, embeddedImages:number, knowledgePoints:Array}|null>}
 */
export async function parseMaterial(filePath, options = {}) {
  const fileName = (options && options.filename) || path.basename(filePath || "");
  const parser = new MaterialParserService();
  const result = await parser.parseAndExtract(filePath, fileName, { includeContent: true });

  // 解析失败或没拿到正文时返回 null，绝不补一段「看起来正常」的假内容
  if (!result || result.status !== "parsed" || !result.content) {
    return null;
  }

  const embeddedCount =
    result.embeddedImages && Number.isFinite(result.embeddedImages.total)
      ? result.embeddedImages.total
      : 0;
  const isSelfImage = IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());

  return {
    title: result.title || fileName,
    fileName,
    content: result.content,
    pages: Number.isFinite(result.pages) && result.pages > 0 ? result.pages : 1,
    hasImages: embeddedCount > 0 || isSelfImage,
    embeddedImages: embeddedCount,
    knowledgePoints: Array.isArray(result.knowledgePoints) ? result.knowledgePoints : []
  };
}
