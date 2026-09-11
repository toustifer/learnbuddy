/**
 * LearnBuddy DSH 学习助手多模态上下文注入与桥接服务 单元测试
 * (DSH Bridge & Multimodal Context Injection Test Suite)
 * 
 * 验证核心：
 * 1. formatQuoteEvidence:
 *    - 规范化输出格式如:
 *      > [引用第 2 页图表: Figure 2-1: 客户端与服务端三次握手时序流及 seq/ack 演进图]
 *      > 图表说明: ...
 *    - 支持段落引用与自定义提问批注 (customNote)
 * 2. truncateContext:
 *    - 安全字符/Token 长度裁剪机制，严格保障不超过 maxLength 限制 (默认 12000)
 *    - 保留头部课件背景与尾部交互纪律
 * 3. validateBridgeMessage & createBridgeResponse:
 *    - 严格遵循 web/src/dsh.ts 桥接协议，校验 learnbuddy:init, learnbuddy:context 等握手结构
 *    - 严格返回匹配的 requestId 和 contextKey，支持 learnbuddy:ready, learnbuddy:received, learnbuddy:error
 * 4. DshContextBridgeService & buildDshSessionPrompt:
 *    - 完整组装【课件背景】、【逐页图文与图表清单】、【核心考点】、【教师预制答疑卡】
 *    - 包含“根据第 X 页图表...”与“根据教师推荐答疑：...”原生约束
 *    - 严格权限隔离校验 (无权材料返回 null)
 * 5. HTTP 桥接端点全链路验证:
 *    - POST /api/learnbuddy/dsh/session-context
 *    - POST /api/learnbuddy/dsh/quote
 *    - POST /api/learnbuddy/dsh/message
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseStore } from "../src/db/store.js";
import {
  DshContextBridgeService,
  buildDshSessionPrompt,
  formatQuoteEvidence,
  truncateContext,
  validateBridgeMessage,
  createBridgeResponse,
  DEFAULT_MAX_CONTEXT_LENGTH
} from "../src/services/dsh-context-bridge.js";
import { registerLearnBuddyRoutes } from "../src/routes/api.js";

// ==========================================
// 1. formatQuoteEvidence 证据格式化测试
// ==========================================
test("DSH Bridge - formatQuoteEvidence 图表与段落证据规范化", () => {
  // 1.1 图表引用
  const figEvidence = formatQuoteEvidence({
    page: 2,
    figureId: "fig-tcp-2",
    caption: "Figure 2-1: 客户端与服务端三次握手时序流及 seq/ack 演进图",
    description: "时序图呈现 SYN(seq=x) -> SYN+ACK(seq=y, ack=x+1) -> ACK(seq=x+1, ack=y+1) 交互过程。",
    customNote: "为什么第二次握手 ack 是 x+1？"
  });

  assert.ok(figEvidence.includes("> [引用第 2 页图表: Figure 2-1: 客户端与服务端三次握手时序流及 seq/ack 演进图]"));
  assert.ok(figEvidence.includes("> 图表说明: 时序图呈现 SYN(seq=x) -> SYN+ACK(seq=y, ack=x+1)"));
  assert.ok(figEvidence.includes("> 提问重点: 为什么第二次握手 ack 是 x+1？"));

  // 1.2 段落引用
  const paraEvidence = formatQuoteEvidence({
    type: "paragraph",
    page: 1,
    chapter: "第1节：TCP 协议连接概览与报文封装结构",
    content: "TCP 报文段由 20 字节固定头部与数据字段组成。",
    customNote: "请解释 20 字节头部包含哪些字段"
  });

  assert.ok(paraEvidence.includes("> [引用第 1 页段落: 第1节：TCP 协议连接概览与报文封装结构]"));
  assert.ok(paraEvidence.includes("> 引用内容: TCP 报文段由 20 字节固定头部与数据字段组成。"));
  assert.ok(paraEvidence.includes("> 提问重点: 请解释 20 字节头部包含哪些字段"));

  // 1.3 兜底保护
  assert.equal(formatQuoteEvidence(null), "");
  assert.equal(formatQuoteEvidence(""), "");
  assert.ok(formatQuoteEvidence("简单纯文本引用").startsWith("> 简单纯文本引用"));
});

// ==========================================
// 2. truncateContext 安全字符裁剪测试
// ==========================================
test("DSH Bridge - truncateContext 上下文安全截断机制", () => {
  // 2.1 未超长文本原样保留
  const shortText = "短文本无需裁剪";
  assert.equal(truncateContext(shortText, 100), shortText);

  // 2.2 超长文本裁剪严格不超过限制
  const longText = "A".repeat(5000) + "B".repeat(5000) + "C".repeat(5000); // 15000 chars
  const truncated = truncateContext(longText, 12000);
  assert.ok(truncated.length <= 12000, `裁剪后长度 ${truncated.length} 必须 <= 12000`);
  assert.ok(truncated.includes("安全字符裁剪"));
  assert.ok(truncated.startsWith("AAAA"), "前部头部内容应保留");
  assert.ok(truncated.endsWith("CCCC"), "尾部结尾内容应保留");

  // 2.3 自定义小上限压力测试
  const smallBudget = 300;
  const smallTruncated = truncateContext(longText, smallBudget, { notice: "\n[已截断]\n" });
  assert.ok(smallTruncated.length <= smallBudget);
  assert.ok(smallTruncated.includes("[已截断]"));
});

// ==========================================
// 3. validateBridgeMessage & createBridgeResponse 协议兼容性测试
// ==========================================
test("DSH Bridge - 桥接协议消息结构验证与响应构造", () => {
  // 3.1 验证 learnbuddy:init 握手
  const validInit = {
    type: "learnbuddy:init",
    requestId: "req-12345",
    contextKey: "student-lin:mat-tcp"
  };
  const initResult = validateBridgeMessage(validInit);
  assert.equal(initResult.valid, true);

  const initResponse = createBridgeResponse("learnbuddy:ready", { status: "ready" }, validInit);
  assert.equal(initResponse.type, "learnbuddy:ready");
  assert.equal(initResponse.requestId, "req-12345");
  assert.equal(initResponse.contextKey, "student-lin:mat-tcp");
  assert.equal(initResponse.status, "ready");
  assert.ok(typeof initResponse.timestamp === "number");

  // 3.2 验证 learnbuddy:context 上下文注入握手
  const validContext = {
    type: "learnbuddy:context",
    requestId: "req-67890",
    contextKey: "student-lin:mat-tcp",
    title: "第三章 · TCP 可靠传输",
    text: "这是注入的课件正文"
  };
  const contextResult = validateBridgeMessage(validContext);
  assert.equal(contextResult.valid, true);

  const contextResponse = createBridgeResponse("learnbuddy:received", {}, validContext);
  assert.equal(contextResponse.type, "learnbuddy:received");
  assert.equal(contextResponse.requestId, "req-67890");
  assert.equal(contextResponse.contextKey, "student-lin:mat-tcp");

  // 3.3 验证非法消息拦截
  assert.equal(validateBridgeMessage(null).valid, false);
  assert.equal(validateBridgeMessage({}).valid, false);
  assert.equal(validateBridgeMessage({ type: "learnbuddy:init" }).valid, false);
  assert.equal(validateBridgeMessage({ type: "learnbuddy:context", requestId: "r", contextKey: "c" }).valid, false); // 缺少 text

  // 3.4 异常响应构造 (learnbuddy:error)
  const errorResponse = createBridgeResponse("learnbuddy:error", { message: "未找到关联课件" }, validInit);
  assert.equal(errorResponse.type, "learnbuddy:error");
  assert.equal(errorResponse.requestId, "req-12345");
  assert.equal(errorResponse.message, "未找到关联课件");
});

// ==========================================
// 4. DshContextBridgeService & buildDshSessionPrompt 逻辑测试
// ==========================================
test("DSH Bridge - buildDshSessionPrompt 组装完整 System Prompt", () => {
  const store = new DatabaseStore(":memory:");
  const bridgeService = new DshContextBridgeService({ store });

  const prompt = bridgeService.buildDshSessionPrompt("mat-tcp");
  assert.ok(prompt, "必须成功组装 System Prompt");

  // 验证四大核心模块注入
  assert.ok(prompt.includes("【课件背景信息】"), "必须包含课件背景信息");
  assert.ok(prompt.includes("计算机网络"), "背景信息必须包含课程名称");
  assert.ok(prompt.includes("第三章 · TCP 可靠传输"), "背景信息必须包含课件标题");

  assert.ok(prompt.includes("【逐页图文与图表清单 (多模态图表先验)】"), "必须包含逐页图表清单");
  assert.ok(prompt.includes("Figure 1-1"), "必须包含 Figure 1-1 说明");
  assert.ok(prompt.includes("Figure 2-1"), "必须包含 Figure 2-1 说明");
  assert.ok(prompt.includes("Figure 3-1"), "必须包含 Figure 3-1 说明");

  assert.ok(prompt.includes("【核心考点与知识点溯源】"), "必须包含核心考点");
  assert.ok(prompt.includes("第 1 页") || prompt.includes("第 2 页"), "考点必须带页码");

  assert.ok(prompt.includes("【教师预制答疑卡 (权威先验库)】"), "必须包含已确认教师答疑卡");
  assert.ok(prompt.includes("qa-syn"), "必须包含答疑卡 qa-syn");
  assert.ok(prompt.includes("控制信息") || prompt.includes("序列号"), "必须包含答疑卡标准答案");

  // 验证交互规范与纪律
  assert.ok(prompt.includes("【伴学助教纪律与交互规范】"));
  assert.ok(prompt.includes("根据第 X 页图表 [图表标题]..."), "必须包含图表引用纪律");
  assert.ok(prompt.includes("根据教师推荐答疑：..."), "必须包含教师答疑权威引用规范");
  assert.ok(prompt.includes("苏格拉底式启发教学"), "必须包含苏格拉底启发式交互约束");

  // 验证便捷独立函数 buildDshSessionPrompt
  const funcPrompt = buildDshSessionPrompt("mat-tcp", { store });
  assert.ok(funcPrompt.includes("【课件背景信息】"));

  // 验证权限隔离：私有材料未授权用户返回 null
  store.createMaterial({
    id: "mat-private-secret",
    courseId: "network",
    ownerId: "t-chen",
    title: "教师私有材料.pdf",
    visibility: "private"
  });
  assert.equal(bridgeService.buildDshSessionPrompt("mat-private-secret", { userId: "s-yi" }), null);
  assert.ok(bridgeService.buildDshSessionPrompt("mat-private-secret", { userId: "t-chen" }));

  // 验证 getSessionContext 包装快照
  const snapshot = bridgeService.getSessionContext("mat-tcp");
  assert.ok(snapshot);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.materialId, "mat-tcp");
  assert.ok(snapshot.diagrams.length >= 3);
  assert.ok(snapshot.prompt.length > 0);

  store.close();
});

// ==========================================
// 5. HTTP 端点集成测试 (/dsh/session-context, /dsh/quote, /dsh/message)
// ==========================================
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

test("HTTP API - POST /dsh/session-context & /dsh/quote & /dsh/message 全链路", async () => {
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
    // 5.1 POST /api/learnbuddy/dsh/session-context 正常获取标杆课件注入数据
    const sessionRes = await makeHttpRequest(
      port,
      "POST",
      "/api/learnbuddy/dsh/session-context",
      { "Content-Type": "application/json" },
      { materialId: "mat-tcp" }
    );
    assert.equal(sessionRes.statusCode, 200);
    const sessionData = JSON.parse(sessionRes.body.toString("utf-8"));
    assert.equal(sessionData.ok, true);
    assert.equal(sessionData.materialId, "mat-tcp");
    assert.equal(sessionData.title, "第三章 · TCP 可靠传输");
    assert.ok(sessionData.diagrams.length >= 3);
    assert.ok(sessionData.prompt.includes("【课件背景信息】"));
    assert.ok(sessionData.prompt.includes("根据第 X 页图表"));

    // 5.2 POST /api/learnbuddy/dsh/session-context 缺少参数与不存在材料
    const emptyRes = await makeHttpRequest(
      port,
      "POST",
      "/api/learnbuddy/dsh/session-context",
      { "Content-Type": "application/json" },
      {}
    );
    assert.equal(emptyRes.statusCode, 400);

    const notFoundRes = await makeHttpRequest(
      port,
      "POST",
      "/api/learnbuddy/dsh/session-context",
      { "Content-Type": "application/json" },
      { materialId: "non-existent-material" }
    );
    assert.equal(notFoundRes.statusCode, 404);

    // 5.3 POST /api/learnbuddy/dsh/quote 引用指定课件图表
    const quoteRes = await makeHttpRequest(
      port,
      "POST",
      "/api/learnbuddy/dsh/quote",
      { "Content-Type": "application/json" },
      {
        materialId: "mat-tcp",
        figureId: "fig-tcp-2",
        page: 2,
        customNote: "请解释客户端发送的 seq 序号与服务端回复的 ack 确认号的数学关系。"
      }
    );
    assert.equal(quoteRes.statusCode, 200);
    const quoteData = JSON.parse(quoteRes.body.toString("utf-8"));
    assert.equal(quoteData.ok, true);
    assert.ok(quoteData.quoteText.includes("> [引用第 2 页图表: Figure 2-1: 客户端与服务端三次握手时序流及 seq/ack 演进图]"));
    assert.ok(quoteData.quoteText.includes("> 图表说明:"));
    assert.ok(quoteData.quoteText.includes("> 提问重点: 请解释客户端发送的 seq 序号与服务端回复的 ack 确认号的数学关系。"));

    // 5.4 POST /api/learnbuddy/dsh/message 校验桥接通道
    const msgRes = await makeHttpRequest(
      port,
      "POST",
      "/api/learnbuddy/dsh/message",
      { "Content-Type": "application/json" },
      {
        type: "learnbuddy:init",
        requestId: "req-test-99",
        contextKey: "s-lin:mat-tcp"
      }
    );
    assert.equal(msgRes.statusCode, 200);
    const msgData = JSON.parse(msgRes.body.toString("utf-8"));
    assert.equal(msgData.ok, true);
    assert.equal(msgData.response.type, "learnbuddy:ready");
    assert.equal(msgData.response.requestId, "req-test-99");
    assert.equal(msgData.response.contextKey, "s-lin:mat-tcp");
  } finally {
    testServer.close();
    store.close();
  }
});
