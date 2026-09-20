/**
 * 契约层「访问契约」测试
 *
 * 验证两件事：
 *   1. **统一信封**：成功响应必须含 schemaVersion / data / evidenceRefs / warnings / asOf / nextCursor
 *   2. **错误码**：失败必须带约定错误码，且**不得用空数组掩盖拒绝访问**
 *
 * 这些是契约，不是实现细节——破坏它们等于破坏 MCP 与 Agent 的分支判断能力。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { DatabaseStore } from "../src/db/store.js";
import { StorageService } from "../src/services/storage.js";
import { registerLearnBuddyRoutes } from "../src/routes/api.js";
import {
  SCHEMA_VERSION,
  ERROR_CODES,
  specifiedCodes,
  isSpecifiedCode,
  classifyError,
  withEnvelope,
  errorBody,
  statusForCode
} from "../src/contracts/envelope.js";
import { withAuthHeaders, tokenFor } from "./helpers/auth.js";

const BASE = "/api/learnbuddy";
const ENVELOPE_FIELDS = [
  "schemaVersion",
  "data",
  "evidenceRefs",
  "warnings",
  "asOf",
  "nextCursor"
];

function makeHttpRequest(port, method, httpPath, headers = {}, body = null) {
  return withAuthHeaders(port, headers).then((authHeaders) => new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: httpPath,
        method,
        headers: authHeaders,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(raw.toString("utf-8"));
          } catch {
            json = null;
          }
          resolve({ statusCode: res.statusCode, headers: res.headers, body: raw, json });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  }));
}

async function startTestServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "learnbuddy-contracts-"));
  const storage = new StorageService({ uploadDir: tmpDir });
  const store = new DatabaseStore(":memory:");
  const middlewares = [];
  registerLearnBuddyRoutes({ webServer: { use: (fn) => middlewares.push(fn) } }, { store, storage });

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
  const port = server.address().port;

  return {
    port,
    store,
    as: async (actor) => ({
      Authorization: `Bearer ${await tokenFor(port, {
        username: { "t-chen": "teacher.chen", "s-yi": "student.lin" }[actor] || actor,
        password: "123"
      })}`
    }),
    get: (p, headers) => makeHttpRequest(port, "GET", p, headers, null),
    post: (p, body, headers = {}) =>
      makeHttpRequest(port, "POST", p, { "Content-Type": "application/json", ...headers }, body),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

// ===========================================================================
// 1. 统一信封
// ===========================================================================

test("契约·信封 - 成功响应必须含六个信封字段，且形状可预测", async () => {
  const t = await startTestServer();
  try {
    const res = await t.get(`${BASE}/materials`, await t.as("t-chen"));
    assert.equal(res.statusCode, 200);

    for (const field of ENVELOPE_FIELDS) {
      assert.ok(
        Object.hasOwn(res.json, field),
        `成功响应必须含 ${field}（统一信封六字段，形状可预测对 Agent 很重要）`
      );
    }
    assert.equal(res.json.schemaVersion, SCHEMA_VERSION);
    assert.ok(Array.isArray(res.json.warnings), "warnings 必须是数组，便于程序遍历");
    assert.ok(Array.isArray(res.json.evidenceRefs), "evidenceRefs 必须是数组");
    assert.equal(res.json.nextCursor, null, "无分页时 nextCursor 应为 null 而不是缺失");
    assert.ok(
      typeof res.json.asOf === "string" && !Number.isNaN(Date.parse(res.json.asOf)),
      "asOf 必须是可解析的时间戳"
    );
    assert.ok(
      res.json.data && typeof res.json.data === "object",
      "data 必须是对象（契约层规定的数据位置）"
    );
    assert.equal(res.json.data.materials !== undefined, true, "data 应含实际业务内容");
  } finally {
    await t.close();
  }
});

test("契约·信封 - 兼容层：既有的扁平字段与 ok 必须保留", async () => {
  const t = await startTestServer();
  try {
    const res = await t.get(`${BASE}/materials`, await t.as("t-chen"));
    // UI 迁移单独排期，所以旧字段不能被拿掉
    assert.equal(res.json.ok, true, "ok 必须保留（现有客户端读它）");
    assert.ok(Array.isArray(res.json.materials), "既有扁平字段 materials 必须保留");
  } finally {
    await t.close();
  }
});

test("契约·信封 - 失败响应 data 固定为 null，不把错误体当数据", async () => {
  const t = await startTestServer();
  try {
    const res = await t.get(`${BASE}/materials`, { skipAuth: true });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.data, null, "失败时 data 必须是 null");
    assert.ok(Array.isArray(res.json.warnings));
    assert.ok(Object.hasOwn(res.json, "schemaVersion"));
  } finally {
    await t.close();
  }
});

// ===========================================================================
// 2. 错误码
// ===========================================================================

test("契约·错误码 - 缺令牌 → 401 + UNAUTHENTICATED", async () => {
  const t = await startTestServer();
  try {
    const res = await t.get(`${BASE}/courses`, { skipAuth: true });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json.code, "UNAUTHENTICATED");
  } finally {
    await t.close();
  }
});

test("契约·错误码 - 越权访问 → FORBIDDEN，且不得用空数组掩盖", async () => {
  const t = await startTestServer();
  try {
    // s-yi 未选修 database，跨课程查作业
    const res = await t.get(`${BASE}/assignments?courseId=database`, await t.as("s-yi"));
    assert.equal(res.statusCode, 403);
    assert.equal(res.json.code, "FORBIDDEN");
    assert.equal(
      res.json.assignments,
      undefined,
      "越权必须是明确的失败，不能退化成成功返回空数组"
    );
  } finally {
    await t.close();
  }
});

test("契约·错误码 - 资源不存在 → 404 + NOT_FOUND", async () => {
  const t = await startTestServer();
  try {
    const res = await t.get(`${BASE}/submissions?assignmentId=lab-nope`, await t.as("t-chen"));
    assert.equal(res.statusCode, 404);
    assert.equal(res.json.code, "NOT_FOUND");
  } finally {
    await t.close();
  }
});

test("契约·错误码 - 缺必填参数 → 400 + 参数类错误码（不得误报成 NOT_FOUND）", async () => {
  const t = await startTestServer();
  try {
    const res = await t.get(`${BASE}/submissions`, await t.as("t-chen"));
    assert.equal(res.statusCode, 400);
    assert.equal(
      res.json.code,
      "INVALID_ARGUMENT",
      "「你没传参数」不能报成「资源不存在」，否则会误导 Agent 去换一个 ID 重试"
    );
    assert.notEqual(res.json.code, "NOT_FOUND");
  } finally {
    await t.close();
  }
});

test("契约·错误码 - 登录失败 → 401 + UNAUTHENTICATED", async () => {
  const t = await startTestServer();
  try {
    const res = await t.post(`${BASE}/auth/login`, {
      username: "teacher.chen",
      password: "wrong-password"
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json.code, "UNAUTHENTICATED");
  } finally {
    await t.close();
  }
});

// ===========================================================================
// 3. 错误码表本身
// ===========================================================================

test("契约·错误码表 - 规范约定的七个码齐全，且各有 HTTP 状态码", () => {
  const expected = [
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "NOT_FOUND",
    "REVISION_CONFLICT",
    "PARSE_FAILED",
    "MODEL_UNAVAILABLE",
    "NOT_REVIEWED"
  ];
  const actual = specifiedCodes();
  for (const code of expected) {
    assert.ok(actual.includes(code), `规范约定的错误码缺了 ${code}`);
    assert.ok(ERROR_CODES[code].status >= 200, `${code} 必须有 HTTP 状态码`);
  }
  assert.equal(actual.length, 7, "规范明确要求「七个错误码」，不得多算");
  assert.equal(isSpecifiedCode("INVALID_ARGUMENT"), false, "参数类错误码不属于规范正式七码");
});

test("契约·错误码表 - NOT_REVIEWED 是正常业务状态，不是异常（HTTP 200）", () => {
  assert.equal(
    ERROR_CODES.NOT_REVIEWED.status,
    200,
    "D2/D3 下未复核是正常状态；它决定 Agent 是礼貌说「还在复核」还是编一个分数"
  );
  assert.match(ERROR_CODES.NOT_REVIEWED.defaultMessage, /复核/);
});

test("契约·归类 - 中文文案能正确归类（含易混的越权/不存在）", () => {
  assert.equal(classifyError("未登录：缺少访问令牌"), "UNAUTHENTICATED");
  assert.equal(classifyError("用户名或密码不正确。演示账号密码为 123。"), "UNAUTHENTICATED");

  // 「权限不足：用户无权访问课程 X 的作业」同时含「无权」与「不存在」时，必须归为越权
  assert.equal(
    classifyError("权限不足：用户「s-yi」无权访问课程「database」的作业"),
    "FORBIDDEN"
  );
  assert.equal(classifyError("课程不存在: nope"), "NOT_FOUND");
  assert.equal(classifyError("缺乏必要参数测试"), "INVALID_ARGUMENT");
  assert.equal(classifyError("缺少必要参数: submissionId"), "INVALID_ARGUMENT");
  assert.equal(classifyError("文件解析失败 [malformed]"), "PARSE_FAILED");
  assert.equal(classifyError("模型服务调用异常，评阅中断"), "MODEL_UNAVAILABLE");
  assert.equal(classifyError("教师尚未复核，成绩暂不可见"), "NOT_REVIEWED");
  assert.equal(classifyError("已有学生提交，请保留原评分标准"), "REVISION_CONFLICT");
});

test("契约·构造 - errorBody 保留 error 文案并新增 code", () => {
  const body = errorBody("FORBIDDEN", { message: "无权访问该课程" });
  assert.equal(body.ok, false);
  assert.equal(body.code, "FORBIDDEN");
  assert.equal(body.error, "无权访问该课程", "error 文案必须保留，现有客户端读它");
  assert.equal(statusForCode("FORBIDDEN"), 403);
  assert.equal(statusForCode("不存在的码"), 400);
});

test("契约·构造 - withEnvelope 始终补齐六个字段", () => {
  const env = withEnvelope({ ok: true, courses: [] });
  for (const field of ENVELOPE_FIELDS) {
    assert.ok(Object.hasOwn(env, field), `缺 ${field}`);
  }
  assert.equal(env.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(env.data, { courses: [] });
  assert.equal(env.ok, true);
  assert.deepEqual(env.courses, [], "扁平字段必须保留");
});
