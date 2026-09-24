/**
 * 批注端点（`/submissions/:id/annotations`）的权限与 D2 测试
 *
 * 背景：这个端点是 2026-09-21 从 `main` 合并进来的。合并前它的实现是
 * `store.getSubmission(submissionId)` —— **不传 userId**，而 store 在拿不到身份时
 * 不做任何权限判断，于是：
 *   - 任何登录用户可读任意提交的批注
 *   - 任何登录用户（含学生）可给任意提交写批注
 * 且批注的 `comment` 属于 D2 的「详细评语与依据」，教师确认前不应给学生看。
 *
 * 这个文件守住修复后的行为，避免以后又被改回去。
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
import { withAuthHeaders, tokenFor } from "./helpers/auth.js";

const BASE = "/api/learnbuddy";

const ACCOUNT_OF = {
  "t-chen": "teacher.chen",
  "t-lin": "teacher.lin",
  "s-yi": "student.lin",
  "s-xu": "student.xu",
  "s-zhou": "student.zhou"
};

function makeHttpRequest(port, method, httpPath, headers = {}, body = null) {
  return withAuthHeaders(port, headers).then((authHeaders) => new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: httpPath, method, headers: authHeaders },
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
          resolve({ statusCode: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  }));
}

async function startTestServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "learnbuddy-anno-"));
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
      Authorization: `Bearer ${await tokenFor(port, { username: ACCOUNT_OF[actor] || actor, password: "123" })}`
    }),
    get: (p, headers) => makeHttpRequest(port, "GET", p, headers, null),
    post: (p, body, headers = {}) =>
      makeHttpRequest(port, "POST", p, { "Content-Type": "application/json", ...headers }, body),
    put: (p, body, headers = {}) =>
      makeHttpRequest(port, "PUT", p, { "Content-Type": "application/json", ...headers }, body),
    delete: (p, headers = {}) => makeHttpRequest(port, "DELETE", p, headers, null),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

/** 给某份提交塞一条批注，便于验证读取端。 */
function seedAnnotation(store, submissionId, comment) {
  store.updateSubmission(submissionId, {
    annotations: [
      {
        id: `anno-seed-${submissionId}`,
        page: 1,
        quote: "原文摘录",
        comment,
        color: "yellow",
        createdAt: "2026-09-21T00:00:00.000Z"
      }
    ]
  });
}

// ===========================================================================
// 1. 认证
// ===========================================================================

test("批注·认证 - 不带令牌一律 401（读和写都是）", async () => {
  const t = await startTestServer();
  try {
    const read = await t.get(`${BASE}/submissions/sub-xu-os/annotations`, { skipAuth: true });
    assert.equal(read.statusCode, 401, "读批注必须要求登录");
    assert.equal(read.json.code, "UNAUTHENTICATED");

    const write = await t.post(
      `${BASE}/submissions/sub-xu-os/annotations`,
      { page: 1, comment: "绕过尝试" },
      { skipAuth: true }
    );
    assert.equal(write.statusCode, 401, "写批注必须要求登录");
  } finally {
    await t.close();
  }
});

// ===========================================================================
// 2. 越权读取（修复前任何人都能读）
// ===========================================================================

test("批注·越权 - 学生读别人的提交批注必须被拒（且不泄露是否存在）", async () => {
  const t = await startTestServer();
  try {
    // s-xu 的提交，由 s-zhou 去读（两人都选了 network，但不是本人）
    seedAnnotation(t.store, "sub-xu-os", "老师给许然的批注内容");

    const res = await t.get(`${BASE}/submissions/sub-xu-os/annotations`, await t.as("s-zhou"));
    assert.equal(res.statusCode, 404, "越权读取应当被拒");
    assert.equal(
      res.json.annotations,
      undefined,
      "拒绝时不得返回任何批注内容"
    );
    assert.ok(
      !JSON.stringify(res.json).includes("许然"),
      "拒绝响应里不得泄漏批注正文"
    );
  } finally {
    await t.close();
  }
});

test("批注·越权 - 不存在的提交与无权访问返回同样的 404（避免探测存在性）", async () => {
  const t = await startTestServer();
  try {
    const ghost = await t.get(`${BASE}/submissions/sub-nope/annotations`, await t.as("t-chen"));
    const forbidden = await t.get(`${BASE}/submissions/sub-xu-os/annotations`, await t.as("s-zhou"));
    assert.equal(ghost.statusCode, 404);
    assert.equal(forbidden.statusCode, 404);
    assert.equal(
      ghost.json.error,
      forbidden.json.error,
      "两种情况的文案也要一致，否则仍可用文案差异探测"
    );
  } finally {
    await t.close();
  }
});

// ===========================================================================
// 3. D2：教师确认前学生看不到批注
// ===========================================================================

test("批注·D2 - 学生读自己「未发布」提交的批注：置空", async () => {
  const t = await startTestServer();
  try {
    // sub-xu-os 状态为 review（未发布），批注里有评语性质的 comment
    assert.notEqual(
      t.store.getSubmission("sub-xu-os").status,
      "published",
      "前置条件：这份提交应当未发布"
    );
    seedAnnotation(t.store, "sub-xu-os", "这段评语在教师确认前不该给学生看");

    const res = await t.get(`${BASE}/submissions/sub-xu-os/annotations`, await t.as("s-xu"));
    assert.equal(res.statusCode, 200, "本人可以访问这个资源，只是内容要按 D2 置空");
    assert.deepEqual(res.json.annotations, [], "未发布时批注必须置空");
    assert.ok(
      !JSON.stringify(res.json).includes("不该给学生看"),
      "批注正文不得泄漏"
    );
  } finally {
    await t.close();
  }
});

test("批注·D2 - 教师始终能看到批注（含未发布）", async () => {
  const t = await startTestServer();
  try {
    seedAnnotation(t.store, "sub-xu-os", "老师自己的批注");

    const res = await t.get(`${BASE}/submissions/sub-xu-os/annotations`, await t.as("t-chen"));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.annotations.length, 1, "教师应看到完整批注");
    assert.equal(res.json.annotations[0].comment, "老师自己的批注");
  } finally {
    await t.close();
  }
});

test("批注·D2 - 发布之后学生才看得到", async () => {
  const t = await startTestServer();
  try {
    seedAnnotation(t.store, "sub-yi-os", "已发布的批注内容");

    // sub-yi-os 在种子里是 published
    assert.equal(t.store.getSubmission("sub-yi-os").status, "published");

    const res = await t.get(`${BASE}/submissions/sub-yi-os/annotations`, await t.as("s-yi"));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.annotations.length, 1, "发布后学生应能看到批注");
    assert.equal(res.json.annotations[0].comment, "已发布的批注内容");
  } finally {
    await t.close();
  }
});

// ===========================================================================
// 4. 写入：只有教师能写（修复前学生也能写）
// ===========================================================================

test("批注·写入 - 学生写批注必须 403（修复前任何人都能写）", async () => {
  const t = await startTestServer();
  try {
    const res = await t.post(
      `${BASE}/submissions/sub-xu-os/annotations`,
      { page: 1, quote: "学生自己加的", comment: "学生试图写批注" },
      await t.as("s-xu")
    );
    assert.equal(res.statusCode, 403, "学生不得写批注");
    assert.equal(res.json.code, "FORBIDDEN");

    const after = t.store.getSubmission("sub-xu-os");
    assert.deepEqual(after.annotations, [], "被拒的写入不得落库");
  } finally {
    await t.close();
  }
});

test("批注·写入 - 非任课教师不能写（返回 404，与不存在同形）", async () => {
  const t = await startTestServer();
  try {
    // t-lin 只教 database，sub-xu-os 属于 os 课程。
    // 注意这里**刻意返回 404 而不是 403**：无权与不存在返回同一结果，
    // 外部就无法用状态码差异去探测「某份提交是否存在」。
    // 但「已确认存在且可读、只是角色不够」的情形（学生写自己已发布提交的批注）
    // 仍返回 403 —— 因为那时存在性本来就不是秘密。
    const res = await t.post(
      `${BASE}/submissions/sub-xu-os/annotations`,
      { page: 1, comment: "跨课程越权写入" },
      await t.as("t-lin")
    );
    assert.equal(res.statusCode, 404, "跨课程教师：与不存在同形，避免探测");
    assert.equal(res.json.annotation, undefined, "被拒时不得返回写入结果");
    assert.deepEqual(t.store.getSubmission("sub-xu-os").annotations, [], "不得落库");
  } finally {
    await t.close();
  }
});

test("批注·写入 - 任课教师可以写，并且写得进去、读得回来", async () => {
  const t = await startTestServer();
  try {
    const write = await t.post(
      `${BASE}/submissions/sub-xu-os/annotations`,
      { page: 2, quote: "运行日志展示缓冲区容量", comment: "这里要补上边界条件说明" },
      await t.as("t-chen")
    );
    assert.equal(write.statusCode, 200, "任课教师应能写批注");
    assert.equal(write.json.annotation.page, 2);
    assert.equal(write.json.annotation.comment, "这里要补上边界条件说明");

    const read = await t.get(`${BASE}/submissions/sub-xu-os/annotations`, await t.as("t-chen"));
    assert.equal(read.json.annotations.length, 1, "写入后应能读回");
    assert.equal(read.json.annotations[0].quote, "运行日志展示缓冲区容量");
  } finally {
    await t.close();
  }
});

test("批注·删除 - 任课教师可删除自己的课程批注，学生不能删除", async () => {
  const t = await startTestServer();
  try {
    seedAnnotation(t.store, "sub-xu-os", "待教师核对");
    const path = `${BASE}/submissions/sub-xu-os/annotations/anno-seed-sub-xu-os`;
    const denied = await t.delete(path, await t.as("s-xu"));
    assert.equal(denied.statusCode, 403);
    assert.equal(t.store.getSubmission("sub-xu-os").annotations.length, 1);
    const removed = await t.delete(path, await t.as("t-chen"));
    assert.equal(removed.statusCode, 200);
    assert.deepEqual(t.store.getSubmission("sub-xu-os").annotations, []);
  } finally {
    await t.close();
  }
});

test("评阅草稿·自动保存不改变正式成绩，版本冲突不会覆盖别的页面", async () => {
  const t = await startTestServer();
  try {
    const teacher = await t.as("t-chen");
    const student = await t.as("s-xu");
    const path = `${BASE}/submissions/sub-xu-os/review-draft`;
    const original = t.store.getSubmission("sub-xu-os");
    const grades = original.grades.map((grade, index) => index === 0
      ? { ...grade, score: 14, comment: "教师已修改评语" }
      : grade);
    const body = { grades, summary: "教师草稿小结", expectedVersion: 0, baseReviewVersion: 0 };
    assert.equal((await t.get(path, student)).statusCode, 403);
    assert.equal((await t.put(path, body, student)).statusCode, 403);
    const first = await t.put(path, body, teacher);
    assert.equal(first.statusCode, 200);
    assert.equal(first.json.draft.version, 1);
    assert.equal((await t.get(path, teacher)).json.draft.grades[0].score, 14);
    assert.equal(t.store.getSubmission("sub-xu-os").grades[0].score, 19);
    assert.equal(t.store.getSubmission("sub-xu-os", "s-xu").grades.length, 0);
    assert.equal((await t.put(path, body, teacher)).statusCode, 409);
    const second = await t.put(path, { ...body, expectedVersion: 1 }, teacher);
    assert.equal(second.statusCode, 200);
    assert.equal(second.json.draft.version, 2);
  } finally {
    await t.close();
  }
});

test("评阅草稿·已发布成绩修改仍对学生隔离，确认发布后清除草稿", async () => {
  const t = await startTestServer();
  try {
    const teacher = await t.as("t-chen");
    const path = `${BASE}/submissions/sub-yi-os/review-draft`;
    const published = t.store.getSubmission("sub-yi-os");
    const grades = published.grades.map((grade, index) => index === 0
      ? { ...grade, score: 18, comment: "教师重新核对" }
      : grade);
    const saved = await t.put(path, { grades, summary: "重新核对后的总结", expectedVersion: 0, baseReviewVersion: 1 }, teacher);
    assert.equal(saved.statusCode, 200);
    assert.equal(t.store.getSubmission("sub-yi-os", "s-yi").grades[0].score, 20);
    const publish = await t.post(`${BASE}/grader/review-publish`, {
      submissionId: "sub-yi-os", grades: saved.json.draft.grades,
      summary: saved.json.draft.summary, strictRange: true
    }, teacher);
    assert.equal(publish.statusCode, 200);
    assert.equal(t.store.getSubmission("sub-yi-os", "s-yi").grades[0].score, 18);
    assert.equal((await t.get(path, teacher)).json.draft, null);
    assert.equal((await t.put(path, { grades, summary: "过期请求", expectedVersion: 0, baseReviewVersion: 1 }, teacher)).statusCode, 409);
  } finally {
    await t.close();
  }
});
