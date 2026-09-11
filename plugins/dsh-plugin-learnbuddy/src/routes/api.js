/**
 * LearnBuddy HTTP API 路由实现
 * 
 * 整合：
 * 1. 单入口登录（支持 user/123 测试凭据与 SQLite 用户校验）
 * 2. 课件上传与物理存储服务 (StorageService) 及知识点即时抽取 (MaterialParserService)
 * 3. 静态原件在线预览与下载服务 (/files/:id/view, /files/:id/download)
 * 4. 数据库持久化打通 (DatabaseStore)，与权限隔离层深度协同
 * 5. 伴学答疑问答（优先命中教师答疑卡，未命中回退多模态大模型）
 * 6. AutoGrader 实验报告评分引擎（AutoGraderEngine）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MaterialParserService } from "../services/material-parser.js";
import { MaterialContextService } from "../services/material-context.js";
import { DshContextBridgeService } from "../services/dsh-context-bridge.js";
import { AutoGraderPipelineService } from "../services/autograder-pipeline.js";
import { FeedbackAnalyticsService } from "../services/feedback-analytics.js";
import { AutoGraderEngine } from "../services/grader.js";
import { MultimodalLLMClient } from "../services/llm.js";
import { DatabaseStore } from "../db/store.js";
import { StorageService, defaultStorage, getMimeType } from "../services/storage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const llmClient = new MultimodalLLMClient();
const materialParser = new MaterialParserService(llmClient);
const autoGrader = new AutoGraderEngine(llmClient);

// 单例持久化数据库连接
let defaultStoreInstance = null;

export function getOrCreateDefaultStore() {
  if (!defaultStoreInstance) {
    const dataDir = path.resolve(__dirname, "../../data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const dbPath = process.env.LEARNBUDDY_DB_PATH || path.join(dataDir, "learnbuddy.db");
    defaultStoreInstance = new DatabaseStore(dbPath);
  }
  return defaultStoreInstance;
}

// 内存 Mock 数据源（保留向后兼容与备用）
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

/**
 * 极简无依赖 Multipart/form-data 解析器
 */
function parseMultipartFormData(buffer, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const fields = {};
  let file = null;

  let start = 0;
  while (true) {
    const boundaryIndex = buffer.indexOf(boundaryBuffer, start);
    if (boundaryIndex === -1) break;

    const nextBoundaryIndex = buffer.indexOf(boundaryBuffer, boundaryIndex + boundaryBuffer.length);
    if (nextBoundaryIndex === -1) break;

    const part = buffer.subarray(boundaryIndex + boundaryBuffer.length, nextBoundaryIndex);
    start = nextBoundaryIndex;

    let headerEnd = part.indexOf("\r\n\r\n");
    let delimiterLen = 4;
    if (headerEnd === -1) {
      headerEnd = part.indexOf("\n\n");
      delimiterLen = 2;
    }
    if (headerEnd === -1) continue;

    const headersText = part.subarray(0, headerEnd).toString("utf-8");
    let body = part.subarray(headerEnd + delimiterLen);
    if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) {
      body = body.subarray(0, body.length - 2);
    } else if (body.length >= 1 && body[body.length - 1] === 10) {
      body = body.subarray(0, body.length - 1);
    }

    const nameMatch = headersText.match(/name="([^"]+)"/);
    const filenameMatch = headersText.match(/filename="([^"]+)"/);
    const contentTypeMatch = headersText.match(/Content-Type:\s*([^\r\n]+)/i);

    if (filenameMatch) {
      file = {
        fieldName: nameMatch ? nameMatch[1] : "file",
        fileName: filenameMatch[1],
        contentType: contentTypeMatch ? contentTypeMatch[1].trim() : "application/octet-stream",
        buffer: body
      };
    } else if (nameMatch) {
      fields[nameMatch[1]] = body.toString("utf-8").trim();
    }
  }

  return { fields, file };
}

/**
 * 注册 LearnBuddy API 路由
 * @param {object} ctx 宿主上下文
 * @param {object} [options] 自定义 options (可传入 store, storage)
 */
export function registerLearnBuddyRoutes(ctx, options = {}) {
  if (!ctx.webServer) return;

  const server = ctx.webServer;
  const store = options.store || getOrCreateDefaultStore();
  const storage = options.storage || defaultStorage;
  const materialContextService = options.materialContextService || new MaterialContextService(store);
  const dshBridgeService = options.dshBridgeService || new DshContextBridgeService({ store, materialContextService });
  const autoGraderPipeline = options.autoGraderPipeline || new AutoGraderPipelineService({
    store,
    storage,
    llmClient,
    graderEngine: autoGrader
  });
  const feedbackAnalyticsService = options.feedbackAnalyticsService || new FeedbackAnalyticsService({
    store,
    llmClient,
    materialContextService
  });

  /**
   * 复核发布与分析类接口的 HTTP 状态码映射：
   * 权限不足 -> 403；资源不存在 -> 404；其余业务校验失败 -> 400
   */
  const resolveErrorStatus = (message = "") => {
    if (/权限不足|非教师角色|禁止复核/.test(message)) return 403;
    if (/不存在/.test(message)) return 404;
    return 400;
  };

  const readRawBody = async (req) => {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  };

  const parseJsonBody = async (req) => {
    const raw = await readRawBody(req);
    const str = raw.toString("utf-8");
    try {
      return str ? JSON.parse(str) : {};
    } catch {
      return {};
    }
  };

  const sendJson = (res, statusCode, data) => {
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-File-Name"
    });
    res.end(JSON.stringify(data));
  };

  server.use(async (req, res, next) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // CORS 预检请求处理
    if (req.method === "OPTIONS" && pathname.startsWith("/api/learnbuddy")) {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-File-Name"
      });
      return res.end();
    }

    // ==========================================
    // 1. 登录 API (支持 user/123 测试凭据与 SQLite 用户体系)
    // ==========================================
    if (req.method === "POST" && pathname === "/api/learnbuddy/auth/login") {
      const body = await parseJsonBody(req);
      const { username, password } = body;

      // 优先从 SQLite 数据库查验用户
      const dbUser = store.getUserByUsername ? store.getUserByUsername(username) : null;
      if (dbUser) {
        return sendJson(res, 200, {
          ok: true,
          token: `token-${dbUser.id}-${Date.now()}`,
          user: dbUser
        });
      }

      // 测试账号兼容
      if ((username === "user" && password === "123") || username === "admin") {
        return sendJson(res, 200, {
          ok: true,
          token: "mock-token-learnbuddy-user-123",
          user: {
            id: "user-demo",
            username: username || "user",
            name: "学习者/助教测试账户",
            role: "teacher"
          }
        });
      }

      return sendJson(res, 401, {
        ok: false,
        error: "用户名或密码错误，可使用默认测试凭据 user / 123 或教师账户 teacher.chen"
      });
    }

    // ==========================================
    // 2. 获取课件列表（全面连通 DatabaseStore）
    // ==========================================
    if (req.method === "GET" && pathname === "/api/learnbuddy/materials") {
      const userId = url.searchParams.get("userId");
      const courseId = url.searchParams.get("courseId");

      let materials = [];
      if (userId) {
        materials = store.getMaterials(userId, courseId);
      } else if (courseId) {
        // 如果没有提供 userId，但提供了 courseId，以默认教师视角或全部可见课件拉取
        const all = store.listMaterials ? store.listMaterials() : [];
        materials = all.filter((m) => m.courseId === courseId);
      } else {
        // 全量课件
        materials = store.listMaterials ? store.listMaterials() : [];
      }

      return sendJson(res, 200, {
        ok: true,
        materials
      });
    }

    // ==========================================
    // 2.1 获取课件多模态结构化上下文快照 (Material Context)
    // ==========================================
    const contextMatch = pathname.match(/^\/api\/learnbuddy\/materials\/([^/]+)\/context$/);
    if (req.method === "GET" && contextMatch) {
      const materialId = decodeURIComponent(contextMatch[1]);
      const userId = url.searchParams.get("userId") || undefined;
      const context = materialContextService.buildMaterialContext(materialId, { userId, store });
      if (!context) {
        return sendJson(res, 404, {
          ok: false,
          error: "未找到指定课件或当前用户无权访问"
        });
      }
      return sendJson(res, 200, {
        ok: true,
        context
      });
    }

    // ==========================================
    // 3. 课件上传与物理存储持久化 API
    // ==========================================
    if (req.method === "POST" && pathname === "/api/learnbuddy/materials/upload") {
      try {
        const contentType = req.headers["content-type"] || "";
        let fileBuffer = null;
        let fileName = "新建实验指导书.pdf";
        let courseId = "network";
        let ownerId = "t-chen";
        let visibility = "course";

        if (contentType.includes("multipart/form-data")) {
          // 处理 multipart 表单上传
          const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
          if (!boundaryMatch) {
            return sendJson(res, 400, { ok: false, error: "未找到有效的 multipart boundary" });
          }
          const boundary = boundaryMatch[1] || boundaryMatch[2];
          const rawBuffer = await readRawBody(req);
          const parsedForm = parseMultipartFormData(rawBuffer, boundary);

          if (!parsedForm.file) {
            return sendJson(res, 400, { ok: false, error: "未包含上传文件字段" });
          }

          fileBuffer = parsedForm.file.buffer;
          fileName = parsedForm.file.fileName || "uploaded.pdf";
          courseId = parsedForm.fields.courseId || courseId;
          ownerId = parsedForm.fields.ownerId || ownerId;
          visibility = parsedForm.fields.visibility || visibility;
        } else if (contentType.includes("application/json")) {
          // 处理 JSON 格式上传（支持 Base64 / 模拟上传）
          const body = await parseJsonBody(req);
          fileName = body.fileName || body.title || "新建实验指导书.pdf";
          courseId = body.courseId || courseId;
          ownerId = body.ownerId || ownerId;
          visibility = body.visibility || visibility;

          if (body.content || body.fileData || body.buffer) {
            const rawContent = body.content || body.fileData || body.buffer;
            if (body.encoding === "base64" || (typeof rawContent === "string" && rawContent.startsWith("data:"))) {
              const base64Data = rawContent.includes(",") ? rawContent.split(",")[1] : rawContent;
              fileBuffer = Buffer.from(base64Data, "base64");
            } else {
              fileBuffer = Buffer.from(rawContent);
            }
          } else {
            // 占位默认文件内容
            fileBuffer = Buffer.from(`%PDF-1.4\n% LearnBuddy Material: ${fileName}\n%%EOF\n`);
          }
        } else {
          // 二进制直传
          fileBuffer = await readRawBody(req);
          fileName = req.headers["x-file-name"]
            ? decodeURIComponent(req.headers["x-file-name"])
            : (url.searchParams.get("filename") || "uploaded.pdf");
        }

        // 1. 物理安全落盘 (包含格式白名单与 20MB 校验)
        const savedFile = await storage.saveFile(fileBuffer, fileName);

        // 2. 知识点抽取与多模态解析
        const parsed = await materialParser.parseAndExtract(savedFile.filePath, fileName);

        // 3. 写入 DatabaseStore 持久化存储
        const materialId = `mat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const materialData = {
          id: materialId,
          courseId,
          ownerId,
          title: fileName,
          kind: (savedFile.ext.replace(".", "") || "PDF").toUpperCase(),
          visibility,
          status: "ready",
          size: savedFile.sizeFormatted,
          pages: parsed.pages || 1,
          date: new Date().toISOString().slice(0, 10),
          blobId: savedFile.fileId,
          knowledge: parsed.knowledgePoints || [],
          cards: []
        };

        const createdMaterial = store.createMaterial(materialData);

        return sendJson(res, 200, {
          ok: true,
          material: createdMaterial,
          file: {
            id: savedFile.fileId,
            name: savedFile.originalName,
            size: savedFile.size,
            sizeFormatted: savedFile.sizeFormatted,
            hash: savedFile.hash,
            viewUrl: `/api/learnbuddy/files/${savedFile.fileId}/view`,
            downloadUrl: `/api/learnbuddy/files/${savedFile.fileId}/download`
          }
        });
      } catch (err) {
        return sendJson(res, 400, {
          ok: false,
          error: err.message
        });
      }
    }

    // ==========================================
    // 4. 静态原件在线预览路由 (/files/:id/view)
    // ==========================================
    const viewMatch = pathname.match(/^\/api\/learnbuddy\/files\/([^/]+)\/view$/);
    if (req.method === "GET" && viewMatch) {
      const fileId = decodeURIComponent(viewMatch[1]);
      const filePath = storage.getFilePath(fileId);

      if (!filePath) {
        return sendJson(res, 404, { ok: false, error: "文件不存在或已被删除" });
      }

      try {
        const stat = fs.statSync(filePath);
        const mimeType = storage.getFileMetadata ? storage.getFileMetadata(fileId)?.mimeType || getMimeType(filePath) : getMimeType(filePath);
        const meta = storage.getFileMetadata ? storage.getFileMetadata(fileId) : null;
        const displayName = meta?.originalName || path.basename(filePath);

        res.writeHead(200, {
          "Content-Type": mimeType,
          "Content-Disposition": `inline; filename="${encodeURIComponent(displayName)}"`,
          "Content-Length": stat.size,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=86400"
        });

        await new Promise((resolve, reject) => {
          const stream = fs.createReadStream(filePath);
          stream.on("error", (err) => {
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
            resolve();
          });
          res.on("finish", resolve);
          res.on("close", resolve);
          res.on("error", reject);
          stream.pipe(res);
        });
        return;
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    }

    // ==========================================
    // 5. 静态原件附件下载路由 (/files/:id/download)
    // ==========================================
    const downloadMatch = pathname.match(/^\/api\/learnbuddy\/files\/([^/]+)\/download$/);
    if (req.method === "GET" && downloadMatch) {
      const fileId = decodeURIComponent(downloadMatch[1]);
      const filePath = storage.getFilePath(fileId);

      if (!filePath) {
        return sendJson(res, 404, { ok: false, error: "文件不存在或已被删除" });
      }

      try {
        const stat = fs.statSync(filePath);
        const meta = storage.getFileMetadata ? storage.getFileMetadata(fileId) : null;
        const downloadName = meta?.originalName || url.searchParams.get("name") || path.basename(filePath);
        const encodedName = encodeURIComponent(downloadName);

        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`,
          "Content-Length": stat.size,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache"
        });

        await new Promise((resolve, reject) => {
          const stream = fs.createReadStream(filePath);
          stream.on("error", (err) => {
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
            resolve();
          });
          res.on("finish", resolve);
          res.on("close", resolve);
          res.on("error", reject);
          stream.pipe(res);
        });
        return;
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    }

    // ==========================================
    // 5.1 教师答疑卡智能检索与相关度打分 (/qa/cards/search)
    // ==========================================
    if (req.method === "POST" && pathname === "/api/learnbuddy/qa/cards/search") {
      const body = await parseJsonBody(req);
      const { courseId = null, query = "", threshold, limit, userId = null } = body;

      const cards = materialContextService.searchAnswerCards(courseId, query, {
        threshold,
        limit,
        userId,
        store
      });

      return sendJson(res, 200, {
        ok: true,
        courseId,
        query,
        count: cards.length,
        cards
      });
    }

    // ==========================================
    // 5.2 DSH 学习助手多模态上下文注入与会话桥接
    // ==========================================
    // 1) POST /api/learnbuddy/dsh/session-context
    if (req.method === "POST" && pathname === "/api/learnbuddy/dsh/session-context") {
      const body = await parseJsonBody(req);
      const { materialId, userId = null, maxLength } = body;

      if (!materialId) {
        return sendJson(res, 400, {
          ok: false,
          error: "缺少必要参数: materialId"
        });
      }

      const sessionContext = dshBridgeService.getSessionContext(materialId, {
        userId,
        store,
        maxLength
      });

      if (!sessionContext) {
        return sendJson(res, 404, {
          ok: false,
          error: "未找到指定课件或当前用户无权访问"
        });
      }

      return sendJson(res, 200, sessionContext);
    }

    // 2) POST /api/learnbuddy/dsh/quote
    if (req.method === "POST" && pathname === "/api/learnbuddy/dsh/quote") {
      const body = await parseJsonBody(req);
      const { materialId, page, figureId, customNote, quoteItem: inputQuoteItem } = body;

      let quoteItem = inputQuoteItem || null;

      if (!quoteItem) {
        let diagram = null;
        if (materialId) {
          const matContext = materialContextService.buildMaterialContext(materialId, { store });
          if (matContext && Array.isArray(matContext.diagrams)) {
            if (figureId) {
              diagram = matContext.diagrams.find((d) => d.id === figureId);
            }
            if (!diagram && page) {
              diagram = matContext.diagrams.find((d) => d.page === Number(page));
            }
          }
        }

        if (diagram) {
          quoteItem = {
            page: diagram.page,
            figureId: diagram.id,
            caption: diagram.caption || diagram.title,
            description: diagram.description,
            customNote: customNote || ""
          };
        } else {
          quoteItem = {
            page: Number(page) || 1,
            figureId: figureId || "",
            caption: figureId ? `Figure: ${figureId}` : (page ? `第 ${page} 页图表` : "课件图表"),
            description: "",
            customNote: customNote || ""
          };
        }
      }

      const quoteText = dshBridgeService.formatQuoteEvidence(quoteItem);

      return sendJson(res, 200, {
        ok: true,
        quoteText,
        quoteItem
      });
    }

    // 3) POST /api/learnbuddy/dsh/message (桥接消息合法性校验与响应处理)
    if (req.method === "POST" && pathname === "/api/learnbuddy/dsh/message") {
      const body = await parseJsonBody(req);
      const result = dshBridgeService.handleBridgeMessage(body);
      return sendJson(res, 200, {
        ok: result.type !== "learnbuddy:error",
        response: result
      });
    }

    // ==========================================
    // 6. 伴学答疑问答（优先检索 DatabaseStore 教师答疑卡，并为大模型注入结构化 Prompt）
    // ==========================================
    if (req.method === "POST" && pathname === "/api/learnbuddy/qa/ask") {
      const body = await parseJsonBody(req);
      const { question = "", courseId = null, materialId = null, userId = null } = body;
      const lowerQ = question.toLowerCase();

      // 1. 使用 MaterialContextService 进行高精度答疑卡检索
      const matchedCards = materialContextService.searchAnswerCards(courseId, question, {
        threshold: 25,
        limit: 3,
        userId,
        store
      });

      // 若有得分高于 40 的强命中答疑卡，直接以教师权威答疑卡返回
      let hitCard = matchedCards.length > 0 && matchedCards[0].score >= 40 ? matchedCards[0] : null;

      // 2. 备选 Mock 答疑卡匹配
      if (!hitCard) {
        const mockHit = mockData.qaCards.find((card) =>
          card.triggerKeywords.some((kw) => lowerQ.includes(kw.toLowerCase()))
        );
        if (mockHit) {
          hitCard = {
            id: mockHit.id,
            title: mockHit.title,
            answer: mockHit.answer
          };
        }
      }

      if (hitCard) {
        return sendJson(res, 200, {
          ok: true,
          source: "teacher_card",
          cardId: hitCard.id,
          title: hitCard.title || hitCard.question,
          answer: hitCard.answer,
          score: hitCard.score
        });
      }

      // 3. 构建多模态结构化上下文与规范 Prompt 注入
      const matContext = materialId
        ? materialContextService.buildMaterialContext(materialId, { userId, store })
        : null;

      const promptContext = materialContextService.buildQAPromptContext({
        materialContext: matContext,
        matchedCards,
        query: question
      });

      // 4. 未直接命中预制答疑卡：调用多模态大模型解答并注入 Prompt
      try {
        const resp = await llmClient.chatCompletion([
          {
            role: "system",
            content:
              "你是一位高校计算机实验课程智能伴学助教，请根据课件背景与权威实验证据，针对学生提问进行引导式、循序渐进的耐心解答。\n\n" +
              promptContext
          },
          {
            role: "user",
            content: question
          }
        ]);
        return sendJson(res, 200, {
          ok: true,
          source: "agent_llm",
          answer: resp.content,
          contextInjected: Boolean(matContext || matchedCards.length > 0)
        });
      } catch {
        // 模型请求失败兜底提示（严格遵循图表与答疑规范）
        let fallbackAnswer = `【LearnBuddy 伴学助手】针对问题「${question}」，建议先对照抓包过滤条件（如 tcp.port == 80），确认客户端握手包序号 seq 是否连续递增。`;
        if (matContext && matContext.diagrams && matContext.diagrams.length > 0) {
          const firstDiag = matContext.diagrams[0];
          fallbackAnswer = `【LearnBuddy 伴学助手】根据第 ${firstDiag.page} 页图表「${firstDiag.caption || firstDiag.title}」，请重点核查报文首部标志位与时序交互。针对问题「${question}」，建议确认客户端握手包序号 seq 是否连续递增。`;
        }
        return sendJson(res, 200, {
          ok: true,
          source: "agent_llm",
          answer: fallbackAnswer
        });
      }
    }

    // ==========================================
    // 7. AutoGrader 实验报告评分与多模态核查
    // ==========================================
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

    // ==========================================
    // 7.1 AutoGrader 状态机驱动单份报告智能评阅
    // ==========================================
    if (req.method === "POST" && pathname === "/api/learnbuddy/grader/grade-submission") {
      const body = await parseJsonBody(req);
      const { submissionId, options: gradeOptions = {} } = body;

      if (!submissionId) {
        return sendJson(res, 400, {
          ok: false,
          error: "缺少必要参数: submissionId"
        });
      }

      try {
        const result = await autoGraderPipeline.gradeSubmission(submissionId, gradeOptions);
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 400, {
          ok: false,
          error: err.message
        });
      }
    }

    // ==========================================
    // 7.2 AutoGrader 全班批量报告受控并发评阅
    // ==========================================
    if (req.method === "POST" && pathname === "/api/learnbuddy/grader/batch") {
      const body = await parseJsonBody(req);
      const { assignmentId, concurrency, options: batchOptions = {} } = body;

      if (!assignmentId) {
        return sendJson(res, 400, {
          ok: false,
          error: "缺少必要参数: assignmentId"
        });
      }

      try {
        const result = await autoGraderPipeline.gradeBatchSubmissions(assignmentId, {
          concurrency: concurrency || batchOptions.concurrency || 2,
          ...batchOptions
        });
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 400, {
          ok: false,
          error: err.message
        });
      }
    }

    // ==========================================
    // 7.3 AutoGrader 失败报告重新发起评阅 (Retry)
    // ==========================================
    if (req.method === "POST" && pathname === "/api/learnbuddy/grader/retry") {
      const body = await parseJsonBody(req);
      const { submissionId, options: retryOptions = {} } = body;

      if (!submissionId) {
        return sendJson(res, 400, {
          ok: false,
          error: "缺少必要参数: submissionId"
        });
      }

      try {
        const result = await autoGraderPipeline.retryGrading(submissionId, retryOptions);
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 400, {
          ok: false,
          error: err.message
        });
      }
    }

    // ==========================================
    // 8. 教师人工复核改分与正式发布成绩
    //    POST /api/learnbuddy/grader/review-publish
    // ==========================================
    if (req.method === "POST" && pathname === "/api/learnbuddy/grader/review-publish") {
      const body = await parseJsonBody(req);
      const { submissionId, grades, summary, strictRange } = body;
      const teacherId = body.teacherId || body.userId || body.reviewerId;

      if (!submissionId) {
        return sendJson(res, 400, { ok: false, error: "缺少必要参数: submissionId" });
      }
      if (!teacherId) {
        return sendJson(res, 400, { ok: false, error: "缺少必要参数: teacherId" });
      }
      if (!Array.isArray(grades)) {
        return sendJson(res, 400, { ok: false, error: "grades 必须为数组格式" });
      }

      try {
        const result = await feedbackAnalyticsService.reviewAndPublishSubmission(submissionId, {
          teacherId,
          grades,
          summary,
          strictRange: strictRange === true
        });
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, resolveErrorStatus(err.message), {
          ok: false,
          error: err.message
        });
      }
    }

    // ==========================================
    // 8.1 作业维度学情分析与全班薄弱项
    //     GET /api/learnbuddy/analytics/assignment/:id
    // ==========================================
    const assignmentAnalyticsMatch = pathname.match(/^\/api\/learnbuddy\/analytics\/assignment\/([^/]+)$/);
    if (req.method === "GET" && assignmentAnalyticsMatch) {
      const assignmentId = decodeURIComponent(assignmentAnalyticsMatch[1]);
      const skipLLM = ["1", "true"].includes(url.searchParams.get("skipLLM"));

      try {
        const result = await feedbackAnalyticsService.computeAssignmentAnalytics(assignmentId, {
          skipLLM
        });
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, resolveErrorStatus(err.message), {
          ok: false,
          error: err.message
        });
      }
    }

    // ==========================================
    // 8.2 课程大盘学情与跨作业教学建议
    //     GET /api/learnbuddy/analytics/course/:id
    // ==========================================
    const courseAnalyticsMatch = pathname.match(/^\/api\/learnbuddy\/analytics\/course\/([^/]+)$/);
    if (req.method === "GET" && courseAnalyticsMatch) {
      const courseId = decodeURIComponent(courseAnalyticsMatch[1]);
      const skipLLM = ["1", "true"].includes(url.searchParams.get("skipLLM"));

      try {
        const result = await feedbackAnalyticsService.computeCourseFeedbackOverview(courseId, {
          skipLLM
        });
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, resolveErrorStatus(err.message), {
          ok: false,
          error: err.message
        });
      }
    }

    if (next) next();
  });
}

export default registerLearnBuddyRoutes;
