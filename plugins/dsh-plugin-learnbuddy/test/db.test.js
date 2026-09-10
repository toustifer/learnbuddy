/**
 * LearnBuddy SQLite 持久化存储与师生权限隔离层 单元测试
 * 
 * 验证重点：
 * 1. SQLite 数据库初始化与 Schema/默认种子数据 (users, courses, materials, assignments, submissions)
 * 2. 师生选课关系与课程权限判定
 * 3. 课件材料权限隔离：
 *    - 学生仅能看到本课程公开资料 + 自己私有资料；
 *    - 未选课学生或非本课教师无法访问；
 * 4. 作业发布权限隔离：
 *    - 学生仅能看到 published 的作业；
 *    - 教师可看到全部作业（包括草稿/未发布）；
 * 5. 提交记录与未确认成绩保护（核心红线）：
 *    - 教师能查看全班提交，完整保留建议分与评语；
 *    - 学生仅能查看自己提交的记录，严禁跨人查看；
 *    - 状态非 published 时，学生的建议分（grades）与评语（summary）必须被严格置空；
 *    - 教师 publishReview 发布后，学生方可查看正式成绩与评语。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseStore } from "../src/db/store.js";

test("DatabaseStore - 初始化与 Seed 默认实体", () => {
  const store = new DatabaseStore(":memory:");

  // 1. 用户验证
  const users = store.listUsers();
  assert.ok(users.length >= 5, "至少包含 5 个默认用户");
  
  const chen = store.getUser("t-chen");
  assert.equal(chen?.name, "陈知行");
  assert.equal(chen?.role, "teacher");

  const linTeacher = store.getUser("t-lin");
  assert.equal(linTeacher?.name, "林悦");
  assert.equal(linTeacher?.role, "teacher");

  const linStudent = store.getUser("s-yi");
  assert.equal(linStudent?.name, "林一");
  assert.equal(linStudent?.role, "student");

  const zhou = store.getUserByUsername("student.zhou");
  assert.equal(zhou?.name, "周可");
  assert.equal(zhou?.role, "student");

  // 2. 课程验证
  const courses = store.listCourses();
  assert.ok(courses.length >= 3, "至少包含 3 门课程");
  const cs101 = store.getCourse("cs101");
  assert.equal(cs101?.code, "CS 101");

  const net = store.getCourse("network");
  assert.equal(net?.title, "计算机网络");
  assert.equal(net?.teacherId, "t-chen");

  store.close();
});

test("DatabaseStore - 选课关系与课程可见性 (hasCourse & getUserCourses)", () => {
  const store = new DatabaseStore(":memory:");

  // 教师陈知行教授 network, os, cs101，但不教授 database
  assert.equal(store.hasCourse("t-chen", "network"), true);
  assert.equal(store.hasCourse("t-chen", "os"), true);
  assert.equal(store.hasCourse("t-chen", "database"), false);

  // 教师林悦教授 database
  assert.equal(store.hasCourse("t-lin", "database"), true);
  assert.equal(store.hasCourse("t-lin", "network"), false);

  // 学生林一选了 network, os, cs101，未选 database
  assert.equal(store.hasCourse("s-yi", "network"), true);
  assert.equal(store.hasCourse("s-yi", "os"), true);
  assert.equal(store.hasCourse("s-yi", "database"), false);

  // 学生周可选了 network, database, cs101，未选 os
  assert.equal(store.hasCourse("s-zhou", "network"), true);
  assert.equal(store.hasCourse("s-zhou", "database"), true);
  assert.equal(store.hasCourse("s-zhou", "os"), false);

  // getUserCourses 测试
  const chenCourses = store.getUserCourses("t-chen");
  assert.ok(chenCourses.some(c => c.id === "network"));
  assert.ok(!chenCourses.some(c => c.id === "database"));

  const yiCourses = store.getUserCourses("s-yi");
  assert.ok(yiCourses.some(c => c.id === "network"));
  assert.ok(!yiCourses.some(c => c.id === "database"));

  store.close();
});

test("DatabaseStore - 课件材料权限隔离 (getMaterials & getMaterialById)", () => {
  const store = new DatabaseStore(":memory:");

  // 在 network 课程中增加一份学生林一的私有笔记，以及一份公开资料
  store.createMaterial({
    id: "mat-yi-private",
    courseId: "network",
    ownerId: "s-yi",
    title: "林一的网络实验手记（私有）",
    kind: "DOCX",
    visibility: "private",
    status: "ready"
  });

  store.createMaterial({
    id: "mat-zhou-private",
    courseId: "network",
    ownerId: "s-zhou",
    title: "周可的网络实验速查（私有）",
    kind: "DOCX",
    visibility: "private",
    status: "ready"
  });

  // 1. 学生林一查询 network 课件：
  // 能看到：本课程公开资料 + 自己私有资料（mat-yi-private）
  // 不能看到：周可的私有资料（mat-zhou-private）以及教师陈知行的私有资料（mat-net-teach）
  const yiMaterials = store.getMaterials("s-yi", "network");
  const yiMaterialIds = yiMaterials.map(m => m.id);

  assert.ok(yiMaterialIds.includes("mat-tcp"), "公开资料应可见");
  assert.ok(yiMaterialIds.includes("mat-wire"), "公开资料应可见");
  assert.ok(yiMaterialIds.includes("mat-yi-private"), "自己的私有资料应可见");
  assert.equal(yiMaterialIds.includes("mat-zhou-private"), false, "他人的私有资料严格不可见");
  assert.equal(yiMaterialIds.includes("mat-net-teach"), false, "教师的私有教案对学生严格不可见");

  // 2. 学生周可查询 network 课件：
  // 只能看到自己私有的 mat-zhou-private，看不到林一的 mat-yi-private
  const zhouMaterials = store.getMaterials("s-zhou", "network");
  const zhouMaterialIds = zhouMaterials.map(m => m.id);
  assert.ok(zhouMaterialIds.includes("mat-zhou-private"));
  assert.equal(zhouMaterialIds.includes("mat-yi-private"), false);

  // 3. 授课教师陈知行查询 network 课件：
  // 能看到：公开课件 + 教师自己的私有资料（mat-net-teach）
  // 不能看到：学生的私有笔记（mat-yi-private / mat-zhou-private）
  const chenMaterials = store.getMaterials("t-chen", "network");
  const chenMaterialIds = chenMaterials.map(m => m.id);
  assert.ok(chenMaterialIds.includes("mat-tcp"));
  assert.ok(chenMaterialIds.includes("mat-net-teach"), "教师能看到自己的私有资料");
  assert.equal(chenMaterialIds.includes("mat-yi-private"), false, "教师不能越权查看学生的私有笔记");

  // 4. 未选修 database 课程的学生林一，查询 database 课件应返回空
  const yiDbMaterials = store.getMaterials("s-yi", "database");
  assert.equal(yiDbMaterials.length, 0, "未选课学生无法获取该课程课件");

  // 5. getMaterialById 权限校验
  assert.ok(store.getMaterialById("mat-tcp", "s-yi"), "学生能通过 ID 访问公开课件");
  assert.ok(store.getMaterialById("mat-yi-private", "s-yi"), "学生能通过 ID 访问自己私有课件");
  assert.equal(store.getMaterialById("mat-zhou-private", "s-yi"), null, "学生不可通过 ID 越权访问他人私有课件");
  assert.equal(store.getMaterialById("mat-tcp", "non-existent-user"), null, "不存在用户不可访问");

  // 6. 验证知识点与答疑卡结构解析
  const tcpMat = store.getMaterialById("mat-tcp");
  assert.ok(Array.isArray(tcpMat.knowledge), "knowledge 应解析为数组");
  assert.ok(tcpMat.knowledge.length > 0);
  assert.ok(Array.isArray(tcpMat.cards), "cards 应解析为数组");
  assert.equal(tcpMat.cards[0]?.id, "qa-syn");

  store.close();
});

test("DatabaseStore - 作业发布状态与学生权限隔离 (getAssignments & getAssignment)", () => {
  const store = new DatabaseStore(":memory:");

  // 创建一个未发布的草稿作业
  store.createAssignment({
    id: "lab-draft",
    courseId: "network",
    title: "实验三 · 未发布的路由协议实验草稿",
    due: "2026-10-01",
    description: "草稿作业",
    materialIds: [],
    rubric: [{ id: "r1", title: "测试项", max: 10, criterion: "评分准则" }],
    confirmed: false,
    published: false // 未发布！
  });

  // 1. 教师陈知行可以查看全部作业（包含已发布和未发布草稿）
  const teacherAssignments = store.getAssignments("t-chen", "network");
  const teacherAssignIds = teacherAssignments.map(a => a.id);
  assert.ok(teacherAssignIds.includes("lab-tcp"), "教师能看到已发布的作业");
  assert.ok(teacherAssignIds.includes("lab-draft"), "教师能看到未发布的作业草稿");

  // 2. 学生林一仅能查看已发布的作业，未发布的草稿对学生隐藏
  const studentAssignments = store.getAssignments("s-yi", "network");
  const studentAssignIds = studentAssignments.map(a => a.id);
  assert.ok(studentAssignIds.includes("lab-tcp"), "学生能看到已发布的作业");
  assert.equal(studentAssignIds.includes("lab-draft"), false, "学生严格看不到未发布的草稿");

  // 3. getAssignment 单查权限验证
  assert.ok(store.getAssignment("lab-draft", "t-chen"), "教师单查草稿作业成功");
  assert.equal(store.getAssignment("lab-draft", "s-yi"), null, "学生单查未发布作业返回 null");

  store.close();
});

test("DatabaseStore - 提交记录查看与未确认成绩严格保护（核心红线）", () => {
  const store = new DatabaseStore(":memory:");

  // 场景：
  // 作业 lab-os (操作系统实验)，授课教师为 t-chen
  // 学生 s-yi 的提交 sub-yi-os 为 published 状态，包含正式评分和评语
  // 学生 s-xu 的提交 sub-xu-os 为 review 状态（助教/AI 建议分，教师尚未确认发布），包含暂存评分和评语

  // 1. 教师陈知行视角查看 lab-os 全班提交
  const teacherSubmissions = store.getSubmissions("t-chen", "lab-os");
  assert.equal(teacherSubmissions.length, 2, "教师能看全班提交 (林一、许然)");

  const xuSubForTeacher = teacherSubmissions.find(s => s.id === "sub-xu-os");
  assert.ok(xuSubForTeacher, "教师能看到许然的提交");
  assert.equal(xuSubForTeacher.status, "review");
  assert.ok(xuSubForTeacher.grades.length > 0, "教师能看到审阅中的建议分");
  assert.ok(xuSubForTeacher.summary.length > 0, "教师能看到建议评语");

  // 2. 许然视角查看 lab-os 提交 (本人，但状态为 review，未 published)
  const xuSubmissions = store.getSubmissions("s-xu", "lab-os");
  assert.equal(xuSubmissions.length, 1, "学生仅能看到自己的提交");
  const xuSubForStudent = xuSubmissions[0];
  assert.equal(xuSubForStudent.id, "sub-xu-os");
  assert.equal(xuSubForStudent.status, "review");
  
  // ★ 核心安全红线断言：未 published 时，学生的建议分必须为空数组，summary 为空！
  assert.deepEqual(xuSubForStudent.grades, [], "未发布的建议分必须对学生置空！");
  assert.equal(xuSubForStudent.summary, "", "未发布的评语必须对学生清空！");

  // 单条查询 getSubmission 也必须受此规则保护
  const xuSingleSub = store.getSubmission("sub-xu-os", "s-xu");
  assert.deepEqual(xuSingleSub.grades, [], "单条查询未发布成绩时 grades 必须为空！");
  assert.equal(xuSingleSub.summary, "", "单条查询未发布成绩时 summary 必须为空！");

  // 3. 林一视角查看 lab-os 提交 (本人，状态为 published)
  const yiSubmissions = store.getSubmissions("s-yi", "lab-os");
  assert.equal(yiSubmissions.length, 1, "学生仅能看到自己的提交");
  const yiSubForStudent = yiSubmissions[0];
  assert.equal(yiSubForStudent.id, "sub-yi-os");
  assert.equal(yiSubForStudent.status, "published");
  assert.ok(yiSubForStudent.grades.length > 0, "已发布的正式成绩对学生可见");
  assert.ok(yiSubForStudent.summary.length > 0, "已发布的正式评语对学生可见");

  // 4. 学生跨人越权测试：林一尝试获取许然的提交
  const yiCrossCheck = store.getSubmission("sub-xu-os", "s-yi");
  assert.equal(yiCrossCheck, null, "学生严禁查看其他学生的作业提交");

  // 5. 非本课程教师越权测试：林悦 (t-lin) 不是 lab-os (操作系统) 的教师
  const wrongTeacherSubs = store.getSubmissions("t-lin", "lab-os");
  assert.equal(wrongTeacherSubs.length, 0, "非本课程教师无法查看全班提交");

  // 6. 教师发布成绩 (publishReview) 测试
  const publishedSub = store.publishReview(
    "sub-xu-os",
    "t-chen",
    [
      { rubricId: "os-r0", score: 20, comment: "优秀", page: 1, evidence: "" },
      { rubricId: "os-r1", score: 28, comment: "良好", page: 2, evidence: "" },
      { rubricId: "os-r2", score: 28, comment: "良好", page: 2, evidence: "" },
      { rubricId: "os-r3", score: 18, comment: "良好", page: 3, evidence: "" }
    ],
    "教师已审核通过并正式确认成绩。"
  );
  assert.equal(publishedSub.status, "published");
  assert.equal(publishedSub.history.length, 1);

  // 此时学生许然再次查看，已发布，能看到正式分数与评语
  const xuAfterPublish = store.getSubmissions("s-xu", "lab-os");
  assert.equal(xuAfterPublish[0].status, "published");
  assert.equal(xuAfterPublish[0].grades.length, 4, "发布后学生能看到确认的成绩");
  assert.equal(xuAfterPublish[0].summary, "教师已审核通过并正式确认成绩。");

  store.close();
});

test("DatabaseStore - 数据持久化与更新测试", () => {
  const store = new DatabaseStore(":memory:");

  // 1. 创建新用户与选课
  store.createUser({
    id: "s-new",
    username: "student.new",
    name: "新同学",
    role: "student"
  });
  store.enrollStudent("network", "s-new");
  assert.equal(store.hasCourse("s-new", "network"), true);

  // 2. 提交作业
  const newSub = store.createSubmission({
    id: "sub-new-net",
    assignmentId: "lab-tcp",
    studentId: "s-new",
    fileName: "TCP新报告.pdf",
    status: "submitted"
  });
  assert.equal(newSub.id, "sub-new-net");
  assert.equal(newSub.status, "submitted");

  // 3. 更新课件
  const mat = store.getMaterialById("mat-tcp");
  store.updateMaterial("mat-tcp", { title: "第三章 · TCP 可靠传输 (第2版)" });
  const updatedMat = store.getMaterialById("mat-tcp");
  assert.equal(updatedMat.title, "第三章 · TCP 可靠传输 (第2版)");

  // 4. 删除课件
  store.deleteMaterial("mat-tcp");
  assert.equal(store.getMaterialById("mat-tcp"), null);

  store.close();
});
