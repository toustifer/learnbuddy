/**
 * LearnBuddy 课件多模态结构化打包与答疑卡检索服务 单元测试
 * (Material Multimodal Context & Answer Card Retrieval Test Suite)
 * 
 * 验证重点：
 * 1. buildMaterialContext 课件多模态快照组装：
 *    - 标题、课程名、课程代码、页码、章节正文
 *    - 每页图表图文说明（Diagram / Figure / Caption / Description）
 *    - 核心知识点（带 page）
 *    - 标杆 sampleKey 课件与动态自定义课件合成
 *    - 师生权限过滤联动
 * 2. searchAnswerCards 教师答疑卡智能检索：
 *    - 中英文多维度分词与关键词/模糊匹配
 *    - 严格过滤未确认（confirmed !== true）卡片
 *    - 课程作用域隔离（courseId 筛选与跨课检索）
 *    - 相关度得分计算与阈值过滤（threshold）
 * 3. buildQAPromptContext 问答规范 Prompt 注入：
 *    - 严格输出“根据第 X 页图表...”
 *    - 严格输出“根据教师推荐答疑：...”
 * 4. HTTP API 端点集成测试：
 *    - GET /api/learnbuddy/materials/:id/context
 *    - POST /api/learnbuddy/qa/cards/search
 *    - POST /api/learnbuddy/qa/ask 联动验证
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseStore } from "../src/db/store.js";
import {
  MaterialContextService,
  buildMaterialContext,
  searchAnswerCards,
  buildQAPromptContext,
  tokenizeText,
  parseKeywords
} from "../src/services/material-context.js";
import { registerLearnBuddyRoutes } from "../src/routes/api.js";
import { withAuthHeaders } from "./helpers/auth.js";

// ==========================================
// 1. 分词与关键字解析基础工具验证
// ==========================================
test("MaterialContext - tokenizeText & parseKeywords 分词与关键字解析", () => {
  const text = "为什么 TCP 三次握手中 SYN 报文要消耗一个序列号 seq？";
  const tokens = tokenizeText(text);

  assert.ok(tokens.includes("tcp"), "应提取英文关键词 tcp");
  assert.ok(tokens.includes("syn"), "应提取英文关键词 syn");
  assert.ok(tokens.includes("seq"), "应提取英文关键词 seq");
  assert.ok(tokens.includes("三次"), "应提取中文 2-gram 三次");
  assert.ok(tokens.includes("握手"), "应提取中文 2-gram 握手");
  assert.ok(tokens.includes("序列号"), "应提取中文 3-gram 序列号");

  const kwList = parseKeywords("SYN, 消耗; 序列号  三次握手");
  assert.deepEqual(kwList, ["syn", "消耗", "序列号", "三次握手"]);
});

// ==========================================
// 2. buildMaterialContext 课件多模态结构化打包
// ==========================================
test("MaterialContext - buildMaterialContext 组装标杆课件 (mat-tcp)", () => {
  const store = new DatabaseStore(":memory:");
  const service = new MaterialContextService(store);

  const context = service.buildMaterialContext("mat-tcp");
  assert.ok(context, "必须成功返回课件上下文快照");
  assert.equal(context.materialId, "mat-tcp");
  assert.equal(context.title, "第三章 · TCP 可靠传输");
  assert.equal(context.courseId, "network");
  assert.equal(context.courseName, "计算机网络");
  assert.equal(context.courseCode, "CS 203");
  assert.equal(context.pages, 3);
  assert.equal(context.sampleKey, "handshake");

  // 验证逐页章节与图文说明
  assert.equal(context.sections.length, 3, "标杆课件应包含 3 页结构化章节");
  const p1 = context.sections[0];
  assert.equal(p1.page, 1);
  assert.ok(p1.chapter.includes("TCP 协议连接概览"));
  assert.ok(p1.content.includes("面向连接"));
  assert.ok(Array.isArray(p1.diagrams) && p1.diagrams.length >= 1, "第 1 页应包含图表说明");
  assert.equal(p1.diagrams[0].id, "fig-tcp-1");
  assert.ok(p1.diagrams[0].caption.includes("Figure 1-1"));
  assert.ok(p1.diagrams[0].description.includes("20 字节"));

  const p2 = context.sections[1];
  assert.equal(p2.page, 2);
  assert.ok(p2.chapter.includes("三次握手时序交互"));
  assert.ok(p2.diagrams[0].caption.includes("Figure 2-1"));

  const p3 = context.sections[2];
  assert.equal(p3.page, 3);
  assert.ok(p3.chapter.includes("Wireshark"));
  assert.ok(p3.diagrams[0].description.includes("RST, ACK"));

  // 验证汇总 diagrams 列表
  assert.equal(context.diagrams.length, 3);
  assert.equal(context.diagrams[0].page, 1);
  assert.equal(context.diagrams[1].page, 2);
  assert.equal(context.diagrams[2].page, 3);

  // 验证核心考点（带 page）
  assert.ok(Array.isArray(context.knowledgePoints));
  assert.ok(context.knowledgePoints.length >= 3);
  for (const kp of context.knowledgePoints) {
    assert.ok(typeof kp.page === "number", "考点必须包含页码数字");
    assert.ok(kp.title || kp.name, "考点必须包含标题");
    assert.ok(kp.summary, "考点必须包含要点摘要");
  }

  // 验证附带的已确认答疑卡
  assert.ok(context.confirmedCards.length >= 1);
  assert.equal(context.confirmedCards[0].id, "qa-syn");
  assert.equal(context.confirmedCards[0].confirmed, true);

  store.close();
});

test("MaterialContext - buildMaterialContext 动态合成自定义课件", () => {
  const store = new DatabaseStore(":memory:");
  const service = new MaterialContextService(store);

  // 插入一个没有 sampleKey 的新课件
  store.createMaterial({
    id: "mat-custom-01",
    courseId: "network",
    ownerId: "t-chen",
    title: "实验拓展 · BGP 路由协议仿真.pdf",
    kind: "PDF",
    visibility: "course",
    status: "ready",
    size: "3.5 MB",
    pages: 2,
    date: "2026-09-11",
    knowledge: [
      {
        id: "bgp-kp-1",
        name: "AS 自治系统与 eBGP/iBGP 邻居建立",
        summary: "BGP 基于 TCP 179 端口建立连接，eBGP 邻居通常直连且 TTL=1，iBGP 可跨越多跳但需 Full Mesh。",
        page: 1,
        difficulty: "核心"
      },
      {
        id: "bgp-kp-2",
        name: "BGP 路由属性与选路原则（Local-Pref / AS-Path）",
        summary: "优先比较 Local-Preference（本地优先级），其次比较最短 AS-Path 路径长度。",
        page: 2,
        difficulty: "进阶"
      }
    ],
    cards: []
  });

  const context = service.buildMaterialContext("mat-custom-01");
  assert.ok(context);
  assert.equal(context.title, "实验拓展 · BGP 路由协议仿真.pdf");
  assert.equal(context.sections.length, 2);
  assert.equal(context.sections[0].page, 1);
  assert.ok(context.sections[0].chapter.includes("eBGP/iBGP"));
  assert.ok(context.sections[0].diagrams[0].caption.includes("Figure 1-1"));
  assert.ok(context.sections[0].diagrams[0].description.includes("AS 自治系统"));

  assert.equal(context.sections[1].page, 2);
  assert.ok(context.sections[1].chapter.includes("选路原则"));
  assert.ok(context.sections[1].diagrams[0].caption.includes("Figure 2-1"));

  store.close();
});

test("MaterialContext - buildMaterialContext 权限隔离校验与不存在返回 null", () => {
  const store = new DatabaseStore(":memory:");
  const service = new MaterialContextService(store);

  // 不存在的材料
  assert.equal(service.buildMaterialContext("non-existent-mat"), null);

  // 在 database 课程中插入教师林悦的私有材料
  store.createMaterial({
    id: "mat-db-secret",
    courseId: "database",
    ownerId: "t-lin",
    title: "数据库期末绝密试题分析.pdf",
    visibility: "private"
  });

  // 学生林一未选修 database 课程，无法读取
  assert.equal(service.buildMaterialContext("mat-db-secret", { userId: "s-yi" }), null);

  // 学生周可选修了 database，但材料为 private 且 owner 不是周可，无权读取
  assert.equal(service.buildMaterialContext("mat-db-secret", { userId: "s-zhou" }), null);

  // 教师林悦拥有该材料，可以成功读取
  const linContext = service.buildMaterialContext("mat-db-secret", { userId: "t-lin" });
  assert.ok(linContext);
  assert.equal(linContext.title, "数据库期末绝密试题分析.pdf");

  store.close();
});

// ==========================================
// 3. searchAnswerCards 教师答疑卡智能检索
// ==========================================
test("MaterialContext - searchAnswerCards 关键词精准命中与打分排序", () => {
  const store = new DatabaseStore(":memory:");
  const service = new MaterialContextService(store);

  // 检索 "SYN 报文为什么消耗序列号" -> 应命中 mat-tcp 的 qa-syn
  const hits = service.searchAnswerCards("network", "为什么 SYN 报文会消耗一个序列号？");
  assert.ok(hits.length >= 1, "必须至少命中一条答疑卡");
  const top = hits[0];
  assert.equal(top.id, "qa-syn");
  assert.ok(top.score >= 50, `评分应较高: 实际 ${top.score}`);
  assert.ok(top.question.includes("SYN"));
  assert.ok(top.answer.includes("控制信息"));
  assert.equal(top.confirmed, true);

  // 跨课程检索（courseId = null）
  const allHits = service.searchAnswerCards(null, "SYN 序列号");
  assert.ok(allHits.some((c) => c.id === "qa-syn"));

  store.close();
});

test("MaterialContext - searchAnswerCards 严格过滤未确认（confirmed: false）卡片", () => {
  const store = new DatabaseStore(":memory:");
  const service = new MaterialContextService(store);

  // 动态向 network 课件添加一张已确认卡和一张未确认草稿卡
  const tcpMat = store.getMaterialById("mat-tcp");
  store.updateMaterial("mat-tcp", {
    cards: [
      ...tcpMat.cards,
      {
        id: "qa-rst-draft",
        question: "抓包全是红色 RST 是怎么回事？",
        keywords: "RST,重置,红色,抓包",
        answer: "端口未开放或防火墙直接拦截阻断。",
        confirmed: false // 未经教师确认！
      },
      {
        id: "qa-rst-confirmed",
        question: "遇到红色 TCP RST 重置报文应该如何排查？",
        keywords: "RST,重置,红色,抓包",
        answer: "确认服务端进程是否已调用 listen() 监听对应端口，排查本机防火墙是否拒绝连接。",
        confirmed: true // 已确认
      }
    ]
  });

  const hits = service.searchAnswerCards("network", "抓包红色 RST 重置报文");
  assert.ok(hits.some((c) => c.id === "qa-rst-confirmed"), "应包含已确认卡片");
  assert.ok(!hits.some((c) => c.id === "qa-rst-draft"), "严禁返回未确认 (confirmed: false) 的卡片");

  store.close();
});

test("MaterialContext - searchAnswerCards 阈值过滤与空查询保护", () => {
  const store = new DatabaseStore(":memory:");
  const service = new MaterialContextService(store);

  // 空查询返回空
  assert.deepEqual(service.searchAnswerCards("network", ""), []);
  assert.deepEqual(service.searchAnswerCards("network", "   "), []);

  // 不相关提问，得分低，被 threshold=50 拦截
  const irrelevantHits = service.searchAnswerCards("network", "今天天气怎么样吃什么中午饭", { threshold: 50 });
  assert.equal(irrelevantHits.length, 0);

  // 课程作用域隔离：在 database 课程检索网络知识点，不应返回 network 的卡片
  const dbHits = service.searchAnswerCards("database", "SYN 报文消耗序列号");
  assert.equal(dbHits.length, 0, "不属于 database 课程的卡片不应泄漏");

  store.close();
});

// ==========================================
// 4. buildQAPromptContext 问答 Prompt 注入与引用规范
// ==========================================
test("MaterialContext - buildQAPromptContext 包含图表引用与教师答疑规范", () => {
  const store = new DatabaseStore(":memory:");
  const service = new MaterialContextService(store);

  const matContext = service.buildMaterialContext("mat-tcp");
  const matchedCards = service.searchAnswerCards("network", "SYN 序列号");

  const promptText = service.buildQAPromptContext({
    materialContext: matContext,
    matchedCards,
    query: "为什么 Wireshark 抓包看到的 SYN 包消耗序列号？"
  });

  assert.ok(promptText.includes("【课件多模态结构化参考资料】"));
  assert.ok(promptText.includes("计算机网络"));
  assert.ok(promptText.includes("第三章 · TCP 可靠传输"));
  
  // 必须引导 Agent 明确引用图表
  assert.ok(promptText.includes("根据第 X 页图表"));
  assert.ok(promptText.includes("Figure 1-1"));
  assert.ok(promptText.includes("Figure 2-1"));

  // 必须引导 Agent 明确引用教师答疑
  assert.ok(promptText.includes("【教师推荐答疑卡"));
  assert.ok(promptText.includes("根据教师推荐答疑："));
  assert.ok(promptText.includes("qa-syn") || promptText.includes("为什么 SYN 报文会消耗一个序列号？"));

  // 便捷函数 buildQAPromptContext 兼容性
  const funcPrompt = buildQAPromptContext(matContext, matchedCards, "学生提问测试");
  assert.ok(funcPrompt.includes("【回答规范与证据引用纪律】"));

  store.close();
});

// ==========================================
// 5. HTTP API 接口集成验证
// ==========================================

function makeHttpRequest(port, method, path, headers = {}, body = null) {
  return withAuthHeaders(port, headers).then((authHeaders) => new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: authHeaders,
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
  }));
}

test("HTTP API - GET /materials/:id/context & POST /qa/cards/search & POST /qa/ask", async () => {
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
    // 1. GET /api/learnbuddy/materials/mat-tcp/context
    const contextRes = await makeHttpRequest(port, "GET", "/api/learnbuddy/materials/mat-tcp/context");
    assert.equal(contextRes.statusCode, 200);
    const contextData = JSON.parse(contextRes.body.toString("utf-8"));
    assert.equal(contextData.ok, true);
    assert.equal(contextData.context.title, "第三章 · TCP 可靠传输");
    assert.equal(contextData.context.pages, 3);
    assert.ok(contextData.context.sections.length >= 3);
    assert.ok(contextData.context.diagrams.length >= 3);
    assert.ok(contextData.context.knowledgePoints.length >= 3);

    // 2. GET /api/learnbuddy/materials/invalid-mat/context -> 404
    const notFoundRes = await makeHttpRequest(port, "GET", "/api/learnbuddy/materials/invalid-mat/context");
    assert.equal(notFoundRes.statusCode, 404);
    const notFoundData = JSON.parse(notFoundRes.body.toString("utf-8"));
    assert.equal(notFoundData.ok, false);

    // 3. POST /api/learnbuddy/qa/cards/search
    const searchRes = await makeHttpRequest(
      port,
      "POST",
      "/api/learnbuddy/qa/cards/search",
      { "Content-Type": "application/json" },
      {
        courseId: "network",
        query: "SYN 消耗序列号"
      }
    );
    assert.equal(searchRes.statusCode, 200);
    const searchData = JSON.parse(searchRes.body.toString("utf-8"));
    assert.equal(searchData.ok, true);
    assert.equal(searchData.courseId, "network");
    assert.ok(searchData.count >= 1);
    assert.equal(searchData.cards[0].id, "qa-syn");
    assert.ok(searchData.cards[0].score >= 30);

    // 4. POST /api/learnbuddy/qa/ask 命中教师答疑卡返回
    const askCardRes = await makeHttpRequest(
      port,
      "POST",
      "/api/learnbuddy/qa/ask",
      { "Content-Type": "application/json" },
      {
        courseId: "network",
        question: "为什么 SYN 报文会消耗一个序列号？"
      }
    );
    assert.equal(askCardRes.statusCode, 200);
    const askCardData = JSON.parse(askCardRes.body.toString("utf-8"));
    assert.equal(askCardData.ok, true);
    assert.equal(askCardData.source, "teacher_card");
    assert.equal(askCardData.cardId, "qa-syn");

    // 5. POST /api/learnbuddy/qa/ask 课件多模态 Prompt 注入
    const askLlmRes = await makeHttpRequest(
      port,
      "POST",
      "/api/learnbuddy/qa/ask",
      { "Content-Type": "application/json" },
      {
        courseId: "network",
        materialId: "mat-tcp",
        question: "TCP 拥塞控制中如果发生超时重传，慢启动门限 ssthresh 会如何调整？"
      }
    );
    assert.equal(askLlmRes.statusCode, 200);
    const askLlmData = JSON.parse(askLlmRes.body.toString("utf-8"));
    assert.equal(askLlmData.ok, true);
    assert.equal(askLlmData.source, "agent_llm");
    assert.equal(askLlmData.contextInjected, true);
  } finally {
    testServer.close();
    store.close();
  }
});
