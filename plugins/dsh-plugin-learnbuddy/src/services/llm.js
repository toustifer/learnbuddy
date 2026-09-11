/**
 * 多供应商多模态大模型统一客户端（DeepSeek / 智谱 GLM）
 *
 * 特性：
 * 1. 环境变量驱动的多供应商接入层，切换供应商**不需要改代码**，默认 DeepSeek
 * 2. 兼容旧的 ZHIPU_API_KEY / GLM_API_KEY / ZHIPU_BASE_URL / GLM_MODEL（只配旧变量时自动判定 provider=zhipu）
 * 3. 区分「视觉（可读图）」与「文本」两条模型路径：有图走 LLM_MODEL_VISION，纯文本走 LLM_MODEL_TEXT
 * 4. 支持纯文本与多模态图文对话（Base64 Data URI / 远程 URL），OpenAI 风格 /chat/completions
 * 5. 严格 JSON 输出模式（response_format=json_object），供结构化知识点抽取与 AutoGrader 评分使用
 * 6. 内置未配置 Key 时的 Mock 兜底，保证无 Key 时系统不崩溃（比赛演示防翻车）
 *
 * ⚠️⚠️ 推理模型（Reasoning Model）适配 —— 阅读本模块前必读（task-13 实测固化）
 *
 *   DeepSeek 的 `deepseek-flash` / `deepseek-v4-pro` 是**推理模型**：它们不是「一次吐答案」，
 *   而是**先把思维链写进 `message.reasoning_content`，最终答案才写进 `message.content`**。
 *   官方响应形状（实测）：
 *
 *     {
 *       "choices": [{
 *         "message": {
 *           "content": "收到",                                  // ← 最终答案（可能为空！）
 *           "reasoning_content": "The user is asking me to reply..." // ← 思维链
 *         },
 *         "finish_reason": "stop" | "length"
 *       }],
 *       "usage": {
 *         "completion_tokens": 16,
 *         "completion_tokens_details": { "reasoning_tokens": 14 }   // ← 思考消耗可观测
 *       }
 *     }
 *
 *   由此产生两个必须记住的运维事实：
 *   1. `max_tokens` 太小时，token 会被思考过程吃光 → `finish_reason="length"` 且
 *      **`content` 为空字符串，但 HTTP 仍然是 200、不报任何错**（静默空结果）。
 *      实测：同一把密钥 `max_tokens=20` → `content=""`；`max_tokens=800` 或不传 → `content="收到"`。
 *   2. `usage.completion_tokens_details.reasoning_tokens` 可观测思考消耗，
 *      是判断「空 content 到底是模型故障还是被截断」的关键依据。
 *
 *   因此本模块的两条防线（见 `_post` / `describeReasoningTruncation`）：
 *   - 给推理模型留足预算：`MIN_REASONING_MODEL_MAX_TOKENS`（业务代码一律不传 maxTokens，
 *     走 API 默认，这是生产链路的既有安全前提）；
 *   - 一旦判定为「推理 token 耗尽导致空 content」，**绝不静默返回空串**：
 *     返回 `ok:false` + `error` + `truncated:true` + `diagnostics`，让上层无法把空结果当有效输出。
 *
 *   ⚠️ 另有视觉模型陷阱：`LLM_MODEL_VISION` **必须用 `deepseek-flash`**（实测可逐字读图）；
 *   `deepseek-v4-pro` 读图会**静默返回空 content**（同样不报错）。详见 README。
 *
 * ⚠️ 密钥安全：本模块只从 process.env 读取密钥，绝不落盘、绝不打印完整密钥。
 */

import http from "node:http";
import https from "node:https";

/** 各供应商默认参数（可被 LLM_* 环境变量逐项覆盖） */
export const PROVIDER_PRESETS = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    visionModel: "deepseek-flash", // 实测可读图（多模态）
    textModel: null, // 未单独配置时回落到视觉模型
    apiKeyEnv: ["DEEPSEEK_API_KEY"],
    baseUrlEnv: ["DEEPSEEK_BASE_URL"],
    modelEnv: []
  },
  zhipu: {
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    visionModel: "glm-4v-flash",
    textModel: null, // 保持旧行为：未配置文本模型时也用 GLM_MODEL / glm-4v-flash
    apiKeyEnv: ["ZHIPU_API_KEY", "GLM_API_KEY"],
    baseUrlEnv: ["ZHIPU_BASE_URL"],
    modelEnv: ["GLM_MODEL"]
  }
};

export const DEFAULT_PROVIDER = "deepseek";
export const DEFAULT_TIMEOUT_MS = 45000;

/** 读取非空字符串环境变量（去首尾空白） */
function pick(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

/** 去掉 baseUrl 末尾的斜杠，避免拼出 `//chat/completions` */
function trimSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

/** 归一化 provider 名；非法值返回 null（由调用方决定回落策略） */
export function normalizeProvider(value) {
  const key = pick(value).toLowerCase();
  return PROVIDER_PRESETS[key] ? key : null;
}

/** 取某供应商下的 baseUrl / 模型默认值（先看通用 LLM_* 变量，再看该供应商的历史变量） */
export function resolveProviderDefaults(providerId, env = process.env) {
  const id = normalizeProvider(providerId) || DEFAULT_PROVIDER;
  const preset = PROVIDER_PRESETS[id];
  const e = env || {};

  let baseUrl = pick(e.LLM_BASE_URL);
  if (!baseUrl) {
    for (const name of preset.baseUrlEnv) {
      if (pick(e[name])) {
        baseUrl = pick(e[name]);
        break;
      }
    }
  }
  if (!baseUrl) baseUrl = preset.baseUrl;

  let visionModel = pick(e.LLM_MODEL_VISION);
  if (!visionModel) {
    for (const name of preset.modelEnv) {
      if (pick(e[name])) {
        visionModel = pick(e[name]);
        break;
      }
    }
  }
  if (!visionModel) visionModel = preset.visionModel;

  // 「若未单独配置文本模型，回落到视觉模型」——保证旧部署零行为变化
  const textModel = pick(e.LLM_MODEL_TEXT) || preset.textModel || visionModel;

  return { provider: id, label: preset.label, baseUrl: trimSlash(baseUrl), visionModel, textModel };
}

/**
 * 解析最终生效的 LLM 配置（纯函数，便于离线测试：传入任意 env 对象即可）
 *
 * 供应商判定顺序：
 *   1. 显式 LLM_PROVIDER（deepseek | zhipu）
 *   2. 只配了 LLM_API_KEY → 默认 deepseek
 *   3. 只配了 ZHIPU_API_KEY / GLM_API_KEY（无 LLM_API_KEY）→ 向后兼容判定为 zhipu
 *   4. 只配了 DEEPSEEK_API_KEY → deepseek
 *   5. 都没有 → deepseek 默认（未配置状态下走 Mock 兜底）
 */
export function resolveLLMConfig(env = process.env) {
  const e = env || {};
  const explicitKey = pick(e.LLM_API_KEY);
  const requested = pick(e.LLM_PROVIDER).toLowerCase();

  let providerId;
  if (requested) {
    providerId = normalizeProvider(requested) || DEFAULT_PROVIDER;
    if (!normalizeProvider(requested)) {
      console.warn(`[MultimodalLLM] 未知 LLM_PROVIDER="${requested}"，回落为 ${DEFAULT_PROVIDER}`);
    }
  } else if (explicitKey) {
    providerId = DEFAULT_PROVIDER;
  } else if (pick(e.ZHIPU_API_KEY) || pick(e.GLM_API_KEY)) {
    providerId = "zhipu"; // 向后兼容：老部署只配了智谱密钥
  } else if (pick(e.DEEPSEEK_API_KEY)) {
    providerId = "deepseek";
  } else {
    providerId = DEFAULT_PROVIDER;
  }

  const preset = PROVIDER_PRESETS[providerId];

  // 密钥：LLM_API_KEY 优先，其次该供应商的历史环境变量名
  let apiKey = explicitKey;
  if (!apiKey) {
    for (const name of preset.apiKeyEnv) {
      if (pick(e[name])) {
        apiKey = pick(e[name]);
        break;
      }
    }
  }

  const defaults = resolveProviderDefaults(providerId, e);

  const rawTimeout = Number(pick(e.LLM_TIMEOUT_MS));
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS;

  return {
    provider: providerId,
    providerLabel: preset.label,
    apiKey,
    baseUrl: defaults.baseUrl,
    visionModel: defaults.visionModel,
    textModel: defaults.textModel,
    timeoutMs,
    configured: Boolean(apiKey)
  };
}

/** 把 Buffer / base64 / 已有 data URI / http(s) URL 统一成 image_url 的 url 字段 */
export function toImageUrl(source, mimeType = "image/png") {
  if (source && typeof source === "object" && !Buffer.isBuffer(source)) {
    const mime = source.mimeType || source.mime || mimeType;
    if (source.url) return toImageUrl(source.url, mime);
    if (source.dataUri) return toImageUrl(source.dataUri, mime);
    const raw = source.data ?? source.base64 ?? source.buffer ?? "";
    return toImageUrl(raw, mime);
  }
  if (Buffer.isBuffer(source)) {
    return `data:${mimeType};base64,${source.toString("base64")}`;
  }
  const text = String(source || "");
  if (text.startsWith("data:") || /^https?:\/\//i.test(text)) return text;
  return `data:${mimeType};base64,${text}`;
}

/**
 * 构造多模态消息体（OpenAI / DeepSeek 兼容形状）
 * @returns {Array<{type:"text",text:string}|{type:"image_url",image_url:{url:string}}>}
 */
export function buildVisionContent(text, images = []) {
  const parts = [];
  if (text !== undefined && text !== null && String(text).length > 0) {
    parts.push({ type: "text", text: String(text) });
  }
  for (const image of images || []) {
    if (!image) continue;
    parts.push({ type: "image_url", image_url: { url: toImageUrl(image) } });
  }
  return parts;
}

/** 判断消息列表中是否已含图片（用于自动选择视觉模型） */
export function messagesContainImage(messages = []) {
  for (const msg of messages || []) {
    const content = msg && msg.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && (part.type === "image_url" || part.image_url)) return true;
    }
  }
  return false;
}

/** 从消息里抽出纯文本（供 Mock 兜底做意图判断，兼容 content 为数组的多模态消息） */
function extractText(messages = []) {
  const last = (messages || [])[messages.length - 1];
  if (!last) return "";
  const content = last.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && part.type === "text") return part.text || "";
        if (part && part.type === "image_url") return "[图片]";
        return "";
      })
      .join("\n");
  }
  return content ? JSON.stringify(content) : "";
}

/** 把可能的数组型 content 归一化成字符串 */
function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return content === undefined || content === null ? "" : String(content);
}

// ---------------------------------------------------------------------------
// 推理模型（Reasoning Model）判定与「空 content」诊断
// ---------------------------------------------------------------------------

/** 已知的推理模型名（先出 reasoning_content，答案才进 content） */
export const KNOWN_REASONING_MODELS = ["deepseek-flash", "deepseek-v4-pro"];

/**
 * 给推理模型的 `max_tokens` 建议下限。
 * 低于该值时，思维链很容易把预算吃光 → `finish_reason="length"` 且 `content=""`。
 * 业务代码（grader / material-parser / autograder-pipeline）**一律不传 maxTokens**（走 API 默认），
 * 本常量只用于「必须显式传 maxTokens」的场景（如实盘验证脚本）。
 */
export const MIN_REASONING_MODEL_MAX_TOKENS = 512;

/** 实盘验证脚本使用的 token 预算（必须是「推理模型友好」的值，回归测试会断言其不低于下限） */
export const REASONING_SAFE_VERIFY_TOKENS = { text: 1024, vision: 1024 };

/** 判断模型名是否为已知推理模型（大小写不敏感，容忍 `provider/model` 前缀） */
export function isReasoningModel(model) {
  const name = String(model || "")
    .trim()
    .toLowerCase()
    .split("/")
    .pop();
  return KNOWN_REASONING_MODELS.includes(name);
}

/** 从 usage 里取 reasoning_tokens（不同供应商可能省略该字段） */
export function extractReasoningTokens(usage) {
  const value = Number(usage?.completion_tokens_details?.reasoning_tokens);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 判定「推理 token 耗尽 → content 为空」这一类截断响应。
 *
 * 判据（满足其一即可）：
 *   1. `finish_reason === "length"`（被 max_tokens 硬截断）；
 *   2. 传了 max_tokens，且 `reasoning_tokens` 已把预算吃满（`>= maxTokens`）。
 *
 * 注意：**不做「推理模型 + 空 content」的兜底判定**——若模型正常 stop 却给空内容，
 * 那是模型/供应商异常，本函数不臆断为截断（保持旧有「空串退化」行为）。
 */
export function describeReasoningTruncation({ finishReason, reasoningTokens, maxTokens } = {}) {
  const tokens = Number(reasoningTokens) || 0;
  const budget = Number(maxTokens);
  const hasBudget = Number.isFinite(budget) && budget > 0;
  const finishReasonIsLength = String(finishReason || "").toLowerCase() === "length";

  if (!finishReasonIsLength && !(hasBudget && tokens >= budget)) return null;

  const budgetPart = hasBudget ? `，max_tokens=${budget}` : "";
  const reasonPart = finishReasonIsLength
    ? `finish_reason=length（输出被 max_tokens 截断）`
    : `reasoning_tokens=${tokens} 已达 max_tokens=${budget}`;
  const tail = hasBudget
    ? `请调大 max_tokens（推理模型建议 >= ${MIN_REASONING_MODEL_MAX_TOKENS}）或不传 max_tokens 走 API 默认。`
    : `本次未传 max_tokens，可能是供应商侧默认上限过低；请显式调大 max_tokens（建议 >= ${MIN_REASONING_MODEL_MAX_TOKENS}）。`;

  return {
    reason: finishReasonIsLength ? "reasoning_token_budget_exhausted" : "reasoning_tokens_saturated",
    finishReason: finishReason ?? null,
    reasoningTokens: tokens,
    maxTokens: hasBudget ? budget : null,
    error:
      `大模型返回空 content：推理模型（deepseek-flash / deepseek-v4-pro）的思维链 ` +
      `(reasoning_content) 已耗尽 token 预算（${reasonPart}${budgetPart}），` +
      `最终答案未能产出。${tail}`
  };
}

export class MultimodalLLMClient {
  /**
   * @param {string|object} config 传字符串时等价于 `{ apiKey }`（兼容旧签名 `new MultimodalLLMClient(key)`）
   */
  constructor(config = {}) {
    const overrides = typeof config === "string" ? { apiKey: config } : config || {};
    const env = overrides.env || process.env;
    const resolved = resolveLLMConfig(env);

    const explicitProvider = normalizeProvider(overrides.provider);
    this.provider = explicitProvider || resolved.provider;
    this.providerLabel = PROVIDER_PRESETS[this.provider].label;

    const defaults =
      this.provider === resolved.provider
        ? { baseUrl: resolved.baseUrl, visionModel: resolved.visionModel, textModel: resolved.textModel }
        : resolveProviderDefaults(this.provider, env);

    this.apiKey = overrides.apiKey !== undefined ? String(overrides.apiKey || "") : resolved.apiKey;
    this.baseUrl = trimSlash(overrides.baseUrl || defaults.baseUrl);
    this.visionModel = overrides.visionModel || defaults.visionModel;
    this.textModel = overrides.textModel || defaults.textModel || this.visionModel;
    this.timeoutMs =
      Number.isFinite(Number(overrides.timeoutMs)) && Number(overrides.timeoutMs) > 0
        ? Number(overrides.timeoutMs)
        : resolved.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  isConfigured() {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  /** 可安全打日志的配置快照（绝不包含完整密钥） */
  describe() {
    return {
      provider: this.provider,
      providerLabel: this.providerLabel,
      baseUrl: this.baseUrl,
      visionModel: this.visionModel,
      textModel: this.textModel,
      timeoutMs: this.timeoutMs,
      configured: this.isConfigured(),
      apiKeyMasked: this.isConfigured() ? `${this.apiKey.slice(0, 3)}***${this.apiKey.slice(-2)}` : ""
    };
  }

  /** 纯文本路径：强制使用 LLM_MODEL_TEXT（未配置时回落到视觉模型） */
  async chatText(messages, options = {}) {
    return this.chatCompletion(messages, { ...options, task: "text" });
  }

  /** 视觉路径：强制使用 LLM_MODEL_VISION（课件图表解析 / 报告截图核验） */
  async chatVision(messages, options = {}) {
    return this.chatCompletion(messages, { ...options, task: "vision" });
  }

  /**
   * 发起对话请求（自动/按 task 选择文本或视觉模型）
   * @param {Array|object} messages 消息数组，content 可为字符串或 [{type:"text"},{type:"image_url"}]
   * @param {object} options { task?: "text"|"vision", model?, temperature?, responseFormat?, timeoutMs?, maxTokens? }
   *
   * ⚠️ `maxTokens` 与推理模型：`deepseek-flash` / `deepseek-v4-pro` 会先输出思维链
   * (`reasoning_content`)，答案才进 `content`。**给小了会拿到空 content**（见文件头注释）。
   * 业务调用方一律**不要传 maxTokens**（走 API 默认）；必须传时请 >= `MIN_REASONING_MODEL_MAX_TOKENS`。
   */
  async chatCompletion(messages, options = {}) {
    const {
      model,
      temperature = 0.2,
      responseFormat = null,
      task = null,
      timeoutMs = this.timeoutMs,
      maxTokens = null
    } = options;

    const normalizedMessages = Array.isArray(messages) ? messages : [messages];
    const wantsVision =
      task === "vision" || (task !== "text" && messagesContainImage(normalizedMessages));
    const chosenModel = model || (wantsVision ? this.visionModel : this.textModel);

    // 若未配置 Key，使用教育领域 Mock 兜底，保证演示不挂
    if (!this.isConfigured()) {
      console.warn(
        `[MultimodalLLM] 未检测到 ${this.provider === "zhipu" ? "ZHIPU_API_KEY / GLM_API_KEY / LLM_API_KEY" : "LLM_API_KEY / DEEPSEEK_API_KEY"}，进入智能 Mock 模拟模式`
      );
      return this._generateMockResponse(normalizedMessages, { model: chosenModel, wantsVision, responseFormat });
    }

    const payload = {
      model: chosenModel,
      messages: normalizedMessages,
      temperature,
      stream: false
    };

    if (responseFormat === "json_object") {
      payload.response_format = { type: "json_object" };
    }
    // 只有显式传出合法正值才带 max_tokens；否则完全不传，交给 API 默认（推理模型最安全）
    const tokenBudget =
      Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0 ? Number(maxTokens) : null;
    if (tokenBudget !== null) {
      payload.max_tokens = tokenBudget;
    }

    return this._post("/chat/completions", payload, { timeoutMs, model: chosenModel, maxTokens: tokenBudget });
  }

  /** 实际 HTTP(S) 请求（http/https 均可，便于离线假供应商测试） */
  _post(path, payload, { timeoutMs = this.timeoutMs, model = "", maxTokens = null } = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    const transport = url.protocol === "http:" ? http : https;
    const bodyStr = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const succeed = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const req = transport.request(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Length": Buffer.byteLength(bodyStr)
          },
          timeout: timeoutMs
        },
        (res) => {
          let respData = "";
          res.setEncoding("utf-8");
          res.on("data", (chunk) => {
            respData += chunk;
          });
          res.on("end", () => {
            let parsed = null;
            try {
              parsed = JSON.parse(respData);
            } catch {
              parsed = null;
            }

            if (res.statusCode >= 200 && res.statusCode < 300) {
              if (!parsed) {
                fail(
                  new Error(
                    `解析响应失败: 响应体不是合法 JSON, 原文: ${respData.slice(0, 200)}`
                  )
                );
                return;
              }
              const choice = parsed.choices?.[0];
              const content = normalizeContent(choice?.message?.content);
              const usage = parsed.usage;
              const finishReason = choice?.finish_reason;
              const reasoningTokens = extractReasoningTokens(usage);
              const reasoningContent = normalizeContent(choice?.message?.reasoning_content);

              const response = {
                ok: true,
                content,
                usage,
                model: parsed.model || model,
                finishReason,
                raw: parsed
              };

              // 可观测性：始终暴露思维链消耗与本轮预算（无值时为 0 / null）
              response.reasoningTokens = reasoningTokens;
              response.reasoningContent = reasoningContent;
              response.maxTokens = maxTokens !== null && maxTokens !== undefined ? maxTokens : null;

              // 关键防线：推理 token 耗尽导致空 content 时，绝不静默返回空串（见文件头注释）
              if (content.trim().length === 0) {
                const truncation = describeReasoningTruncation({ finishReason, reasoningTokens, maxTokens });
                if (truncation) {
                  response.ok = false;
                  response.truncated = true;
                  response.error = truncation.error;
                  response.diagnostics = {
                    reason: truncation.reason,
                    finishReason: truncation.finishReason,
                    reasoningTokens: truncation.reasoningTokens,
                    maxTokens: truncation.maxTokens,
                    reasoningContentPreview: reasoningContent.slice(0, 200),
                    isReasoningModel: isReasoningModel(response.model)
                  };
                }
              }

              succeed(response);
              return;
            }

            const apiMessage = parsed?.error?.message || parsed?.message || respData.slice(0, 300);
            const err = new Error(`API Error [${res.statusCode}]: ${apiMessage}`);
            err.status = res.statusCode;
            err.provider = this.provider;
            err.body = parsed ?? respData;
            fail(err);
          });
        }
      );

      req.on("error", (err) => {
        if (err && err.code === "ETIMEDOUT" && !err.timedOut) {
          const timeoutErr = new Error(`请求大模型 API 超时 (${timeoutMs}ms)`);
          timeoutErr.code = "ETIMEDOUT";
          timeoutErr.timedOut = true;
          fail(timeoutErr);
          return;
        }
        fail(err);
      });

      req.on("timeout", () => {
        const err = new Error(`请求大模型 API 超时 (${timeoutMs}ms)`);
        err.code = "ETIMEDOUT";
        err.timedOut = true;
        req.destroy(err);
        fail(err);
      });

      req.write(bodyStr);
      req.end();
    });
  }

  /**
   * 无密钥时的教育领域 Mock 兜底（结构合法：始终返回 { ok, content, ... }）
   */
  _generateMockResponse(messages, _meta = {}) {
    const textPrompt = extractText(messages);

    if (textPrompt.includes("评分") || textPrompt.includes("rubric") || textPrompt.includes("AutoGrader")) {
      return Promise.resolve({
        ok: true,
        content: JSON.stringify({
          totalScore: 92,
          summaryReview: "报告实验数据完备，TCP 三次握手过程时序分析准确，附带了清晰的抓包证据截图；仅在异常排查处对防火墙拦截机制阐述偏简略。",
          rubricChecks: [
            { item: "实验拓扑与网络环境描述", score: 10, max: 10, status: "pass", comment: "拓扑清晰完整" },
            { item: "Wireshark 抓包截图与过滤语法", score: 12, max: 20, status: "warning", comment: "缺少部分过滤条件说明" },
            { item: "三次握手报文序号与时序图分析", score: 40, max: 40, status: "pass", comment: "seq/ack 变化逻辑阐述极佳" },
            { item: "网络异常/连接重置案例诊断", score: 30, max: 30, status: "pass", comment: "结合 RST 包进行了合理解释" }
          ]
        }),
        usage: null,
        mock: true
      });
    }

    return Promise.resolve({
      ok: true,
      content: "【多模态助教】已收到输入。结合课件图文分析：在计算机网络实验中，请重点观察 TCP 标志位（SYN, ACK, RST）以及序列号变化。如需对特定波形或抓包排查，请上传截图。",
      usage: null,
      mock: true
    });
  }
}

export default MultimodalLLMClient;
