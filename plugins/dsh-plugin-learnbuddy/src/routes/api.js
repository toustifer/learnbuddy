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
import { verifyPassword, readBearerToken, readQueryToken, resolveActorFromRequest } from "../services/auth.js";
import { ERROR_CODES, classifyError, withEnvelope } from "../contracts/envelope.js";
import { isGradeVisible } from "../contracts/projection.js";
import {
  deriveDocumentVersionId,
  evidenceRefsFromMaterialContext,
  withSubmissionEvidenceRefs,
  withSubmissionsEvidenceRefs,
  collectFromSubmissions
} from "../contracts/evidence.js";
import { registerTeachingRoutes } from "./teaching.js";
import { registerSpeechRoutes } from "./speech.js";

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

/**
 * 伴学答疑兜底答案（task-13：模型空输出 / 请求失败时使用，保证 answer 永不为空）。
 * 只说明服务状态，不把固定学科建议伪装成对用户问题的回答。
 */
function buildQaFallbackAnswer(question, matContext) {
  return "【LearnBuddy 伴学助手】本次未获得可用的模型回答。请检查模型配置或稍后重试，也可以查看老师发布的答疑卡。" +
    (matContext ? "所选课件仍可阅读，请回到原文核对。" : "");
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
 * @param {object} [options] 自定义 options (可传入 store, storage, llmClient)
 */
export function registerLearnBuddyRoutes(ctx, options = {}) {
  if (!ctx.webServer) return;

  const server = ctx.webServer;
  const store = options.store || getOrCreateDefaultStore();
  const storage = options.storage || defaultStorage;
  // 允许注入大模型客户端（与 store / storage 同一套 options 风格）；不注入时沿用模块级单例
  const qaLlmClient = options.llmClient || llmClient;
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

  /**
   * 身份绑定：把请求换成一个可信的 `Actor`。
   *
   * 只认 `Authorization: Bearer <token>`（文件预览 / 下载这两个由浏览器直连的场景，
   * 另允许 `?token=`，见 `readQueryToken` 的说明）。
   *
   * **不再接受任何自报身份。** 原来的 `requireUser(url.searchParams.get("userId"))`
   * 等于让调用方自己声明自己是谁——实测中任何人只要自报一个教师账号，
   * 不需要任何凭据就能拿到全班学生的分数与评语。
   *
   * @param {import("node:http").IncomingMessage} req
   * @param {{fallbackToken?: string}} [options]
   * @returns {{ok: true, user: object} | {ok: false, status: number, error: string}}
   */
  const requireActor = (req, options = {}) =>
    resolveActorFromRequest(store, req, { queryToken: options.fallbackToken || "" });

  /**
   * 允许用 `?token=` 传令牌的端点：图片预览与文件下载由浏览器直接发起
   * （`<img src>` / `<a href>`），无法附加自定义请求头。
   * 令牌本身仍是服务端签发并校验的，因此不等于「自报身份」。
   */
  const QUERY_TOKEN_ENDPOINT = /^\/api\/learnbuddy\/files\/[^/]+\/(view|download)$/;

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

  /**
   * 统一响应出口（契约层「访问契约」在这里**定义一次**）。
   *
   * 为什么放在这个函数里：所有端点、`teaching.js`、`speech` 共用同一个出口，
   * 因此**新增端点自动合规**——不需要每个端点自己记得加信封或错误码。
   *
   * 做两件事：
   *   1. 成功：补 `schemaVersion` / `asOf` / `warnings` / `evidenceRefs` / `nextCursor` / `data`
   *   2. 失败：按既有文案归类出 `code`（调用方已显式给出 `code` 时以调用方为准），
   *      同时**保留原有 `error` 字段**，不打断现有客户端
   */
  const sendJson = (res, statusCode, data) => {
    let payload = data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      if (data.ok === false) {
        const code = typeof data.code === "string" ? data.code : classifyError(data.error);
        const spec = ERROR_CODES[code];
        const merged = {
          ...data,
          code,
          error: data.error || (spec && spec.defaultMessage) || "请求失败"
        };
        payload = withEnvelope(merged, { data: null });
      } else {
        payload = withEnvelope(data);
      }
    }

    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-File-Name"
    });
    res.end(JSON.stringify(payload));
  };

  registerTeachingRoutes(server, { store, readJson: parseJsonBody, sendJson });
  registerSpeechRoutes(server, { sendJson });

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
    // ==========================================
    // 1. 认证域（登录 / 当前身份 / 退出）
    //
    // 身份绑定的第一性问题：入口负责认证，之后只传 `Actor`。
    // 令牌由服务端随机签发并落库，调用方无法用任何入参声明自己是谁。
    // ==========================================
    if (req.method === "POST" && pathname === "/api/learnbuddy/auth/login") {
      const body = await parseJsonBody(req);
      const { username, password } = body;

      const credential =
        typeof username === "string" && store.getCredentialByUsername
          ? store.getCredentialByUsername(username.trim())
          : null;

      // 「用户不存在」与「密码错误」返回同一种结果，避免被用来枚举系统里有哪些账号
      if (!credential || !verifyPassword(password, credential.passwordHash)) {
        return sendJson(res, 401, {
          ok: false,
          error: "用户名或密码不正确。演示账号密码为 123。"
        });
      }

      const session = store.createSession(credential.user.id);
      return sendJson(res, 200, {
        ok: true,
        token: session.token,
        expiresAt: session.expiresAt,
        user: { ...credential.user, courses: store.getUserCourses(credential.user.id) }
      });
    }

    // 当前登录身份：前端刷新后用令牌换回用户对象；无令牌即 401
    if (req.method === "GET" && pathname === "/api/learnbuddy/auth/me") {
      const auth = requireActor(req);
      if (!auth.ok) {
        return sendJson(res, auth.status, { ok: false, error: auth.error });
      }
      return sendJson(res, 200, {
        ok: true,
        user: { ...auth.user, courses: store.getUserCourses(auth.user.id) }
      });
    }

    // 退出登录：作废令牌。无令牌时也返回成功（幂等），避免前端退出流程被卡住
    if (req.method === "POST" && pathname === "/api/learnbuddy/auth/logout") {
      const token = readBearerToken(req);
      if (token) store.deleteSession(token);
      return sendJson(res, 200, { ok: true });
    }

    // ---- 统一门槛：除上面三个认证端点外，一律要求有效令牌 ----
    //
    // 放在路由分发之前，是为了避免「新加一个端点忘了校验」——
    // 默认拒绝、显式放行，比逐个端点加校验更不容易漏。
    if (pathname.startsWith("/api/learnbuddy")) {
      const gate = requireActor(req, {
        fallbackToken: QUERY_TOKEN_ENDPOINT.test(pathname) ? readQueryToken(url) : ""
      });
      if (!gate.ok) {
        return sendJson(res, gate.status, { ok: false, error: gate.error });
      }
      // 后续各端点直接复用这次解析结果，不再重复查库
      req.actor = gate.user;
    }

    // ==========================================
    // 2. 获取课件列表（全面连通 DatabaseStore）
    //    返回的每个 material 由 store 映射层带上 task-15 的
    //    parseStatus / parseError / parseErrorCode（成功项不带错误字段）。
    //    注意：权限过滤逻辑（学生仅见公开+自有私有资料）保持不变，
    //    解析错误信息随 material 一起过滤，不构成越权泄露渠道。
    // ==========================================
    if (req.method === "GET" && pathname === "/api/learnbuddy/materials") {
      // 身份绑定：可见范围一律由登录身份决定，不接受调用方声明。
      // 原先「不带 userId 就返回全库」「只给 courseId 就返回该课全部」两条兜底分支已删除——
      // 那正是已确认的越权泄漏：任何人可借此拉到教师 private 资料。
      const userId = req.actor.id;
      const courseId = url.searchParams.get("courseId") || undefined;
      const materials = store.getMaterials(userId, courseId);

      // 「未读范围」显式暴露：把还没解析成功的课件点名，避免调用方
      // 以为"列表拿到了"就等于"内容都读得到"。
      const unreadable = materials.filter(
        (m) => m.parseStatus === "failed" || m.parseStatus === "pending"
      );
      const materialWarnings = unreadable.length
        ? [
            `有 ${unreadable.length} 份课件尚未解析成功，不在本次可读范围内：` +
              unreadable.slice(0, 3).map((m) => m.title).join("、") +
              (unreadable.length > 3 ? " 等" : "")
          ]
        : [];

      return sendJson(res, 200, {
        ok: true,
        materials,
        warnings: materialWarnings
      });
    }

    // ==========================================
    // 2.1 获取课件多模态结构化上下文快照 (Material Context)
    // ==========================================
    const contextMatch = pathname.match(/^\/api\/learnbuddy\/materials\/([^/]+)\/context$/);
    if (req.method === "GET" && contextMatch) {
      const materialId = decodeURIComponent(contextMatch[1]);
      // 身份绑定：上下文按登录身份构建，不再从查询参数取 userId
      const userId = req.actor.id;
      const context = materialContextService.buildMaterialContext(materialId, { userId, store });
      if (!context) {
        return sendJson(res, 404, {
          ok: false,
          error: "未找到指定课件或当前用户无权访问"
        });
      }
      // 溯源契约：上下文里的段落与图表要能指回原文。
      // 文档版本取原件的内容哈希（内容寻址 ⇒ 原件不可变，旧引用不会指错）
      const contextMaterial = store.getMaterialById(materialId, userId);
      const documentVersionId = deriveDocumentVersionId(contextMaterial);
      const evidenceRefs = evidenceRefsFromMaterialContext(context, documentVersionId);
      // 缺版本时**不猜**：留空并说明原因，而不是编一个版本号让引用看起来成立
      const traceWarnings = documentVersionId
        ? []
        : [
            "该课件没有可追溯的原件版本（缺少内容哈希），本次不产出证据引用 —— " +
              "溯源要求指向确定版本，没有版本时留空而不猜测。"
          ];
      return sendJson(res, 200, {
        ok: true,
        context,
        evidenceRefs,
        warnings: traceWarnings
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
        //    task-14：解析失败时 parseAndExtract 返回 status:"failed" + errorCode，
        //    这里**如实透出**（原件已落盘可预览，但 material 标为 pending 且不伪造知识点）。
        const parsed = await materialParser.parseAndExtract(savedFile.filePath, fileName);
        const parseFailed = parsed.status === "failed";

        // 3. 写入 DatabaseStore 持久化存储（含解析错误，刷新/重进列表后仍可排查）
        const materialId = `mat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const materialData = {
          id: materialId,
          courseId,
          ownerId,
          title: fileName,
          kind: (savedFile.ext.replace(".", "") || "PDF").toUpperCase(),
          visibility,
          // materials.status 只允许 ready/pending；解析失败记 pending，绝不伪装 ready
          status: parseFailed ? "pending" : "ready",
          size: savedFile.sizeFormatted,
          pages: parsed.pages || 1,
          date: new Date().toISOString().slice(0, 10),
          blobId: savedFile.fileId,
          knowledge: parsed.knowledgePoints || [],
          cards: [],
          // task-15：错误必须落库（成功时写 null，不残留任何陈旧错误）
          parseErrorCode: parsed.errorCode || null,
          parseError: parsed.error || null
        };

        const createdMaterial = store.createMaterial(materialData);

        return sendJson(res, 200, {
          ok: true,
          material: createdMaterial,
          parseStatus: parsed.status,
          parseError: parsed.error || null,
          parseErrorCode: parsed.errorCode || null,
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

      // 契约层要求：降级与「未读范围」必须显式暴露，不能让人以为拿到的是全量
      const sessionWarnings = [];
      if (sessionContext.truncated) {
        sessionWarnings.push("课件上下文因长度上限被截断，本次未包含全文。");
      }
      if (Number(sessionContext.cardsCount) === 0) {
        sessionWarnings.push("本课件暂无已发布的教师答疑卡，回答将主要依据课件原文。");
      }
      return sendJson(res, 200, { ...sessionContext, warnings: sessionWarnings });
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

      // 1. 使用 MaterialContextService 进行高精度答疑卡检索
      const matchedCards = materialContextService.searchAnswerCards(courseId, question, {
        threshold: 25,
        limit: 3,
        userId,
        store
      });

      // 若有得分高于 40 的强命中答疑卡，直接以教师权威答疑卡返回
      const hitCard = matchedCards.length > 0 && matchedCards[0].score >= 40 ? matchedCards[0] : null;

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
        const resp = await qaLlmClient.chatCompletion([
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

        // task-13 防护：推理模型（deepseek-flash / deepseek-v4-pro）在 max_tokens 被思维链吃光时
        // 会返回 200 + 空 content 而不报错；llm.js 已给出 ok:false + truncated + error 的诊断，
        // 这里绝不能把空串当成有效答案回给前端（否则学生会看到一条空白回答）。
        const answer = typeof resp.content === "string" ? resp.content.trim() : "";
        if (resp.ok === false || resp.mock === true || answer.length === 0) {
          if (resp.truncated || resp.error) {
            console.warn(`[LearnBuddy QA] 模型返回空 content，使用兜底答案。诊断: ${resp.error || "未知"}`);
          }
          return sendJson(res, 200, {
            ok: true,
            source: "agent_llm",
            answer: buildQaFallbackAnswer(question, matContext),
            contextInjected: Boolean(matContext || matchedCards.length > 0),
            fallback: true,
            truncated: Boolean(resp.truncated),
            // 契约层要求：降级必须**显式暴露**，不能只藏在文案里
            warnings: [
              resp.truncated
                ? "模型输出被截断，本次回答已降级为基于课件骨架的兜底内容，请以教师复核为准。"
                : "模型未返回有效内容，本次回答已降级为基于课件骨架的兜底内容，请以教师复核为准。"
            ]
          });
        }

        const contextInjected = Boolean(matContext || matchedCards.length > 0);
        const warnings = [];
        if (!contextInjected) {
          //「未读范围」要显式暴露：没有课件上下文，回答就不含这门课的具体内容
          warnings.push(
            "本次回答未注入课件上下文（未指定 materialId，或该课件对当前身份不可读），回答可能不含本课具体内容。"
          );
        }

        return sendJson(res, 200, {
          ok: true,
          source: "agent_llm",
          answer,
          contextInjected,
          warnings
        });
      } catch {
        // 模型请求失败兜底提示（严格遵循图表与答疑规范）
        return sendJson(res, 200, {
          ok: true,
          source: "agent_llm",
          answer: buildQaFallbackAnswer(question, matContext),
          fallback: true,
          warnings: [
            "模型服务暂不可用，本次回答已降级为兜底内容；这不是基于本次提问的模型回答，请稍后重试。"
          ]
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
        const { submissionId, grades, summary, strictRange, annotations } = body;
        // 身份绑定：复核人取自登录令牌，不再接受 body 里的 teacherId/reviewerId
        const teacherId = req.actor.id;

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
          strictRange: strictRange === true,
          annotations: Array.isArray(annotations) ? annotations : undefined
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
    // 7.8 提交报告批注 (Annotations CRUD)
    //     GET  /api/learnbuddy/submissions/:id/annotations
    //     POST /api/learnbuddy/submissions/:id/annotations
    // ==========================================
    // 身份绑定 + D2 补齐（2026-09-21 合并 main 时修）：
    // 原先两个方法都调 `store.getSubmission(id)`（**不传 userId**），
    // 而 store 在不传身份时不做任何权限判断 ⇒ 任何登录用户都能读写任意提交的批注。
    // 另外批注的 comment 属于 D2 的「详细评语与依据」，教师确认前不得给学生看。
    const submissionAnnoMatch = pathname.match(/^\/api\/learnbuddy\/submissions\/([^/]+)\/annotations$/);
    if (submissionAnnoMatch) {
      const submissionId = decodeURIComponent(submissionAnnoMatch[1]);

      const annoAuth = requireActor(req);
      if (!annoAuth.ok) {
        return sendJson(res, annoAuth.status, { ok: false, error: annoAuth.error });
      }

      // 权限探针：带身份读取，store 会校验归属与课程关系，无权时返回 null。
      // 无权与不存在**都返回 404**，避免用状态码差异探测某份提交是否存在。
      const annoAllowed = store.getSubmission(submissionId, annoAuth.user.id);
      if (!annoAllowed) {
        return sendJson(res, 404, { ok: false, error: "提交记录不存在" });
      }

      if (req.method === "GET") {
        // D2 用的是**投影契约里同一个可见性判据**（isGradeVisible），
        // 批注与 grades/summary 走同一条规则，不再各写一套。
        const rawSubmission = store.getSubmission(submissionId);
        const annotations = isGradeVisible(rawSubmission, annoAuth.user)
          ? (rawSubmission.annotations || [])
          : [];
        return sendJson(res, 200, {
          ok: true,
          submissionId,
          annotations
        });
      }

      if (req.method === "POST") {
        // 只有教师可以批注报告
        if (annoAuth.user.role !== "teacher") {
          return sendJson(res, 403, {
            ok: false,
            error: "权限不足：只有教师可以批注报告"
          });
        }

        const body = await parseJsonBody(req);
        const rawSubmission = store.getSubmission(submissionId);
        if (!rawSubmission) {
          return sendJson(res, 404, { ok: false, error: "提交记录不存在" });
        }
        const existingList = Array.isArray(rawSubmission.annotations)
          ? [...rawSubmission.annotations]
          : [];
        const newAnnotation = {
          id: body.id || `anno-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          page: typeof body.page === "number" ? body.page : 1,
          quote: body.quote || "",
          comment: body.comment || "",
          color: body.color || "yellow",
          createdAt: new Date().toISOString()
        };
        existingList.push(newAnnotation);
        store.updateSubmission(submissionId, { annotations: existingList });
        return sendJson(res, 200, {
          ok: true,
          submissionId,
          annotation: newAnnotation
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

    // ==========================================
    // 9. 课程 / 作业 / 提交域（task-17：补齐 5 个 P0 端点）
    //
    // 背景：store 早已实现 getUserCourses / getAssignments / getSubmissions /
    // getSubmission / createSubmission，但**没有任何 HTTP 端点调用它们**，
    // 导致 (1) 前端拿不到课程/作业/提交列表，评阅主线无法从 UI 走通；
    // (2) 尤为严重：store.getSubmissions() 正是「非 published 报告的
    // grades/summary 对学生置空」这条安全红线的实现处，无端点可达 = 红线形同虚设。
    //
    // 安全约定（本域 5 个端点一致）：
    //   - `userId` **必填**，缺失 400；用户不存在 404；
    //   - 无课程/记录访问权 403；资源不存在 404；
    //   - 全部数据经 store 权限层产出，端点自身不做任何字段拼装绕过。
    // ==========================================

    // 9.1 课程列表：学生 = 已选课程，教师 = 所授课程
    if (req.method === "GET" && pathname === "/api/learnbuddy/courses") {
      const auth = requireActor(req);
      if (!auth.ok) {
        return sendJson(res, auth.status, { ok: false, error: auth.error });
      }

      const courses = store.getUserCourses(auth.user.id);
      return sendJson(res, 200, {
        ok: true,
        userId: auth.user.id,
        role: auth.user.role,
        count: courses.length,
        courses
      });
    }

    // 9.2 作业列表：学生仅见已发布作业；教师见本课程全部作业
    //     courseId 可选；传入时先做「课程存在 + 有访问权」判定，
    //     避免跨课程查询静默返回空数组（前端无法区分「无权限」与「确实没作业」）。
    if (req.method === "GET" && pathname === "/api/learnbuddy/assignments") {
      const auth = requireActor(req);
      if (!auth.ok) {
        return sendJson(res, auth.status, { ok: false, error: auth.error });
      }

      const courseId = url.searchParams.get("courseId");
      if (courseId) {
        if (!store.getCourse(courseId)) {
          return sendJson(res, 404, { ok: false, error: `课程不存在: ${courseId}` });
        }
        if (!store.hasCourse(auth.user.id, courseId)) {
          return sendJson(res, 403, {
            ok: false,
            error: `权限不足：用户「${auth.user.id}」无权访问课程「${courseId}」的作业`
          });
        }
      }

      const assignments = store.getAssignments(auth.user.id, courseId);
      return sendJson(res, 200, {
        ok: true,
        userId: auth.user.id,
        courseId: courseId || null,
        count: assignments.length,
        assignments
      });
    }

    // 9.3 提交列表（核心）
    //     必须经由 store.getSubmissions(userId, assignmentId)：
    //     教师看全班完整评分；学生只看自己的，且**非 published 报告**的
    //     grades / summary / failure 被强制置空。
    //     这是「未发布成绩不泄漏给学生」这条安全红线在 HTTP 层的唯一生效点。
    if (req.method === "GET" && pathname === "/api/learnbuddy/submissions") {
      const auth = requireActor(req);
      if (!auth.ok) {
        return sendJson(res, auth.status, { ok: false, error: auth.error });
      }

      const assignmentId = url.searchParams.get("assignmentId");
      if (!assignmentId) {
        return sendJson(res, 400, { ok: false, error: "缺少必要参数: assignmentId" });
      }

      const assignment = store.getAssignment(assignmentId);
      if (!assignment) {
        return sendJson(res, 404, { ok: false, error: `作业不存在: ${assignmentId}` });
      }
      if (!store.hasCourse(auth.user.id, assignment.courseId)) {
        return sendJson(res, 403, {
          ok: false,
          error: `权限不足：用户「${auth.user.id}」无权访问课程「${assignment.courseId}」的提交记录`
        });
      }

      // 溯源契约：建议分要能指回报告原文（版本取这份提交的内容哈希）
      const submissions = withSubmissionsEvidenceRefs(
        store.getSubmissions(auth.user.id, assignmentId)
      );
      return sendJson(res, 200, {
        ok: true,
        userId: auth.user.id,
        role: auth.user.role,
        assignmentId,
        courseId: assignment.courseId,
        count: submissions.length,
        submissions,
        evidenceRefs: collectFromSubmissions(submissions)
      });
    }

    // 9.4 单份提交详情
    //     越权与不存在的语义区分（与 review-publish 的 403 风格一致）：
    //     记录确实不存在 → 404；存在但无权访问 → 403。
    const submissionDetailMatch = pathname.match(/^\/api\/learnbuddy\/submissions\/([^/]+)$/);
    if (req.method === "GET" && submissionDetailMatch) {
      const auth = requireActor(req);
      if (!auth.ok) {
        return sendJson(res, auth.status, { ok: false, error: auth.error });
      }

      const submissionId = decodeURIComponent(submissionDetailMatch[1]);
      const exists = store.getSubmission(submissionId);
      if (!exists) {
        return sendJson(res, 404, { ok: false, error: `提交记录不存在: ${submissionId}` });
      }

      // 走权限层：学生看他人记录 / 跨课程 → null；自己的非 published → 字段置空
      const submission = store.getSubmission(submissionId, auth.user.id);
      if (!submission) {
        return sendJson(res, 403, {
          ok: false,
          error: `权限不足：用户「${auth.user.id}」无权访问提交记录「${submissionId}」`
        });
      }

      // 溯源契约：建议分要能指回报告原文
      const enrichedSubmission = withSubmissionEvidenceRefs(submission);
      return sendJson(res, 200, {
        ok: true,
        submission: enrichedSubmission,
        evidenceRefs: collectFromSubmissions([enrichedSubmission])
      });
    }

    // 9.5 创建提交（学生交报告）
    //     请求体支持两种形态（复用既有 storage / multipart 机制）：
    //       a) JSON: { assignmentId, studentId, fileName, content(base64 或 data URL), encoding? }
    //       b) multipart/form-data: 字段 assignmentId / studentId + 文件字段（如 file）
    //     为什么用 base64 JSON 作为主契约：前端只需 `File → ArrayBuffer → base64`，
    //     与既有 `POST /materials/upload` 的 JSON 分支完全一致，无需额外 multipart 编码库。
    //     报告文件一律经 StorageService 落盘，**数据库只存 blobId（SHA-256 文件名）**，
    //     绝不把大 base64 写进 submissions 表。
    if (req.method === "POST" && pathname === "/api/learnbuddy/submissions") {
      const contentType = req.headers["content-type"] || "";
      let body = {};
      let fileBuffer = null;
      let fileName = "";

      if (contentType.includes("multipart/form-data")) {
        const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
        if (!boundaryMatch) {
          return sendJson(res, 400, { ok: false, error: "未找到有效的 multipart boundary" });
        }
        const rawBuffer = await readRawBody(req);
        const parsedForm = parseMultipartFormData(rawBuffer, boundaryMatch[1] || boundaryMatch[2]);
        body = parsedForm.fields || {};
        if (!parsedForm.file) {
          return sendJson(res, 400, { ok: false, error: "未包含上传文件字段" });
        }
        fileBuffer = parsedForm.file.buffer;
        fileName = parsedForm.file.fileName || body.fileName || "";
      } else {
        body = await parseJsonBody(req);
        fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
        const rawContent = body.content ?? body.fileData ?? body.buffer;
        if (typeof rawContent === "string" && rawContent.length > 0) {
          const isBase64 = body.encoding === "base64" || rawContent.startsWith("data:");
          const payload = isBase64 && rawContent.includes(",") ? rawContent.split(",")[1] : rawContent;
          fileBuffer = Buffer.from(payload, isBase64 ? "base64" : "utf-8");
        }
      }

      // 身份绑定：提交人取自登录令牌，不再接受 body 里的 studentId/userId
      const auth = requireActor(req);
      if (!auth.ok) {
        return sendJson(res, auth.status, {
          ok: false,
          error: auth.error
        });
      }

      const assignmentId = typeof body.assignmentId === "string" ? body.assignmentId.trim() : "";
      if (!assignmentId) {
        return sendJson(res, 400, { ok: false, error: "缺少必要参数: assignmentId" });
      }
      if (!fileName) {
        return sendJson(res, 400, { ok: false, error: "缺少必要参数: fileName" });
      }
      if (!fileBuffer || fileBuffer.length === 0) {
        return sendJson(res, 400, {
          ok: false,
          error: "缺少必要参数: content（报告文件内容，base64 或 data URL；multipart 时为文件字段）"
        });
      }

      if (auth.user.role !== "student") {
        return sendJson(res, 403, {
          ok: false,
          error: `权限不足：用户「${auth.user.id}」非学生角色，禁止提交报告`
        });
      }

      const assignment = store.getAssignment(assignmentId);
      if (!assignment) {
        return sendJson(res, 404, { ok: false, error: `作业不存在: ${assignmentId}` });
      }
      if (!store.hasCourse(auth.user.id, assignment.courseId)) {
        return sendJson(res, 403, {
          ok: false,
          error: `权限不足：学生「${auth.user.id}」未选修课程「${assignment.courseId}」，禁止提交报告`
        });
      }
      // 学生只能向已发布作业提交（store.getAssignment(id, userId) 对学生过滤未发布）
      if (!store.getAssignment(assignmentId, auth.user.id)) {
        return sendJson(res, 403, {
          ok: false,
          error: `权限不足：作业「${assignmentId}」尚未发布，学生不可提交报告`
        });
      }

      // 扩展名白名单 / 20MB 上限 / SHA-256 去重均在此校验，失败 → 400
      let savedFile;
      try {
        savedFile = await storage.saveFile(fileBuffer, fileName);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }

      const submissionId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      try {
        store.createSubmission({
          id: submissionId,
          assignmentId,
          studentId: auth.user.id,
          fileName: savedFile.originalName,
          submittedAt: new Date().toISOString(),
          status: "submitted",
          blobId: savedFile.fileId,
          grades: [],
          summary: "",
          history: []
        });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }

      // 回读时同样走权限层（纵深防御）：新建记录 status=submitted，
      // 即使是本人查询，grades/summary 也必须是置空后的契约值。
      const submission = store.getSubmission(submissionId, auth.user.id);
      return sendJson(res, 200, {
        ok: true,
        submission,
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
    }

    if (next) next();
  });
}

export default registerLearnBuddyRoutes;
