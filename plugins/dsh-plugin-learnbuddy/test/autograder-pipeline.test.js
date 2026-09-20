/**
 * AutoGrader 报告逐项核查与状态机管理引擎 单元测试
 * (AutoGrader Pipeline & State Machine Test Suite)
 * 
 * 验证重点：
 * 1. extractReportContent 多模态报告解构与提取：
 *    - 内置 sampleKey (network, os, database) 解构
 *    - 物理原件 blobId 元数据与兜底提取
 * 2. calculateGradesAndTotal 程序严格求和与小项 [0, max] 边界保护：
 *    - 严禁信任模型口算的 totalScore（强制忽略模型口算值）
 *    - 分数边界限制（负分 clamp 到 0，超额分数 clamp 到 max）
 *    - 证据页码 (page >= 1) 与评语 (comment, evidence) 完整性
 * 3. gradeSubmission 状态机生命周期流转：
 *    - submitted -> grading -> review (待教师复核)
 *    - 作业未配置 Rubric 时自动 fallback 标杆计网实验 Rubric
 *    - 非法状态流转拦截（review / published 状态禁止启动评阅）
 *    - 异常容错机制：发生错误时原子更新为 failed 并记录 failure 原因
 * 4. retryGrading 失败重试：
 *    - 对 failed 状态的报告重新评阅，成功后流转至 review 并清空 failure
 *    - 对非 failed 状态报告发起 retry 被严格拦截
 * 5. gradeBatchSubmissions 全班批量报告受控并发调度：
 *    - 自动筛选 submitted 与 failed 状态报告，排除已 published / review 报告
 *    - 受控并发调度与进度统计 (total, processed, succeeded, failed, results)
 * 6. HTTP REST API 端点集成测试：
 *    - POST /api/learnbuddy/grader/grade-submission
 *    - POST /api/learnbuddy/grader/batch
 *    - POST /api/learnbuddy/grader/retry
 *    - 缺失参数 400 校验与异常处理
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseStore } from "../src/db/store.js";
import {
  AutoGraderPipelineService,
  DEFAULT_NETWORK_RUBRIC,
  SAMPLE_STUDENT_REPORTS,
  extractReportContent,
  calculateGradesAndTotal
} from "../src/services/autograder-pipeline.js";
import { registerLearnBuddyRoutes } from "../src/routes/api.js";

function makeHttpRequest(port, method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks)
          });
        });
      }
    );
    req.on("error", reject);
    if (body) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
}

// ==========================================
// 1. extractReportContent 报告提取验证
// ==========================================
test("AutoGrader - extractReportContent 多模态报告解构与提取", () => {
  // 1. 命中 network sampleKey
  const netReport = extractReportContent({
    fileName: "TCP实验报告_周可.pdf",
    sampleKey: "network"
  });
  assert.ok(netReport, "必须成功解构 network 报告");
  assert.equal(netReport.title, "TCP实验报告_周可.pdf");
  assert.ok(netReport.content.includes("TCP 三次握手"));
  assert.ok(netReport.content.includes("Wireshark"));
  assert.equal(netReport.pages, 3);
  assert.equal(netReport.hasImages, true);
  assert.ok(netReport.diagrams.length >= 2);
  assert.equal(netReport.diagrams[0].page, 2);

  // 2. 命中 os sampleKey
  const osReport = extractReportContent({
    fileName: "进程同步实验.pdf",
    sampleKey: "os"
  });
  assert.ok(osReport.content.includes("POSIX pthread"));
  assert.ok(osReport.content.includes("生产者与消费者"));

  // 3. 通用兜底解构
  const fallbackReport = extractReportContent({
    fileName: "未知自定义作业.pdf"
  });
  assert.ok(fallbackReport.title.includes("未知自定义作业"));
  assert.equal(fallbackReport.pages, 3);
  assert.equal(fallbackReport.hasImages, true);

  // 4. 空入参保护
  assert.equal(extractReportContent(null), null);
});

// ==========================================
// 2. calculateGradesAndTotal 【程序严格求和与边界限制】
// ==========================================
test("AutoGrader - calculateGradesAndTotal 程序严格累加求和与模型口算防御", () => {
  const rubric = [
    { id: "r-1", title: "环境搭建", max: 20 },
    { id: "r-2", title: "抓包时序分析", max: 40 },
    { id: "r-3", title: "异常排查与总结", max: 40 }
  ];

  // 模拟大模型试图篡改口算总分（口算写了 9999），且个别小项越界（负数与溢出）
  const maliciousModelOutput = {
    totalScore: 9999, // 恶意或错误的大模型口算值
    summary: "学生实验完成良好，三次握手分析清晰。",
    items: [
      { rubricId: "r-1", score: -10, page: 1, comment: "拓扑完整", evidence: "拓扑截图" }, // 负数 -> 应 clamp 为 0
      { rubricId: "r-2", score: 85, page: 2, comment: "时序正确", evidence: "时序图" },   // 超过 max(40) -> 应 clamp 为 40
      { rubricId: "r-3", score: 35, page: 3, comment: "总结到位", evidence: "RST排查" }    // 合法分 35
    ]
  };

  const result = calculateGradesAndTotal(rubric, maliciousModelOutput);

  // 验证各小项被严格约束在 [0, max] 范围内
  assert.equal(result.grades.length, 3);
  assert.equal(result.grades[0].score, 0, "负分必须被 clamp 为 0");
  assert.equal(result.grades[1].score, 40, "超过 max(40) 的分数必须被 clamp 为 40");
  assert.equal(result.grades[2].score, 35, "合法分数保持 35");

  // 验证总分由程序严格求和：0 + 40 + 35 = 75
  assert.equal(result.totalScore, 75, "总分必须严格等于 0 + 40 + 35 = 75，严禁使用模型给出的 9999");
  assert.equal(result.maxScore, 100);
  assert.equal(result.summary, "学生实验完成良好，三次握手分析清晰。");
});

// ==========================================
// 3. gradeSubmission 单份报告评阅与状态机流转
// ==========================================
test("AutoGrader - gradeSubmission 正常流转 (submitted -> grading -> review)", async () => {
  const store = new DatabaseStore(":memory:");
  const pipeline = new AutoGraderPipelineService({ store });

  // 准备一个 submitted 状态的报告
  const initial = store.getSubmission("sub-zhou-net");
  assert.ok(initial);
  assert.equal(initial.status, "submitted");
  assert.deepEqual(initial.grades, []);

  const gradeResult = await pipeline.gradeSubmission("sub-zhou-net");
  assert.equal(gradeResult.ok, true);
  assert.equal(gradeResult.status, "review");
  assert.ok(gradeResult.totalScore > 0 && gradeResult.totalScore <= 100);
  assert.ok(gradeResult.grades.length > 0);
  assert.ok(gradeResult.summary.length > 0);

  // 数据库内状态与数据必须持久化为 review
  const updated = store.getSubmission("sub-zhou-net");
  assert.equal(updated.status, "review");
  assert.equal(updated.failure, null);
  assert.ok(Array.isArray(updated.grades) && updated.grades.length > 0);
  assert.ok(updated.summary.length > 0);

  // 验证程序求和一致性
  const computedSum = updated.grades.reduce((sum, g) => sum + g.score, 0);
  assert.equal(gradeResult.totalScore, computedSum);

  store.close();
});

test("AutoGrader - gradeSubmission 自动 fallback 标杆计网实验 Rubric", async () => {
  const store = new DatabaseStore(":memory:");
  const pipeline = new AutoGraderPipelineService({ store });

  // 创建一个未配置 rubric 的作业与提交报告
  store.createAssignment({
    id: "lab-custom-no-rubric",
    courseId: "network",
    title: "未配置评分标准的作业",
    rubric: [] // 空 Rubric
  });

  store.createSubmission({
    id: "sub-test-fallback",
    assignmentId: "lab-custom-no-rubric",
    studentId: "s-zhou",
    fileName: "学生自定义报告.pdf",
    status: "submitted",
    sampleKey: "network"
  });

  const res = await pipeline.gradeSubmission("sub-test-fallback");
  assert.equal(res.ok, true);
  assert.equal(res.grades.length, DEFAULT_NETWORK_RUBRIC.length, "应 fallback 使用标杆计网 4 项 Rubric");
  assert.equal(res.grades[0].rubricId, "network-r0");
  assert.equal(res.grades[1].rubricId, "network-r1");

  store.close();
});

test("AutoGrader - gradeSubmission 状态机非法流转拦截", async () => {
  const store = new DatabaseStore(":memory:");
  const pipeline = new AutoGraderPipelineService({ store });

  // sub-yi-os 初始状态为 published
  const publishedSub = store.getSubmission("sub-yi-os");
  assert.equal(publishedSub.status, "published");

  await assert.rejects(
    async () => {
      await pipeline.gradeSubmission("sub-yi-os");
    },
    (err) => {
      assert.ok(err.message.includes("published"));
      assert.ok(err.message.includes("仅允许对「submitted」或「failed」状态的报告启动评阅"));
      return true;
    }
  );

  // sub-xu-os 初始状态为 review
  const reviewSub = store.getSubmission("sub-xu-os");
  assert.equal(reviewSub.status, "review");

  await assert.rejects(
    async () => {
      await pipeline.gradeSubmission("sub-xu-os");
    },
    (err) => {
      assert.ok(err.message.includes("review"));
      return true;
    }
  );

  store.close();
});

test("AutoGrader - gradeSubmission 评阅异常流转至 failed 并持久化 failure", async () => {
  const store = new DatabaseStore(":memory:");
  const pipeline = new AutoGraderPipelineService({ store });

  // 注入 forceFail 模拟评阅故障
  await assert.rejects(
    async () => {
      await pipeline.gradeSubmission("sub-xu-net", {
        forceFail: true,
        forceFailMessage: "多模态大模型超时 (504 Gateway Timeout)"
      });
    },
    (err) => {
      assert.ok(err.message.includes("超时"));
      return true;
    }
  );

  // 校验数据库中该报告已被原子记录为 failed 状态，且记录了 failure 错误原因
  const failedSub = store.getSubmission("sub-xu-net");
  assert.equal(failedSub.status, "failed");
  assert.ok(failedSub.failure.includes("多模态大模型超时"));

  store.close();
});

// ==========================================
// 4. retryGrading 失败重试机制
// ==========================================
test("AutoGrader - retryGrading 对 failed 报告重试成功与非法状态拦截", async () => {
  const store = new DatabaseStore(":memory:");
  const pipeline = new AutoGraderPipelineService({ store });

  // 1. 将 sub-xu-net 设置为 failed 状态
  store.updateSubmission("sub-xu-net", {
    status: "failed",
    failure: "LLM 连接中断"
  });

  // 2. 执行 retryGrading 重试
  const retryRes = await pipeline.retryGrading("sub-xu-net");
  assert.equal(retryRes.ok, true);
  assert.equal(retryRes.status, "review");
  assert.ok(retryRes.totalScore > 0);

  // 3. 校验数据库已成功转为 review，且 failure 已被清空
  const reloaded = store.getSubmission("sub-xu-net");
  assert.equal(reloaded.status, "review");
  assert.equal(reloaded.failure, null);
  assert.ok(reloaded.grades.length > 0);

  // 4. 对处于 review 状态的报告执行 retry 必须被拦截报错
  await assert.rejects(
    async () => {
      await pipeline.retryGrading("sub-xu-net");
    },
    (err) => {
      assert.ok(err.message.includes("仅允许对「failed」状态的报告发起重试"));
      return true;
    }
  );

  store.close();
});

// ==========================================
// 5. gradeBatchSubmissions 全班批量连续评阅调度
// ==========================================
test("AutoGrader - gradeBatchSubmissions 批量受控并发调度与进度统计", async () => {
  const store = new DatabaseStore(":memory:");
  const pipeline = new AutoGraderPipelineService({ store });

  // lab-tcp 作业下有两个 submitted 状态的提交：sub-zhou-net, sub-xu-net
  const batchRes = await pipeline.gradeBatchSubmissions("lab-tcp", { concurrency: 2 });
  assert.equal(batchRes.ok, true);
  assert.equal(batchRes.assignmentId, "lab-tcp");
  assert.equal(batchRes.total, 2, "lab-tcp 下应有 2 份待评阅报告");
  assert.equal(batchRes.processed, 2);
  assert.equal(batchRes.succeeded, 2);
  assert.equal(batchRes.failed, 0);
  assert.equal(batchRes.results.length, 2);

  // 校验两份报告均流转为 review
  const sub1 = store.getSubmission("sub-zhou-net");
  const sub2 = store.getSubmission("sub-xu-net");
  assert.equal(sub1.status, "review");
  assert.equal(sub2.status, "review");

  // 再次对 lab-tcp 发起批量评阅：因为没有 submitted / failed 的报告，应该返回 total=0
  const emptyBatch = await pipeline.gradeBatchSubmissions("lab-tcp");
  assert.equal(emptyBatch.total, 0);
  assert.equal(emptyBatch.processed, 0);

  store.close();
});

// ==========================================
// 6. HTTP REST API 端点集成测试
// ==========================================
test("HTTP API - POST /grader/grade-submission & /grader/batch & /grader/retry 全链路", async () => {
  const store = new DatabaseStore(":memory:");
  const middlewares = [];
  const fakeCtx = {
    webServer: {
      use: (fn) => middlewares.push(fn)
    }
  };

  registerLearnBuddyRoutes(fakeCtx, { store });

  const testServer = http.createServer(async (req, res) => {
    for (const mw of middlewares) {
      let nextCalled = false;
      await mw(req, res, () => {
        nextCalled = true;
      });
      if (!nextCalled && (res.writableEnded || res.headersSent)) {
        break;
      }
    }
    if (!res.writableEnded && !res.headersSent) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  await new Promise((resolve) => testServer.listen(0, "127.0.0.1", resolve));
  const port = testServer.address().port;

  try {
    // 1. POST /api/learnbuddy/grader/grade-submission 参数缺失 400
    const missingRes = await makeHttpRequest(
      port,
      "POST",
      "/api/learnbuddy/grader/grade-submission",
      { "Content-Type": "application/json" },
      {}
    );
    assert.equal(missingRes.statusCode, 400);
    const missingData = JSON.parse(missingRes.body.toString("utf-8"));
    assert.equal(missingData.ok, false);
    assert.ok(missingData.error.includes("缺少必要参数: submissionId"));

    // 2. POST /api/learnbuddy/grader/grade-submission 触发单份评阅
    const gradeRes = await makeHttpRequest(
      port,
      "POST",
      "/api/learnbuddy/grader/grade-submission",
      { "Content-Type": "application/json" },
      { submissionId: "sub-zhou-net" }
    );
    assert.equal(gradeRes.statusCode, 200);
    const gradeData = JSON.parse(gradeRes.body.toString("utf-8"));
    assert.equal(gradeData.ok, true);
    assert.equal(gradeData.status, "review");
    assert.ok(gradeData.totalScore > 0);
    assert.ok(gradeData.grades.length > 0);

    // 3. POST /api/learnbuddy/grader/batch 触发全班批量评阅
    // 先把 sub-xu-net 重新确认为 submitted 状态
    store.updateSubmission("sub-xu-net", { status: "submitted" });
    const batchRes = await makeHttpRequest(
      port,
      "POST",
      "/api/learnbuddy/grader/batch",
      { "Content-Type": "application/json" },
      { assignmentId: "lab-tcp", concurrency: 2 }
    );
    assert.equal(batchRes.statusCode, 200);
    const batchData = JSON.parse(batchRes.body.toString("utf-8"));
    assert.equal(batchData.ok, true);
    assert.equal(batchData.assignmentId, "lab-tcp");
    assert.ok(batchData.processed >= 1);
    assert.ok(batchData.succeeded >= 1);

    // 4. POST /api/learnbuddy/grader/retry 失败重试端点
    // 将 sub-xu-net 改为 failed 模拟失败记录
    store.updateSubmission("sub-xu-net", {
      status: "failed",
      failure: "模拟接口超时"
    });

    const retryRes = await makeHttpRequest(
      port,
      "POST",
      "/api/learnbuddy/grader/retry",
      { "Content-Type": "application/json" },
      { submissionId: "sub-xu-net" }
    );
    assert.equal(retryRes.statusCode, 200);
    const retryData = JSON.parse(retryRes.body.toString("utf-8"));
    assert.equal(retryData.ok, true);
    assert.equal(retryData.status, "review");
    assert.ok(retryData.totalScore > 0);

    // 校验重试后数据库状态恢复
    const subAfterRetry = store.getSubmission("sub-xu-net");
    assert.equal(subAfterRetry.status, "review");
    assert.equal(subAfterRetry.failure, null);
    // 5. v0.2: 批注 CRUD 端点测试
    const createAnnoRes = await makeHttpRequest(
      port,
      "POST",
      "/api/learnbuddy/submissions/sub-xu-net/annotations",
      { "Content-Type": "application/json" },
      {
        page: 2,
        quote: "TCP 三次握手",
        comment: "教师评注：三次握手抓包时序分析详实",
        color: "green"
      }
    );
    assert.equal(createAnnoRes.statusCode, 200);
    const createAnnoData = JSON.parse(createAnnoRes.body.toString("utf-8"));
    assert.equal(createAnnoData.ok, true);
    assert.equal(createAnnoData.annotation.page, 2);
    assert.equal(createAnnoData.annotation.color, "green");

    const getAnnoRes = await makeHttpRequest(
      port,
      "GET",
      "/api/learnbuddy/submissions/sub-xu-net/annotations"
    );
    assert.equal(getAnnoRes.statusCode, 200);
    const getAnnoData = JSON.parse(getAnnoRes.body.toString("utf-8"));
    assert.equal(getAnnoData.ok, true);
    assert.equal(getAnnoData.annotations.length, 1);
    assert.equal(getAnnoData.annotations[0].quote, "TCP 三次握手");
  } finally {
    testServer.close();
    store.close();
  }
});
