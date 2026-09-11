/**
 * 多供应商 LLM 接入层（DeepSeek / 智谱 GLM）离线单元测试
 * (Configurable Multi-Provider LLM Client Test Suite — task-10)
 *
 * 设计红线：
 * 1. **绝不发真实外部请求**。所有 HTTP 断言都打到本进程用 `node:http` 起的假供应商
 *    Server（127.0.0.1 随机端口），并显式把 `baseUrl` 指向它。
 * 2. **绝不使用真实密钥**。全部使用 `sk-test-placeholder` 之类的占位值。
 * 3. 覆盖验收标准 1/2/3/4：
 *    - 环境变量驱动与 provider 判定（deepseek / zhipu / 向后兼容 / 非法值回落）
 *    - 端点路径与 `Authorization: Bearer <key>` 头、JSON 输出模式透传
 *    - 模型名路由（有图 → vision 模型；纯文本 → text 模型；显式 task / model 覆盖）
 *    - 多模态消息体形状（content 为数组且含 data URI 的 image_url）
 *    - 响应解析（含数组型 content 归一化、usage/model/finishReason）
 *    - 401 / 超时 / 非 200 / 非 JSON 响应错误处理
 *    - 无 key 时 Mock 兜底且结构合法
 * 4. 本任务基线为 92 个用例，本文件为**新增**用例，不改动既有断言。
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

import {
  MultimodalLLMClient,
  PROVIDER_PRESETS,
  DEFAULT_PROVIDER,
  DEFAULT_TIMEOUT_MS,
  normalizeProvider,
  resolveProviderDefaults,
  resolveLLMConfig,
  toImageUrl,
  buildVisionContent,
  messagesContainImage
} from "../src/services/llm.js";

/** 占位假密钥（红线：仓库内不得出现任何真实密钥） */
const FAKE_KEY = "sk-test-placeholder";

/** 一张 1x1 的最小合法 PNG，用于多模态请求体断言 */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

/**
 * 起一个假供应商 Server：记录收到的请求，按脚本返回响应。
 * @param {(ctx: {url: string, headers: object, body: any, index: number}) => {status?: number, body?: string, delayMs?: number}} responder
 * @returns {Promise<{port: number, baseUrl: string, requests: object[], close: () => Promise<void>}>}
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

      let plan;
      try {
        plan = responder(ctx) || {};
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message } }));
        return;
      }

      const send = () => {
        const status = plan.status ?? 200;
        const payload =
          plan.body !== undefined
            ? plan.body
            : JSON.stringify({
                id: "chatcmpl-test",
                object: "chat.completion",
                model: body?.model || "unknown",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "假供应商应答" },
                    finish_reason: "stop"
                  }
                ],
                usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
              });
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(payload);
      };

      if (plan.delayMs) setTimeout(send, plan.delayMs);
      else send();
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

/** 断言某次请求命中了假供应商的 OpenAI 风格端点与 Bearer 头 */
function assertRequestEnvelope(req, { path = "/chat/completions", key = FAKE_KEY } = {}) {
  assert.equal(req.method, "POST", "必须是 POST");
  assert.equal(req.url, path, `端点路径必须是 ${path}`);
  assert.equal(req.headers.authorization, `Bearer ${key}`, "Authorization 必须是 Bearer <key>");
  assert.match(req.headers["content-type"], /application\/json/, "Content-Type 必须是 JSON");
  assert.equal(req.body.stream, false, "必须显式 stream=false");
  assert.equal(typeof req.headers["content-length"], "string", "必须带 Content-Length");
}

// ---------------------------------------------------------------------------
// 1. 供应商预设与默认值（验收标准 1/2）
// ---------------------------------------------------------------------------

test("LLM 预设：DeepSeek 为默认供应商，base 与视觉模型符合验收标准", () => {
  assert.equal(DEFAULT_PROVIDER, "deepseek");
  assert.deepEqual(Object.keys(PROVIDER_PRESETS).sort(), ["deepseek", "zhipu"]);

  const ds = PROVIDER_PRESETS.deepseek;
  assert.equal(ds.baseUrl, "https://api.deepseek.com");
  assert.equal(ds.visionModel, "deepseek-flash");
  assert.equal(ds.textModel, null, "未配置文本模型时应回落视觉模型");

  const zp = PROVIDER_PRESETS.zhipu;
  assert.equal(zp.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
  assert.equal(zp.visionModel, "glm-4v-flash");
});

test("normalizeProvider：大小写/空白归一化，非法值返回 null", () => {
  assert.equal(normalizeProvider("deepseek"), "deepseek");
  assert.equal(normalizeProvider("  DeepSeek  "), "deepseek");
  assert.equal(normalizeProvider("ZHIPU"), "zhipu");
  assert.equal(normalizeProvider("openai"), null);
  assert.equal(normalizeProvider(""), null);
  assert.equal(normalizeProvider(undefined), null);
  assert.equal(normalizeProvider(null), null);
});

test("resolveProviderDefaults：LLM_* 通用变量优先于供应商历史变量", () => {
  const d = resolveProviderDefaults("zhipu", {
    LLM_BASE_URL: "https://custom.example.com/v1",
    LLM_MODEL_VISION: "custom-vision",
    LLM_MODEL_TEXT: "custom-text",
    ZHIPU_BASE_URL: "https://ignored.example.com",
    GLM_MODEL: "ignored-model"
  });
  assert.equal(d.baseUrl, "https://custom.example.com/v1");
  assert.equal(d.visionModel, "custom-vision");
  assert.equal(d.textModel, "custom-text");
});

test("resolveProviderDefaults：无任何变量时回落预设，末尾斜杠被去除", () => {
  const ds = resolveProviderDefaults("deepseek", {});
  assert.deepEqual(ds, {
    provider: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    visionModel: "deepseek-flash",
    textModel: "deepseek-flash"
  });

  const slash = resolveProviderDefaults("zhipu", { LLM_BASE_URL: "https://x.example.com/v1///" });
  assert.equal(slash.baseUrl, "https://x.example.com/v1", "必须去除末尾斜杠，避免拼出 //chat/completions");
});

test("resolveLLMConfig：显式 LLM_PROVIDER 决定供应商，key 走通用 LLM_API_KEY", () => {
  const cfg = resolveLLMConfig({
    LLM_PROVIDER: "zhipu",
    LLM_API_KEY: FAKE_KEY,
    LLM_MODEL_VISION: "glm-4v-flash"
  });
  assert.equal(cfg.provider, "zhipu");
  assert.equal(cfg.apiKey, FAKE_KEY);
  assert.equal(cfg.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
  assert.equal(cfg.configured, true);
});

test("resolveLLMConfig：非法 LLM_PROVIDER 回落 deepseek 而非抛错", () => {
  const cfg = resolveLLMConfig({ LLM_PROVIDER: "openai", LLM_API_KEY: FAKE_KEY });
  assert.equal(cfg.provider, "deepseek");
  assert.equal(cfg.baseUrl, "https://api.deepseek.com");
  assert.equal(cfg.configured, true);
});

test("向后兼容：只配旧 ZHIPU_API_KEY/GLM_API_KEY 时判定为 zhipu", () => {
  const a = resolveLLMConfig({ ZHIPU_API_KEY: FAKE_KEY });
  assert.equal(a.provider, "zhipu");
  assert.equal(a.apiKey, FAKE_KEY);
  assert.equal(a.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
  assert.equal(a.visionModel, "glm-4v-flash");

  const b = resolveLLMConfig({ GLM_API_KEY: FAKE_KEY, GLM_MODEL: "glm-4v-plus" });
  assert.equal(b.provider, "zhipu");
  assert.equal(b.apiKey, FAKE_KEY, "GLM_API_KEY 也应被识别");
  assert.equal(b.visionModel, "glm-4v-plus", "GLM_MODEL 仍应生效");
});

test("向后兼容：旧 ZHIPU_BASE_URL 生效；DEEPSEEK_API_KEY 单独配置判定为 deepseek", () => {
  const z = resolveLLMConfig({ ZHIPU_API_KEY: FAKE_KEY, ZHIPU_BASE_URL: "https://legacy.zhipu.example.com/v4" });
  assert.equal(z.provider, "zhipu");
  assert.equal(z.baseUrl, "https://legacy.zhipu.example.com/v4");

  const d = resolveLLMConfig({ DEEPSEEK_API_KEY: FAKE_KEY });
  assert.equal(d.provider, "deepseek");
  assert.equal(d.apiKey, FAKE_KEY);
});

test("未配任何 key 时：默认 deepseek 且 configured=false（Mock 兜底前置条件）", () => {
  const cfg = resolveLLMConfig({});
  assert.equal(cfg.provider, "deepseek");
  assert.equal(cfg.apiKey, "");
  assert.equal(cfg.configured, false);
  assert.equal(cfg.baseUrl, "https://api.deepseek.com");
  assert.equal(cfg.visionModel, "deepseek-flash");
});

test("LLM_TIMEOUT_MS：合法正值生效，非法/缺失回落默认 45000ms", () => {
  assert.equal(resolveLLMConfig({ LLM_TIMEOUT_MS: "1200" }).timeoutMs, 1200);
  assert.equal(resolveLLMConfig({ LLM_TIMEOUT_MS: "0" }).timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(resolveLLMConfig({ LLM_TIMEOUT_MS: "-5" }).timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(resolveLLMConfig({ LLM_TIMEOUT_MS: "abc" }).timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(resolveLLMConfig({}).timeoutMs, DEFAULT_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// 2. 构造函数与密钥安全
// ---------------------------------------------------------------------------

test("构造函数：兼容旧签名 new MultimodalLLMClient(key) 字符串形式", () => {
  const client = new MultimodalLLMClient(FAKE_KEY);
  assert.equal(client.apiKey, FAKE_KEY);
  assert.equal(client.isConfigured(), true);
});

test("构造函数：显式 config 覆盖 env；env 为空对象时不影响 process.env", () => {
  const client = new MultimodalLLMClient({
    env: {},
    apiKey: FAKE_KEY,
    provider: "zhipu",
    baseUrl: "http://127.0.0.1:1/v4",
    visionModel: "v-model",
    textModel: "t-model",
    timeoutMs: 999
  });
  assert.equal(client.provider, "zhipu");
  assert.equal(client.baseUrl, "http://127.0.0.1:1/v4");
  assert.equal(client.visionModel, "v-model");
  assert.equal(client.textModel, "t-model");
  assert.equal(client.timeoutMs, 999);
});

test("describe()：配置快照可用于日志，且**绝不泄露完整密钥**", () => {
  const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY });
  const info = client.describe();
  assert.equal(info.provider, "deepseek");
  assert.equal(info.visionModel, "deepseek-flash");
  assert.equal(info.configured, true);
  assert.ok(!JSON.stringify(info).includes(FAKE_KEY), "describe() 不得包含完整密钥");
  assert.equal(info.apiKeyMasked, `${FAKE_KEY.slice(0, 3)}***${FAKE_KEY.slice(-2)}`);
});

// ---------------------------------------------------------------------------
// 3. 图像 / 消息体工具函数（验收标准 4：多模态形状）
// ---------------------------------------------------------------------------

test("toImageUrl：Buffer / base64 / data URI / http URL 四种输入归一化", () => {
  const fromBuffer = toImageUrl(PNG_1X1);
  assert.ok(fromBuffer.startsWith("data:image/png;base64,"), "Buffer 应转 data URI");
  assert.equal(fromBuffer, `data:image/png;base64,${PNG_1X1.toString("base64")}`);

  const fromJpeg = toImageUrl(PNG_1X1, "image/jpeg");
  assert.ok(fromJpeg.startsWith("data:image/jpeg;base64,"), "mimeType 应生效");

  const b64 = PNG_1X1.toString("base64");
  assert.equal(toImageUrl(b64), `data:image/png;base64,${b64}`);

  const dataUri = "data:image/webp;base64,AAAA";
  assert.equal(toImageUrl(dataUri), dataUri, "已是 data URI 时原样返回");

  const remote = "https://example.com/a.png";
  assert.equal(toImageUrl(remote), remote, "http(s) URL 原样返回");

  // 对象形态
  assert.equal(toImageUrl({ mimeType: "image/png", base64: b64 }), `data:image/png;base64,${b64}`);
  assert.equal(toImageUrl({ url: remote }), remote);
  assert.equal(toImageUrl({ dataUri }), dataUri);
  assert.equal(toImageUrl({ mime: "image/gif", data: b64 }), `data:image/gif;base64,${b64}`);
});

test("buildVisionContent：产出 OpenAI 风格 content 数组（text + image_url.data URI）", () => {
  const parts = buildVisionContent("请识别图中文字", [PNG_1X1]);

  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { type: "text", text: "请识别图中文字" });
  assert.equal(parts[1].type, "image_url");
  assert.ok(
    parts[1].image_url.url.startsWith("data:image/png;base64,"),
    "image_url.url 必须是 data URI（DeepSeek 多模态实测形状）"
  );

  // 空文本 / 空图边界
  assert.deepEqual(buildVisionContent("", []), []);
  assert.equal(buildVisionContent("", [PNG_1X1]).length, 1);
  assert.equal(buildVisionContent("hi", []).length, 1);
  assert.equal(buildVisionContent("hi", [null, undefined, ""]).length, 1, "空图片项应被跳过");
  assert.equal(buildVisionContent("hi", [PNG_1X1, PNG_1X1]).length, 3, "多图支持");
});

test("messagesContainImage：准确识别多模态消息", () => {
  assert.equal(messagesContainImage([{ role: "user", content: "纯文本" }]), false);
  assert.equal(messagesContainImage([{ role: "user", content: buildVisionContent("hi", [PNG_1X1]) }]), true);
  assert.equal(messagesContainImage([{ role: "user", content: [{ type: "text", text: "hi" }] }]), false);
  assert.equal(messagesContainImage([]), false);
  assert.equal(messagesContainImage(undefined), false);
});

// ---------------------------------------------------------------------------
// 4. 端到端：端点 / 鉴权 / 模型路由 / 消息体（验收标准 2/3/4）
// ---------------------------------------------------------------------------

test("chatCompletion：命中 /chat/completions，Bearer 头正确，响应字段解析完整", async () => {
  const fake = await startFakeProvider(() => ({}));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });
    const resp = await client.chatCompletion([{ role: "user", content: "你好" }]);

    assert.equal(fake.requests.length, 1);
    assertRequestEnvelope(fake.requests[0]);

    assert.equal(resp.ok, true);
    assert.equal(resp.content, "假供应商应答");
    assert.equal(resp.model, "deepseek-flash", "假供应商回显请求模型");
    assert.equal(resp.finishReason, "stop");
    assert.deepEqual(resp.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
    assert.equal(resp.raw.object, "chat.completion");
  } finally {
    await fake.close();
  }
});

test("baseUrl 末尾斜杠不会拼出 //chat/completions", async () => {
  const fake = await startFakeProvider(() => ({}));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: `${fake.baseUrl}///` });
    await client.chatCompletion([{ role: "user", content: "hi" }]);
    assert.equal(fake.requests[0].url, "/chat/completions");
  } finally {
    await fake.close();
  }
});

test("模型路由：纯文本走 text 模型，含图自动走 vision 模型", async () => {
  const fake = await startFakeProvider(() => ({}));
  try {
    const client = new MultimodalLLMClient({
      env: {},
      apiKey: FAKE_KEY,
      baseUrl: fake.baseUrl,
      visionModel: "vision-model-x",
      textModel: "text-model-y"
    });

    await client.chatCompletion([{ role: "user", content: "纯文本提问" }]);
    assert.equal(fake.requests[0].body.model, "text-model-y", "纯文本必须走 text 模型");

    await client.chatCompletion([
      { role: "user", content: buildVisionContent("看图", [PNG_1X1]) }
    ]);
    assert.equal(fake.requests[1].body.model, "vision-model-x", "含图必须走 vision 模型");
  } finally {
    await fake.close();
  }
});

test("chatText / chatVision：显式强制模型路径，即使消息里带图", async () => {
  const fake = await startFakeProvider(() => ({}));
  try {
    const client = new MultimodalLLMClient({
      env: {},
      apiKey: FAKE_KEY,
      baseUrl: fake.baseUrl,
      visionModel: "vision-model-x",
      textModel: "text-model-y"
    });

    await client.chatText([{ role: "user", content: "文本任务" }]);
    assert.equal(fake.requests[0].body.model, "text-model-y");

    // 关键：task=text 时即便消息含图也走文本模型（不静默升级）
    await client.chatText([{ role: "user", content: buildVisionContent("x", [PNG_1X1]) }]);
    assert.equal(fake.requests[1].body.model, "text-model-y");

    await client.chatVision([{ role: "user", content: "视觉任务" }]);
    assert.equal(fake.requests[2].body.model, "vision-model-x", "task=vision 即便无图也走 vision 模型");
  } finally {
    await fake.close();
  }
});

test("显式 options.model 优先级最高，可覆盖任务路由", async () => {
  const fake = await startFakeProvider(() => ({}));
  try {
    const client = new MultimodalLLMClient({
      env: {},
      apiKey: FAKE_KEY,
      baseUrl: fake.baseUrl,
      visionModel: "vision-model-x",
      textModel: "text-model-y"
    });
    await client.chatCompletion([{ role: "user", content: "x" }], { model: "explicit-model-z" });
    assert.equal(fake.requests[0].body.model, "explicit-model-z");
  } finally {
    await fake.close();
  }
});

test("多模态请求体形状：content 为数组，含 text 与 image_url 的 data URI", async () => {
  const fake = await startFakeProvider(() => ({}));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });
    await client.chatVision([
      { role: "system", content: "你是助教" },
      { role: "user", content: buildVisionContent("读出图中的英文文字", [PNG_1X1]) }
    ]);

    const sent = fake.requests[0].body;
    assert.equal(sent.model, "deepseek-flash");
    assert.equal(sent.messages.length, 2);

    const userContent = sent.messages[1].content;
    assert.ok(Array.isArray(userContent), "多模态时 content 必须是数组");
    assert.equal(userContent[0].type, "text");
    assert.equal(userContent[0].text, "读出图中的英文文字");
    assert.equal(userContent[1].type, "image_url");
    assert.ok(userContent[1].image_url.url.startsWith("data:image/png;base64,"));
  } finally {
    await fake.close();
  }
});

test("JSON 输出模式：response_format 正确透传；未指定时不带该字段", async () => {
  const fake = await startFakeProvider(() => ({}));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });

    await client.chatCompletion([{ role: "user", content: "输出 JSON" }], { responseFormat: "json_object" });
    assert.deepEqual(fake.requests[0].body.response_format, { type: "json_object" });

    await client.chatCompletion([{ role: "user", content: "普通对话" }]);
    assert.equal("response_format" in fake.requests[1].body, false, "未指定时不得带 response_format");

    // 非 json_object 值不应被透传（避免发出供应商不认的枚举）
    await client.chatCompletion([{ role: "user", content: "x" }], { responseFormat: "text" });
    assert.equal("response_format" in fake.requests[2].body, false);
  } finally {
    await fake.close();
  }
});

test("可选参数：temperature 与 max_tokens 仅在合法时透传", async () => {
  const fake = await startFakeProvider(() => ({}));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });

    await client.chatCompletion([{ role: "user", content: "x" }], { temperature: 0.9, maxTokens: 512 });
    assert.equal(fake.requests[0].body.temperature, 0.9);
    assert.equal(fake.requests[0].body.max_tokens, 512);

    await client.chatCompletion([{ role: "user", content: "x" }]);
    assert.equal(fake.requests[1].body.temperature, 0.2, "默认 temperature 为 0.2");
    assert.equal("max_tokens" in fake.requests[1].body, false);

    await client.chatCompletion([{ role: "user", content: "x" }], { maxTokens: 0 });
    assert.equal("max_tokens" in fake.requests[2].body, false, "maxTokens<=0 不应透传");
  } finally {
    await fake.close();
  }
});

test("响应解析：数组型 content 被归一化为字符串（兼容供应商差异）", async () => {
  const fake = await startFakeProvider(() => ({
    body: JSON.stringify({
      model: "deepseek-flash",
      choices: [
        {
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "第一段" },
              { type: "text", text: "第二段" }
            ]
          },
          finish_reason: "stop"
        }
      ]
    })
  }));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });
    const resp = await client.chatCompletion([{ role: "user", content: "x" }]);
    assert.equal(resp.content, "第一段第二段");
  } finally {
    await fake.close();
  }
});

test("响应解析：choices/content 缺失时 content 退化为空串而非崩溃", async () => {
  const fake = await startFakeProvider(() => ({ body: JSON.stringify({ model: "deepseek-flash" }) }));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });
    const resp = await client.chatCompletion([{ role: "user", content: "x" }]);
    assert.equal(resp.ok, true);
    assert.equal(resp.content, "");
    assert.equal(resp.finishReason, undefined);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------------------
// 5. 错误处理：401 / 非 200 / 非 JSON / 超时（验收标准 4）
// ---------------------------------------------------------------------------

test("401 未授权：抛错且带 status / provider / body，不走 Mock 兜底", async () => {
  const fake = await startFakeProvider(() => ({
    status: 401,
    body: JSON.stringify({ error: { message: "Authentication Fails, Your api key is invalid" } })
  }));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });
    await assert.rejects(
      () => client.chatCompletion([{ role: "user", content: "x" }]),
      (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.provider, "deepseek");
        assert.match(err.message, /API Error \[401\]/);
        assert.match(err.message, /api key is invalid/);
        assert.deepEqual(err.body, { error: { message: "Authentication Fails, Your api key is invalid" } });
        return true;
      },
      "配置了 key 时 401 必须抛错，而不是静默 Mock"
    );
    assert.equal(fake.requests.length, 1, "401 不应重试");
  } finally {
    await fake.close();
  }
});

test("非 200（500 / 429）：抛错并回传状态码与错误体", async () => {
  const fake = await startFakeProvider((ctx) =>
    ctx.index === 0
      ? { status: 500, body: JSON.stringify({ error: { message: "internal server error" } }) }
      : { status: 429, body: JSON.stringify({ error: { message: "rate limit exceeded" } }) }
  );
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });

    await assert.rejects(
      () => client.chatCompletion([{ role: "user", content: "x" }]),
      (err) => err.status === 500 && /internal server error/.test(err.message)
    );
    await assert.rejects(
      () => client.chatCompletion([{ role: "user", content: "x" }]),
      (err) => err.status === 429 && /rate limit exceeded/.test(err.message)
    );
  } finally {
    await fake.close();
  }
});

test("非 JSON 错误体：仍以状态码抛错，错误信息回落到原始文本", async () => {
  const fake = await startFakeProvider(() => ({ status: 502, body: "<html>Bad Gateway</html>" }));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });
    await assert.rejects(
      () => client.chatCompletion([{ role: "user", content: "x" }]),
      (err) => err.status === 502 && /Bad Gateway/.test(err.message)
    );
  } finally {
    await fake.close();
  }
});

test("200 但响应体不是合法 JSON：抛解析失败错误", async () => {
  const fake = await startFakeProvider(() => ({ status: 200, body: "not-json-at-all" }));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });
    await assert.rejects(
      () => client.chatCompletion([{ role: "user", content: "x" }]),
      (err) => /解析响应失败/.test(err.message) && /not-json-at-all/.test(err.message)
    );
  } finally {
    await fake.close();
  }
});

test("超时：服务端挂起超过 timeoutMs 时抛出 ETIMEDOUT", async () => {
  const fake = await startFakeProvider(() => ({ delayMs: 3000 }));
  try {
    const client = new MultimodalLLMClient({
      env: {},
      apiKey: FAKE_KEY,
      baseUrl: fake.baseUrl,
      timeoutMs: 150
    });

    const startedAt = Date.now();
    await assert.rejects(
      () => client.chatCompletion([{ role: "user", content: "x" }]),
      (err) => {
        assert.equal(err.code, "ETIMEDOUT");
        assert.equal(err.timedOut, true);
        assert.match(err.message, /超时/);
        return true;
      }
    );
    assert.ok(Date.now() - startedAt < 2500, "必须在 timeoutMs 附近快速失败，而不是等满 3s");
  } finally {
    await fake.close();
  }
});

test("连接失败（端口无监听）：错误原样上抛，不伪装成 Mock", async () => {
  // 先拿一个空闲端口再关掉，确保无人监听
  const probe = await startFakeProvider(() => ({}));
  const deadPort = probe.port;
  await probe.close();

  const client = new MultimodalLLMClient({
    env: {},
    apiKey: FAKE_KEY,
    baseUrl: `http://127.0.0.1:${deadPort}`,
    timeoutMs: 2000
  });
  await assert.rejects(
    () => client.chatCompletion([{ role: "user", content: "x" }]),
    (err) => {
      assert.equal(err.ok, undefined, "错误对象不应带 ok:true");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 6. Mock 兜底（验收标准 3：未配 key 防翻车）
// ---------------------------------------------------------------------------

test("无 key 兜底：返回结构合法的 { ok, content, mock }，且不发起任何网络请求", async () => {
  const fake = await startFakeProvider(() => ({}));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: "", baseUrl: fake.baseUrl });
    assert.equal(client.isConfigured(), false);

    const resp = await client.chatCompletion([{ role: "user", content: "帮我讲解 TCP 三次握手" }]);

    assert.equal(resp.ok, true);
    assert.equal(resp.mock, true);
    assert.equal(typeof resp.content, "string");
    assert.ok(resp.content.length > 0, "Mock content 不能为空");
    assert.equal(fake.requests.length, 0, "无 key 时绝不发起真实网络请求");
  } finally {
    await fake.close();
  }
});

test("无 key 兜底：评分意图返回可解析的 JSON（Rubric 结构合法）", async () => {
  const fake = await startFakeProvider(() => ({}));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: "", baseUrl: fake.baseUrl });
    const resp = await client.chatCompletion(
      [{ role: "user", content: "请对照评分标准 rubric 评分并输出 JSON" }],
      { responseFormat: "json_object" }
    );

    const parsed = JSON.parse(resp.content);
    assert.equal(typeof parsed.totalScore, "number");
    assert.ok(Array.isArray(parsed.rubricChecks) && parsed.rubricChecks.length > 0);
    for (const item of parsed.rubricChecks) {
      assert.equal(typeof item.item, "string");
      assert.equal(typeof item.score, "number");
      assert.equal(typeof item.max, "number");
      assert.ok(item.score <= item.max, "单项得分不得超过满分");
    }
    const sum = parsed.rubricChecks.reduce((acc, i) => acc + i.score, 0);
    assert.ok(sum <= parsed.totalScore || sum <= 100, "Mock 分数自洽");
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

test("无 key 兜底：多模态消息（content 为数组）也能被正确解析意图", async () => {
  const fake = await startFakeProvider(() => ({}));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: "", baseUrl: fake.baseUrl });
    const resp = await client.chatVision([
      { role: "user", content: buildVisionContent("请评分 rubric", [PNG_1X1]) }
    ]);
    assert.equal(resp.ok, true);
    assert.equal(resp.mock, true);
    const parsed = JSON.parse(resp.content);
    assert.ok(Array.isArray(parsed.rubricChecks), "数组型 content 中的文本仍应触发评分意图");
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------------------
// 7. Provider 切换：端点必须跟着走（验收标准 1）
// ---------------------------------------------------------------------------

test("provider 切换：deepseek ↔ zhipu 命中各自端点，且默认 base 与预置一致", async () => {
  const ds = await startFakeProvider(() => ({}));
  const zp = await startFakeProvider(() => ({}));
  try {
    const dsClient = new MultimodalLLMClient({
      env: { LLM_PROVIDER: "deepseek" },
      apiKey: FAKE_KEY,
      baseUrl: ds.baseUrl
    });
    const zpClient = new MultimodalLLMClient({
      env: { LLM_PROVIDER: "zhipu" },
      apiKey: FAKE_KEY,
      baseUrl: zp.baseUrl
    });

    assert.equal(dsClient.provider, "deepseek");
    assert.equal(zpClient.provider, "zhipu");

    await dsClient.chatCompletion([{ role: "user", content: "x" }]);
    await zpClient.chatCompletion([{ role: "user", content: "x" }]);

    assert.equal(ds.requests.length, 1);
    assert.equal(zp.requests.length, 1);
    assert.equal(zp.requests[0].url, "/chat/completions", "zhipu 同样是 OpenAI 风格端点");
    assertRequestEnvelope(ds.requests[0]);
    assertRequestEnvelope(zp.requests[0]);
  } finally {
    await ds.close();
    await zp.close();
  }
});

test("provider 开关不改代码：仅换环境变量即可把请求打到不同端点与模型", async () => {
  const fake = await startFakeProvider(() => ({}));
  try {
    // 同一份构造代码，仅 env 不同
    const build = (env) => new MultimodalLLMClient({ env, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });

    const dsClient = build({ LLM_PROVIDER: "deepseek" });
    assert.equal(dsClient.visionModel, "deepseek-flash");
    assert.equal(dsClient.textModel, "deepseek-flash");

    const zpClient = build({ LLM_PROVIDER: "zhipu" });
    assert.equal(zpClient.visionModel, "glm-4v-flash");
    assert.equal(zpClient.textModel, "glm-4v-flash", "未配置文本模型时保持旧行为");

    // 也支持通过 LLM_MODEL_TEXT 单独拆出文本模型
    const split = build({ LLM_PROVIDER: "deepseek", LLM_MODEL_VISION: "deepseek-flash", LLM_MODEL_TEXT: "deepseek-v4-pro" });
    await split.chatCompletion([{ role: "user", content: "纯文本" }]);
    assert.equal(fake.requests[0].body.model, "deepseek-v4-pro");
    await split.chatCompletion([{ role: "user", content: buildVisionContent("看图", [PNG_1X1]) }]);
    assert.equal(fake.requests[1].body.model, "deepseek-flash");
  } finally {
    await fake.close();
  }
});

test("zhipu 未配置文本模型时行为与旧版一致（仍使用 GLM_MODEL/glm-4v-flash）", async () => {
  const fake = await startFakeProvider(() => ({}));
  try {
    const client = new MultimodalLLMClient({
      env: { ZHIPU_API_KEY: FAKE_KEY, GLM_MODEL: "glm-4v-flash" },
      baseUrl: fake.baseUrl
    });
    assert.equal(client.provider, "zhipu");
    await client.chatCompletion([{ role: "user", content: "纯文本也必须打到 glm-4v-flash" }]);
    assert.equal(fake.requests[0].body.model, "glm-4v-flash");
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------------------
// 8. 既有调用方契约（不破既有：grader / material-parser / autograder-pipeline）
// ---------------------------------------------------------------------------

test("旧调用契约：chatCompletion(messages, { responseFormat }) 签名与返回结构不变", async () => {
  const fake = await startFakeProvider(() => ({
    body: JSON.stringify({
      model: "deepseek-flash",
      choices: [
        {
          message: { role: "assistant", content: "{\"totalScore\":88,\"rubricChecks\":[]}" },
          finish_reason: "stop"
        }
      ],
      usage: { total_tokens: 12 }
    })
  }));
  try {
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });
    const resp = await client.chatCompletion(
      [
        { role: "system", content: "你是 AutoGrader" },
        { role: "user", content: "请评分 rubric" }
      ],
      { responseFormat: "json_object" }
    );

    // grader.js / autograder-pipeline.js 依赖：resp.content 可 JSON.parse
    assert.equal(resp.ok, true);
    assert.equal(typeof resp.content, "string");
    assert.equal(JSON.parse(resp.content).totalScore, 88);
    assert.ok(resp.usage && resp.raw, "usage 与 raw 字段保持可用");
  } finally {
    await fake.close();
  }
});

test("MaterialParser 契约：含图课件走视觉模型，content 为多模态数组", async () => {
  const fake = await startFakeProvider(() => ({
    body: JSON.stringify({
      model: "deepseek-flash",
      choices: [
        {
          message: {
            role: "assistant",
            content: JSON.stringify({
              points: [{ id: "kp-1", name: "TCP 三次握手", summary: "看图得出", page: 1, difficulty: "核心" }]
            })
          },
          finish_reason: "stop"
        }
      ]
    })
  }));
  try {
    const { MaterialParserService } = await import("../src/services/material-parser.js");
    const client = new MultimodalLLMClient({
      env: {},
      apiKey: FAKE_KEY,
      baseUrl: fake.baseUrl,
      visionModel: "vision-model-x",
      textModel: "text-model-y"
    });
    const parser = new MaterialParserService(client);

    // 直接验证 extractKnowledgePoints 的「第三参赛参 = 图片」契约
    const points = await parser.extractKnowledgePoints("课件正文", "切片截图.png", [PNG_1X1]);
    assert.equal(points[0].name, "TCP 三次握手");

    const sent = fake.requests[0].body;
    assert.equal(sent.model, "vision-model-x", "含图课件必须走视觉模型");
    assert.ok(Array.isArray(sent.messages[1].content), "含图时 content 必须是数组");
    assert.equal(sent.messages[1].content[1].type, "image_url");

    // 纯文本课件仍走文本模型，且 content 为字符串（旧行为不变）
    const points2 = await parser.extractKnowledgePoints("纯文本正文", "讲义.txt");
    assert.equal(points2.length, 1);
    assert.equal(fake.requests[1].body.model, "text-model-y");
    assert.equal(typeof fake.requests[1].body.messages[1].content, "string");
  } finally {
    await fake.close();
  }
});

test("MaterialParser：视觉路径失败时降级为题库模板，不抛错到路由层", async () => {
  const fake = await startFakeProvider(() => ({ status: 500, body: JSON.stringify({ error: { message: "boom" } }) }));
  try {
    const { MaterialParserService } = await import("../src/services/material-parser.js");
    const client = new MultimodalLLMClient({ env: {}, apiKey: FAKE_KEY, baseUrl: fake.baseUrl });
    const parser = new MaterialParserService(client);

    const points = await parser.extractKnowledgePoints("正文", "截图.png", [PNG_1X1]);
    assert.ok(Array.isArray(points) && points.length >= 3, "降级模板应返回可用的知识点列表");
    assert.equal(typeof points[0].id, "string");
    assert.equal(typeof points[0].summary, "string");
  } finally {
    await fake.close();
  }
});

test("MaterialParser.parseAndExtract：真实落盘的图片课件走视觉模型并内联图片（端到端）", async () => {
  const fake = await startFakeProvider(() => ({
    body: JSON.stringify({
      model: "deepseek-flash",
      choices: [
        {
          message: {
            role: "assistant",
            content: JSON.stringify({
              points: [{ id: "kp-1", name: "从图片提取的考点", summary: "图片解析成功", page: 1, difficulty: "核心" }]
            })
          },
          finish_reason: "stop"
        }
      ]
    })
  }));

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "learnbuddy-llm-test-"));
  try {
    const { MaterialParserService } = await import("../src/services/material-parser.js");
    const { renderTextPng } = await import("../scripts/lib/png-text.mjs");

    const client = new MultimodalLLMClient({
      env: {},
      apiKey: FAKE_KEY,
      baseUrl: fake.baseUrl,
      visionModel: "vision-model-x",
      textModel: "text-model-y"
    });
    const parser = new MaterialParserService(client);

    // 写一张真实的、内容确定的 PNG 到磁盘，再走完整 parseAndExtract 链路
    const pngPath = path.join(tmpDir, "lecture-slide.png");
    await fs.writeFile(pngPath, renderTextPng("DEEPSEEK", 10));

    const result = await parser.parseAndExtract(pngPath, "lecture-slide.png");

    assert.equal(result.ext, ".png");
    assert.equal(result.title, "lecture-slide.png");
    assert.equal(result.status, "parsed");
    assert.equal(result.knowledgePoints.length, 1);
    assert.equal(result.knowledgePoints[0].name, "从图片提取的考点");

    // 关键：图片课件必须走视觉模型，且请求体里真的带了图片 data URI
    assert.equal(fake.requests.length, 1, "图片课件应只发一次模型请求");
    const sent = fake.requests[0].body;
    assert.equal(sent.model, "vision-model-x", "图片课件必须走 LLM_MODEL_VISION");

    const userContent = sent.messages[1].content;
    assert.ok(Array.isArray(userContent), "图片课件的 content 必须是多模态数组");
    const imagePart = userContent.find((p) => p.type === "image_url");
    assert.ok(imagePart, "content 中必须含 image_url 部分");
    assert.ok(
      imagePart.image_url.url.startsWith("data:image/png;base64,"),
      "图片必须被内联为 PNG data URI"
    );
    // data URI 解回来应与磁盘上的 PNG 字节一致
    const decoded = Buffer.from(imagePart.image_url.url.split(",")[1], "base64");
    assert.ok(decoded.equals(await fs.readFile(pngPath)), "内联的图片字节必须与磁盘文件一致");
  } finally {
    await fake.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("MaterialParser.parseAndExtract：纯文本课件走文本模型且 content 为字符串（旧行为不变）", async () => {
  const fake = await startFakeProvider(() => ({
    body: JSON.stringify({
      model: "text-model-y",
      choices: [
        {
          message: {
            role: "assistant",
            content: JSON.stringify({
              points: [{ id: "kp-1", name: "文本考点", summary: "文本解析成功", page: 2, difficulty: "基础" }]
            })
          },
          finish_reason: "stop"
        }
      ]
    })
  }));

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "learnbuddy-llm-test-"));
  try {
    const { MaterialParserService } = await import("../src/services/material-parser.js");
    const client = new MultimodalLLMClient({
      env: {},
      apiKey: FAKE_KEY,
      baseUrl: fake.baseUrl,
      visionModel: "vision-model-x",
      textModel: "text-model-y"
    });
    const parser = new MaterialParserService(client);

    const txtPath = path.join(tmpDir, "handout.txt");
    await fs.writeFile(txtPath, "实验讲义正文：TCP 三次握手与 Wireshark 抓包分析。", "utf-8");

    const result = await parser.parseAndExtract(txtPath, "handout.txt");
    assert.equal(result.ext, ".txt");
    assert.equal(result.rawContentSummary.includes("TCP 三次握手"), true);

    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].body.model, "text-model-y", "纯文本课件必须走 LLM_MODEL_TEXT");
    assert.equal(
      typeof fake.requests[0].body.messages[1].content,
      "string",
      "纯文本课件的 content 必须仍是字符串（不破坏旧行为）"
    );
  } finally {
    await fake.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
