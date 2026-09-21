/**
 * 契约层：证据引用 `EvidenceRefV1`
 *
 * 依据《契约层规范》的「溯源契约」：
 *   - **MUST**：凡"结论"必挂证据引用（知识点、答案卡、检查结果、建议分、评语一律如此）
 *   - **MUST**：证据指向**文档版本 + 原文定位**（页 / 幻灯片 / 标题路径 / 单元格范围 / 资产）
 *   - **MUST NOT**：解析失败时用"另一份材料的证据"或"看起来正常的内容"顶替
 *
 * 为什么必须有这个结构（规范原文）：
 *   **指不回去的结论，对人没说服力，对 Agent 更不能被引用。**
 *   现在的固定描述兜底就是反例 —— 没有溯源契约，假内容无法被识别为假。
 *
 * ## 两条硬规则
 *
 * 1. **不猜位置**：拿不到页码/工作表就留 `null`，**绝不估计**。
 *    编一个页码比留空更糟 —— 留空调用方知道"没有定位"，编页码会让它以为定位到了。
 *
 * 2. **版本用内容哈希**：`documentVersionId` 取原件的内容哈希（`blobId`）。
 *    它是**内容寻址**的，所以天然满足「原件不可变、更新产生新版本、旧版本仍可追溯」——
 *    内容变了哈希就变，旧引用自然指向旧内容。
 *    ⚠️ 尚未引入独立的 `document_versions` 表，因此没有单调递增的 `revision` 号。
 *    将来加版本表时**只需要改 `deriveDocumentVersionId` 一处**，其余调用点不动。
 */

import { createHash } from "node:crypto";

/** 证据种类。`kind` 决定 `locator` 里哪些字段才有意义。 */
export const EVIDENCE_KINDS = Object.freeze([
  "text", // 正文段落
  "figure", // 图表、示意图
  "image", // 截图、照片
  "table", // 表格
  "code", // 代码块
  "asset" // 其它内嵌资产（附件、音视频等）
]);

/**
 * 由材料/提交推导「文档版本标识」。
 *
 * 用内容哈希而不是自增号：内容寻址天然保证不可变 —— 内容变了标识就变，
 * 于是**旧证据永远指向旧内容**，不会因为覆盖上传而指错。
 *
 * @param {{blobId?: string}|null} source 带 blobId 的对象（material 或 submission）
 * @returns {string|null} 没有原件时返回 null，**不编造**
 */
export function deriveDocumentVersionId(source) {
  const blobId = source && typeof source.blobId === "string" ? source.blobId.trim() : "";
  return blobId || null;
}

/**
 * 构造 `locator`：**只放真实存在的定位信息**。
 *
 * 不同文档类型有不同定位方式（见规范与《03》第 4 节）：
 * PDF/PPTX → 页或幻灯片序号；DOCX → 标题路径；表格 → 工作表与范围。
 * **拿不到就留 null，不用估计值填充。**
 *
 * @param {object} [input]
 * @param {number|null} [input.page] 页码（PDF/PPTX）
 * @param {number|null} [input.slide] 幻灯片序号
 * @param {string[]|null} [input.headingPath] DOCX 标题路径
 * @param {string|null} [input.sheet] 工作表名
 * @param {string|null} [input.range] 单元格范围，如 A1:C12
 * @param {string|null} [input.figure] 图号，如「图 1」
 * @param {object|null} [input.bbox] 必须同时说明参照页、单位与渲染尺寸，否则视为不可用
 * @returns {object}
 */
export function buildLocator(input = {}) {
  const asPage = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const asText = (value) => {
    const s = typeof value === "string" ? value.trim() : "";
    return s || null;
  };

  const headingPath = Array.isArray(input.headingPath)
    ? input.headingPath.map((s) => String(s).trim()).filter(Boolean)
    : [];

  // bbox 只在「参照页 + 单位 + 渲染尺寸」都齐全时才可用（规范对 bbox 的要求）
  const bbox =
    input.bbox && typeof input.bbox === "object" && asPage(input.bbox.page) && asText(input.bbox.unit) && input.bbox.renderSize
      ? {
          page: asPage(input.bbox.page),
          unit: asText(input.bbox.unit),
          renderSize: input.bbox.renderSize,
          x: Number(input.bbox.x) || 0,
          y: Number(input.bbox.y) || 0,
          width: Number(input.bbox.width) || 0,
          height: Number(input.bbox.height) || 0
        }
      : null;

  return {
    // 注意：这里**没有** `page: input.page || 1` 这类兜底 —— 不认识就留 null
    page: asPage(input.page),
    slide: asPage(input.slide),
    headingPath: headingPath.length ? headingPath : null,
    sheet: asText(input.sheet),
    range: asText(input.range),
    figure: asText(input.figure),
    bbox
  };
}

/** 短哈希，用于生成稳定 ID。 */
function shortHash(seed) {
  return createHash("sha256").update(String(seed)).digest("hex").slice(0, 12);
}

/**
 * 构造一条证据引用。
 *
 * **`id` 是确定性生成的**（同样的定位 → 同样的 id），不是随机的：
 * 引用要能跨请求稳定比对，随机 id 会让"同一条证据"每次看起来都不同。
 *
 * @param {object} input
 * @param {string|null} input.documentVersionId 文档版本（内容哈希）
 * @param {string|null} [input.blockId] 块标识（段落/图/表格的稳定 id）
 * @param {string} [input.kind] 证据种类，见 EVIDENCE_KINDS
 * @param {object} [input.locator] 定位信息，见 buildLocator
 * @param {string|null} [input.quote] 原文摘录（必须是原文，不是概述）
 * @param {string|null} [input.assetId] 内嵌资产 id
 * @returns {object} EvidenceRefV1
 */
export function createEvidenceRef(input = {}) {
  const kind = EVIDENCE_KINDS.includes(input.kind) ? input.kind : "text";
  const documentVersionId = input.documentVersionId || null;
  const blockId = input.blockId || null;
  const assetId = input.assetId || null;
  const locator = buildLocator(input.locator || {});
  const quote = typeof input.quote === "string" && input.quote.trim() ? input.quote.trim() : null;

  return {
    // 稳定 ID：定位相同的证据，id 相同
    id: `ev_${shortHash(
      [documentVersionId, blockId, assetId, kind, locator.page, locator.figure, locator.sheet, locator.range, quote]
        .map((v) => (v === null || v === undefined ? "" : String(v)))
        .join("|")
    )}`,
    documentVersionId,
    blockId,
    kind,
    locator,
    quote,
    assetId
  };
}

/**
 * 判断一条证据引用「是否真的能指回原文」。
 *
 * 判据：必须有文档版本 **且** 至少有一种定位方式（页/幻灯片/标题路径/工作表/资产）。
 * 只有 `quote` 不算 —— 摘录可能被改写，页号才是可核对的锚点。
 *
 * 这个函数是给**调用方与 CI 用的**：新增"结论类"输出时应当断言它成立。
 *
 * @param {object|null} ref
 * @returns {boolean}
 */
export function isTraceable(ref) {
  if (!ref || typeof ref !== "object") return false;
  if (!ref.documentVersionId) return false;
  const locator = ref.locator || {};
  return Boolean(
    locator.page ||
      locator.slide ||
      (Array.isArray(locator.headingPath) && locator.headingPath.length) ||
      locator.sheet ||
      locator.figure ||
      ref.assetId ||
      ref.blockId
  );
}

/** 过滤出真正可溯源的引用，并去重（同 id 只留一条）。 */
export function collectEvidenceRefs(refs) {
  if (!Array.isArray(refs)) return [];
  const seen = new Set();
  const out = [];
  for (const ref of refs) {
    if (!isTraceable(ref)) continue;
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    out.push(ref);
  }
  return out;
}

/**
 * 从课件上下文（`/materials/:id/context` 的 `sections`）生成证据引用。
 *
 * 每个段落一条 `text` 证据、每张图一条 `figure` 证据 —— 这样伴学回答里的
 * "根据第 N 页…" 才能被核对；而**没有页码的段落不会得到页码**。
 *
 * @param {{sections?: object[]}|null} context
 * @param {string|null} documentVersionId
 * @returns {object[]}
 */
export function evidenceRefsFromMaterialContext(context, documentVersionId) {
  const sections = context && Array.isArray(context.sections) ? context.sections : [];
  const refs = [];

  for (const section of sections) {
    refs.push(
      createEvidenceRef({
        documentVersionId,
        blockId: section.page ? `page-${section.page}` : null,
        kind: "text",
        locator: { page: section.page },
        // 摘录必须是原文：这里截取正文，不做概括
        quote: typeof section.content === "string" ? section.content.slice(0, 120) : null
      })
    );

    for (const diagram of Array.isArray(section.diagrams) ? section.diagrams : []) {
      refs.push(
        createEvidenceRef({
          documentVersionId,
          blockId: diagram.id || null,
          kind: "figure",
          locator: { page: diagram.page, figure: diagram.caption || diagram.title },
          quote: diagram.caption || diagram.title || null,
          assetId: diagram.imageUrl ? diagram.id : null
        })
      );
    }
  }

  return collectEvidenceRefs(refs);
}

/**
 * 从一条评分项生成证据引用。
 *
 * 建议分是对**学生报告**的结论，所以 `documentVersionId` 应当传**报告的版本**
 * （提交的 blobId），而不是课件的 —— 规范明确禁止"证据取自本次未读取的输入"。
 *
 * @param {{evidence?: string, page?: number|null, rubricId?: string}} grade
 * @param {string|null} documentVersionId 被评阅文档（报告）的版本
 * @returns {object|null}
 */
export function evidenceRefFromGrade(grade, documentVersionId) {
  if (!grade || typeof grade !== "object") return null;
  const quote = typeof grade.evidence === "string" ? grade.evidence.trim() : "";
  const ref = createEvidenceRef({
    documentVersionId,
    blockId: grade.rubricId ? `grade-${grade.rubricId}` : null,
    kind: "text",
    locator: { page: grade.page },
    quote: quote || null
  });
  // 连摘录都没有的评分项，不生成"看起来有证据"的引用
  return isTraceable(ref) && (quote || ref.locator.page) ? ref : null;
}

/**
 * 给一份提交里的评分项补 `evidenceRefs`。
 *
 * 采用「**有才加、没有就不加**」而不是统一加空数组：
 * 评分为空（未发布、或还没评）时加一个空数组只会制造噪声，
 * 而响应级信封里的 `evidenceRefs` 始终存在，已经提供了稳定的取用位置。
 *
 * @param {object|null} submission
 * @returns {object|null}
 */
export function withSubmissionEvidenceRefs(submission) {
  if (!submission || typeof submission !== "object") return submission;
  const grades = Array.isArray(submission.grades) ? submission.grades : [];
  if (!grades.length) return submission;

  const documentVersionId = deriveDocumentVersionId(submission);
  let changed = false;
  const enriched = grades.map((grade) => {
    // 已经有了就不重复推导（幂等）
    if (Array.isArray(grade.evidenceRefs)) return grade;
    const ref = evidenceRefFromGrade(grade, documentVersionId);
    if (!ref) return grade;
    changed = true;
    return { ...grade, evidenceRefs: [ref] };
  });

  return changed ? { ...submission, grades: enriched } : submission;
}

/** 批量版本。 */
export function withSubmissionsEvidenceRefs(submissions) {
  if (!Array.isArray(submissions)) return [];
  return submissions.map(withSubmissionEvidenceRefs);
}

/** 把一批提交里所有评分项的证据引用汇总起来（响应级 `evidenceRefs` 用）。 */
export function collectFromSubmissions(submissions) {
  if (!Array.isArray(submissions)) return [];
  const refs = [];
  for (const submission of submissions) {
    for (const grade of Array.isArray(submission?.grades) ? submission.grades : []) {
      if (Array.isArray(grade.evidenceRefs)) refs.push(...grade.evidenceRefs);
    }
  }
  return collectEvidenceRefs(refs);
}
