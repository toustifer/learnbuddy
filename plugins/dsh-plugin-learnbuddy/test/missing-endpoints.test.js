/**
 * task-17：课程 / 作业 / 提交域 5 个 P0 端点 集成测试
 * (Missing Endpoints: courses / assignments / submissions)
 *
 * ─────────────────────────────────────────────────────────────
 * 【身份绑定后的契约】——本文件的验证口径
 * ─────────────────────────────────────────────────────────────
 * 身份**不再由调用方自报**：除 `/auth/login`、`/auth/me`、`/auth/logout` 外，
 * 所有 `/api/learnbuddy/*` 端点都要求 `Authorization: Bearer <令牌>`，缺令牌一律 401；
 * 身份由令牌对应的会话解析，请求里再传 `?userId=` 一律被忽略。
 *
 * 因此本文件相对改造前的三处口径变更：
 *   1. 「学生视角」= 真的用学生账号登录拿令牌（`t.as("s-yi")`），而不是 `?userId=s-yi`；
 *   2. 旧「缺 userId → 400」→ 新「无令牌 → 401」（`{ skipAuth: true }` 打未登录请求）；
 *   3. 旧「用户不存在 → 404」的场景已不存在（身份来自令牌，没有「传进来的用户」了）
 *      → 改写为等价的安全断言「伪造 / 无效令牌 → 401」，用例保留不删。
 *
 * 验证重点：
 * 1. GET  /api/learnbuddy/courses
 *    学生 = 已选课程；教师 = 所授课程；无令牌 401；伪造令牌 401；自报 userId 无效
 * 2. GET  /api/learnbuddy/assignments?courseId=
 *    本课程可见（学生仅 published）/ 跨课程 403 / 课程不存在 404 / 无令牌 401
 * 3. GET  /api/learnbuddy/submissions?assignmentId=   ← 本任务核心
 *    【安全红线】学生查非 published 报告 → grades=[] summary=""；
 *    教师查**同一份** → 完整 grades + summary（必须经 store.getSubmissions）
 * 4. GET  /api/learnbuddy/submissions/:id
 *    教师可见完整分数 / 学生看自己的置空 / 学生看他人 403 / 不存在 404
 * 5. POST /api/learnbuddy/submissions
 *    走 StorageService 真实落盘（大 base64 不入库）；初始 status=submitted；
 *    🔴 **提交人取自令牌**——body / multipart 里塞 studentId 一律无效；
 *    非学生 403；跨课程 403
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
import { tokenFor, withAuthHeaders, forgetToken } from "./helpers/auth.js";

// ==========================================
// 测试基础设施（与既有 storage.test.js / autograder-pipeline.test.js 同构）
// ==========================================

function createTempDir(prefix = "learnbuddy-missing-endpoints-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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
  }));
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
  // 端口由系统回收后再分配，可能落到上一个用例用过的端口号，
  // 而 helper 的令牌缓存以端口为键 —— 清一次，避免拿到已关闭 Store 签发的死令牌。
  forgetToken(port);

  return {
    port,
    store,
    storage,
    uploadDir: tmpDir,
    get: (p, headers) => makeHttpRequest(port, "GET", p, headers, null),
    post: (p, body, headers = {}) =>
      makeHttpRequest(port, "POST", p, { "Content-Type": "application/json", ...headers }, body),
    /**
     * 取指定演示账号的 Authorization 头。
     * 身份绑定后服务端只认令牌，要验「学生视角」就必须真的用学生账号登录。
     */
    as: async (actor) => {
      // helper 的令牌缓存以端口为键（假设一个 Server 只用默认账号）。
      // 本文件要在同一个 Server 上切换学生 / 教师多个账号做对照，
      // 所以先清掉该端口的缓存，强制按目标账号重新登录 —— 否则会拿到上一个账号的令牌。
      forgetToken(port);
      const token = await tokenFor(port, {
        username: ACCOUNT_OF[actor] || actor,
        password: DEMO_PASSWORD
      });
      return { Authorization: `Bearer ${token}` };
    },
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

const BASE = "/api/learnbuddy";

/** 演示账号密码（种子数据统一值） */
const DEMO_PASSWORD = "123";
/** 演示账号 id → 登录用户名（种子数据） */
const ACCOUNT_OF = {
  "t-chen": "teacher.chen",
  "t-lin": "teacher.lin",
  "s-yi": "student.lin",
  "s-zhou": "student.zhou",
  "s-xu": "student.xu"
};

// ==========================================
// 1. GET /courses
// ==========================================

test("缺失端点 - GET /courses：无令牌 401（身份绑定后不再接受自报 userId，不得返回全量课程）", async () => {
  const t = await startTestServer();
  try {
    // 未登录：`?userId=` 写得再对也不认，入口直接拒绝
    const res = await t.get(`${BASE}/courses?userId=s-yi`, { skipAuth: true });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json.ok, false);
    assert.ok(res.json.error.includes("未登录"), `错误信息应指明未登录，实际: ${res.json.error}`);
    // 绝不能退化成「无身份即返回全量」
    assert.equal(res.json.courses, undefined);

    // 未登录请求确实没带上任何 Authorization（skipAuth 是测试侧约定，不会漏出去）
    const noOwnHeaders = await t.get(`${BASE}/courses`, { skipAuth: true });
    assert.equal(noOwnHeaders.statusCode, 401);
    assert.equal(noOwnHeaders.json.courses, undefined);
  } finally {
    await t.close();
  }
});

test("缺失端点 - GET /courses：学生看已选课程，教师看所授课程（身份取自令牌）", async () => {
  const t = await startTestServer();
  try {
    // store.getUserCourses 按 courses.code 升序返回，断言统一按 code 排序比较
    const ids = (json) => json.courses.map((c) => c.id).sort();

    // 学生 s-yi：network / os / cs101（种子 enrollments）
    const studentRes = await t.get(`${BASE}/courses`, await t.as("s-yi"));
    assert.equal(studentRes.statusCode, 200);
    assert.equal(studentRes.json.ok, true);
    assert.equal(studentRes.json.userId, "s-yi");
    assert.equal(studentRes.json.role, "student");
    assert.deepEqual(ids(studentRes.json), ["cs101", "network", "os"]);
    assert.equal(studentRes.json.count, 3);

    // 教师 t-chen：network / os / cs101（courses.teacher_id）
    const teacherRes = await t.get(`${BASE}/courses`, await t.as("t-chen"));
    assert.equal(teacherRes.statusCode, 200);
    assert.equal(teacherRes.json.role, "teacher");
    assert.deepEqual(ids(teacherRes.json), ["cs101", "network", "os"]);

    // 教师 t-lin：仅 database
    const linRes = await t.get(`${BASE}/courses`, await t.as("t-lin"));
    assert.deepEqual(ids(linRes.json), ["database"]);

    // 学生 s-zhou：network / database / cs101 —— 不含 os，验证不是「返回全量」
    const zhouRes = await t.get(`${BASE}/courses`, await t.as("s-zhou"));
    assert.deepEqual(ids(zhouRes.json), ["cs101", "database", "network"]);
    assert.ok(!zhouRes.json.courses.some((c) => c.id === "os"), "未选课程不得出现在列表中");

    // 🔴 身份绑定核心判据：查询参数里的 userId 必须被忽略，身份只认令牌
    const spoofed = await t.get(`${BASE}/courses?userId=s-zhou`, await t.as("s-yi"));
    assert.equal(spoofed.statusCode, 200);
    assert.equal(spoofed.json.userId, "s-yi", "自报 userId 不得覆盖登录身份");
    assert.deepEqual(ids(spoofed.json), ["cs101", "network", "os"]);
    assert.ok(
      !spoofed.json.courses.some((c) => c.id === "database"),
      "不得借自报 userId 拿到他人课程"
    );

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

test("缺失端点 - GET /courses：伪造 / 无效令牌 → 401（原「用户不存在 404」已随身份绑定退役）", async () => {
  const t = await startTestServer();
  try {
    // 自己编的令牌：服务端没有对应会话记录 —— 旧口径是「用户不存在 404」，
    // 新契约下「传进来的用户」已不存在，等价的安全断言是「令牌不被承认」。
    const forged = await t.get(`${BASE}/courses`, { Authorization: "Bearer deadbeef" });
    assert.equal(forged.statusCode, 401);
    assert.equal(forged.json.ok, false);
    assert.equal(forged.json.courses, undefined);

    // 形似合法（64 位十六进制）但从未签发的令牌同样不行
    const forgedLong = await t.get(`${BASE}/courses`, {
      Authorization: `Bearer ${"a".repeat(64)}`
    });
    assert.equal(forgedLong.statusCode, 401);
    assert.equal(forgedLong.json.courses, undefined);

    // 认证方案不对（缺 Bearer 前缀）：不按令牌解析，视同未登录
    const badScheme = await t.get(`${BASE}/courses`, { Authorization: "deadbeef" });
    assert.equal(badScheme.statusCode, 401);

    // 对照：同样这个端点，带上真实令牌就能拿到自己的课程（证明 401 不是端点坏了）
    const legit = await t.get(`${BASE}/courses`, await t.as("s-yi"));
    assert.equal(legit.statusCode, 200);
    assert.equal(legit.json.userId, "s-yi");
  } finally {
    await t.close();
  }
});

// ==========================================
// 2. GET /assignments
// ==========================================

test("缺失端点 - GET /assignments：无令牌 401；伪造令牌 401；跨课程 403；课程不存在 404", async () => {
  const t = await startTestServer();
  try {
    // 1) 无令牌 → 401（入口默认拒绝，身份不再由调用方声明）
    const noToken = await t.get(`${BASE}/assignments?courseId=network`, { skipAuth: true });
    assert.equal(noToken.statusCode, 401);
    assert.equal(noToken.json.ok, false);
    assert.equal(noToken.json.assignments, undefined);

    // 2) 伪造令牌 → 401（原「用户不存在 404」的等价安全断言）
    const forged = await t.get(`${BASE}/assignments?courseId=network`, {
      Authorization: "Bearer deadbeef"
    });
    assert.equal(forged.statusCode, 401);
    assert.equal(forged.json.assignments, undefined);

    // 3) 课程不存在 → 404（与权限不足区分）
    const noCourse = await t.get(`${BASE}/assignments?courseId=nope`, await t.as("s-yi"));
    assert.equal(noCourse.statusCode, 404);
    assert.ok(noCourse.json.error.includes("课程不存在"));

    // 4) 跨课程：s-yi 未选修 database → 403（不是静默空数组）
    const crossCourse = await t.get(`${BASE}/assignments?courseId=database`, await t.as("s-yi"));
    assert.equal(crossCourse.statusCode, 403);
    assert.equal(crossCourse.json.ok, false);
    assert.ok(crossCourse.json.error.includes("权限不足"), crossCourse.json.error);
    assert.equal(crossCourse.json.assignments, undefined);

    // 5) 自报 userId 同样无效：s-yi 谎称自己是 database 课教师 t-lin 也进不去
    const spoof = await t.get(
      `${BASE}/assignments?courseId=database&userId=t-lin`,
      await t.as("s-yi")
    );
    assert.equal(spoof.statusCode, 403);
    assert.equal(spoof.json.assignments, undefined);
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
    const studentRes = await t.get(`${BASE}/assignments?courseId=network`, await t.as("s-yi"));
    assert.equal(studentRes.statusCode, 200);
    assert.equal(studentRes.json.ok, true);
    assert.deepEqual(ids(studentRes.json), ["lab-tcp"]);
    assert.ok(
      !studentRes.json.assignments.some((a) => a.id === "lab-tcp-draft"),
      "未发布作业不得泄漏给学生"
    );

    // 教师 t-chen 看 network：含草稿
    const teacherRes = await t.get(`${BASE}/assignments?courseId=network`, await t.as("t-chen"));
    assert.equal(teacherRes.statusCode, 200);
    assert.deepEqual(ids(teacherRes.json), ["lab-tcp", "lab-tcp-draft"]);

    // 其它课程：s-zhou 在 database → lab-db
    const dbRes = await t.get(`${BASE}/assignments?courseId=database`, await t.as("s-zhou"));
    assert.deepEqual(ids(dbRes.json), ["lab-db"]);

    // 不传 courseId：返回该用户全部可访问课程的作业
    //   s-yi 已选 network / os / cs101 → lab-tcp + lab-os（cs101 无作业）
    const allRes = await t.get(`${BASE}/assignments`, await t.as("s-yi"));
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

test("缺失端点 - GET /submissions：参数与权限边界（401 / 400 / 404 / 403）", async () => {
  const t = await startTestServer();
  try {
    // 1) 无令牌 → 401（安全红线：不得退化为「无身份即返回全部提交」）
    const noToken = await t.get(`${BASE}/submissions?assignmentId=lab-os`, { skipAuth: true });
    assert.equal(noToken.statusCode, 401);
    assert.equal(noToken.json.ok, false);
    assert.ok(noToken.json.error.includes("未登录"));
    assert.equal(noToken.json.submissions, undefined);

    // 2) 伪造令牌 → 401（原「用户不存在 404」的等价安全断言）
    const forged = await t.get(`${BASE}/submissions?assignmentId=lab-os`, {
      Authorization: "Bearer deadbeef"
    });
    assert.equal(forged.statusCode, 401);
    assert.equal(forged.json.submissions, undefined);

    // 3) 缺 assignmentId → 400
    const noAssignment = await t.get(`${BASE}/submissions`, await t.as("s-xu"));
    assert.equal(noAssignment.statusCode, 400);
    assert.ok(noAssignment.json.error.includes("assignmentId"));

    // 4) 作业不存在 → 404
    const noHw = await t.get(`${BASE}/submissions?assignmentId=lab-nope`, await t.as("s-xu"));
    assert.equal(noHw.statusCode, 404);
    assert.ok(noHw.json.error.includes("作业不存在"));

    // 5) 跨课程：t-chen 不是 database 课教师 → 403
    const crossCourse = await t.get(`${BASE}/submissions?assignmentId=lab-db`, await t.as("t-chen"));
    assert.equal(crossCourse.statusCode, 403);
    assert.ok(crossCourse.json.error.includes("权限不足"), crossCourse.json.error);
    assert.equal(crossCourse.json.submissions, undefined);

    // 6) 跨课程：学生 s-yi 未选修 database → 403（不是静默空数组）
    const studentCross = await t.get(`${BASE}/submissions?assignmentId=lab-db`, await t.as("s-yi"));
    assert.equal(studentCross.statusCode, 403);
    assert.equal(studentCross.json.submissions, undefined);

    // 7) 自报 userId 无效：s-yi 谎称自己是 t-chen 也跨不过课程边界
    const spoof = await t.get(
      `${BASE}/submissions?assignmentId=lab-db&userId=t-chen`,
      await t.as("s-yi")
    );
    assert.equal(spoof.statusCode, 403);
    assert.equal(spoof.json.submissions, undefined);
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

    // ── A. 学生视角（真的以 s-xu 登录）：请求 -> HTTP -> store.getSubmissions -> 置空 ──
    const studentRes = await t.get(`${BASE}/submissions?assignmentId=lab-os`, await t.as("s-xu"));
    assert.equal(studentRes.statusCode, 200);
    assert.equal(studentRes.json.ok, true);
    assert.equal(studentRes.json.role, "student");
    assert.equal(studentRes.json.userId, "s-xu");
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

    // ── B. 教师视角（真的以 t-chen 登录）：同一份提交必须拿到完整分数与评语 ──
    const teacherRes = await t.get(`${BASE}/submissions?assignmentId=lab-os`, await t.as("t-chen"));
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

    // 🔴 同一份记录、两种身份，结果必须不同 —— 这才是这条红线的判据
    assert.equal(studentView.id, teacherView.id, "师生查的必须是同一份提交");
    assert.notDeepEqual(studentView.grades, teacherView.grades);
    assert.notEqual(studentView.summary, teacherView.summary);

    // ── C. 已发布报告：学生自己可见完整分数 ──
    const publishedRes = await t.get(`${BASE}/submissions?assignmentId=lab-os`, await t.as("s-yi"));
    assert.equal(publishedRes.json.count, 1);
    const publishedView = publishedRes.json.submissions[0];
    assert.equal(publishedView.id, "sub-yi-os");
    assert.equal(publishedView.status, "published");
    assert.equal(publishedView.grades.length, 4, "published 报告学生可见完整分数");
    assert.ok(publishedView.summary.length > 0);

    // ── D. submitted 状态同样置空 ──
    const submittedRes = await t.get(`${BASE}/submissions?assignmentId=lab-tcp`, await t.as("s-xu"));
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

test("缺失端点 - GET /submissions/:id：详情权限（无令牌 401 / 学生置空 / 教师完整 / 越权 403 / 不存在 404）", async () => {
  const t = await startTestServer();
  try {
    // 1) 无令牌 → 401（身份绑定：详情同样不接受自报 userId）
    const noToken = await t.get(`${BASE}/submissions/sub-xu-os`, { skipAuth: true });
    assert.equal(noToken.statusCode, 401);
    assert.ok(noToken.json.error.includes("未登录"));

    // 2) 不存在 → 404
    const ghost = await t.get(`${BASE}/submissions/sub-nope`, await t.as("t-chen"));
    assert.equal(ghost.statusCode, 404);
    assert.ok(ghost.json.error.includes("提交记录不存在"));

    // 3) 学生看他人提交 → 403
    const cross = await t.get(`${BASE}/submissions/sub-xu-os`, await t.as("s-zhou"));
    assert.equal(cross.statusCode, 403);
    assert.ok(cross.json.error.includes("权限不足"));

    // 4) 跨课程教师 → 403
    const crossTeacher = await t.get(`${BASE}/submissions/sub-zhou-db`, await t.as("t-chen"));
    assert.equal(crossTeacher.statusCode, 403);

    // 5) 学生看自己的未发布报告 → 置空
    const own = await t.get(`${BASE}/submissions/sub-xu-os`, await t.as("s-xu"));
    assert.equal(own.statusCode, 200);
    assert.equal(own.json.ok, true);
    assert.equal(own.json.submission.id, "sub-xu-os");
    assert.deepEqual(own.json.submission.grades, []);
    assert.equal(own.json.submission.summary, "");

    // 6) 教师看同一份 → 完整
    const teacher = await t.get(`${BASE}/submissions/sub-xu-os`, await t.as("t-chen"));
    assert.equal(teacher.statusCode, 200);
    assert.equal(teacher.json.submission.grades.length, 4);
    assert.ok(teacher.json.submission.summary.length > 0);
    assert.equal(teacher.json.submission.id, own.json.submission.id, "师生看的是同一份记录");

    // 7) 学生看自己的已发布报告 → 完整
    const published = await t.get(`${BASE}/submissions/sub-yi-os`, await t.as("s-yi"));
    assert.equal(published.json.submission.status, "published");
    assert.equal(published.json.submission.grades.length, 4);
  } finally {
    await t.close();
  }
});

// ==========================================
// 5. POST /submissions
// ==========================================

test("缺失端点 - POST /submissions：参数校验（登录身份 / 作业 / 文件名 / 文件内容）", async () => {
  const t = await startTestServer();
  try {
    const pdfBase64 = Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64");

    // 1) 无令牌 → 401（提交人不再由 body 里的 studentId 声明）
    const noToken = await t.post(
      `${BASE}/submissions`,
      { assignmentId: "lab-tcp", fileName: "报告.pdf", content: pdfBase64, encoding: "base64" },
      { skipAuth: true }
    );
    assert.equal(noToken.statusCode, 401);
    assert.equal(noToken.json.ok, false);

    // 2) 缺 assignmentId → 400
    const noAssignment = await t.post(
      `${BASE}/submissions`,
      { fileName: "报告.pdf", content: pdfBase64, encoding: "base64" },
      await t.as("s-yi")
    );
    assert.equal(noAssignment.statusCode, 400);
    assert.ok(noAssignment.json.error.includes("assignmentId"));

    // 3) 缺 fileName → 400
    const noName = await t.post(
      `${BASE}/submissions`,
      { assignmentId: "lab-tcp", content: pdfBase64, encoding: "base64" },
      await t.as("s-yi")
    );
    assert.equal(noName.statusCode, 400);
    assert.ok(noName.json.error.includes("fileName"));

    // 4) 缺 content → 400
    const noContent = await t.post(
      `${BASE}/submissions`,
      { assignmentId: "lab-tcp", fileName: "报告.pdf" },
      await t.as("s-yi")
    );
    assert.equal(noContent.statusCode, 400);
    assert.ok(noContent.json.error.includes("content"));

    // 5) 非学生角色（教师令牌）→ 403
    const teacher = await t.post(
      `${BASE}/submissions`,
      { assignmentId: "lab-tcp", fileName: "报告.pdf", content: pdfBase64, encoding: "base64" },
      await t.as("t-chen")
    );
    assert.equal(teacher.statusCode, 403);
    assert.ok(teacher.json.error.includes("非学生角色"));

    // 6) 跨课程学生 → 403
    const cross = await t.post(
      `${BASE}/submissions`,
      { assignmentId: "lab-db", fileName: "报告.pdf", content: pdfBase64, encoding: "base64" },
      await t.as("s-yi")
    );
    assert.equal(cross.statusCode, 403);
    assert.ok(cross.json.error.includes("未选修课程"));

    // 7) 作业不存在 → 404
    const noHw = await t.post(
      `${BASE}/submissions`,
      { assignmentId: "lab-nope", fileName: "报告.pdf", content: pdfBase64, encoding: "base64" },
      await t.as("s-yi")
    );
    assert.equal(noHw.statusCode, 404);

    // 8) 未发布作业 → 403（学生不可向草稿作业提交）
    t.store.createAssignment({
      id: "lab-tcp-draft",
      courseId: "network",
      title: "实验二 · 未发布草稿",
      published: false
    });
    const draft = await t.post(
      `${BASE}/submissions`,
      {
        assignmentId: "lab-tcp-draft",
        fileName: "报告.pdf",
        content: pdfBase64,
        encoding: "base64"
      },
      await t.as("s-yi")
    );
    assert.equal(draft.statusCode, 403);
    assert.ok(draft.json.error.includes("尚未发布"));

    // 9) 非白名单格式 → 400（StorageService 拦截）
    const badExt = await t.post(
      `${BASE}/submissions`,
      { assignmentId: "lab-tcp", fileName: "报告.exe", content: pdfBase64, encoding: "base64" },
      await t.as("s-yi")
    );
    assert.equal(badExt.statusCode, 400);
    assert.ok(badExt.json.error.includes("不支持的文件格式"));

    // 10) 🔴 身份绑定核心判据：body 里塞 studentId / userId **不生效**，提交人只认令牌
    const spoof = await t.post(
      `${BASE}/submissions`,
      {
        assignmentId: "lab-tcp",
        studentId: "s-zhou", // 伪造提交人
        userId: "s-zhou",
        fileName: "身份绑定校验.pdf",
        content: pdfBase64,
        encoding: "base64"
      },
      await t.as("s-yi")
    );
    assert.equal(spoof.statusCode, 200);
    assert.equal(spoof.json.ok, true);
    assert.equal(
      spoof.json.submission.studentId,
      "s-yi",
      "🔴 提交人必须取自令牌，body 里的 studentId 一律无效"
    );

    // 提交不得挂到被冒充的学生名下：s-zhou 查 lab-tcp 看不到它
    const zhouList = await t.get(`${BASE}/submissions?assignmentId=lab-tcp`, await t.as("s-zhou"));
    assert.ok(
      !zhouList.json.submissions.some((s) => s.id === spoof.json.submission.id),
      "不得把提交挂到被冒充的学生名下"
    );
    // 而 s-yi 自己查得到 —— 证明它确实归属令牌对应的身份
    const yiList = await t.get(`${BASE}/submissions?assignmentId=lab-tcp`, await t.as("s-yi"));
    assert.ok(yiList.json.submissions.some((s) => s.id === spoof.json.submission.id));
  } finally {
    await t.close();
  }
});

test("缺失端点 - POST /submissions：报告经 StorageService 落盘，大文件不入库，初始 submitted", async () => {
  const t = await startTestServer();
  try {
    // 构造一段带唯一标记的「大」报告内容（约 700KB），用于证明 base64 没有写进数据库
    const marker = "LEARNBUDDY-REPORT-MARKER-7f3a9c";
    const reportText = `%PDF-1.4\n${marker}\n${"实验截图证据与数据分析。".repeat(20000)}\n%%EOF\n`;
    const reportBuffer = Buffer.from(reportText, "utf-8");
    assert.ok(reportBuffer.length > 200 * 1024, "测试载荷需足够大才有证明力");
    const base64Payload = reportBuffer.toString("base64");

    // 以 s-yi 身份提交；body 里特意塞一个「别人」的 studentId / userId 证明其无效
    const res = await t.post(
      `${BASE}/submissions`,
      {
        assignmentId: "lab-tcp",
        studentId: "s-zhou",
        userId: "s-zhou",
        fileName: "TCP实验报告_林一.pdf",
        encoding: "base64",
        content: `data:application/pdf;base64,${base64Payload}`
      },
      await t.as("s-yi")
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.json.ok, true);

    const sub = res.json.submission;
    assert.ok(sub.id.startsWith("sub-"), `提交 ID 前缀异常: ${sub.id}`);
    assert.equal(sub.assignmentId, "lab-tcp", "必须正确关联 assignmentId");
    assert.equal(sub.studentId, "s-yi", "🔴 必须关联令牌对应的 studentId（body 里的 s-zhou 无效）");
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
    assert.equal(rawRow.student_id, "s-yi", "入库的提交人同样取自令牌");
    assert.equal(rawRow.status, "submitted");
    assert.ok(!rawDump.includes(marker), "🔴 报告正文绝不能进数据库");
    assert.ok(!rawDump.includes(base64Payload), "🔴 base64 绝不能进数据库");
    assert.ok(rawDump.length < 2000, `单行记录不应被大内容撑大（实际 ${rawDump.length} 字节）`);

    // ③ 列表端点能查到新提交（同一 store，端到端闭环）
    const listRes = await t.get(`${BASE}/submissions?assignmentId=lab-tcp`, await t.as("s-yi"));
    assert.equal(listRes.statusCode, 200);
    const newSub = listRes.json.submissions.find((s) => s.id === sub.id);
    assert.ok(newSub, "新提交必须出现在列表中");
    assert.equal(newSub.status, "submitted");
    assert.deepEqual(newSub.grades, []);
    assert.equal(newSub.summary, "");

    // ④ 被冒充的 s-zhou 看不到这份提交（身份确实绑定在 s-yi 上）
    const zhouRes = await t.get(`${BASE}/submissions?assignmentId=lab-tcp`, await t.as("s-zhou"));
    assert.ok(!zhouRes.json.submissions.some((s) => s.id === sub.id));

    // ⑤ 教师视角同样能看到这份新提交
    const teacherRes = await t.get(`${BASE}/submissions?assignmentId=lab-tcp`, await t.as("t-chen"));
    assert.ok(teacherRes.json.submissions.some((s) => s.id === sub.id));

    // ⑥ 文件可经既有静态预览端点读回（真实链路）
    const viewRes = await t.get(
      `${BASE}/files/${encodeURIComponent(sub.blobId)}/view`
    );
    assert.equal(viewRes.statusCode, 200);

    // ⑦ 新建提交可以立即进入评阅状态机（status=submitted 是评阅的合法入口）
    assert.equal(t.store.getSubmission(sub.id).status, "submitted");
  } finally {
    await t.close();
  }
});

test("缺失端点 - POST /submissions：multipart/form-data 上传同样落盘并入库（身份取自令牌）", async () => {
  const t = await startTestServer();
  try {
    const boundary = "----LearnBuddyTestBoundary1738";
    const fileContent = Buffer.from("%PDF-1.4\nmultipart 提交的报告正文\n%%EOF\n");

    const parts = [
      // 🔴 伪造的 studentId 字段：服务端必须忽略，提交人取登录令牌（s-zhou）
      `--${boundary}\r\nContent-Disposition: form-data; name="studentId"\r\n\r\ns-yi\r\n`,
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
        "Content-Length": bodyBuffer.length,
        ...(await t.as("s-zhou"))
      },
      bodyBuffer
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.json.ok, true);
    assert.equal(
      res.json.submission.studentId,
      "s-zhou",
      "🔴 multipart 里的 studentId 同样无效，提交人只认令牌"
    );
    assert.equal(res.json.submission.assignmentId, "lab-tcp");
    assert.equal(res.json.submission.status, "submitted");
    assert.equal(res.json.submission.fileName, "TCP实验报告_周可.pdf");

    // 被冒充的 s-yi 在 lab-tcp 上看不到这份提交
    const yiList = await t.get(`${BASE}/submissions?assignmentId=lab-tcp`, await t.as("s-yi"));
    assert.ok(!yiList.json.submissions.some((s) => s.id === res.json.submission.id));

    const savedPath = t.storage.getFilePath(res.json.submission.blobId);
    assert.ok(savedPath, "multipart 文件必须真实落盘");
    assert.equal(fs.readFileSync(savedPath, "utf-8"), fileContent.toString("utf-8"));
  } finally {
    await t.close();
  }
});
