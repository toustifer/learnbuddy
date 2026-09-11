// 实盘验证脚本（**由 Leader 用真实密钥执行**，不参与 `npm test`）：
// 用环境变量里的真实密钥直连供应商，验证 ①纯文本对话 ②图片理解（自生成含确定文字的 PNG）。
//
// 运行（在 plugins/dsh-plugin-learnbuddy 目录下）：
//   # DeepSeek
//   $env:LLM_API_KEY="sk-****"; node scripts/verify-live-llm.mjs
//
//   # 智谱 GLM（旧部署回归）
//   $env:LLM_PROVIDER="zhipu"; $env:ZHIPU_API_KEY="****"; node scripts/verify-live-llm.mjs
//
// 行为约定：
//   - **无密钥时友好跳过并退出码 0**（不能报错，避免 CI 误判）
//   - 只从 process.env 读密钥，绝不落盘、绝不打印完整密钥
//   - 图片由脚本自行生成（./lib/png-text.mjs 手写 PNG，零依赖），不依赖任何外部素材
//   - 输出清晰的 PASS/FAIL 摘要；有 FAIL 时退出码 1
//
// ⚠️ 推理模型（task-13 教训）：`deepseek-flash` / `deepseek-v4-pro` 先输出思维链
//   (`reasoning_content`)，最终答案才进 `content`。**max_tokens 给小了会拿到空 content，却不报错**
//   （实测 max_tokens=32 → content="" + finish_reason=length；max_tokens=800/不传 → content="收到"）。
//   本脚本因此不再使用 32/64 这类过小值，统一使用 `REASONING_SAFE_VERIFY_TOKENS`（见下）。
//   若模型仍返回空 content，客户端会给出 ok:false + 可辨识诊断，本脚本会把诊断原样打印出来。
import {
  MultimodalLLMClient,
  PROVIDER_PRESETS,
  normalizeProvider,
  buildVisionContent,
  MIN_REASONING_MODEL_MAX_TOKENS,
  REASONING_SAFE_VERIFY_TOKENS
} from "../src/services/llm.js";
import { renderTextPng } from "./lib/png-text.mjs";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// 推理模型友好的 token 预算（导出，供离线回归测试断言「不再使用过小值」）
// ---------------------------------------------------------------------------
export const MAX_TOKENS_TEXT = REASONING_SAFE_VERIFY_TOKENS.text;
export const MAX_TOKENS_VISION = REASONING_SAFE_VERIFY_TOKENS.vision;

/** 把客户端的截断诊断渲染成一行可读文本（无诊断时返回空串） */
export function formatTruncationDiagnostic(resp) {
  if (!resp || (!resp.truncated && !resp.error)) return "";
  const d = resp.diagnostics || {};
  const parts = [
    `finish_reason=${d.finishReason ?? resp.finishReason ?? "(无)"}`,
    `reasoning_tokens=${d.reasoningTokens ?? resp.reasoningTokens ?? "(无)"}`,
    `max_tokens=${d.maxTokens ?? resp.maxTokens ?? "(未传)"}`
  ];
  return `${resp.error || "空 content"} [${parts.join(", ")}]`;
}

/**
 * 推理模型友好的 token 预算 self-check：
 * 返回错误文案（表示预算过小、修复被回退）或空串（正常）。导出以便离线回归测试。
 */
export function checkTokenBudgets(
  text = MAX_TOKENS_TEXT,
  vision = MAX_TOKENS_VISION,
  min = MIN_REASONING_MODEL_MAX_TOKENS
) {
  const tooSmall = (v) => !Number.isFinite(v) || v < min;
  if (!tooSmall(text) && !tooSmall(vision)) return "";
  return (
    `内部错误：验证脚本的 max_tokens 过小（text=${text}, vision=${vision}），` +
    `推理模型至少需要 ${min}。`
  );
}

// ---------------------------------------------------------------------------
// 断言收集
// ---------------------------------------------------------------------------
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** 密钥脱敏显示 */
function mask(key) {
  if (!key) return "(空)";
  return `${key.slice(0, 3)}***${key.slice(-2)}`;
}

/**
 * 实盘验证主流程。
 * 导出以便离线演练/测试在不起子进程的前提下驱动同一份逻辑；
 * 返回值即进程退出码（0 = 全绿或友好跳过，1 = 有 FAIL）。
 */
export async function main() {
  // 断言 self-check：脚本自身不许用过小的 token 值（防止本次修复被回退）
  const budgetError = checkTokenBudgets();
  if (budgetError) {
    console.error(budgetError);
    return 1;
  }

  // -------------------------------------------------------------------------
  // 0. 解析配置 & 无密钥友好跳过
  // -------------------------------------------------------------------------
  const env = process.env;
  const explicitProvider = normalizeProvider(env.LLM_PROVIDER);

  // 供应商候选：显式指定优先；否则看谁配了密钥
  const candidates = [];
  if (explicitProvider) {
    candidates.push(explicitProvider);
  } else if (env.LLM_API_KEY) {
    candidates.push("deepseek");
  } else {
    if (env.ZHIPU_API_KEY || env.GLM_API_KEY) candidates.push("zhipu");
    if (env.DEEPSEEK_API_KEY) candidates.push("deepseek");
  }

  const providerId = candidates[0] || null;

  // 从环境里找出这个供应商实际可用的密钥
  const resolveKey = (provider) => {
    if (env.LLM_API_KEY) return env.LLM_API_KEY.trim();
    for (const name of PROVIDER_PRESETS[provider].apiKeyEnv) {
      if (env[name] && env[name].trim()) return env[name].trim();
    }
    return "";
  };

  const apiKey = providerId ? resolveKey(providerId) : "";

  console.log("=".repeat(72));
  console.log("LearnBuddy LLM 实盘验证 (scripts/verify-live-llm.mjs)");
  console.log("=".repeat(72));

  if (!apiKey) {
    console.log("SKIP  未检测到任何 LLM 密钥，跳过实盘验证（这是**正常且预期**的行为）。");
    console.log("");
    console.log("  请先设置环境变量后再运行，例如：");
    console.log('    $env:LLM_API_KEY="sk-****"        # DeepSeek（默认 provider）');
    console.log('    $env:LLM_PROVIDER="zhipu"; $env:ZHIPU_API_KEY="****"   # 智谱 GLM');
    console.log("");
    console.log("已识别的密钥环境变量：LLM_API_KEY / DEEPSEEK_API_KEY / ZHIPU_API_KEY / GLM_API_KEY");
    console.log("");
    console.log("0/0 项通过（无密钥，友好跳过）");
    return 0;
  }

  // 实盘脚本应打真实端点，因此尊重预设默认 base（除非显式覆盖了 LLM_BASE_URL）
  const client = new MultimodalLLMClient({
    env,
    provider: providerId,
    apiKey
  });

  console.log(`provider  : ${client.provider} (${client.providerLabel})`);
  console.log(`baseUrl   : ${client.baseUrl}`);
  console.log(`视觉模型  : ${client.visionModel}`);
  console.log(`文本模型  : ${client.textModel}`);
  console.log(`超时      : ${client.timeoutMs} ms`);
  console.log(`密钥      : ${mask(client.apiKey)}`);
  console.log(
    `推理模型  : ${client.textModel === client.visionModel ? "文本/视觉同模型" : "文本与视觉分离"}` +
      `（max_tokens: 文本 ${MAX_TOKENS_TEXT} / 视觉 ${MAX_TOKENS_VISION}，` +
      `下限 ${MIN_REASONING_MODEL_MAX_TOKENS}；推理模型先出 reasoning_content，答案才进 content）`
  );
  console.log("-".repeat(72));

  // -------------------------------------------------------------------------
  // 1. 纯文本对话
  // -------------------------------------------------------------------------
  const PING = "PONG-7391";
  try {
    const resp = await client.chatText(
      [
        {
          role: "system",
          content: "你是一个严格的接口连通性测试端点。只回复用户要求的内容，不要任何多余文字。"
        },
        {
          role: "user",
          content: `请只回复这个字符串，不要加引号、不要加任何其他字符：${PING}`
        }
      ],
      { maxTokens: MAX_TOKENS_TEXT }
    );

    const content = String(resp.content || "").trim();
    const truncation = formatTruncationDiagnostic(resp);
    check(
      `① 纯文本对话（${client.textModel}）返回 200 且 content 非空`,
      resp.ok === true && content.length > 0,
      truncation
        ? `⚠️ 空 content 诊断: ${truncation}`
        : `content=${JSON.stringify(content.slice(0, 60))}, reasoning_tokens=${
            resp.reasoningTokens ?? 0
          }`
    );
    check(
      `① 纯文本对话正确回显哨兵串 ${PING}`,
      content.toUpperCase().includes(PING),
      `content=${JSON.stringify(content.slice(0, 80))}`
    );
  } catch (err) {
    check("① 纯文本对话请求成功", false, `抛出异常: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // 2. 图片理解：自生成含确定文字的 PNG → 断言模型读出了该文字
  // -------------------------------------------------------------------------
  const VISION_WORD = "DEEPSEEK";
  const png = renderTextPng(VISION_WORD, 14);
  console.log(
    `已生成验证图片: ${png.length} 字节, PNG 魔数=${png.subarray(1, 4).toString("ascii")}, 期望模型读出 "${VISION_WORD}"`
  );

  try {
    const resp = await client.chatVision(
      [
        {
          role: "system",
          content:
            "你是一个高精度 OCR 引擎。用户会给你一张白底黑字的图片，请逐字识别图中的大写英文单词，只输出这个单词本身。"
        },
        {
          role: "user",
          content: buildVisionContent(
            "请识别这张图片中的大写英文单词，只输出单词本身，不要任何解释。",
            [png]
          )
        }
      ],
      { maxTokens: MAX_TOKENS_VISION }
    );

    const content = String(resp.content || "").trim();
    const truncation = formatTruncationDiagnostic(resp);
    check(
      `② 图片理解（${client.visionModel}）返回 200 且 content 非空`,
      resp.ok === true && content.length > 0,
      truncation
        ? `⚠️ 空 content 诊断: ${truncation}`
        : `content=${JSON.stringify(content.slice(0, 60))}, reasoning_tokens=${
            resp.reasoningTokens ?? 0
          }`
    );
    check(
      `② 图片理解正确读出图中文字 "${VISION_WORD}"（OCR 级断言）`,
      content.toUpperCase().includes(VISION_WORD),
      `content=${JSON.stringify(content.slice(0, 80))}`
    );
  } catch (err) {
    check("② 图片理解请求成功", false, `抛出异常: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // 3. 模型路由自检（不发请求，纯配置断言）
  // -------------------------------------------------------------------------
  check(
    "③ 视觉与文本模型均已解析出非空模型名",
    Boolean(client.visionModel) && Boolean(client.textModel),
    `vision=${client.visionModel} text=${client.textModel}`
  );

  if (client.provider === "deepseek") {
    // 注意：断言的是**预设默认值**，而不是 client.baseUrl。
    // client.baseUrl 允许被 LLM_BASE_URL 覆盖（本地假供应商自检就会这么做），
    // 因此拿它去比官方端点会在合法的覆盖场景下误报 FAIL。
    const presetDefault = PROVIDER_PRESETS.deepseek.baseUrl;
    check(
      "③ DeepSeek 预设默认 base 为官方端点 https://api.deepseek.com",
      presetDefault === "https://api.deepseek.com",
      `preset=${presetDefault}`
    );
    check(
      "③ 当前实际使用的 base 未被意外篡改",
      Boolean(client.baseUrl) && /^https?:\/\//.test(client.baseUrl),
      `实际 baseUrl=${client.baseUrl}${env.LLM_BASE_URL ? "（由 LLM_BASE_URL 覆盖）" : ""}`
    );
  }

  // -------------------------------------------------------------------------
  // 摘要
  // -------------------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.log("-".repeat(72));
  console.log(`${results.length - failed.length}/${results.length} 项通过`);

  if (failed.length > 0) {
    console.log("\n失败项：");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
    console.log(
      "\n提示：若为 401，请确认密钥与 provider 匹配（DeepSeek 用 LLM_API_KEY 或 DEEPSEEK_API_KEY）；" +
        "\n      若图片理解失败，请确认 LLM_MODEL_VISION 用的是可读图模型（DeepSeek 为 deepseek-flash，" +
        "\n        实测 deepseek-v4-pro 读图会静默返回空 content）；" +
        "\n      若提示「推理 token 耗尽」，说明 max_tokens 给小了：调大（建议 >= 512）或干脆不传走 API 默认；" +
        "\n      若为超时，可用 LLM_TIMEOUT_MS 调整（默认 45000）。"
    );
    return 1;
  }

  console.log("\n全部通过 ✅ LLM 接入层可在该供应商下正常提供文本与图片理解能力。");
  return 0;
}

// 仅在「被直接执行」时跑实盘流程；被测试 import 时只取常量与纯函数（不会发请求、不会 process.exit）
const invokedDirectly =
  Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  process.exit(await main());
}
