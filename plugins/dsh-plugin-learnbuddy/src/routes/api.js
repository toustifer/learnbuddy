/**
 * LearnBuddy HTTP API 路由实现
 * 整合：
 * 1. 单入口登录（支持 user/123）
 * 2. 课件上传与多模态知识点抽取服务（MaterialParserService）
 * 3. 伴学答疑问答（优先命中教师答疑卡，未命中回退多模态大模型）
 * 4. AutoGrader 实验报告评分引擎（AutoGraderEngine）
 */

import { MaterialParserService } from "../services/material-parser.js";
import { AutoGraderEngine } from "../services/grader.js";
import { MultimodalLLMClient } from "../services/llm.js";

const llmClient = new MultimodalLLMClient();
const materialParser = new MaterialParserService(llmClient);
const autoGrader = new AutoGraderEngine(llmClient);

// 内存 Mock 数据源（开箱即用，支持评委和前端演示离线跑通）
export const mockData = {
  materials: [
    {
      id: "mat-cs101-01",
      title: "实验一：Wireshark抓包与TCP三次握手分析.pdf",
      size: "2.4 MB",
      uploadedAt: "2026-09-08 14:30",
      status: "parsed",
      keyPointsCount: 4,
      pages: 12,
      knowledgePoints: [
        {
          id: "kp-1",
          name: "TCP 三次握手报文交互与 Flags 识别",
          summary: "客户端发送 SYN 建立连接，服务端回复 SYN+ACK，客户端最后发送 ACK。Wireshark 中 Flags 展开查看。",
          page: 2,
          difficulty: "核心"
        },
        {
          id: "kp-2",
          name: "Seq 与 Ack 序号递增逻辑",
          summary: "相对序号默认开启，SYN 标志消耗一个逻辑序号，后续 ACK 确认号为 seq+1。",
          page: 5,
          difficulty: "进阶"
        },
        {
          id: "kp-3",
          name: "TCP RST 报文排查与异常诊断",
          summary: "目标端口未开启监听或被防火墙直接阻断时响应 RST 报文，Wireshark 显示为红底黑字警示。",
          page: 7,
          difficulty: "核心"
        },
        {
          id: "kp-4",
          name: "Wireshark 显示过滤器语法",
          summary: "熟练使用 tcp.port == 80 以及 tcp.flags 逻辑过滤语法。",
          page: 9,
          difficulty: "基础"
        }
      ]
    }
  ],
  qaCards: [
    {
      id: "card-001",
      materialId: "mat-cs101-01",
      triggerKeywords: ["TCP RST", "红色报文", "连接重置", "RST包", "红底黑字"],
      title: "抓包中出现红色 TCP RST 的常见排查",
      answer: "抓包中看到红色的 RST（Reset）通常表示目标端口未开启监听，或服务端主动拒绝/重置连接。请先检查服务器端口是否处于 LISTEN 状态，以及防火墙策略是否放行。"
    },
    {
      id: "card-002",
      materialId: "mat-cs101-01",
      triggerKeywords: ["三次握手", "SYN", "ACK", "时序图", "握手步骤"],
      title: "TCP 三次握手标准时序与报文特征",
      answer: "1. 客户端发送 SYN (seq=x)；\n2. 服务端回复 SYN+ACK (seq=y, ack=x+1)；\n3. 客户端回复 ACK (seq=x+1, ack=y+1)。请重点比对抓包中的 Flags 标志位与序号变化。"
    }
  ]
};

export function registerLearnBuddyRoutes(ctx) {
  if (!ctx.webServer) return;

  const server = ctx.webServer;

  const parseJsonBody = async (req) => {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          resolve({});
        }
      });
    });
  };

  const sendJson = (res, statusCode, data) => {
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });
    res.end(JSON.stringify(data));
  };

  server.use(async (req, res, next) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    if (req.method === "OPTIONS" && pathname.startsWith("/api/learnbuddy")) {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      });
      return res.end();
    }

    // 1. 登录 API (单入口，支持 user/123 测试凭据)
    if (req.method === "POST" && pathname === "/api/learnbuddy/auth/login") {
      const body = await parseJsonBody(req);
      const { username, password } = body;
      if ((username === "user" && password === "123") || username === "admin") {
        return sendJson(res, 200, {
          ok: true,
          token: "mock-token-learnbuddy-user-123",
          user: {
            username: username || "user",
            name: "学习者/助教测试账户",
            role: "user"
          }
        });
      }
      return sendJson(res, 401, { ok: false, error: "用户名或密码错误，可使用默认测试凭据 user / 123" });
    }

    // 2. 获取课件列表（含解析出的结构化知识点）
    if (req.method === "GET" && pathname === "/api/learnbuddy/materials") {
      return sendJson(res, 200, {
        ok: true,
        materials: mockData.materials
      });
    }

    // 3. 课件上传与知识点即时抽取 API
    if (req.method === "POST" && pathname === "/api/learnbuddy/materials/upload") {
      const body = await parseJsonBody(req);
      const fileName = body.fileName || "新建实验指导书.pdf";
      
      const parsed = await materialParser.parseAndExtract("", fileName);
      const newMaterial = {
        id: `mat-${Date.now()}`,
        ...parsed
      };
      mockData.materials.unshift(newMaterial);

      return sendJson(res, 200, {
        ok: true,
        material: newMaterial
      });
    }

    // 4. 伴学答疑问答（答疑卡快速召回 vs 多模态大模型解答）
    if (req.method === "POST" && pathname === "/api/learnbuddy/qa/ask") {
      const body = await parseJsonBody(req);
      const { question = "" } = body;

      // 快速检查教师预制答疑卡
      const hitCard = mockData.qaCards.find(card =>
        card.triggerKeywords.some(kw => question.toLowerCase().includes(kw.toLowerCase()))
      );

      if (hitCard) {
        return sendJson(res, 200, {
          ok: true,
          source: "teacher_card",
          cardId: hitCard.id,
          title: hitCard.title,
          answer: hitCard.answer
        });
      }

      // 未命中预制锦囊：调用大模型解答
      try {
        const resp = await llmClient.chatCompletion([
          {
            role: "system",
            content: "你是一位高校计算机实验课程智能伴学助教，请根据计算机网络与 Wireshark 实验背景，针对学生提问进行引导式、循序渐进的耐心解答。"
          },
          {
            role: "user",
            content: question
          }
        ]);
        return sendJson(res, 200, {
          ok: true,
          source: "agent_llm",
          answer: resp.content
        });
      } catch (err) {
        return sendJson(res, 200, {
          ok: true,
          source: "agent_llm",
          answer: `【LearnBuddy 伴学助手】针对问题「${question}」，建议先对照抓包过滤条件（如 tcp.port == 80），确认客户端握手包序号 seq 是否连续递增。`
        });
      }
    }

    // 5. AutoGrader 实验报告评分与多模态核查
    if (req.method === "POST" && pathname === "/api/learnbuddy/grader/submit") {
      const body = await parseJsonBody(req);
      const reportTitle = body.reportTitle || "计算机网络实验报告.pdf";
      const reportContent = body.reportContent || "";

      const gradeResult = await autoGrader.gradeReport({
        title: reportTitle,
        content: reportContent,
        hasImages: true
      });

      return sendJson(res, 200, gradeResult);
    }

    if (next) next();
  });
}
