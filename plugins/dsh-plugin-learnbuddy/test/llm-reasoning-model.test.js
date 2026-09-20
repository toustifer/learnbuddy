/**
 * 推理模型（Reasoning Model）适配与「空 content 不得静默返回」离线测试（task-13）
 *
 * 背景（Leader 真实密钥实测固化）：
 *   `deepseek-flash` / `deepseek-v4-pro` 是**推理模型**——先把思维链写进
 *   `message.reasoning_content`，最终答案才写进 `message.content`。
 *   当 `max_tokens` 过小时，token 被思考过程吃光 → `finish_reason="length"` 且
 *   **`content` 为空字符串，HTTP 依然 200、不报任何错**（静默空结果）。
 *   实测对照：同密钥 max_tokens=20 → content=""；max_tokens=800 / 不传 → content="收到"。
 *
 * 设计红线（与 llm-provider.test.js 一致）：
 * 1. **绝不发真实外部请求**：全部打到本进程 `node:http` 起的假供应商 Server。
 * 2. **绝不使用真实密钥**：只用 `sk-test-placeholder` 占位值。
 * 3. **不改动既有断言**：向后兼容由「content 非空 → 行为完全不变」用例守护。
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

import {
  MultimodalLLMClient,
  MIN_REASONING_MODEL_MAX_TOKENS,
  REASONING_SAFE_VERIFY_TOKENS,
  KNOWN_REASONING_MODELS,
  isReasoningModel,
  extractReasoningTokens,
  describeReasoningTruncation
} from "../src/services/llm.js";

import { withAuthHeaders } from "./helpers/auth.js";
import {
  MAX_TOKENS_TEXT,
  MAX_TOKENS_VISION,
  checkTokenBudgets,
  formatTruncationDiagnostic
} from "../scripts/verify-live-llm.mjs";

/** 占位假密钥（红线：仓库内不得出现任何真实密钥） */
const FAKE_KEY = "sk-test-placeholder";

/** 一张 1x1 的最小合法 PNG，用于视觉路径请求体断言 */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

/** 与 verify-live-llm.mjs 中一致的哨兵串（模拟「思维链很长、答案很短」的真实响应） */
const REASONING_TEXT =
  "The user is asking me to reply with a specific string. I should output exactly PONG-7391 " +
  "with no quotes and no extra characters. Let me make sure I follow the instruction precisely.";

/**
 * 起一个假供应商 Server（与 llm-provider.test.js 同款，保持测试风格一致）。
 * @param {(ctx: {url: string, headers: object, body: any, index: number}) => {status?: number, body?: string}} responder
 */
async function startFakeProvider(responder) {
  const requests = [];

  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf-8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      const index = requests.length;
      const ctx = { url: req.url, method: req.method, headers: req.headers, body, raw, index };
      requests.push(ctx);

      const plan = responder(ctx) || {};
      res.writeHead(plan.status ?? 200, { "Content-Type": "application/json" });
      res.end(plan.body !== undefined ? plan.body : JSON.stringify({ choices: [] }));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** 构造一个「真实形状」的推理模型响应体 */
function reasoningResponse({
  content = "",
  reasoningContent = REASONING_TEXT,
  finishReason = "length",
  reasoningTokens = 20,
  model = "deepseek-flash"
} = {}) {
  return JSON.stringify({
    id: "chatcmpl-reasoning",
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, reasoning_content: reasoningContent },
        finish_reason: finishReason
      }
    ],
    usage: {
      prompt_tokens: 30,
      completion_tokens: reasoningTokens,
      total_tokens: 30 + reasoningTokens,
      completion_tokens_details: { reasoning_tokens: reasoningTokens }
    }
  });
}

// ---------------------------------------------------------------------------
// 1. 纯函数：推理模型认知固化
// ---------------------------------------------------------------------------

test("已知推理模型清单包含 deepseek-flash / deepseek-v4-pro，且识别大小写与 provider 前缀", () => {
  assert.deepEqual(KNOWN_REASONING_MODELS, ["deepseek-flash", "deepseek-v4-pro"]);
  assert.equal(isReasoningModel("deepseek-flash"), true);
  assert.equal(isReasoningModel("  DeepSeek-V4-Pro  "), true);
  assert.equal(isReasoningModel("deepseek/deepseek-flash"), true, "容忍 provider/model 前缀");
  assert.equal(isReasoningModel("glm-4v-flash"), false);
  assert.equal(isReasoningModel(""), false);
  assert.equal(isReasoningModel(undefined), false);
});

test("extractReasoningTokens：解析 completion_tokens_details.reasoning_tokens，缺失/非法时为 0", () => {
  assert.equal(
    extractReasoningTokens({ completion_tokens_details: { reasoning_tokens: 95 } }),
    95,
    "DeepSeek 视觉用例实测 reasoning_tokens=95"
  );
  assert.equal(extractReasoningTokens({ completion_tokens_details: { reasoning_tokens: 14 } }), 14);
  assert.equal(extractReasoningTokens({ completion_tokens: 16 }), 0, "无 details 字段时回落 0");
  assert.equal(extractReasoningTokens({ completion_tokens_details: { reasoning_tokens: "abc" } }), 0);
  assert.equal(extractReasoningTokens({ completion_tokens_details: { reasoning_tokens: -3 } }), 0);
  assert.equal(extractReasoningTokens(null), 0);
  assert.equal(extractReasoningTokens(undefined), 0);
});

test("describeReasoningTruncation：finish_reason=length 判为截断；reasoning_tokens 打满预算也判为截断", () => {
  // 判据 1：finish_reason=length（未传 max_tokens 也能判定）
  const byLength = describeReasoningTruncation({ finishReason: "length", reasoningTokens: 20, maxTokens: null });
  assert.ok(byLength, "finish_reason=length 必须判为截断");
  assert.equal(byLength.reason, "reasoning_token_budget_exhausted");
  assert.match(byLength.error, /reasoning_content/);
  assert.match(byLength.error, /max_tokens/);

  // 判据 2：传了预算且 reasoning_tokens 已达上限
  const bySaturation = describeReasoningTruncation({ finishReason: "stop", reasoningTokens: 64, maxTokens: 64 });
  assert.ok(bySaturation, "reasoning_tokens 打满 max_tokens 必须判为截断");
  assert.equal(bySaturation.reason, "reasoning_tokens_saturated");
  assert.match(bySaturation.error, /64/);

  // 反向：正常 stop + 未打满 → 不判定为截断（避免误伤正常响应）
  assert.equal(describeReasoningTruncation({ finishReason: "stop", reasoningTokens: 14, maxTokens: 800 }), null);
  assert.equal(describeReasoningTruncation({ finishReason: "stop", reasoningTokens: 14, maxTokens: null }), null);
  assert.equal(describeReasoningTruncation({}), null);
  assert.equal(describeReasoningTruncation(), null);
});

// ---------------------------------------------------------------------------
// 2. 端到端：空 content 不得静默返回（本任务核心价值）
// ---------------------------------------------------------------------------

test("【核心】finish_reason=length + content 空 + reasoning_content 非空 → 可辨识诊断，绝不静默返回空串", async () => {
  const fake = await startFakeProvider(() => ({ body: reasoningResponse() }));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });
    const resp = await client.chatText([{ role: "user", content: "请只回复 PONG-7391" }], { maxTokens: 32 });

    // 关键红线：空 content 必须伴随 ok:false + 诊断，让上层无法把它当有效输出
    assert.equal(resp.ok, false, "空 content 且被截断时 ok 必须为 false");
    assert.equal(resp.content, "", "content 仍如实回传空串（不伪造内容）");
    assert.equal(resp.truncated, true, "必须显式带上 truncated 标志");
    assert.match(resp.error, /空 content/, "必须有明确的中文 error 文案");
    assert.match(resp.error, /max_tokens=32/, "error 必须指出本轮 max_tokens");
    assert.match(resp.error, /reasoning|reasoning_content|思维链/, "error 必须指出是思维链耗尽预算");

    // 诊断细节可供上层/日志排查
    assert.equal(resp.diagnostics.reason, "reasoning_token_budget_exhausted");
    assert.equal(resp.diagnostics.finishReason, "length");
    assert.equal(resp.diagnostics.reasoningTokens, 20);
    assert.equal(resp.diagnostics.maxTokens, 32);
    assert.equal(resp.diagnostics.isReasoningModel, true);
    assert.ok(resp.diagnostics.reasoningContentPreview.includes("PONG-7391"), "应能看到思维链片段");

    // 可观测性字段
    assert.equal(resp.reasoningTokens, 20);
    assert.equal(resp.maxTokens, 32);
    assert.ok(resp.reasoningContent.length > 0);
    assert.equal(resp.usage.completion_tokens_details.reasoning_tokens, 20);

    // 网络层仍然是 200 + 正常解析（本问题恰恰是「HTTP 200 但内容为空」）
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].body.max_tokens, 32);
  } finally {
    await fake.close();
  }
});

test("未传 max_tokens 但 finish_reason=length（供应商默认上限过低）→ 同样给出诊断", async () => {
  const fake = await startFakeProvider(() => ({
    body: reasoningResponse({ finishReason: "length", reasoningTokens: 128 })
  }));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });
    const resp = await client.chatCompletion([{ role: "user", content: "x" }]);

    assert.equal("max_tokens" in fake.requests[0].body, false, "不传 maxTokens 时请求体不得带 max_tokens");
    assert.equal(resp.ok, false);
    assert.equal(resp.truncated, true);
    assert.equal(resp.maxTokens, null);
    assert.equal(resp.diagnostics.maxTokens, null);
    assert.match(resp.error, /未传 max_tokens|供应商侧默认上限/, "提示应覆盖「没传也空」的排查路径");
  } finally {
    await fake.close();
  }
});

test("reasoning_tokens 打满 max_tokens（finish_reason 仍为 stop）→ 同样不静默返回空串", async () => {
  const fake = await startFakeProvider(() => ({
    body: reasoningResponse({ content: "", finishReason: "stop", reasoningTokens: 64 })
  }));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });
    const resp = await client.chatText([{ role: "user", content: "x" }], { maxTokens: 64 });

    assert.equal(resp.ok, false);
    assert.equal(resp.truncated, true);
    assert.equal(resp.diagnostics.reason, "reasoning_tokens_saturated");
    assert.match(resp.error, /reasoning_tokens=64/);
  } finally {
    await fake.close();
  }
});

test("【核心】视觉路径（含图）同样受保护：推理模型读图空 content 也返回诊断", async () => {
  const fake = await startFakeProvider(() => ({
    body: reasoningResponse({ finishReason: "length", reasoningTokens: 95 })
  }));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });
    const { buildVisionContent } = await import("../src/services/llm.js");
    const resp = await client.chatVision(
      [{ role: "user", content: buildVisionContent("读出图中文字", [PNG_1X1]) }],
      { maxTokens: 128 }
    );

    assert.equal(resp.ok, false);
    assert.equal(resp.truncated, true);
    assert.equal(resp.reasoningTokens, 95, "视觉用例实测 reasoning_tokens=95 应被如实暴露");
    assert.match(resp.error, /max_tokens=128/);
    assert.equal(fake.requests[0].body.model, "deepseek-flash");
    assert.ok(Array.isArray(fake.requests[0].body.messages[0].content), "视觉请求体仍是多模态数组");
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------------------
// 3. 向后兼容回归：content 非空时行为完全不变
// ---------------------------------------------------------------------------

test("【回归】content 正常（含 reasoning_content）时：ok=true、无 truncated/error，字段与服务旧契约一致", async () => {
  const fake = await startFakeProvider(() => ({
    body: reasoningResponse({
      content: "收到",
      finishReason: "stop",
      reasoningTokens: 14
    })
  }));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });
    const resp = await client.chatText(
      [{ role: "system", content: "只回复收到的内容" }, { role: "user", content: "说话" }],
      { maxTokens: 800 }
    );

    assert.equal(resp.ok, true);
    assert.equal(resp.content, "收到");
    assert.equal(resp.finishReason, "stop");
    assert.equal(resp.model, "deepseek-flash");
    assert.equal(resp.truncated, undefined, "正常响应不得带 truncated");
    assert.equal(resp.error, undefined, "正常响应不得带 error");
    assert.equal(resp.diagnostics, undefined, "正常响应不得带 diagnostics");
    assert.equal(resp.reasoningTokens, 14, "思维链消耗仍应可观测（新增字段，不影响旧字段）");
    assert.equal(resp.maxTokens, 800);
    assert.deepEqual(resp.usage, {
      prompt_tokens: 30,
      completion_tokens: 14,
      total_tokens: 44,
      completion_tokens_details: { reasoning_tokens: 14 }
    });
    // 旧契约字段保持不变
    assert.ok(resp.raw && resp.raw.object === "chat.completion");
  } finally {
    await fake.close();
  }
});

test("【回归】响应缺失 choices/content（无 finish_reason）时仍退化为空串 + ok:true（既有行为不变）", async () => {
  const fake = await startFakeProvider(() => ({ body: JSON.stringify({ model: "deepseek-flash" }) }));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });
    const resp = await client.chatCompletion([{ role: "user", content: "x" }]);

    assert.equal(resp.ok, true, "没有 finish_reason=length 证据时不做臆断，保持旧行为");
    assert.equal(resp.content, "");
    assert.equal(resp.truncated, undefined);
    assert.equal(resp.reasoningTokens, 0);
    assert.equal(resp.maxTokens, null);
  } finally {
    await fake.close();
  }
});

test("【回归】Mock 兜底路径完全不变：无 key 时 content 非空、mock=true、不发请求", async () => {
  const fake = await startFakeProvider(() => ({}));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: "", baseUrl: fake.baseUrl });
    const resp = await client.chatCompletion([{ role: "user", content: "帮我讲解 TCP 三次握手" }]);

    assert.equal(resp.ok, true);
    assert.equal(resp.mock, true);
    assert.ok(resp.content.length > 0);
    assert.equal(resp.truncated, undefined);
    assert.equal(resp.error, undefined);
    assert.equal(fake.requests.length, 0, "无 key 时绝不发请求");
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------------------
// 4. 验证脚本参数合理性（防止「给推理模型传 32/64」的假失败被回退）
// ---------------------------------------------------------------------------

test("验证脚本 token 预算不低于推理模型下限（回归：不得再出现 32 / 64 这类过小值）", () => {
  assert.equal(MIN_REASONING_MODEL_MAX_TOKENS, 512, "推理模型建议下限为 512");
  assert.equal(REASONING_SAFE_VERIFY_TOKENS.text, 1024);
  assert.equal(REASONING_SAFE_VERIFY_TOKENS.vision, 1024);

  assert.equal(MAX_TOKENS_TEXT, 1024, "文本用例不得再使用 maxTokens=32");
  assert.equal(MAX_TOKENS_VISION, 1024, "视觉用例不得再使用 maxTokens=64");
  assert.ok(MAX_TOKENS_TEXT > 32 && MAX_TOKENS_VISION > 64, "两个用例都必须留足 token");
  assert.ok(MAX_TOKENS_TEXT >= MIN_REASONING_MODEL_MAX_TOKENS);
  assert.ok(MAX_TOKENS_VISION >= MIN_REASONING_MODEL_MAX_TOKENS);

  // self-check 函数本身的行为（防止修复被悄悄改小）
  assert.equal(checkTokenBudgets(MAX_TOKENS_TEXT, MAX_TOKENS_VISION), "", "当前预算应通过 self-check");
  assert.match(checkTokenBudgets(32, 64), /过小/, "旧的 32/64 必须被判为过小");
  assert.match(checkTokenBudgets(NaN, 1024), /过小/);
});

test("验证脚本的截断诊断渲染：把 ok:false 响应渲染成一行可读 FAIL 明细", () => {
  const line = formatTruncationDiagnostic({
    truncated: true,
    error: "大模型返回空 content：推理模型思维链耗尽 token 预算",
    finishReason: "length",
    reasoningTokens: 20,
    maxTokens: 32,
    diagnostics: { finishReason: "length", reasoningTokens: 20, maxTokens: 32 }
  });
  assert.match(line, /空 content/);
  assert.match(line, /finish_reason=length/);
  assert.match(line, /reasoning_tokens=20/);
  assert.match(line, /max_tokens=32/);

  // 正常响应 → 空串（不污染 PASS 明细）
  assert.equal(formatTruncationDiagnostic({ ok: true, content: "收到", reasoningTokens: 14 }), "");
  assert.equal(formatTruncationDiagnostic(null), "");
  assert.equal(formatTruncationDiagnostic(undefined), "");
});

// ---------------------------------------------------------------------------
// 5. 调用方防护：空 content 不得被当成有效评分 / 有效知识点
// ---------------------------------------------------------------------------

test("【调用方】AutoGraderEngine：空 content（截断）→ 走规则降级评分，而不是产出空评分卡", async () => {
  const fake = await startFakeProvider(() => ({
    body: reasoningResponse({ content: "", finishReason: "length", reasoningTokens: 32 })
  }));
  try {
    const { AutoGraderEngine, BENCHMARK_RUBRIC } = await import("../src/services/grader.js");
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });
    const engine = new AutoGraderEngine(client);

    const result = await engine.gradeReport({ title: "实验一报告.pdf", content: "实验正文" }, BENCHMARK_RUBRIC);

    assert.equal(result.ok, true, "上层契约不变：始终返回可用结果");
    assert.ok(Number.isFinite(result.totalScore), "必须给出可用的规则降级分数");
    assert.ok(Array.isArray(result.rubricChecks) && result.rubricChecks.length > 0, "评分项不得为空");
    assert.ok(result.summaryReview.length > 0);
  } finally {
    await fake.close();
  }
});

test("【调用方】MaterialParser：空 content（截断）→ 降级标杆模板，而不是返回空知识点数组", async () => {
  const fake = await startFakeProvider(() => ({
    body: reasoningResponse({ content: "", finishReason: "length", reasoningTokens: 64 })
  }));
  try {
    const { MaterialParserService } = await import("../src/services/material-parser.js");
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });
    const parser = new MaterialParserService(client);

    const points = await parser.extractKnowledgePoints("课件正文", "讲义.pdf");
    assert.ok(Array.isArray(points) && points.length > 0, "空 content 不得导致空知识点列表");
    assert.equal(typeof points[0].name, "string");
    assert.equal(typeof points[0].summary, "string");
  } finally {
    await fake.close();
  }
});

test("【调用方】AutoGraderPipeline：空 content（截断）→ 规则判定降级；strictLLM 时把诊断上抛", async () => {
  const fake = await startFakeProvider(() => ({
    body: reasoningResponse({ content: "", finishReason: "length", reasoningTokens: 64 })
  }));
  try {
    const { AutoGraderPipelineService } = await import("../src/services/autograder-pipeline.js");
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });
    const pipeline = new AutoGraderPipelineService({ llmClient: client });

    const report = { title: "实验报告.pdf", pages: 3, content: "正文", diagrams: [] };
    const rubric = [{ id: "network-r0", title: "拓扑描述", max: 10 }];

    const parsed = await pipeline._evaluateWithLLM(report, rubric, {});
    assert.ok(Array.isArray(parsed.items) && parsed.items.length > 0, "必须降级到规则判定而非空结果");
    assert.equal(typeof parsed.summary, "string");

    await assert.rejects(
      () => pipeline._evaluateWithLLM(report, rubric, { strictLLM: true }),
      (err) => {
        assert.match(err.message, /空 content/, "strictLLM 模式下必须把可辨识诊断上抛");
        return true;
      }
    );
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------------------
// 6. 真实 HTTP 路由：伴学答疑不得把空 answer 回给前端（routes/api.js 防护）
// ---------------------------------------------------------------------------

/** 起一个真实 HTTP Server 并挂载 LearnBuddy 路由（与 material-context.test.js 同款宿主模拟） */
async function startApiServer({ llmClient }) {
  const { registerLearnBuddyRoutes } = await import("../src/routes/api.js");
  const { DatabaseStore } = await import("../src/db/store.js");

  const store = new DatabaseStore(":memory:");
  const middlewares = [];
  registerLearnBuddyRoutes({ webServer: { use: (fn) => middlewares.push(fn) } }, { store, llmClient });

  const server = http.createServer(async (req, res) => {
    for (const mw of middlewares) {
      let nextCalled = false;
      await mw(req, res, () => {
        nextCalled = true;
      });
      if (!nextCalled && (res.writableEnded || res.headersSent)) break;
    }
    if (!res.writableEnded && !res.headersSent) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, store, server };
}

/** 极简 POST JSON 请求（复用 material-context.test.js 的契约：返回 statusCode + body Buffer） */
function postJson(port, path, payload) {
  // 身份绑定后这些端点要求令牌，统一在这里补上
  return withAuthHeaders(port, { "Content-Type": "application/json" }).then((headers) =>
    new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(data) }
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks) }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  }));
}

test("【路由防护】POST /qa/ask：模型返回空 content（截断）→ answer 不得为空，回退兜底答案并标记 fallback", async () => {
  const fake = await startFakeProvider(() => ({
    body: reasoningResponse({ content: "", finishReason: "length", reasoningTokens: 40 })
  }));
  const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });
  const { port, store, server } = await startApiServer({ llmClient: client });
  try {
    const res = await postJson(port, "/api/learnbuddy/qa/ask", {
      question: "TCP 拥塞控制中超时重传时 ssthresh 会如何调整？"
    });
    const data = JSON.parse(res.body.toString("utf-8"));

    assert.equal(res.statusCode, 200);
    assert.equal(data.ok, true);
    assert.equal(data.source, "agent_llm", "source 契约保持不变，前端无需改动");
    assert.equal(typeof data.answer, "string");
    assert.ok(data.answer.trim().length > 0, "【核心】answer 绝不能是空串/空白");
    assert.match(data.answer, /LearnBuddy 伴学助手/, "应回退到可读的兜底答案");
    assert.equal(data.fallback, true, "必须标记为兜底，便于前端/日志区分");
    assert.equal(data.truncated, true, "应透出被截断的事实");
    assert.equal(fake.requests.length, 1, "确实调用了模型");
  } finally {
    server.close();
    store.close();
    await fake.close();
  }
});

test("【路由防护】未配置模型时返回明确降级提示，不冒充模型或教师答案", async () => {
  const { port, store, server } = await startApiServer({ llmClient: new MultimodalLLMClient({ env: {} }) });
  try {
    const res = await postJson(port, "/api/learnbuddy/qa/ask", { question: "解释一个不在教师答疑卡中的概念" });
    const data = JSON.parse(res.body.toString("utf-8"));
    assert.equal(data.fallback, true);
    assert.match(data.answer, /未获得可用的模型回答/);
    assert.doesNotMatch(data.answer, /tcp.port|seq/);
  } finally { server.close(); store.close(); }
});

test("【路由回归】POST /qa/ask：模型正常返回内容时行为不变（原样透出 answer，无 fallback 标记）", async () => {
  const fake = await startFakeProvider(() => ({
    body: reasoningResponse({
      content: "ssthresh 会降为当前拥塞窗口的一半，然后进入慢启动重新探测。",
      finishReason: "stop",
      reasoningTokens: 18
    })
  }));
  const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });
  const { port, store, server } = await startApiServer({ llmClient: client });
  try {
    const res = await postJson(port, "/api/learnbuddy/qa/ask", {
      question: "TCP 拥塞控制中超时重传时 ssthresh 会如何调整？"
    });
    const data = JSON.parse(res.body.toString("utf-8"));

    assert.equal(res.statusCode, 200);
    assert.equal(data.ok, true);
    assert.equal(data.source, "agent_llm");
    assert.equal(data.answer, "ssthresh 会降为当前拥塞窗口的一半，然后进入慢启动重新探测。");
    assert.equal(data.fallback, undefined, "正常路径不得带 fallback 标记（旧行为不变）");
    assert.equal(data.truncated, undefined);
  } finally {
    server.close();
    store.close();
    await fake.close();
  }
});
