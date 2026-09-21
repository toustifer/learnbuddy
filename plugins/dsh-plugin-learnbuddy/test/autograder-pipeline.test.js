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
test("AutoGrader - extractReportContent 只返回真实解析结果或显式失败", async () => {
  // 1. 命中 network sampleKey：来源必须如实标记为 fixture
  const netReport = await extractReportContent({
    fileName: "TCP实验报告_周可.pdf",
    sampleKey: "network"
  });
  assert.ok(netReport, "必须成功解构 network 报告");
  assert.equal(netReport.status, "parsed");
  assert.equal(netReport.source, "fixture", "内置样例必须标记为 fixture，不得混入正式评分");
  assert.equal(netReport.title, "TCP实验报告_周可.pdf");
  assert.ok(netReport.content.includes("TCP 三次握手"));
  assert.ok(netReport.content.includes("Wireshark"));
  assert.equal(netReport.pages, 3);
  assert.equal(netReport.hasImages, true);
  assert.ok(netReport.diagrams.length >= 2);
  assert.equal(netReport.diagrams[0].page, 2);

  // 2. 命中 os sampleKey
  const osReport = await extractReportContent({
    fileName: "进程同步实验.pdf",
    sampleKey: "os"
  });
  assert.ok(osReport.content.includes("POSIX pthread"));
  assert.ok(osReport.content.includes("生产者与消费者"));

  // 3. 没有原件时必须是显式失败，绝不生成替代正文（返工单 P1-4）
  const noBlob = await extractReportContent({ fileName: "未知自定义作业.pdf" });
  assert.equal(noBlob.status, "failed", "无原件不得回落成「看起来正常」的报告");
  assert.equal(noBlob.errorCode, "PARSE_FAILED");
  assert.equal(noBlob.content, "", "解析失败时正文必须为空，不允许任何替代正文");
  assert.equal(noBlob.hasImages, false, "不得硬编码 hasImages");
  assert.deepEqual(noBlob.diagrams, []);

  // 4. 空入参保护
  assert.equal(await extractReportContent(null), null);
});

test("AutoGrader - extractReportContent 真实解析路径使用解析产物并如实标记来源", async () => {
  const fakeParser = {
    async parseDocument() {
      return {
        status: "parsed",
        title: "lab.pdf",
        markdown: "# 实验目的\n掌握三次握手\n\n## 实验步骤\n1. 打开 Wireshark 抓包",
        pages: 2,
        pagesEstimated: true,
        images: [{ mimeType: "image/png", data: Buffer.from([1, 2, 3]) }],
        embedded: { total: 1, inlined: 1, skipped: 0 }
      };
    }
  };
  const savedImages = [];
  const storage = {
    getFile: () => ({ path: "/tmp/lab.pdf", originalName: "lab.pdf", size: 100, mimeType: "application/pdf" }),
    saveFile: async (buffer, originalName, options) => {
      savedImages.push({ buffer, originalName, options });
      return { fileId: "hash-abc.png", mimeType: "image/png", size: buffer.length, originalName };
    }
  };

  const report = await extractReportContent(
    { fileName: "lab.pdf", blobId: "blob-1" },
    storage,
    { parser: fakeParser }
  );

  assert.equal(report.status, "parsed");
  assert.equal(report.source, "document", "真实解析必须标记 source=document");
  assert.ok(report.content.includes("三次握手"));
  assert.equal(report.pages, 2);
  assert.equal(report.pagesEstimated, true, "估算页数必须显式标记，不冒充真实页码");
  assert.equal(report.hasImages, true, "有真实图片资产时 hasImages 才为 true");
  assert.equal(report.structuredPages.length, 2, "章节结构取文档真实标题");
  assert.equal(report.structuredPages[0].heading, "实验目的");
  assert.equal(report.structuredPages[1].heading, "实验步骤");

  // 内嵌图片必须真实落盘并给出可访问引用
  assert.equal(report.images.length, 1);
  assert.equal(report.images[0].fileId, "hash-abc.png");
  assert.equal(report.images[0].mimeType, "image/png");
  assert.ok(report.images[0].viewUrl.endsWith("/files/hash-abc.png/view"));
  assert.equal(savedImages.length, 1, "落盘必须真的调用存储服务");
  assert.equal(savedImages[0].originalName, "report-image-1.png", "落盘文件名要带白名单扩展名");
  assert.equal(savedImages[0].options.role, "report-image");
  assert.deepEqual(report.imageWarnings, []);
});

test("AutoGrader - 内嵌图片落盘失败不牵连正文与评分", async () => {
  const fakeParser = {
    async parseDocument() {
      return {
        status: "parsed",
        title: "lab.docx",
        markdown: "# 实验\n正文内容",
        pages: 1,
        pagesEstimated: true,
        images: [{ mimeType: "image/webp", data: Buffer.from([1]) }],
        embedded: { total: 1, inlined: 1, skipped: 0 }
      };
    }
  };
  // 存储服务不支持 saveFile：必须优雅降级并如实说明，而不是抛错或假装有图
  const storage = { getFile: () => ({ path: "/tmp/lab.docx", originalName: "lab.docx" }) };

  const report = await extractReportContent(
    { fileName: "lab.docx", blobId: "blob-y" },
    storage,
    { parser: fakeParser }
  );

  assert.equal(report.status, "parsed", "图片落盘问题不得让整个解析失败");
  assert.equal(report.hasImages, false, "没有真实落盘的图就不能声称有图");
  assert.deepEqual(report.images, []);
  assert.equal(report.imageWarnings.length, 1, "未能落盘的原因必须如实记录");
});

test("AutoGrader - extractReportContent 解析失败不回落假内容", async () => {
  const fakeParser = {
    async parseDocument() {
      return { status: "failed", errorCode: "malformed", error: "解析结果为空" };
    }
  };
  const storage = { getFile: () => ({ path: "/tmp/broken.pdf", originalName: "broken.pdf" }) };

  const report = await extractReportContent(
    { fileName: "broken.pdf", blobId: "blob-x" },
    storage,
    { parser: fakeParser }
  );

  assert.equal(report.status, "failed");
  assert.equal(report.errorCode, "malformed");
  assert.equal(report.content, "");
  assert.equal(report.hasImages, false);
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
    // 5. 批注（annotations）CRUD 端点不在此处断言。
    //    该端点尚未实现，且字段投影归属涉及 D2 边界；
    //    依据《AutoGrader 返工单与复审标准》§5「两处不要自行决定」——
    //    必须先把数据模型确认下来再实现，不能替团队拍板。见下方待确认测试。
  } finally {
    testServer.close();
    store.close();
  }
});

test("AutoGrader - 正文过短的报告记为 partial 而不是完全成功", async () => {
  const fakeParser = {
    async parseDocument() {
      return {
        status: "partial",
        warnings: ["正文仅提取到 12 个字符，内容可能不完整。"],
        title: "short.docx",
        markdown: "实验报告",
        pages: 1,
        pagesEstimated: true,
        images: [],
        embedded: { total: 0, inlined: 0, skipped: 0 }
      };
    }
  };
  // 顺带验证真实 StorageService 的接口（getFileMetadata + filePath）同样被兼容
  const storage = {
    getFileMetadata: () => ({ filePath: "/tmp/short.docx", originalName: "short.docx" })
  };

  const report = await extractReportContent(
    { fileName: "short.docx", blobId: "blob-short" },
    storage,
    { parser: fakeParser }
  );

  assert.equal(report.status, "partial", "内容不完整不能被当成完全成功");
  assert.equal(report.warnings.length, 1, "降级原因必须如实上报");
  assert.ok(report.warnings[0].includes("字符"));
});

test("AutoGrader - 判定字段采纳模型输出，不由分数反推", () => {
  const rubric = [{ id: "r0", title: "数据准备与查询设计", max: 20, criterion: "过程可复现。" }];
  const raw = {
    summary: "小结",
    items: [
      {
        rubricId: "r0",
        score: 10, // 分数只有一半：若按分数反推会得到 partially_satisfied
        judgment: "satisfied", // 模型明确判定为达成
        coveredPoints: ["列出了测试表的字段定义与约二十万行数据规模"],
        missingPoints: [],
        page: 1,
        comment: "环境与数据准备交代清楚。",
        evidence: "写入约二十万行数据，分别在建索引前后执行同一组查询。"
      }
    ]
  };

  const { grades } = calculateGradesAndTotal(rubric, raw);
  const g = grades[0];

  assert.equal(g.score, 10, "分数仍由程序按小项取值，不受判定字段影响");
  assert.equal(g.judgment, "satisfied", "judgment 必须取模型输出，不能由分数反推");
  assert.equal(g.judgmentSource, "model");
  assert.deepEqual(g.coverage.coveredPoints, ["列出了测试表的字段定义与约二十万行数据规模"]);
  assert.deepEqual(g.coverage.missingPoints, []);
});

test("AutoGrader - 模型未给判定时如实留空，不套模板句", () => {
  const rubric = [{ id: "r0", title: "执行计划分析", max: 30, criterion: "解释观察结果。" }];
  const raw = { summary: "小结", items: [{ rubricId: "r0", score: 15, page: 2, comment: "评语" }] };

  const { grades } = calculateGradesAndTotal(rubric, raw);
  const g = grades[0];

  assert.equal(g.judgmentSource, "score_fallback", "模型未给判定时应显式标记来源为分数兜底");
  assert.deepEqual(g.coverage.coveredPoints, [], "模型没给覆盖点就必须留空");
  assert.deepEqual(g.coverage.missingPoints, []);

  // 关键：不能出现「完全达成「XXX」所要求的…」这类标题拼接文案
  const serialized = JSON.stringify(g.coverage);
  assert.ok(!serialized.includes("完全达成"), "不得用模板句冒充具体分析");
  assert.ok(!serialized.includes("基本完成"), "不得用模板句冒充具体分析");
});

test("AutoGrader - 关注级别与分数解耦", () => {
  const rubric = [{ id: "r0", title: "性能解释与总结", max: 20, criterion: "给出结论。" }];

  // 0 分但依据明确（报告确实没做）→ 值得关注，而不是「需人工裁决」
  const zero = calculateGradesAndTotal(rubric, {
    items: [{ rubricId: "r0", score: 0, judgment: "not_satisfied", missingPoints: ["未给出任何结论或改进方向"] }]
  }).grades[0];
  assert.equal(zero.attentionLevel, "needs_attention", "低分本身不等于需要人工裁决");

  // 依据不足 → 需人工裁决（即便分数不低）
  const unable = calculateGradesAndTotal(rubric, {
    items: [{ rubricId: "r0", score: 18, judgment: "unable_to_judge" }]
  }).grades[0];
  assert.equal(unable.attentionLevel, "review_required", "依据不足才需要人工介入");

  // 缺失点较多 → 需人工裁决
  const manyMissing = calculateGradesAndTotal(rubric, {
    items: [{ rubricId: "r0", score: 12, judgment: "partially_satisfied", missingPoints: ["缺少对比数据", "未解释瓶颈原因"] }]
  }).grades[0];
  assert.equal(manyMissing.attentionLevel, "review_required");

  // 干净达成 → 表现明确
  const clean = calculateGradesAndTotal(rubric, {
    items: [{ rubricId: "r0", score: 20, judgment: "satisfied", missingPoints: [] }]
  }).grades[0];
  assert.equal(clean.attentionLevel, "clear");
});

test(
  "HTTP API - 批注 CRUD 端点（待确认数据模型后实现）",
  { skip: "端点未实现；依据返工单 §5，字段投影归属涉及 D2 边界，需先与团队确认再动手" },
  () => {}
);
