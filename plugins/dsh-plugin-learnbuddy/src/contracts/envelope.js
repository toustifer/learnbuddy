/**
 * 契约层：统一返回体与错误码
 *
 * 依据《Agent 友好 / MCP 友好 契约层规范》的「访问契约」：
 *   1. 统一返回体含 `schemaVersion` / `data` / `evidenceRefs` / `warnings` / `asOf` / `nextCursor`
 *   2. 失败使用约定错误码（不是自由文本）
 *   3. 降级与未读范围写进 `warnings`，显式暴露
 *   4. **不得**用「成功返回空数组」掩盖拒绝访问
 *
 * 为什么错误码如此重要（规范原文）：
 *   错误码不是文案，是**给 Agent 的分支决策表**。Agent 看到 `MODEL_UNAVAILABLE`
 *   就知道「该稍后重试，不要编答案」；看到自由文本则只能放弃或乱猜。
 *
 * 兼容策略（已确认的决策 #5「保留旧字段兼容层」）：
 *   `ok` 与既有的扁平字段**全部保留**，只是**新增**信封字段。
 *   这样前端与既有测试不需要同步迁移，UI 迁移可以单独排期。
 */

/** 信封版本号。信封字段形状变化时递增。 */
export const SCHEMA_VERSION = 1;

/**
 * 约定错误码表。
 *
 * `status` 是默认 HTTP 状态码；调用方可以显式覆盖（例如同一错误码在
 * 不同端点下语义不同时）。`defaultMessage` 仅作兜底，正式文案由调用方给出。
 */
export const ERROR_CODES = {
  UNAUTHENTICATED: { status: 401, defaultMessage: "未登录或登录已失效" },
  FORBIDDEN: { status: 403, defaultMessage: "无权访问该资源" },
  NOT_FOUND: { status: 404, defaultMessage: "资源不存在" },
  REVISION_CONFLICT: { status: 409, defaultMessage: "内容已被他人修改，请基于最新版本重试" },
  PARSE_FAILED: { status: 422, defaultMessage: "文件无法解析" },
  MODEL_UNAVAILABLE: { status: 503, defaultMessage: "模型服务暂不可用，请稍后重试" },

  /**
   * `NOT_REVIEWED` 在 D2/D3 下是**正常业务状态，不是异常**，因此 HTTP 仍为 200。
   *
   * 为什么要单独给一个码：它决定学生问成绩时，伴学 Agent 是礼貌地说
   * 「老师还在复核」，还是**编一个数字出来**。所以它必须可被程序判断，
   * 不能只是一句话。
   */
  NOT_REVIEWED: { status: 200, defaultMessage: "教师尚未复核，成绩与详细评语暂不可见" },

  /**
   * ⚠️ 规范缺口（2026-09-21 实现时发现，**待黄山确认后并入规范**）：
   *
   * 规范的七个错误码全部对应「业务状态」，但参数校验失败（缺必填参数、格式不对）
   * 不属于任何一种业务状态——它表示调用方把请求写错了。
   * 规范要求「失败使用七个错误码之一」，可七个都套不上：
   * 套 `NOT_FOUND` 会把「你没传参数」误报成「资源不存在」，反而误导 Agent。
   *
   * 因此这里**新增**第八个码，纯属增量，不影响原有七个。
   * 若黄山认为应当维持严格的七码，把这一项删掉、并把校验失败改为不带 `code` 即可，
   * 改动只在本文件与 `classifyError()` 内。
   */
  INVALID_ARGUMENT: { status: 400, defaultMessage: "请求参数不合法，请修正后重试" }
};

/**
 * 是否属于规范正式约定的七个错误码（不含上面标注的待确认项）。
 * @param {string} code
 */
export function isSpecifiedCode(code) {
  return Object.hasOwn(ERROR_CODES, code) && code !== "INVALID_ARGUMENT";
}

/** 列出规范正式约定的七个错误码。 */
export function specifiedCodes() {
  return Object.keys(ERROR_CODES).filter(isSpecifiedCode);
}

/**
 * 把既有的中文错误文案归类到错误码。
 *
 * 为什么用文案反推而不是逐处改写调用点：现有 51 处 `ok:false` 分布在不同端点，
 * 逐个改容易漏；集中一处归类既能立刻覆盖全部，也方便以后统一收敛。
 * **新代码请直接显式传 `code`**，不要依赖这里的兜底规则。
 *
 * @param {string} message
 * @returns {string} 错误码
 */
export function classifyError(message = "") {
  const text = String(message);

  // 未认证
  if (/未登录|缺少访问令牌|登录已失效|用户名或密码/.test(text)) return "UNAUTHENTICATED";

  // 越权（必须在「不存在」之前判断：越权文案里常同时含「无权」与「不存在」）
  if (/权限不足|无权访问|非教师角色|非学生角色|禁止复核|仅任课教师|尚未发布/.test(text)) {
    return "FORBIDDEN";
  }

  // 并发写冲突
  // 「已有学生提交，请保留原评分标准」也归这里：它不是参数错，而是
  // 「对象已进入下一状态，不能再这样改」——正是 REVISION_CONFLICT 的语义
  if (/已被他人|并发|版本冲突|已修改|已有学生提交|请保留原/.test(text)) return "REVISION_CONFLICT";

  // 解析失败（含各解析错误码的说明文案）
  if (/解析失败|解析引擎不可用|损坏|加密|需要 OCR|不支持解析/.test(text)) return "PARSE_FAILED";

  // 模型不可用
  if (/模型服务|模型不可用|评阅中断|未配置模型/.test(text)) return "MODEL_UNAVAILABLE";

  // 尚未复核（正常业务状态）
  if (/尚未复核|未复核|老师还在复核/.test(text)) return "NOT_REVIEWED";

  // 资源不存在
  if (/不存在|未找到|已被删除/.test(text)) return "NOT_FOUND";

  // 参数问题兜底（见 ERROR_CODES.INVALID_ARGUMENT 的说明）
  return "INVALID_ARGUMENT";
}

/**
 * 构造统一信封。
 *
 * **六个字段始终存在**（不适用的用空数组 / null），形状可预测——
 * 这是给 Agent 用的，可预测比"省字段"重要得多。
 *
 * `data` 与既有的扁平字段**同时存在**：`data` 是契约层规定的正式位置，
 * 扁平字段是为了不打断现有客户端。UI 迁移完成后可以只保留 `data`
 * （见规范第九节已确认的决策 #5）。
 *
 * @param {object} body 端点原本要返回的结构（至少含 ok）
 * @param {object} [options]
 * @param {object|null} [options.data] 覆盖 data 内容；默认取 body 去掉 ok 之后的剩余字段
 * @param {Array} [options.evidenceRefs] 能定位回原文的引用
 * @param {Array} [options.warnings] 降级与未读范围的显式说明
 * @param {string} [options.asOf] 数据截止时间；默认取当前时间
 * @param {string|null} [options.nextCursor] 游标分页的下一页游标
 */
export function withEnvelope(body, options = {}) {
  if (!body || typeof body !== "object") return body;

  const { ok, ...rest } = body;
  const isFailure = ok === false;

  const envelope = {
    ...body,
    schemaVersion: SCHEMA_VERSION,
    asOf: options.asOf || body.asOf || new Date().toISOString(),
    // 三个"可选容器"字段：**优先取端点自己给的值**（端点在响应体里直接带
    // warnings / evidenceRefs / nextCursor 即可），否则取 options，再否则给空值。
    // 这样端点可以自然地声明"本次回答是降级结果"，不必额外传参。
    warnings: asArray(options.warnings, body.warnings),
    evidenceRefs: asArray(options.evidenceRefs, body.evidenceRefs),
    nextCursor:
      options.nextCursor !== undefined
        ? options.nextCursor
        : body.nextCursor !== undefined
          ? body.nextCursor
          : null,
    // 失败时 data 没有意义，固定为 null，避免调用方误把错误体当数据读
    data: isFailure ? (options.data !== undefined ? options.data : null) : options.data !== undefined ? options.data : rest
  };
  return envelope;
}

/** 取第一个是数组的值；都不是则给空数组。 */
function asArray(...candidates) {
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

/**
 * 构造错误响应体。
 *
 * 保留 `error` 文案（现有客户端读它），并**新增** `code` 供程序判断。
 *
 * @param {string} code 错误码（必须是 ERROR_CODES 中的键）
 * @param {object} [options]
 * @param {string} [options.message] 面向人的说明；默认取错误码的兜底文案
 * @param {number} [options.status] 覆盖默认 HTTP 状态码
 * @param {object} [options.extra] 附加字段（如 conflict 的 currentRevision）
 */
export function errorBody(code, options = {}) {
  const spec = ERROR_CODES[code] || ERROR_CODES.INVALID_ARGUMENT;
  const message = options.message || spec.defaultMessage;
  const body = {
    ok: false,
    code,
    error: message
  };
  if (options.extra && typeof options.extra === "object") Object.assign(body, options.extra);
  return body;
}

/** 取某错误码对应的 HTTP 状态码。 */
export function statusForCode(code) {
  const spec = ERROR_CODES[code];
  return spec ? spec.status : 400;
}
