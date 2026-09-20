/**
 * LearnBuddy 教师人工复核改分、发布确认与全班学情分析闭环 单元测试
 * (Teacher Review & Publish + Feedback Analytics Test Suite)
 *
 * 验证重点：
 * 1. reviewAndPublishSubmission 教师人工复核与正式发布：
 *    - 权限红线：操作者必须是该作业所属课程的执教教师（非本课教师 / 学生 / 幽灵账号均拦截）
 *    - 程序严格求和：总分由后端遍历小项累加，忽略调用方传入的任何口算总分
 *    - 分数越界 clamp（负分夹取到 0，超额夹取到 max）与 strictRange 严格拒绝
 *    - ReviewVersion 快照写入 submission.history（confirmedAt / grades / summary / version）
 *    - grading 状态禁止发布；重复发布递增版本号
 * 2. 发布前后学生可见性红线（与 DatabaseStore 权限层联动）：
 *    - 发布前学生看不到分数与评语（严格置空）
 *    - 发布后学生可见正式成绩；其他学生依然不可见
 * 3. computeAssignmentAnalytics 作业维度学情统计：
 *    - 均分 / 最高分 / 最低分 / 提交率 / 评阅完成率 / 分数段分布
 *    - 各 Rubric 采分点平均得分率与失分率、weakestItems 全班薄弱项标记
 *    - teachingSuggestions 下周备课补讲建议（具体到课件页码与图表）
 * 4. computeCourseFeedbackOverview 课程大盘聚合
 * 5. HTTP REST 端点全链路：
 *    - POST /api/learnbuddy/grader/review-publish
 *    - GET  /api/learnbuddy/analytics/assignment/:id
 *    - GET  /api/learnbuddy/analytics/course/:id
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseStore } from "../src/db/store.js";
import { FeedbackAnalyticsService } from "../src/services/feedback-analytics.js";
import { registerLearnBuddyRoutes } from "../src/routes/api.js";
import { withAuthHeaders, tokenFor } from "./helpers/auth.js";

/**
 * 确定性 LLM 桩：未配置 Key、返回非 JSON 文本，
 * 使教学建议稳定走「规则降级」分支，避免测试依赖外网与真实模型。
 */
const stubLLMClient = {
  isConfigured: () => false,
  chatCompletion: async () => ({
    ok: true,
    content: "【本地规则兜底】未配置大模型，使用规则化教学建议。"
  })
};

function createService(store) {
  return new FeedbackAnalyticsService({ store, llmClient: stubLLMClient });
}

/** 构造 lab-tcp 的完整四项给分（[r0, r1, r2, r3]），支持传入越界值以验证 clamp */
function buildNetworkGrades(scores, comments = {}) {
  const rubricIds = ["network-r0", "network-r1", "network-r2", "network-r3"];
  const titles = ["实验环境与抓包过程", "三次握手字段分析", "抓包截图与证据", "异常分析与实验总结"];
  return scores.map((score, i) => ({
    rubricId: rubricIds[i],
    title: titles[i],
    score,
    page: Math.min(i + 1, 3),
    comment: comments[i] || `第 ${i + 1} 项教师复核批注。`,
    evidence: `报告第 ${Math.min(i + 1, 3)} 页对应证据。`
  }));
}

function makeHttpRequest(port, method, path, headers = {}, body = null) {
  return withAuthHeaders(port, headers).then((authHeaders) => new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers: authHeaders },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on("error", reject);
    if (body !== null) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  }));
}

// ==========================================
// 1. 教师复核发布成功 + ReviewVersion 快照
// ==========================================
test("FeedbackAnalytics - reviewAndPublishSubmission 复核成功、程序严格求和并写入 ReviewVersion 快照", async () => {
  const store = new DatabaseStore(":memory:");
  const service = createService(store);

  const grades = buildNetworkGrades([18, 27, 24, 14], {
    0: "网络环境与过滤条件描述完整，过程可复现。",
    1: "三次握手 seq/ack 演进解释准确。",
    2: "截图与结论对应清晰。",
    3: "异常分析到位。"
  });

  const result = await service.reviewAndPublishSubmission("sub-zhou-net", {
    teacherId: "t-chen",
    grades,
    summary: "整体完成度较高，异常诊断部分可再补充防火墙拦截场景。",
    // 恶意/错误的口算总分必须被程序忽略
    totalScore: 9999,
    maxScore: 9999
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "published");
  assert.equal(result.previousStatus, "submitted");
  assert.equal(result.maxScore, 100, "满分必须来自 Rubric 程序求和 (20+30+30+20)");
  assert.equal(result.totalScore, 83, "总分必须由程序严格累加 18+27+24+14 = 83，忽略传入的 9999");
  assert.equal(result.clamped, false);
  assert.deepEqual(result.clampedItems, []);
  assert.equal(result.reviewVersion, 1);
  assert.equal(result.grades.length, 4);
  assert.equal(result.summary, "整体完成度较高，异常诊断部分可再补充防火墙拦截场景。");

  // 数据库持久化校验
  const persisted = store.getSubmission("sub-zhou-net");
  assert.equal(persisted.status, "published");
  assert.equal(persisted.grades.length, 4);
  assert.equal(persisted.failure, null);
  assert.equal(persisted.history.length, 1, "必须写入一条 ReviewVersion 快照");

  const snapshot = persisted.history[0];
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.teacherId, "t-chen");
  assert.equal(snapshot.reviewerId, "t-chen");
  assert.equal(snapshot.totalScore, 83);
  assert.equal(snapshot.maxScore, 100);
  assert.equal(snapshot.summary, persisted.summary);
  assert.equal(snapshot.grades.length, 4);
  assert.ok(typeof snapshot.confirmedAt === "string" && snapshot.confirmedAt.length > 0, "快照必须含 confirmedAt");
  assert.ok(!Number.isNaN(Date.parse(snapshot.confirmedAt)), "confirmedAt 必须是合法时间戳");

  // 快照与正式成绩必须是彼此独立的深拷贝，互不污染
  assert.notEqual(snapshot.grades, persisted.grades);
  snapshot.grades[0].score = -1;
  assert.equal(store.getSubmission("sub-zhou-net").grades[0].score, 18);

  store.close();
});

// ==========================================
// 2. 分数越界 clamp 与 strictRange 严格拒绝
// ==========================================
test("FeedbackAnalytics - 分数越界 clamp 到 [0, max] 并留痕，strictRange 下严格拒绝", async () => {
  const store = new DatabaseStore(":memory:");
  const service = createService(store);

  const result = await service.reviewAndPublishSubmission("sub-xu-net", {
    teacherId: "t-chen",
    grades: buildNetworkGrades([999, -10, 30, 15]),
    summary: "越界分数夹取测试。"
  });

  assert.equal(result.totalScore, 65, "20(max) + 0 + 30 + 15 = 65");
  assert.equal(result.clamped, true);
  assert.equal(result.clampedItems.length, 2);

  const r0 = result.grades.find((g) => g.rubricId === "network-r0");
  assert.equal(r0.score, 20, "999 必须被 clamp 到 max=20");
  assert.equal(r0.clamped, true);
  assert.equal(r0.originalScore, 999);

  const r1 = result.grades.find((g) => g.rubricId === "network-r1");
  assert.equal(r1.score, 0, "-10 必须被 clamp 到 0");
  assert.equal(r1.originalScore, -10);

  // 快照同样记录 clamp 事实
  const persisted = store.getSubmission("sub-xu-net");
  assert.equal(persisted.history[0].clamped, true);
  assert.equal(persisted.history[0].clampedItems.length, 2);

  // strictRange: true 时越界分数直接拒绝，且不改动数据库
  const store2 = new DatabaseStore(":memory:");
  const service2 = createService(store2);
  await assert.rejects(
    () =>
      service2.reviewAndPublishSubmission("sub-zhou-net", {
        teacherId: "t-chen",
        grades: buildNetworkGrades([200, 20, 20, 20]),
        strictRange: true
      }),
    (err) => {
      assert.ok(err.message.includes("打分超限"));
      assert.ok(err.message.includes("[0, 20]"));
      return true;
    }
  );
  assert.equal(store2.getSubmission("sub-zhou-net").status, "submitted", "被拒绝的发布不得改动状态");
  assert.equal(store2.getSubmission("sub-zhou-net").history.length, 0);

  // 非法数字与非空校验
  await assert.rejects(
    () =>
      service2.reviewAndPublishSubmission("sub-zhou-net", {
        teacherId: "t-chen",
        grades: buildNetworkGrades(["abc", 20, 20, 20])
      }),
    /分数必须为合法数字/
  );
  await assert.rejects(
    () =>
      service2.reviewAndPublishSubmission("sub-zhou-net", {
        teacherId: "t-chen",
        grades: buildNetworkGrades([null, 20, 20, 20])
      }),
    /分数不能为空/
  );

  // 缺少某个采分项时必须拒绝，禁止静默按 0 记分
  await assert.rejects(
    () =>
      service2.reviewAndPublishSubmission("sub-zhou-net", {
        teacherId: "t-chen",
        grades: buildNetworkGrades([18, 27, 24])
      }),
    /缺少评分项「异常分析与实验总结」/
  );

  // 必填参数校验
  await assert.rejects(
    () => service2.reviewAndPublishSubmission("", { teacherId: "t-chen", grades: [] }),
    /缺少必要参数: submissionId/
  );
  await assert.rejects(
    () => service2.reviewAndPublishSubmission("sub-zhou-net", { grades: [] }),
    /缺少必要参数: teacherId/
  );
  await assert.rejects(
    () => service2.reviewAndPublishSubmission("sub-zhou-net", { teacherId: "t-chen", grades: {} }),
    /grades 必须为数组格式/
  );

  store.close();
  store2.close();
});

// ==========================================
// 3. 权限红线：仅本课程执教教师可复核发布
// ==========================================
test("FeedbackAnalytics - 权限红线拦截非本课教师、学生与不存在用户", async () => {
  const store = new DatabaseStore(":memory:");
  const service = createService(store);
  const grades = buildNetworkGrades([18, 27, 24, 14]);

  // 1. t-lin 是「数据库原理」执教教师，对 network 课程的 lab-tcp 无权复核
  await assert.rejects(
    () => service.reviewAndPublishSubmission("sub-zhou-net", { teacherId: "t-lin", grades }),
    (err) => {
      assert.ok(err.message.includes("权限不足"));
      assert.ok(err.message.includes("不是课程「network」的执教教师"));
      return true;
    }
  );

  // 2. 学生角色不得复核成绩
  await assert.rejects(
    () => service.reviewAndPublishSubmission("sub-zhou-net", { teacherId: "s-yi", grades }),
    /非教师角色，禁止复核成绩/
  );

  // 3. 不存在的用户
  await assert.rejects(
    () => service.reviewAndPublishSubmission("sub-zhou-net", { teacherId: "t-ghost", grades }),
    /用户不存在: t-ghost/
  );

  // 4. 报告 / 作业不存在
  await assert.rejects(
    () => service.reviewAndPublishSubmission("sub-not-exist", { teacherId: "t-chen", grades }),
    /提交记录不存在: sub-not-exist/
  );

  // 5. 越权失败后数据必须保持原样
  const untouched = store.getSubmission("sub-zhou-net");
  assert.equal(untouched.status, "submitted");
  assert.equal(untouched.history.length, 0);

  // 6. 本课执教教师（t-chen 执教 network）可以正常复核
  const okResult = await service.reviewAndPublishSubmission("sub-zhou-net", {
    teacherId: "t-chen",
    grades
  });
  assert.equal(okResult.ok, true);
  assert.equal(okResult.status, "published");

  // 7. 另一位教师 t-lin 执教 database，可复核 lab-db 的报告
  store.createSubmission({
    id: "sub-yi-db",
    assignmentId: "lab-db",
    studentId: "s-yi",
    fileName: "索引实验报告_林一.pdf",
    status: "review",
    grades: []
  });
  const dbResult = await service.reviewAndPublishSubmission("sub-yi-db", {
    teacherId: "t-lin",
    grades: [
      { rubricId: "database-r0", score: 20 },
      { rubricId: "database-r1", score: 27 },
      { rubricId: "database-r2", score: 24 },
      { rubricId: "database-r3", score: 17 }
    ]
  });
  assert.equal(dbResult.totalScore, 88);
  assert.equal(dbResult.status, "published");

  store.close();
});

// ==========================================
// 4. 发布前后学生可见性红线
// ==========================================
test("FeedbackAnalytics - 发布前学生看不到成绩，发布后正式可见", async () => {
  const store = new DatabaseStore(":memory:");
  const service = createService(store);

  // 1. 发布前：学生视角分数与评语严格置空
  const beforeStudent = store.getSubmission("sub-zhou-net", "s-zhou");
  assert.equal(beforeStudent.status, "submitted");
  assert.deepEqual(beforeStudent.grades, [], "未发布前学生不可见任何建议分");
  assert.equal(beforeStudent.summary, "", "未发布前学生不可见任何评语");

  const beforeList = store.getSubmissions("s-zhou", "lab-tcp");
  assert.equal(beforeList.length, 1);
  assert.deepEqual(beforeList[0].grades, []);

  // 2. 教师视角始终可见（复核依据）
  const teacherView = store.getSubmission("sub-zhou-net", "t-chen");
  assert.equal(teacherView.status, "submitted");

  // 3. 执行复核发布
  const published = await service.reviewAndPublishSubmission("sub-zhou-net", {
    teacherId: "t-chen",
    grades: buildNetworkGrades([18, 27, 24, 14]),
    summary: "已人工复核，正式发布。"
  });
  assert.equal(published.status, "published");

  // 4. 发布后：该学生可见正式成绩与评语
  const afterStudent = store.getSubmission("sub-zhou-net", "s-zhou");
  assert.equal(afterStudent.status, "published");
  assert.equal(afterStudent.grades.length, 4);
  assert.equal(afterStudent.grades.reduce((s, g) => s + g.score, 0), 83);
  assert.equal(afterStudent.summary, "已人工复核，正式发布。");

  const afterList = store.getSubmissions("s-zhou", "lab-tcp");
  assert.equal(afterList[0].grades.length, 4);

  // 5. 其他学生依然不可见他人报告
  assert.equal(store.getSubmission("sub-zhou-net", "s-xu"), null);
  // 6. 非选课学生不可见
  assert.equal(store.getSubmission("sub-zhou-net", "s-anon"), null);

  // 7. 教师能看到全班
  assert.equal(store.getSubmissions("t-chen", "lab-tcp").length, 2);

  store.close();
});

// ==========================================
// 5. 状态机红线：grading 中禁止发布；重复发布递增版本
// ==========================================
test("FeedbackAnalytics - grading 状态禁止发布，重复复核发布递增 ReviewVersion", async () => {
  const store = new DatabaseStore(":memory:");
  const service = createService(store);

  // 1. 评阅中禁止抢跑发布
  store.updateSubmission("sub-zhou-net", { status: "grading" });
  await assert.rejects(
    () =>
      service.reviewAndPublishSubmission("sub-zhou-net", {
        teacherId: "t-chen",
        grades: buildNetworkGrades([18, 27, 24, 14])
      }),
    /正在后台评阅中/
  );
  assert.equal(store.getSubmission("sub-zhou-net").status, "grading");
  assert.equal(store.getSubmission("sub-zhou-net").history.length, 0);

  // 2. 恢复为 review 后正常发布 v1
  store.updateSubmission("sub-zhou-net", { status: "review" });
  const v1 = await service.reviewAndPublishSubmission("sub-zhou-net", {
    teacherId: "t-chen",
    grades: buildNetworkGrades([18, 27, 24, 14]),
    summary: "第一次复核。"
  });
  assert.equal(v1.reviewVersion, 1);
  assert.equal(v1.previousStatus, "review");

  // 3. 教师改分后再次发布 -> v2，历史保留两个版本
  const v2 = await service.reviewAndPublishSubmission("sub-zhou-net", {
    teacherId: "t-chen",
    grades: buildNetworkGrades([20, 30, 28, 18]),
    summary: "二次复核上调分数。"
  });
  assert.equal(v2.reviewVersion, 2);
  assert.equal(v2.previousStatus, "published");
  assert.equal(v2.totalScore, 96);

  const persisted = store.getSubmission("sub-zhou-net");
  assert.equal(persisted.status, "published");
  assert.equal(persisted.grades.reduce((s, g) => s + g.score, 0), 96);
  assert.equal(persisted.summary, "二次复核上调分数。");
  assert.equal(persisted.history.length, 2);
  assert.equal(persisted.history[0].version, 1);
  assert.equal(persisted.history[0].totalScore, 83, "v1 历史快照必须保持原始 83 分不被覆盖");
  assert.equal(persisted.history[1].version, 2);
  assert.equal(persisted.history[1].totalScore, 96);

  store.close();
});

// ==========================================
// 6. computeAssignmentAnalytics 学情统计正确性
// ==========================================
test("FeedbackAnalytics - computeAssignmentAnalytics 均分/失分率/weakestItems 统计正确", async () => {
  const store = new DatabaseStore(":memory:");
  const service = createService(store);

  // 1. 尚未发布任何报告：均分为 0，薄弱项为空，给出兜底建议
  const emptyOverview = await service.computeAssignmentAnalytics("lab-tcp", { skipLLM: true });
  assert.equal(emptyOverview.ok, true);
  assert.equal(emptyOverview.assignmentTitle, "实验一 · TCP 三次握手分析");
  assert.equal(emptyOverview.totalStudents, 3, "network 课程选课 3 人");
  assert.equal(emptyOverview.totalSubmissions, 2);
  assert.equal(emptyOverview.publishedCount, 0);
  assert.equal(emptyOverview.reviewCompletionRate, 0);
  assert.equal(emptyOverview.averageScore, 0);
  assert.equal(emptyOverview.weakestItems.length, 0);
  assert.equal(emptyOverview.teachingSuggestions[0].topic, "全班表现优异");

  // 2. 发布两份报告：83 分与 69 分
  await service.reviewAndPublishSubmission("sub-zhou-net", {
    teacherId: "t-chen",
    grades: buildNetworkGrades([18, 27, 24, 14])
  });
  await service.reviewAndPublishSubmission("sub-xu-net", {
    teacherId: "t-chen",
    grades: buildNetworkGrades([16, 21, 18, 14])
  });

  const analytics = await service.computeAssignmentAnalytics("lab-tcp", { skipLLM: true });

  // 2.1 基础统计
  assert.equal(analytics.totalStudents, 3);
  assert.equal(analytics.totalSubmissions, 2);
  assert.equal(analytics.publishedCount, 2);
  assert.equal(analytics.reviewedCount, 2);
  assert.equal(analytics.gradingCount, 0);
  assert.equal(analytics.failedCount, 0);
  assert.equal(analytics.submissionRate, 0.67, "2/3 提交率");
  assert.equal(analytics.reviewCompletionRate, 1, "2/2 评阅完成率");
  assert.equal(analytics.maxScore, 100);
  assert.equal(analytics.averageScore, 76, "(83 + 69) / 2 = 76");
  assert.equal(analytics.highestScore, 83);
  assert.equal(analytics.lowestScore, 69);
  assert.equal(analytics.averageScoreRate, 0.76);

  // 2.2 分数段分布
  const band = (name) => analytics.scoreDistribution.find((b) => b.band === name).count;
  assert.equal(band("80-89"), 1, "83 分落在 80-89 段");
  assert.equal(band("60-69"), 1, "69 分落在 60-69 段");
  assert.equal(band("0-59"), 0);
  assert.equal(analytics.scoreDistribution.reduce((s, b) => s + b.count, 0), 2);

  // 2.3 逐项得分率与失分率
  const r0 = analytics.rubricAnalytics.find((r) => r.rubricId === "network-r0");
  assert.equal(r0.max, 20);
  assert.equal(r0.studentCount, 2);
  assert.equal(r0.avgScore, 17, "(18+16)/2 = 17");
  assert.equal(r0.scoreRate, 0.85);
  assert.equal(r0.lossRate, 0.15);
  assert.equal(r0.avgLostPoints, 3);

  const r2 = analytics.rubricAnalytics.find((r) => r.rubricId === "network-r2");
  assert.equal(r2.avgScore, 21, "(24+18)/2 = 21");
  assert.equal(r2.scoreRate, 0.7);
  assert.equal(r2.lossRate, 0.3);
  assert.equal(r2.title, "抓包截图与证据");

  // 2.4 全班薄弱项：按失分率降序（r2/r3 均 0.3，高于 r1 的 0.2 与 r0 的 0.15）
  assert.equal(analytics.weakestItems.length, 4, "四个采分点均有失分");
  assert.equal(analytics.weakestItems[0].lossRate, 0.3);
  assert.deepEqual(
    analytics.weakestItems.slice(0, 2).map((w) => w.rubricId).sort(),
    ["network-r2", "network-r3"],
    "最薄弱两项必须是抓包证据与异常分析"
  );
  assert.equal(analytics.weakestItems.at(-1).rubricId, "network-r0", "失分率最低的排在末位");

  // 2.5 下周备课/补讲建议：具体到课件页码与图表，并量化失分率
  assert.equal(analytics.teachingSuggestions.length, 3, "取失分率最高的 3 项生成补讲建议");
  for (const suggestion of analytics.teachingSuggestions) {
    assert.ok(suggestion.topic, "建议必须包含薄弱采分点主题");
    assert.ok(Number.isInteger(suggestion.targetPage) && suggestion.targetPage >= 1, "必须明确指出课件页码");
    assert.ok(typeof suggestion.targetFigure === "string" && suggestion.targetFigure.length > 0, "必须明确指出课件图表");
    assert.ok(suggestion.suggestion.includes("失分率"), "建议必须量化说明全班失分情况");
    assert.ok(suggestion.actionPlan.length > 0, "必须给出可落地的课堂行动计划");
  }
  assert.equal(analytics.teachingSuggestions[0].rubricId, analytics.weakestItems[0].rubricId);

  // 3. 未发布 / 评阅中的报告不得计入成绩统计
  store.createSubmission({
    id: "sub-review-only",
    assignmentId: "lab-tcp",
    studentId: "s-yi",
    fileName: "待复核报告.pdf",
    status: "review",
    grades: [{ rubricId: "network-r0", score: 20 }]
  });
  const afterExtra = await service.computeAssignmentAnalytics("lab-tcp", { skipLLM: true });
  assert.equal(afterExtra.totalSubmissions, 3);
  assert.equal(afterExtra.publishedCount, 2, "review 状态的报告不得计入已发布成绩");
  assert.equal(afterExtra.averageScore, 76, "均分只统计已发布成绩");
  assert.equal(afterExtra.reviewCompletionRate, 0.67, "2/3 报告完成评阅发布");
  assert.equal(afterExtra.reviewedCount, 3);

  // 4. 作业不存在
  await assert.rejects(
    () => service.computeAssignmentAnalytics("lab-not-exist"),
    /作业不存在: lab-not-exist/
  );
  await assert.rejects(() => service.computeAssignmentAnalytics(""), /缺少必要参数: assignmentId/);

  store.close();
});

// ==========================================
// 7. computeCourseFeedbackOverview 课程大盘聚合
// ==========================================
test("FeedbackAnalytics - computeCourseFeedbackOverview 课程大盘与跨作业薄弱项聚合", async () => {
  const store = new DatabaseStore(":memory:");
  const service = createService(store);

  // 1. network 课程：发布两份报告
  await service.reviewAndPublishSubmission("sub-zhou-net", {
    teacherId: "t-chen",
    grades: buildNetworkGrades([18, 27, 24, 14])
  });
  await service.reviewAndPublishSubmission("sub-xu-net", {
    teacherId: "t-chen",
    grades: buildNetworkGrades([16, 21, 18, 14])
  });

  const overview = await service.computeCourseFeedbackOverview("network", { skipLLM: true });
  assert.equal(overview.ok, true);
  assert.equal(overview.courseId, "network");
  assert.equal(overview.courseTitle, "计算机网络");
  assert.equal(overview.courseCode, "CS 203");
  assert.equal(overview.teacherId, "t-chen");
  assert.equal(overview.totalStudents, 3);
  assert.equal(overview.totalAssignments, 1);
  assert.equal(overview.publishedAssignmentsCount, 1);
  assert.equal(overview.totalSubmissionsCount, 2);
  assert.equal(overview.totalPublishedSubmissionsCount, 2);
  assert.equal(overview.overallAverageScore, 76);
  assert.equal(overview.overallSubmissionRate, 0.67, "2 份提交 / (3 人 × 1 次作业)");
  assert.equal(overview.overallReviewCompletionRate, 1);

  // 作业摘要
  assert.equal(overview.assignmentSummaries.length, 1);
  const summary = overview.assignmentSummaries[0];
  assert.equal(summary.assignmentId, "lab-tcp");
  assert.equal(summary.title, "实验一 · TCP 三次握手分析");
  assert.equal(summary.averageScore, 76);
  assert.equal(summary.highestScore, 83);
  assert.equal(summary.lowestScore, 69);
  assert.ok(summary.weakestItem, "作业摘要必须带出最薄弱采分点");
  assert.equal(summary.weakestItem.rubricId, "network-r2");

  // 课程级薄弱项排行
  assert.ok(overview.weakestItems.length >= 4);
  assert.equal(overview.weakestItems[0].lossRate, 0.3);
  assert.equal(overview.weakestItems[0].assignmentId, "lab-tcp");
  assert.ok(overview.weakestItems[0].assignmentTitle.includes("TCP"));
  for (let i = 1; i < overview.weakestItems.length; i++) {
    assert.ok(
      overview.weakestItems[i - 1].lossRate >= overview.weakestItems[i].lossRate,
      "课程级薄弱项必须按失分率降序排列"
    );
  }

  // 课程级教学建议汇总
  assert.equal(overview.teachingAdvice.length, 1);
  assert.equal(overview.teachingAdvice[0].assignmentId, "lab-tcp");
  assert.equal(overview.teachingAdvice[0].suggestions.length, 3);

  // 2. os 课程：种子数据中 sub-yi-os 已 published（20+27+24+17 = 88）
  const osOverview = await service.computeCourseFeedbackOverview("os", { skipLLM: true });
  assert.equal(osOverview.courseTitle, "操作系统");
  assert.equal(osOverview.totalAssignments, 1);
  assert.equal(osOverview.totalPublishedSubmissionsCount, 1);
  assert.equal(osOverview.overallAverageScore, 88);
  assert.equal(osOverview.assignmentSummaries[0].publishedCount, 1);

  // 3. 课程不存在 / 参数缺失
  await assert.rejects(
    () => service.computeCourseFeedbackOverview("course-not-exist"),
    /课程不存在: course-not-exist/
  );
  await assert.rejects(() => service.computeCourseFeedbackOverview(""), /缺少必要参数: courseId/);

  store.close();
});

// ==========================================
// 8. HTTP REST 端点全链路
// ==========================================
test("HTTP API - review-publish / analytics/assignment / analytics/course 全链路", async () => {
  const store = new DatabaseStore(":memory:");
  const service = createService(store);
  const middlewares = [];
  const fakeCtx = { webServer: { use: (fn) => middlewares.push(fn) } };

  registerLearnBuddyRoutes(fakeCtx, { store, feedbackAnalyticsService: service });

  const testServer = http.createServer(async (req, res) => {
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

  await new Promise((resolve) => testServer.listen(0, "127.0.0.1", resolve));
  const port = testServer.address().port;
  const jsonHeaders = { "Content-Type": "application/json" };

  try {
    // 1. 身份绑定：身份只来自令牌，body 里的 teacherId 已不再是身份来源。
    //    不带令牌打 review-publish 一律 401（旧用例断言「缺 teacherId → 400」已随身份绑定退役，
    //    因为此时 teacherId 取自令牌、永远存在，入参 teacherId 被忽略）。
    const unauth = await makeHttpRequest(
      port,
      "POST",
      "/api/learnbuddy/grader/review-publish",
      { ...jsonHeaders, skipAuth: true },
      {
        submissionId: "sub-zhou-net",
        teacherId: "t-chen",
        grades: buildNetworkGrades([18, 27, 24, 14])
      }
    );
    assert.equal(unauth.statusCode, 401, "未登录复核必须 401");

    // 参数校验与身份无关：带合法令牌（默认 teacher.chen）但缺 submissionId 仍为 400
    const noSubmission = await makeHttpRequest(port, "POST", "/api/learnbuddy/grader/review-publish", jsonHeaders, {
      grades: []
    });
    assert.equal(noSubmission.statusCode, 400);
    assert.ok(JSON.parse(noSubmission.body.toString()).error.includes("缺少必要参数: submissionId"));

    // 参数校验与身份无关：grades 非数组必须在进入业务前被拦下
    const badGrades = await makeHttpRequest(port, "POST", "/api/learnbuddy/grader/review-publish", jsonHeaders, {
      submissionId: "sub-zhou-net",
      grades: "not-an-array"
    });
    assert.equal(badGrades.statusCode, 400);
    assert.ok(JSON.parse(badGrades.body.toString()).error.includes("grades 必须为数组格式"));

    // 2. 越权教师 403：以 teacher.lin（「数据库原理」执教教师，非 network 执教教师）真实登录后
    //    去打 t-chen 课程下的提交。身份不可伪造——body 里写什么都不会改变判定结果。
    const asLin = {
      ...jsonHeaders,
      Authorization: `Bearer ${await tokenFor(port, { username: "teacher.lin", password: "123" })}`
    };
    const forbidden = await makeHttpRequest(port, "POST", "/api/learnbuddy/grader/review-publish", asLin, {
      submissionId: "sub-zhou-net",
      grades: buildNetworkGrades([18, 27, 24, 14])
    });
    assert.equal(forbidden.statusCode, 403);
    assert.ok(JSON.parse(forbidden.body.toString()).error.includes("权限不足"));

    // 3. 报告不存在 404
    const notFound = await makeHttpRequest(port, "POST", "/api/learnbuddy/grader/review-publish", jsonHeaders, {
      submissionId: "sub-ghost",
      grades: buildNetworkGrades([18, 27, 24, 14])
    });
    assert.equal(notFound.statusCode, 404);

    // 4. 正常复核发布：不带任何身份字段，复核人取自默认的 teacher.chen 令牌（越界分数 clamp）
    const publishRes = await makeHttpRequest(port, "POST", "/api/learnbuddy/grader/review-publish", jsonHeaders, {
      submissionId: "sub-zhou-net",
      grades: buildNetworkGrades([18, 27, 24, 14]),
      summary: "HTTP 全链路复核发布。"
    });
    assert.equal(publishRes.statusCode, 200);
    const publishData = JSON.parse(publishRes.body.toString());
    assert.equal(publishData.ok, true);
    assert.equal(publishData.status, "published");
    assert.equal(publishData.totalScore, 83);
    assert.equal(publishData.maxScore, 100);
    assert.equal(publishData.reviewVersion, 1);
    assert.equal(publishData.history.length, 1);

    // 5. 发布后学生可见（HTTP 侧写入与权限层联动）
    const studentView = store.getSubmission("sub-zhou-net", "s-zhou");
    assert.equal(studentView.grades.length, 4);
    assert.equal(studentView.summary, "HTTP 全链路复核发布。");

    // 6. 作业维度学情
    const assignmentRes = await makeHttpRequest(
      port,
      "GET",
      "/api/learnbuddy/analytics/assignment/lab-tcp?skipLLM=true"
    );
    assert.equal(assignmentRes.statusCode, 200);
    const assignmentData = JSON.parse(assignmentRes.body.toString());
    assert.equal(assignmentData.ok, true);
    assert.equal(assignmentData.assignmentId, "lab-tcp");
    assert.equal(assignmentData.publishedCount, 1);
    assert.equal(assignmentData.averageScore, 83);
    assert.equal(assignmentData.submissionRate, 0.67);
    assert.ok(assignmentData.weakestItems.length > 0);
    assert.ok(assignmentData.teachingSuggestions.length > 0);
    assert.ok(assignmentData.teachingSuggestions[0].targetPage >= 1);

    // 7. 作业不存在 404
    const assignment404 = await makeHttpRequest(port, "GET", "/api/learnbuddy/analytics/assignment/lab-ghost");
    assert.equal(assignment404.statusCode, 404);
    assert.ok(JSON.parse(assignment404.body.toString()).error.includes("作业不存在"));

    // 8. 课程大盘学情
    const courseRes = await makeHttpRequest(port, "GET", "/api/learnbuddy/analytics/course/network?skipLLM=true");
    assert.equal(courseRes.statusCode, 200);
    const courseData = JSON.parse(courseRes.body.toString());
    assert.equal(courseData.ok, true);
    assert.equal(courseData.courseId, "network");
    assert.equal(courseData.totalAssignments, 1);
    assert.equal(courseData.overallAverageScore, 83);
    assert.equal(courseData.assignmentSummaries.length, 1);
    assert.ok(courseData.weakestItems.length > 0);
    assert.equal(courseData.teachingAdvice.length, 1);

    // 9. 课程不存在 404
    const course404 = await makeHttpRequest(port, "GET", "/api/learnbuddy/analytics/course/course-ghost");
    assert.equal(course404.statusCode, 404);
    assert.ok(JSON.parse(course404.body.toString()).error.includes("课程不存在"));

    // 10. 未匹配路由回落 404，确认中间件正确放行
    const fallthrough = await makeHttpRequest(port, "GET", "/api/learnbuddy/not-a-route");
    assert.equal(fallthrough.statusCode, 404);
    assert.equal(fallthrough.body.toString(), "Not Found");
  } finally {
    testServer.close();
    store.close();
  }
});
