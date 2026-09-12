/**
 * task-17：课程 / 作业 / 提交域 5 个 P0 端点 集成测试
 * (Missing Endpoints: courses / assignments / submissions)
 *
 * 验证重点：
 * 1. GET  /api/learnbuddy/courses?userId=
 *    学生 = 已选课程；教师 = 所授课程；userId 缺失 400；用户不存在 404
 * 2. GET  /api/learnbuddy/assignments?courseId=&userId=
 *    本课程可见（学生仅 published）/ 跨课程 403 / 课程不存在 404 / userId 缺失 400
 * 3. GET  /api/learnbuddy/submissions?assignmentId=&userId=   ← 本任务核心
 *    【安全红线】学生查非 published 报告 → grades=[] summary=""；
 *    教师查**同一份** → 完整 grades + summary（必须经 store.getSubmissions）
 * 4. GET  /api/learnbuddy/submissions/:id?userId=
 *    教师可见完整分数 / 学生看自己的置空 / 学生看他人 403 / 不存在 404
 * 5. POST /api/learnbuddy/submissions
 *    走 StorageService 真实落盘（大 base64 不入库）；初始 status=submitted；
 *    assignmentId / studentId 正确关联；非学生 403；跨课程 403
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

// ==========================================
// 测试基础设施（与既有 storage.test.js / autograder-pipeline.test.js 同构）
// ==========================================

function createTempDir(prefix = "learnbuddy-missing-endpoints-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeHttpRequest(port, method, httpPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: httpPath, method, headers },
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
  });
}

/**
 * 起一个真实的 HTTP Server，挂上 registerLearnBuddyRoutes 产出的中间件。
 * 用真实 store（in-memory SQLite + 种子数据）+ 真实 StorageService（临时目录），
 * 不用 mock —— 路由行为必须与生产一致。
 */
async function startTestServer(options = {}) {
  const tmpDir = options.uploadDir || createTempDir();
  const storage = new StorageService({ uploadDir: tmpDir });
  const store = options.store || new DatabaseStore(":memory:");
  const middlewares = [];
  const fakeCtx = { webServer: { use: (fn) => middlewares.push(fn) } };

  registerLearnBuddyRoutes(fakeCtx, { store, storage });

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
    storage,
    uploadDir: tmpDir,
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

const BASE = "/api/learnbuddy";

// ==========================================
// 1. GET /courses
// ==========================================

test("缺失端点 - GET /courses：userId 必填（缺失 400，不得返回全量课程）", async () => {
  const t = await startTestServer();
  try {
    const res = await t.get(`${BASE}/courses`);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.ok, false);
    assert.ok(res.json.error.includes("userId"), `错误信息应指明缺 userId，实际: ${res.json.error}`);
    // 绝不能退化成「无身份即返回全量」
    assert.equal(res.json.courses, undefined);
  } finally {
    await t.close();
  }
});

test("缺失端点 - GET /courses：学生看已选课程，教师看所授课程", async () => {
  const t = await startTestServer();
  try {
    // store.getUserCourses 按 courses.code 升序返回，断言统一按 code 排序比较
    const ids = (json) => json.courses.map((c) => c.id).sort();

    // 学生 s-yi：network / os / cs101（种子 enrollments）
    const studentRes = await t.get(`${BASE}/courses?userId=s-yi`);
    assert.equal(studentRes.statusCode, 200);
    assert.equal(studentRes.json.ok, true);
    assert.equal(studentRes.json.userId, "s-yi");
    assert.equal(studentRes.json.role, "student");
    assert.deepEqual(ids(studentRes.json), ["cs101", "network", "os"]);
    assert.equal(studentRes.json.count, 3);

    // 教师 t-chen：network / os / cs101（courses.teacher_id）
    const teacherRes = await t.get(`${BASE}/courses?userId=t-chen`);
    assert.equal(teacherRes.statusCode, 200);
    assert.equal(teacherRes.json.role, "teacher");
    assert.deepEqual(ids(teacherRes.json), ["cs101", "network", "os"]);

    // 教师 t-lin：仅 database
    const linRes = await t.get(`${BASE}/courses?userId=t-lin`);
    assert.deepEqual(ids(linRes.json), ["database"]);

    // 学生 s-zhou：network / database / cs101 —— 不含 os，验证不是「返回全量」
    const zhouRes = await t.get(`${BASE}/courses?userId=s-zhou`);
    assert.deepEqual(ids(zhouRes.json), ["cs101", "database", "network"]);
    assert.ok(!zhouRes.json.courses.some((c) => c.id === "os"), "未选课程不得出现在列表中");

    // 课程字段契约（store.mapCourse 映射）
    const network = studentRes.json.courses.find((c) => c.id === "network");
    assert.deepEqual(Object.keys(network).sort(), [
      "code",
      "color",
      "description",
      "id",
      "teacherId",
      "title"
    ]);
    assert.equal(network.title, "计算机网络");
    assert.equal(network.teacherId, "t-chen");
  } finally {
    await t.close();
  }
});

test("缺失端点 - GET /courses：用户不存在返回 404", async () => {
  const t = await startTestServer();
  try {
    const res = await t.get(`${BASE}/courses?userId=s-nobody`);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json.ok, false);
    assert.ok(res.json.error.includes("不存在"));
  } finally {
    await t.close();
  }
});
