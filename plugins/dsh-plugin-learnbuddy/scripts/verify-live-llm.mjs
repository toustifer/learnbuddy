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
import {
  MultimodalLLMClient,
  PROVIDER_PRESETS,
  normalizeProvider,
  resolveLLMConfig,
  buildVisionContent
} from "../src/services/llm.js";
import { renderTextPng } from "./lib/png-text.mjs";

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

// ---------------------------------------------------------------------------
// 0. 解析配置 & 无密钥友好跳过
// ---------------------------------------------------------------------------
const env = process.env;
const explicitProvider = normalizeProvider(env.LLM_PROVIDER);
const config = resolveLLMConfig(env);

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
function resolveKey(provider) {
  if (env.LLM_API_KEY) return env.LLM_API_KEY.trim();
  for (const name of PROVIDER_PRESETS[provider].apiKeyEnv) {
    if (env[name] && env[name].trim()) return env[name].trim();
  }
  return "";
}

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
  process.exit(0);
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
console.log("-".repeat(72));

// ---------------------------------------------------------------------------
// 1. 纯文本对话
// ---------------------------------------------------------------------------
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
    { maxTokens: 32 }
  );

  const content = String(resp.content || "").trim();
  check(
    `① 纯文本对话（${client.textModel}）返回 200 且 content 非空`,
    resp.ok === true && content.length > 0,
    `content=${JSON.stringify(content.slice(0, 60))}`
  );
  check(
    `① 纯文本对话正确回显哨兵串 ${PING}`,
    content.toUpperCase().includes(PING),
    `content=${JSON.stringify(content.slice(0, 80))}`
  );
} catch (err) {
  check("① 纯文本对话请求成功", false, `抛出异常: ${err.message}`);
}

// ---------------------------------------------------------------------------
// 2. 图片理解：自生成含确定文字的 PNG → 断言模型读出了该文字
// ---------------------------------------------------------------------------
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
    { maxTokens: 64 }
  );

  const content = String(resp.content || "").trim();
  check(
    `② 图片理解（${client.visionModel}）返回 200 且 content 非空`,
    resp.ok === true && content.length > 0,
    `content=${JSON.stringify(content.slice(0, 60))}`
  );
  check(
    `② 图片理解正确读出图中文字 "${VISION_WORD}"（OCR 级断言）`,
    content.toUpperCase().includes(VISION_WORD),
    `content=${JSON.stringify(content.slice(0, 80))}`
  );
} catch (err) {
  check("② 图片理解请求成功", false, `抛出异常: ${err.message}`);
}

// ---------------------------------------------------------------------------
// 3. 模型路由自检（不发请求，纯配置断言）
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// 摘要
// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log("-".repeat(72));
console.log(`${results.length - failed.length}/${results.length} 项通过`);

if (failed.length > 0) {
  console.log("\n失败项：");
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
  console.log(
    "\n提示：若为 401，请确认密钥与 provider 匹配（DeepSeek 用 LLM_API_KEY 或 DEEPSEEK_API_KEY）；" +
      "\n      若图片理解失败，请确认 LLM_MODEL_VISION 用的是可读图模型（DeepSeek 为 deepseek-flash）；" +
      "\n      若为超时，可用 LLM_TIMEOUT_MS 调整（默认 45000）。"
  );
  process.exit(1);
}

console.log("\n全部通过 ✅ LLM 接入层可在该供应商下正常提供文本与图片理解能力。");
process.exit(0);
