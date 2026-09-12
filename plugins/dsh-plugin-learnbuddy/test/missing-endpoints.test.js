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
    if (body) {
      // Buffer 必须原样写入（multipart 二进制体不能走 JSON.stringify）
      if (Buffer.isBuffer(body)) req.write(body);
      else req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
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

// ==========================================
// 2. GET /assignments
// ==========================================

test("缺失端点 - GET /assignments：userId 必填；跨课程 403；课程不存在 404", async () => {
  const t = await startTestServer();
  try {
    // 1) 缺 userId → 400
    const noUser = await t.get(`${BASE}/assignments?courseId=network`);
    assert.equal(noUser.statusCode, 400);
    assert.equal(noUser.json.ok, false);
    assert.ok(noUser.json.error.includes("userId"));

    // 2) 用户不存在 → 404
    const ghost = await t.get(`${BASE}/assignments?userId=s-nobody&courseId=network`);
    assert.equal(ghost.statusCode, 404);

    // 3) 课程不存在 → 404（与权限不足区分）
    const noCourse = await t.get(`${BASE}/assignments?userId=s-yi&courseId=nope`);
    assert.equal(noCourse.statusCode, 404);
    assert.ok(noCourse.json.error.includes("课程不存在"));

    // 4) 跨课程：s-yi 未选修 database → 403（不是静默空数组）
    const crossCourse = await t.get(`${BASE}/assignments?userId=s-yi&courseId=database`);
    assert.equal(crossCourse.statusCode, 403);
    assert.equal(crossCourse.json.ok, false);
    assert.ok(crossCourse.json.error.includes("权限不足"), crossCourse.json.error);
    assert.equal(crossCourse.json.assignments, undefined);
  } finally {
    await t.close();
  }
});

test("缺失端点 - GET /assignments：本课程可见性 + 学生看不到未发布作业", async () => {
  const t = await startTestServer();
  try {
    // 播种一条**未发布**草稿作业，用于验证师生可见性差异
    t.store.createAssignment({
      id: "lab-tcp-draft",
      courseId: "network",
      title: "实验二 · 未发布草稿",
      due: "2026-10-01",
      description: "尚未发布，学生不应看到",
      materialIds: [],
      rubric: [],
      confirmed: false,
      published: false
    });

    const ids = (json) => json.assignments.map((a) => a.id).sort();

    // 学生 s-yi 看 network：只有已发布的 lab-tcp
    const studentRes = await t.get(`${BASE}/assignments?userId=s-yi&courseId=network`);
    assert.equal(studentRes.statusCode, 200);
    assert.equal(studentRes.json.ok, true);
    assert.deepEqual(ids(studentRes.json), ["lab-tcp"]);
    assert.ok(
      !studentRes.json.assignments.some((a) => a.id === "lab-tcp-draft"),
      "未发布作业不得泄漏给学生"
    );

    // 教师 t-chen 看 network：含草稿
    const teacherRes = await t.get(`${BASE}/assignments?userId=t-chen&courseId=network`);
    assert.equal(teacherRes.statusCode, 200);
    assert.deepEqual(ids(teacherRes.json), ["lab-tcp", "lab-tcp-draft"]);

    // 其它课程：s-zhou 在 database → lab-db
    const dbRes = await t.get(`${BASE}/assignments?userId=s-zhou&courseId=database`);
    assert.deepEqual(ids(dbRes.json), ["lab-db"]);

    // 不传 courseId：返回该用户全部可访问课程的作业
    //   s-yi 已选 network / os / cs101 → lab-tcp + lab-os（cs101 无作业）
    const allRes = await t.get(`${BASE}/assignments?userId=s-yi`);
    assert.equal(allRes.json.courseId, null);
    assert.deepEqual(ids(allRes.json), ["lab-os", "lab-tcp"]);

    // 作业字段契约（store.mapAssignment 映射）
    const labTcp = studentRes.json.assignments[0];
    assert.deepEqual(Object.keys(labTcp).sort(), [
      "confirmed",
      "courseId",
      "description",
      "due",
      "id",
      "materialIds",
      "published",
      "rubric",
      "title"
    ]);
    assert.equal(labTcp.courseId, "network");
    assert.equal(labTcp.published, true);
    assert.equal(labTcp.rubric.length, 4);
  } finally {
    await t.close();
  }
});

// ==========================================
// 3. GET /submissions  ← 本任务核心：未发布成绩对学生置空
// ==========================================

test("缺失端点 - GET /submissions：参数与权限边界（400 / 403 / 404）", async () => {
  const t = await startTestServer();
  try {
    // 1) 缺 userId → 400（安全红线：不得退化为「无身份即返回全部提交」）
    const noUser = await t.get(`${BASE}/submissions?assignmentId=lab-os`);
    assert.equal(noUser.statusCode, 400);
    assert.equal(noUser.json.ok, false);
    assert.ok(noUser.json.error.includes("userId"));
    assert.equal(noUser.json.submissions, undefined);

    // 2) 缺 assignmentId → 400
    const noAssignment = await t.get(`${BASE}/submissions?userId=s-xu`);
    assert.equal(noAssignment.statusCode, 400);
    assert.ok(noAssignment.json.error.includes("assignmentId"));

    // 3) 用户不存在 → 404
    const ghost = await t.get(`${BASE}/submissions?userId=s-nobody&assignmentId=lab-os`);
    assert.equal(ghost.statusCode, 404);

    // 4) 作业不存在 → 404
    const noHw = await t.get(`${BASE}/submissions?userId=s-xu&assignmentId=lab-nope`);
    assert.equal(noHw.statusCode, 404);
    assert.ok(noHw.json.error.includes("作业不存在"));

    // 5) 跨课程：t-chen 不是 database 课教师 → 403
    const crossCourse = await t.get(`${BASE}/submissions?userId=t-chen&assignmentId=lab-db`);
    assert.equal(crossCourse.statusCode, 403);
    assert.ok(crossCourse.json.error.includes("权限不足"), crossCourse.json.error);

    // 6) 跨课程：学生 s-yi 未选修 database → 403
    const studentCross = await t.get(`${BASE}/submissions?userId=s-yi&assignmentId=lab-db`);
    assert.equal(studentCross.statusCode, 403);
  } finally {
    await t.close();
  }
});

test("缺失端点 - GET /submissions 【安全红线】学生查 review 报告成绩置空，教师查同一份完整", async () => {
  const t = await startTestServer();
  try {
    // 前置断言：种子数据里 sub-xu-os 确实是「已评阅未发布」且库里带着完整分数
    const rawRow = t.store.listSubmissions("lab-os").find((s) => s.id === "sub-xu-os");
    assert.equal(rawRow.status, "review");
    assert.equal(rawRow.grades.length, 4, "库内原始记录必须带 4 项评分（否则本测试无意义）");
    assert.ok(rawRow.summary.length > 0, "库内原始记录必须带评语");

    // ── A. 学生视角：请求 -> HTTP -> store.getSubmissions -> 置空 ──
    const studentRes = await t.get(`${BASE}/submissions?userId=s-xu&assignmentId=lab-os`);
    assert.equal(studentRes.statusCode, 200);
    assert.equal(studentRes.json.ok, true);
    assert.equal(studentRes.json.role, "student");
    assert.equal(studentRes.json.assignmentId, "lab-os");
    assert.equal(studentRes.json.courseId, "os");
    assert.equal(studentRes.json.count, 1, "学生只能看到自己的提交");

    const studentView = studentRes.json.submissions[0];
    assert.equal(studentView.id, "sub-xu-os");
    assert.equal(studentView.studentId, "s-xu");
    assert.equal(studentView.status, "review");
    assert.deepEqual(studentView.grades, [], "🔴 未发布报告的 grades 必须对学生置空");
    assert.equal(studentView.summary, "", "🔴 未发布报告的 summary 必须对学生置空");
    assert.equal(
      Object.prototype.hasOwnProperty.call(studentView, "failure"),
      false,
      "🔴 failure 必须不下发给学生"
    );
    // 元信息仍然可见（学生需要知道「已提交/评阅中」）
    assert.equal(studentView.fileName, "进程同步实验报告_许然.docx");

    // ── B. 教师视角：同一份提交必须拿到完整分数与评语 ──
    const teacherRes = await t.get(`${BASE}/submissions?userId=t-chen&assignmentId=lab-os`);
    assert.equal(teacherRes.statusCode, 200);
    assert.equal(teacherRes.json.role, "teacher");
    assert.equal(teacherRes.json.count, 2, "教师能看到全班 2 份提交");

    const teacherView = teacherRes.json.submissions.find((s) => s.id === "sub-xu-os");
    assert.ok(teacherView, "教师必须能看到 sub-xu-os");
    assert.equal(teacherView.studentId, "s-xu");
    assert.equal(teacherView.status, "review");
    assert.equal(teacherView.grades.length, 4, "教师必须看到完整评分");
    assert.equal(teacherView.grades[0].score, 19);
    assert.equal(teacherView.grades[0].rubricId, "os-r0");
    assert.ok(teacherView.summary.includes("边界测试"), `教师评语不完整: ${teacherView.summary}`);

    // ── C. 已发布报告：学生自己可见完整分数 ──
    const publishedRes = await t.get(`${BASE}/submissions?userId=s-yi&assignmentId=lab-os`);
    assert.equal(publishedRes.json.count, 1);
    const publishedView = publishedRes.json.submissions[0];
    assert.equal(publishedView.id, "sub-yi-os");
    assert.equal(publishedView.status, "published");
    assert.equal(publishedView.grades.length, 4, "published 报告学生可见完整分数");
    assert.ok(publishedView.summary.length > 0);

    // ── D. submitted 状态同样置空 ──
    const submittedRes = await t.get(`${BASE}/submissions?userId=s-xu&assignmentId=lab-tcp`);
    assert.equal(submittedRes.json.count, 1, "学生只能看到自己的 sub-xu-net");
    assert.equal(submittedRes.json.submissions[0].id, "sub-xu-net");
    assert.equal(submittedRes.json.submissions[0].status, "submitted");
    assert.deepEqual(submittedRes.json.submissions[0].grades, []);
    assert.equal(submittedRes.json.submissions[0].summary, "");
  } finally {
    await t.close();
  }
});

// ==========================================
// 4. GET /submissions/:id
// ==========================================

test("缺失端点 - GET /submissions/:id：详情权限（学生置空 / 教师完整 / 越权 403 / 不存在 404）", async () => {
  const t = await startTestServer();
  try {
    // 1) 缺 userId → 400
    const noUser = await t.get(`${BASE}/submissions/sub-xu-os`);
    assert.equal(noUser.statusCode, 400);
    assert.ok(noUser.json.error.includes("userId"));

    // 2) 不存在 → 404
    const ghost = await t.get(`${BASE}/submissions/sub-nope?userId=t-chen`);
    assert.equal(ghost.statusCode, 404);
    assert.ok(ghost.json.error.includes("提交记录不存在"));

    // 3) 学生看他人提交 → 403
    const cross = await t.get(`${BASE}/submissions/sub-xu-os?userId=s-zhou`);
    assert.equal(cross.statusCode, 403);
    assert.ok(cross.json.error.includes("权限不足"));

    // 4) 跨课程教师 → 403
    const crossTeacher = await t.get(`${BASE}/submissions/sub-zhou-db?userId=t-chen`);
    assert.equal(crossTeacher.statusCode, 403);

    // 5) 学生看自己的未发布报告 → 置空
    const own = await t.get(`${BASE}/submissions/sub-xu-os?userId=s-xu`);
    assert.equal(own.statusCode, 200);
    assert.equal(own.json.ok, true);
    assert.equal(own.json.submission.id, "sub-xu-os");
    assert.deepEqual(own.json.submission.grades, []);
    assert.equal(own.json.submission.summary, "");

    // 6) 教师看同一份 → 完整
    const teacher = await t.get(`${BASE}/submissions/sub-xu-os?userId=t-chen`);
    assert.equal(teacher.statusCode, 200);
    assert.equal(teacher.json.submission.grades.length, 4);
    assert.ok(teacher.json.submission.summary.length > 0);

    // 7) 学生看自己的已发布报告 → 完整
    const published = await t.get(`${BASE}/submissions/sub-yi-os?userId=s-yi`);
    assert.equal(published.json.submission.status, "published");
    assert.equal(published.json.submission.grades.length, 4);
  } finally {
    await t.close();
  }
});

// ==========================================
// 5. POST /submissions
// ==========================================

test("缺失端点 - POST /submissions：参数校验（学生身份 / 作业 / 文件名 / 文件内容）", async () => {
  const t = await startTestServer();
  try {
    const pdfBase64 = Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64");

    // 1) 缺 studentId / userId → 400
    const noStudent = await t.post(`${BASE}/submissions`, {
      assignmentId: "lab-tcp",
      fileName: "报告.pdf",
      content: pdfBase64,
      encoding: "base64"
    });
    assert.equal(noStudent.statusCode, 400);
    assert.ok(noStudent.json.error.includes("studentId"));

    // 2) 缺 assignmentId → 400
    const noAssignment = await t.post(`${BASE}/submissions`, {
      studentId: "s-yi",
      fileName: "报告.pdf",
      content: pdfBase64,
      encoding: "base64"
    });
    assert.equal(noAssignment.statusCode, 400);
    assert.ok(noAssignment.json.error.includes("assignmentId"));

    // 3) 缺 fileName → 400
    const noName = await t.post(`${BASE}/submissions`, {
      studentId: "s-yi",
      assignmentId: "lab-tcp",
      content: pdfBase64,
      encoding: "base64"
    });
    assert.equal(noName.statusCode, 400);
    assert.ok(noName.json.error.includes("fileName"));

    // 4) 缺 content → 400
    const noContent = await t.post(`${BASE}/submissions`, {
      studentId: "s-yi",
      assignmentId: "lab-tcp",
      fileName: "报告.pdf"
    });
    assert.equal(noContent.statusCode, 400);
    assert.ok(noContent.json.error.includes("content"));

    // 5) 用户不存在 → 404
    const ghost = await t.post(`${BASE}/submissions`, {
      studentId: "s-nobody",
      assignmentId: "lab-tcp",
      fileName: "报告.pdf",
      content: pdfBase64,
      encoding: "base64"
    });
    assert.equal(ghost.statusCode, 404);

    // 6) 非学生角色（教师）→ 403
    const teacher = await t.post(`${BASE}/submissions`, {
      studentId: "t-chen",
      assignmentId: "lab-tcp",
      fileName: "报告.pdf",
      content: pdfBase64,
      encoding: "base64"
    });
    assert.equal(teacher.statusCode, 403);
    assert.ok(teacher.json.error.includes("非学生角色"));

    // 7) 跨课程学生 → 403
    const cross = await t.post(`${BASE}/submissions`, {
      studentId: "s-yi",
      assignmentId: "lab-db",
      fileName: "报告.pdf",
      content: pdfBase64,
      encoding: "base64"
    });
    assert.equal(cross.statusCode, 403);
    assert.ok(cross.json.error.includes("未选修课程"));

    // 8) 作业不存在 → 404
    const noHw = await t.post(`${BASE}/submissions`, {
      studentId: "s-yi",
      assignmentId: "lab-nope",
      fileName: "报告.pdf",
      content: pdfBase64,
      encoding: "base64"
    });
    assert.equal(noHw.statusCode, 404);

    // 9) 未发布作业 → 403（学生不可向草稿作业提交）
    t.store.createAssignment({
      id: "lab-tcp-draft",
      courseId: "network",
      title: "实验二 · 未发布草稿",
      published: false
    });
    const draft = await t.post(`${BASE}/submissions`, {
      studentId: "s-yi",
      assignmentId: "lab-tcp-draft",
      fileName: "报告.pdf",
      content: pdfBase64,
      encoding: "base64"
    });
    assert.equal(draft.statusCode, 403);
    assert.ok(draft.json.error.includes("尚未发布"));

    // 10) 非白名单格式 → 400（StorageService 拦截）
    const badExt = await t.post(`${BASE}/submissions`, {
      studentId: "s-yi",
      assignmentId: "lab-tcp",
      fileName: "报告.exe",
      content: pdfBase64,
      encoding: "base64"
    });
    assert.equal(badExt.statusCode, 400);
    assert.ok(badExt.json.error.includes("不支持的文件格式"));
  } finally {
    await t.close();
  }
});

test("缺失端点 - POST /submissions：报告经 StorageService 落盘，大文件不入库，初始 submitted", async () => {
  const t = await startTestServer();
  try {
    // 构造一段带唯一标记的「大」报告内容（约 240KB），用于证明 base64 没有写进数据库
    const marker = "LEARNBUDDY-REPORT-MARKER-7f3a9c";
    const reportText = `%PDF-1.4\n${marker}\n${"实验截图证据与数据分析。".repeat(20000)}\n%%EOF\n`;
    const reportBuffer = Buffer.from(reportText, "utf-8");
    assert.ok(reportBuffer.length > 200 * 1024, "测试载荷需足够大才有证明力");
    const base64Payload = reportBuffer.toString("base64");

    const res = await t.post(`${BASE}/submissions`, {
      studentId: "s-yi",
      assignmentId: "lab-tcp",
      fileName: "TCP实验报告_林一.pdf",
      encoding: "base64",
      content: `data:application/pdf;base64,${base64Payload}`
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json.ok, true);

    const sub = res.json.submission;
    assert.ok(sub.id.startsWith("sub-"), `提交 ID 前缀异常: ${sub.id}`);
    assert.equal(sub.assignmentId, "lab-tcp", "必须正确关联 assignmentId");
    assert.equal(sub.studentId, "s-yi", "必须正确关联 studentId");
    assert.equal(sub.status, "submitted", "初始状态必须是 submitted");
    assert.equal(sub.fileName, "TCP实验报告_林一.pdf");
    assert.deepEqual(sub.grades, []);
    assert.equal(sub.summary, "");
    assert.ok(sub.submittedAt, "必须记录提交时间");
    assert.match(sub.blobId, /^[0-9a-f]{64}\.pdf$/, "blobId 必须是 SHA-256 + 白名单扩展名");

    // 响应里的文件信息可直接用于预览/下载
    assert.equal(res.json.file.id, sub.blobId);
    assert.equal(res.json.file.name, "TCP实验报告_林一.pdf");
    assert.equal(res.json.file.size, reportBuffer.length);
    assert.equal(res.json.file.viewUrl, `${BASE}/files/${sub.blobId}/view`);
    assert.equal(res.json.file.downloadUrl, `${BASE}/files/${sub.blobId}/download`);

    // ① 文件确实物理落盘，且内容与上传一致（未截断/未损坏）
    const savedPath = t.storage.getFilePath(sub.blobId);
    assert.ok(savedPath, "文件必须真实落盘");
    assert.equal(fs.readFileSync(savedPath, "utf-8"), reportText);
    assert.equal(fs.statSync(savedPath).size, reportBuffer.length);

    // ② 数据库里只有引用，**没有** base64 / 报告正文
    const rawRow = t.store.db
      .prepare("SELECT * FROM submissions WHERE id = ?")
      .get(sub.id);
    const rawDump = JSON.stringify(rawRow);
    assert.equal(rawRow.blob_id, sub.blobId);
    assert.equal(rawRow.status, "submitted");
    assert.ok(!rawDump.includes(marker), "🔴 报告正文绝不能进数据库");
    assert.ok(!rawDump.includes(base64Payload), "🔴 base64 绝不能进数据库");
    assert.ok(rawDump.length < 2000, `单行记录不应被大内容撑大（实际 ${rawDump.length} 字节）`);

    // ③ 列表端点能查到新提交（同一 store，端到端闭环）
    const listRes = await t.get(`${BASE}/submissions?userId=s-yi&assignmentId=lab-tcp`);
    assert.equal(listRes.statusCode, 200);
    const newSub = listRes.json.submissions.find((s) => s.id === sub.id);
    assert.ok(newSub, "新提交必须出现在列表中");
    assert.equal(newSub.status, "submitted");
    assert.deepEqual(newSub.grades, []);
    assert.equal(newSub.summary, "");

    // ④ 教师视角同样能看到这份新提交
    const teacherRes = await t.get(`${BASE}/submissions?userId=t-chen&assignmentId=lab-tcp`);
    assert.ok(teacherRes.json.submissions.some((s) => s.id === sub.id));

    // ⑤ 文件可经既有静态预览端点读回（真实链路）
    const viewRes = await t.get(
      `${BASE}/files/${encodeURIComponent(sub.blobId)}/view`
    );
    assert.equal(viewRes.statusCode, 200);

    // ⑥ 新建提交可以立即进入评阅状态机（status=submitted 是评阅的合法入口）
    assert.equal(t.store.getSubmission(sub.id).status, "submitted");
  } finally {
    await t.close();
  }
});

test("缺失端点 - POST /submissions：multipart/form-data 上传同样落盘并入库", async () => {
  const t = await startTestServer();
  try {
    const boundary = "----LearnBuddyTestBoundary1738";
    const fileContent = Buffer.from("%PDF-1.4\nmultipart 提交的报告正文\n%%EOF\n");

    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="studentId"\r\n\r\ns-zhou\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="assignmentId"\r\n\r\nlab-tcp\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="TCP实验报告_周可.pdf"\r\n` +
        `Content-Type: application/pdf\r\n\r\n`
    ];
    const tail = `\r\n--${boundary}--\r\n`;
    const bodyBuffer = Buffer.concat([
      Buffer.from(parts.join(""), "utf-8"),
      fileContent,
      Buffer.from(tail, "utf-8")
    ]);

    const res = await makeHttpRequest(
      t.port,
      "POST",
      `${BASE}/submissions`,
      {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": bodyBuffer.length
      },
      bodyBuffer
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.submission.studentId, "s-zhou");
    assert.equal(res.json.submission.assignmentId, "lab-tcp");
    assert.equal(res.json.submission.status, "submitted");
    assert.equal(res.json.submission.fileName, "TCP实验报告_周可.pdf");

    const savedPath = t.storage.getFilePath(res.json.submission.blobId);
    assert.ok(savedPath, "multipart 文件必须真实落盘");
    assert.equal(fs.readFileSync(savedPath, "utf-8"), fileContent.toString("utf-8"));
  } finally {
    await t.close();
  }
});
