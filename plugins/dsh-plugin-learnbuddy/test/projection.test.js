/**
 * 契约层「投影契约」测试（D2）
 *
 * D2：教师确认后学生才可查看自己的分数、详细评语与依据；
 *     **确认前由服务端移除敏感评分字段及历史泄漏**。
 *
 * 这里最重要的一个用例是「**未发布 + history 非空**」：
 * 改造前投影是三处手写黑名单，其中 store 里那两处只清 `grades` / `summary`，
 * **漏掉了 `history`** —— 而 history 里装着历次评分的 grades 与 summary。
 * 只要某份提交变成「未发布但 history 非空」，学生就能从 history 读到分数。
 * 下面第 2 个用例专门守住这条通道。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  SUBMISSION_VIEW_FIELDS,
  toStudentSubmissionView,
  toTeacherSubmissionView,
  projectSubmission,
  projectSubmissions,
  isGradeVisible
} from "../src/contracts/projection.js";
import { DatabaseStore } from "../src/db/store.js";

const TEACHER = { id: "t-chen", role: "teacher" };
const STUDENT = { id: "s-xu", role: "student" };

/** 一份「未发布且 history 非空」的提交 —— 最容易泄漏的形状 */
function leakySubmission(overrides = {}) {
  return {
    id: "sub-leaky",
    assignmentId: "lab-os",
    studentId: "s-xu",
    fileName: "实验报告.pdf",
    submittedAt: "2026-09-10 10:06",
    status: "review",
    sampleKey: "os",
    blobId: "abc123",
    grades: [{ rubricId: "os-r0", score: 19, comment: "老师写的评语" }],
    summary: "老师的总评",
    history: [
      {
        revision: 1,
        grades: [{ rubricId: "os-r0", score: 15, comment: "上一轮评语" }],
        summary: "上一轮总评"
      }
    ],
    failure: "内部解析失败：第 3 页图像缺失",
    ...overrides
  };
}

// ===========================================================================
// 1. 学生视图
// ===========================================================================

test("投影·学生 - 未发布：grades / summary / history 必须全空", () => {
  const view = toStudentSubmissionView(leakySubmission());

  assert.deepEqual(view.grades, [], "未发布时学生不得看到分数");
  assert.equal(view.summary, "", "未发布时学生不得看到总评");
  assert.deepEqual(
    view.history,
    [],
    "未发布时学生不得看到 history —— 它装着历次评分的分数（改造前漏清了这条）"
  );
});

test("投影·学生 - 回归：history 里藏着的分数也不得泄漏", () => {
  const source = leakySubmission();
  const view = toStudentSubmissionView(source);

  const dumped = JSON.stringify(view);
  assert.ok(
    !dumped.includes("上一轮评语"),
    "history 里的历史评语不得出现在学生视图的序列化结果中"
  );
  assert.ok(!dumped.includes("上一轮总评"), "history 里的历史总评不得泄漏");
  assert.ok(!dumped.includes('"score":15'), "history 里的历史分数不得泄漏");
  assert.ok(!dumped.includes("老师写的评语"), "本轮评语同样不得泄漏");
  assert.ok(!dumped.includes("老师的总评"), "本轮总评同样不得泄漏");
});

test("投影·学生 - 已发布：可以看到分数、总评与历史", () => {
  const view = toStudentSubmissionView(leakySubmission({ status: "published" }));

  assert.equal(view.grades.length, 1, "已发布后学生可以看到分数");
  assert.equal(view.summary, "老师的总评");
  assert.equal(view.history.length, 1, "已发布后历史也应可见");
  assert.equal(view.grades[0].score, 19);
});

test("投影·学生 - teacherOnly 字段（failure）整个键都不出现", () => {
  for (const status of ["submitted", "grading", "review", "published", "failed"]) {
    const view = toStudentSubmissionView(leakySubmission({ status }));
    assert.equal(
      Object.hasOwn(view, "failure"),
      false,
      `status=${status} 时学生视图不得出现 failure —— 它含内部失败细节`
    );
  }
});

// ===========================================================================
// 2. 教师视图
// ===========================================================================

test("投影·教师 - 任何状态都能看到完整内容（包括 failure）", () => {
  for (const status of ["submitted", "review", "failed"]) {
    const view = toTeacherSubmissionView(leakySubmission({ status }));
    assert.equal(view.grades.length, 1, `status=${status} 教师应看到分数`);
    assert.equal(view.summary, "老师的总评");
    assert.equal(view.history.length, 1, "教师应看到历史");
    assert.match(view.failure, /图像缺失/, "教师应看到失败原因");
  }
});

// ===========================================================================
// 3. 白名单（核心安全属性）
// ===========================================================================

test("投影·白名单 - 未登记的字段一律不对外暴露（默认安全）", () => {
  const withExtra = leakySubmission({
    // 模拟「以后给提交加了新字段」——它必须默认不可见
    internalNotes: "这是一段不该外泄的内部备注",
    modelRawOutput: "模型的原始输出，可能含敏感推理",
    teacherPrivateComment: "只给老师看的备注"
  });

  const studentView = toStudentSubmissionView(withExtra);
  const studentDump = JSON.stringify(studentView);
  for (const field of ["internalNotes", "modelRawOutput", "teacherPrivateComment"]) {
    assert.equal(
      Object.hasOwn(studentView, field),
      false,
      `${field} 未登记进白名单，学生视图不得暴露`
    );
    assert.ok(!studentDump.includes(field), `${field} 不得出现在序列化结果里`);
  }

  // 教师视图同样只含白名单字段 —— 投影对两端都是显式契约
  const teacherView = toTeacherSubmissionView(withExtra);
  assert.equal(Object.hasOwn(teacherView, "internalNotes"), false, "教师视图也只含白名单字段");
});

test("投影·白名单 - 视图恰好等于白名单字段集合（不多不少）", () => {
  const expected = new Set([
    ...SUBMISSION_VIEW_FIELDS.always,
    ...SUBMISSION_VIEW_FIELDS.graded,
    ...SUBMISSION_VIEW_FIELDS.teacherOnly
  ]);

  const teacherKeys = Object.keys(toTeacherSubmissionView(leakySubmission()));
  assert.deepEqual(teacherKeys.sort(), [...expected].sort(), "教师视图字段集合必须与白名单一致");

  const studentExpected = new Set([
    ...SUBMISSION_VIEW_FIELDS.always,
    ...SUBMISSION_VIEW_FIELDS.graded
  ]);
  const studentKeys = Object.keys(toStudentSubmissionView(leakySubmission()));
  assert.deepEqual(
    studentKeys.sort(),
    [...studentExpected].sort(),
    "学生视图字段集合必须等于白名单去掉 teacherOnly"
  );
});

test("投影·白名单 - 形状稳定：未发布也保留键，值为空（对 Agent 更友好）", () => {
  const view = toStudentSubmissionView(leakySubmission());
  for (const field of SUBMISSION_VIEW_FIELDS.graded) {
    assert.ok(Object.hasOwn(view, field), `${field} 必须存在（形状可预测），只是值为空`);
  }
});

// ===========================================================================
// 4. 分发与可见性判断
// ===========================================================================

test("投影·分发 - projectSubmission 按角色给不同视图", () => {
  const s = leakySubmission();
  assert.deepEqual(projectSubmission(s, STUDENT).grades, []);
  assert.equal(projectSubmission(s, TEACHER).grades.length, 1);
  assert.equal(projectSubmission(null, STUDENT), null, "空输入返回 null，不抛错");
  // 无角色信息时按最严的（学生）处理
  assert.deepEqual(projectSubmission(s, null).grades, [], "拿不准身份时按学生视图，默认安全");
});

test("投影·批量 - projectSubmissions 对整批统一裁剪", () => {
  const views = projectSubmissions([leakySubmission(), leakySubmission({ id: "sub-b" })], STUDENT);
  assert.equal(views.length, 2);
  for (const v of views) assert.deepEqual(v.grades, []);
  assert.deepEqual(projectSubmissions(null, STUDENT), [], "非数组输入返回空数组");
});

test("投影·可见性 - isGradeVisible 直接对应错误码 NOT_REVIEWED 的语义", () => {
  assert.equal(isGradeVisible(leakySubmission(), STUDENT), false, "未复核 → 学生看不到成绩");
  assert.equal(isGradeVisible(leakySubmission({ status: "published" }), STUDENT), true);
  assert.equal(isGradeVisible(leakySubmission(), TEACHER), true, "教师始终能看到（含未复核）");
  assert.equal(isGradeVisible(null, STUDENT), false);
});

// ===========================================================================
// 5. 端到端：store 真的走了契约（而不是自己再写一套）
// ===========================================================================

test("投影·端到端 - store 读出的提交已按契约裁剪，history 通道被堵住", () => {
  const store = new DatabaseStore(":memory:");
  try {
    store.createSubmission({
      id: "sub-leaky-e2e",
      assignmentId: "lab-os",
      studentId: "s-xu",
      fileName: "实验报告.pdf",
      submittedAt: "2026-09-10 10:06",
      status: "review",
      grades: [{ rubricId: "os-r0", score: 19, comment: "老师写的评语" }],
      summary: "老师的总评",
      history: [
        { revision: 1, grades: [{ rubricId: "os-r0", score: 15, comment: "上一轮评语" }], summary: "上一轮总评" }
      ],
      failure: "内部解析失败"
    });

    const studentView = store.getSubmission("sub-leaky-e2e", "s-xu");
    assert.deepEqual(studentView.grades, [], "store 必须按契约置空分数");
    assert.equal(studentView.summary, "");
    assert.deepEqual(
      studentView.history,
      [],
      "store 必须清空 history —— 改造前这里漏了，学生能从 history 读到上一轮分数"
    );
    assert.equal(Object.hasOwn(studentView, "failure"), false, "failure 不得出现在学生视图");

    const teacherView = store.getSubmission("sub-leaky-e2e", "t-chen");
    assert.equal(teacherView.grades.length, 1, "教师视图不受影响");
    assert.equal(teacherView.history.length, 1);
    assert.match(teacherView.failure, /解析失败/);

    // 列表接口同样走契约
    const listForStudent = store.getSubmissions("s-xu", "lab-os");
    const mine = listForStudent.find((s) => s.id === "sub-leaky-e2e");
    assert.ok(mine, "学生应能在列表里看到自己的提交");
    assert.deepEqual(mine.history, [], "列表接口的 history 也必须被清空");
    assert.deepEqual(mine.grades, []);

    const listForTeacher = store.getSubmissions("t-chen", "lab-os");
    const tView = listForTeacher.find((s) => s.id === "sub-leaky-e2e");
    assert.equal(tView.history.length, 1, "教师列表应保留历史");
  } finally {
    store.close();
  }
});

// ===========================================================================
// 解析产物也要过投影（2026-09-22 修复）
// ===========================================================================

test("投影·解析产物 - parsedContent 必须在白名单里（否则教师刷新后看不到报告）", () => {
  assert.ok(
    SUBMISSION_VIEW_FIELDS.graded.includes("parsedContent"),
    "parsedContent 含报告正文结构，属「已发布前对学生不可见」这一组；" +
      "漏掉它会让教师刷新页面后看不到报告，也让证据引用的段反查拿不到 structuredPages"
  );
});

test("投影·解析产物 - 教师始终能看到", () => {
  const sub = {
    id: "s1",
    status: "review",
    grades: [{ rubricId: "r0", score: 10 }],
    parsedContent: { source: "document", structuredPages: [{ paragraphs: ["正文"] }] }
  };
  const view = toTeacherSubmissionView(sub);
  assert.equal(view.parsedContent.source, "document");
  assert.equal(view.parsedContent.structuredPages.length, 1, "教师要看得到正文结构才能复核");
});

test("投影·解析产物 - 学生未发布时置空（D2：依据也不该提前可见）", () => {
  const sub = {
    id: "s1",
    status: "review",
    grades: [{ rubricId: "r0", score: 10 }],
    parsedContent: { source: "document", structuredPages: [{ paragraphs: ["正文"] }] }
  };
  const view = toStudentSubmissionView(sub);
  assert.equal(view.parsedContent, null, "未发布时不得看到报告正文结构");
  assert.deepEqual(view.grades, []);
});

test("投影·解析产物 - 学生已发布时可见", () => {
  const sub = {
    id: "s1",
    status: "published",
    grades: [{ rubricId: "r0", score: 10 }],
    parsedContent: { source: "document", structuredPages: [{ paragraphs: ["正文"] }] }
  };
  const view = toStudentSubmissionView(sub);
  assert.equal(view.parsedContent.source, "document");
});
