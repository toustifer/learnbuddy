/**
 * LearnBuddy DSH 学习助手多模态上下文注入与桥接服务
 * (DSH Context Bridge Service)
 * 
 * 核心职责：
 * 1. buildDshSessionPrompt(materialId, options):
 *    - 调度 MaterialContextService.buildMaterialContext 组装课件背景、逐页图文与图表清单、核心考点与教师答疑卡
 *    - 生成面向 DSH 会话挂载的完整 System Prompt 指令块
 * 2. formatQuoteEvidence(quoteItem):
 *    - 规范化用户在前端点击“引用图表/段落”时生成的标准证据注入文本
 *    - 输出格式如：
 *      > [引用第 2 页图表: Figure 2-1: 客户端与服务端三次握手时序流及 seq/ack 演进图]
 *      > 图表说明: ...
 * 3. truncateContext(text, maxLength, options):
 *    - 安全字符/Token 长度裁剪机制，防止上下文过长导致 LLM 模型拒答
 *    - 默认限制 12000 字符，保留头部背景与尾部交互纪律
 * 4. validateBridgeMessage & createBridgeResponse:
 *    - 严格兼容 web/src/dsh.ts 桥接协议的握手校验与响应构造 (learnbuddy:init, learnbuddy:context 等)
 */

import { MaterialContextService } from "./material-context.js";

export const DEFAULT_MAX_CONTEXT_LENGTH = 12000;

/**
 * 规范化用户在前端点击“引用图表/段落”时生成的证据注入文本
 * 
 * @param {object | string} quoteItem 引用条目数据
 * @returns {string} 标准化 Markdown 引用文本
 */
export function formatQuoteEvidence(quoteItem = {}) {
  if (!quoteItem) return "";

  // 字符串参数直接包装为引用块
  if (typeof quoteItem === "string") {
    const trimmed = quoteItem.trim();
    if (!trimmed) return "";
    return trimmed
      .split("\n")
      .map((line) => (line.startsWith(">") ? line : `> ${line}`))
      .join("\n");
  }

  const page = quoteItem.page || 1;
  const isParagraph = quoteItem.type === "paragraph" || quoteItem.type === "selection";
  const customNote = (quoteItem.customNote || quoteItem.note || quoteItem.question || "").trim();

  const lines = [];

  if (isParagraph) {
    const chapter = quoteItem.chapter || quoteItem.title || quoteItem.heading || `第 ${page} 节正文`;
    const content = (quoteItem.content || quoteItem.text || quoteItem.description || quoteItem.detail || "").trim();
    lines.push(`> [引用第 ${page} 页段落: ${chapter}]`);
    if (content) {
      lines.push(`> 引用内容: ${content}`);
    }
  } else {
    // 默认作为图表/Figure 引用
    const figureTitle =
      quoteItem.caption ||
      quoteItem.figureTitle ||
      quoteItem.title ||
      (quoteItem.figureId ? `Figure: ${quoteItem.figureId}` : `第 ${page} 页图表`);
    const description = (quoteItem.description || quoteItem.detail || quoteItem.content || quoteItem.text || "").trim();

    lines.push(`> [引用第 ${page} 页图表: ${figureTitle}]`);
    if (description) {
      lines.push(`> 图表说明: ${description}`);
    }
  }

  if (customNote) {
    lines.push(`> 提问重点: ${customNote}`);
  }

  return lines.join("\n");
}

/**
 * 安全文本裁剪机制：确保生成的上下文不超过模型安全阈值（默认 12000 字符）
 * 
 * @param {string} text 待裁剪文本
 * @param {number} [maxLength=12000] 最大字符上限
 * @param {object} [options] 裁剪选项
 * @param {string} [options.notice] 截断提示说明
 * @returns {string} 裁剪后的安全文本
 */
export function truncateContext(text = "", maxLength = DEFAULT_MAX_CONTEXT_LENGTH, options = {}) {
  if (typeof text !== "string") return "";
  if (text.length <= maxLength) return text;

  const notice =
    options.notice ||
    `\n\n... [课件上下文已触发安全字符裁剪，限制在 ${maxLength} 字符以内，保持核心考点与规则完整] ...\n\n`;

  // 如果提示语本身超长，直接切片
  if (notice.length >= maxLength) {
    return text.slice(0, maxLength);
  }

  const budget = maxLength - notice.length;
  // 保留前部 75% 与后部 25% 结构（保证前部背景与尾部纪律同时保留）
  const headSize = Math.floor(budget * 0.75);
  const tailSize = budget - headSize;

  const head = text.slice(0, headSize);
  const tail = tailSize > 0 ? text.slice(-tailSize) : "";

  return `${head}${notice}${tail}`;
}

/**
 * 校验来自前端或 iframe 的桥接消息结构合法性
 * 严格遵循 web/src/dsh.ts 桥接协议规范
 * 
 * @param {any} message 消息体
 * @returns {{ valid: boolean, error?: string, messageType?: string }}
 */
export function validateBridgeMessage(message) {
  if (!message || typeof message !== "object") {
    return { valid: false, error: "消息必须是非空对象" };
  }

  const { type, requestId, contextKey } = message;

  if (typeof type !== "string" || !type.trim()) {
    return { valid: false, error: "缺少有效的消息类型 (type)" };
  }

  if (typeof requestId !== "string" || !requestId.trim()) {
    return { valid: false, error: "缺少有效的请求标识符 (requestId)" };
  }

  if (typeof contextKey !== "string" || !contextKey.trim()) {
    return { valid: false, error: "缺少有效的会话上下文键 (contextKey)" };
  }

  // 校验具体协议类型的专属字段
  if (type === "learnbuddy:context") {
    if (typeof message.text !== "string" || !message.text.trim()) {
      return { valid: false, error: "learnbuddy:context 必须包含有效 text 字符串" };
    }
  }

  return {
    valid: true,
    messageType: type
  };
}

/**
 * 构造与 web/src/dsh.ts 接收逻辑完全兼容的桥接响应消息
 * 
 * @param {string} type 响应消息类型，如 "learnbuddy:ready", "learnbuddy:received", "learnbuddy:error"
 * @param {object} [data={}] 附加数据体
 * @param {object} [originalMessage=null] 原始请求消息（自动复用 requestId 和 contextKey）
 * @returns {object} 标准格式化响应对象
 */
export function createBridgeResponse(type, data = {}, originalMessage = null) {
  const requestId = originalMessage?.requestId || data?.requestId || "";
  const contextKey = originalMessage?.contextKey || data?.contextKey || "";

  const isError = type === "learnbuddy:error" || type === "error" || Boolean(data?.error);
  const responseType = isError ? "learnbuddy:error" : type;

  if (isError) {
    const errorMsg = data?.message || data?.error || "学习会话桥接异常";
    return {
      type: "learnbuddy:error",
      requestId,
      contextKey,
      message: String(errorMsg),
      timestamp: Date.now()
    };
  }

  return {
    type: responseType,
    requestId,
    contextKey,
    ...data,
    timestamp: Date.now()
  };
}

/**
 * DSH 会话桥接与多模态上下文组装服务类
 */
export class DshContextBridgeService {
  /**
   * @param {object} [options]
   * @param {import('../db/store.js').DatabaseStore} [options.store] 数据库持久化连接
   * @param {MaterialContextService} [options.materialContextService] 课件多模态打包服务
   */
  constructor(options = {}) {
    this.store = options.store || null;
    this.materialContextService = options.materialContextService || new MaterialContextService(this.store);
  }

  /**
   * 注入或更新 DatabaseStore 实例
   * @param {import('../db/store.js').DatabaseStore} store
   */
  setStore(store) {
    this.store = store;
    if (this.materialContextService) {
      this.materialContextService.setStore(store);
    }
  }

  /**
   * 组装 DSH Session 初始挂载的完整 System Prompt 指令块
   * 
   * @param {string} materialId 课件 ID
   * @param {object} [options]
   * @param {string} [options.userId] 请求用户 ID（用于课件访问权限校验）
   * @param {import('../db/store.js').DatabaseStore} [options.store] 覆盖 store 实例
   * @param {number} [options.maxLength=12000] 最大允许字符数
   * @param {string} [options.systemRole] 自定义角色描述
   * @param {boolean} [options.includeCards=true] 是否打包已确认答疑卡
   * @param {boolean} [options.includeDiagrams=true] 是否打包图表清单
   * @param {boolean} [options.includeKnowledge=true] 是否打包核心考点
   * @returns {string | null} 组装好的完整 System Prompt，若课件不存在或无权查看则返回 null
   */
  buildDshSessionPrompt(materialId, options = {}) {
    const store = options.store || this.store;
    const userId = options.userId || null;
    const maxLength = typeof options.maxLength === "number" ? options.maxLength : DEFAULT_MAX_CONTEXT_LENGTH;
    const includeCards = options.includeCards !== false;
    const includeDiagrams = options.includeDiagrams !== false;
    const includeKnowledge = options.includeKnowledge !== false;

    const materialContext = this.materialContextService.buildMaterialContext(materialId, {
      userId,
      store
    });

    if (!materialContext) {
      return null;
    }

    const lines = [];

    // 1. 系统角色定位
    lines.push("【LearnBuddy 课件伴学助手 System Prompt】");
    lines.push(
      options.systemRole ||
        "你是一位高校计算机与软件实验课程的高级智能伴学助教（LearnBuddy Companion Agent）。" +
        "你的职责是依据授课教师提供的课件大纲、图文实验指导书与权威答疑卡，为学生提供准确、严谨、循序渐进的启发式辅导。"
    );
    lines.push("");

    // 2. 课件背景信息
    lines.push("【课件背景信息】");
    lines.push(`- 课程名称: ${materialContext.courseName || materialContext.courseId} (${materialContext.courseCode || "CS-LAB"})`);
    lines.push(`- 课件名称: ${materialContext.title}`);
    lines.push(`- 课件规格: 共 ${materialContext.pages || 1} 页 | 类型: ${materialContext.kind || "PDF"} | 状态: ${materialContext.status || "ready"}`);
    lines.push("");

    // 3. 逐页图文与图表清单 (含多模态图表证据)
    if (includeDiagrams) {
      const sections = materialContext.sections || materialContext.pageContents || [];
      if (sections.length > 0) {
        if (materialContext.synthetic) {
          lines.push("【逐页图文与图表清单 (注意：该课件正文未提取，以下为基于考点合成的辅助提示，非原文)】");
        } else {
          lines.push("【逐页图文与图表清单 (多模态图表先验)】");
        }
        for (const sec of sections) {
          lines.push(`- 第 ${sec.page} 页 [${sec.chapter || `第 ${sec.page} 节`}]:`);
          if (sec.content) {
            if (sec.synthetic || materialContext.synthetic) {
              lines.push(`  摘要提示 (非原文): ${sec.content}`);
            } else {
              lines.push(`  正文阐述: ${sec.content}`);
            }
          }
          if (Array.isArray(sec.diagrams) && sec.diagrams.length > 0) {
            lines.push(`  图表清单:`);
            for (const diag of sec.diagrams) {
              const diagTitle = diag.caption || diag.title || diag.id;
              lines.push(`    * [第 ${sec.page} 页图表: ${diagTitle}] (ID: ${diag.id}, 类型: ${diag.type || "diagram"})`);
              if (diag.description) {
                lines.push(`      图表说明: ${diag.description}`);
              }
            }
          }
        }
        lines.push("");
      }
    }

    // 4. 核心考点与知识点溯源
    if (includeKnowledge && Array.isArray(materialContext.knowledgePoints) && materialContext.knowledgePoints.length > 0) {
      lines.push("【核心考点与知识点溯源】");
      for (const kp of materialContext.knowledgePoints) {
        const pageInfo = kp.page ? `第 ${kp.page} 页` : "全局考点";
        lines.push(`- [${pageInfo}] ${kp.title || kp.name} (难度: ${kp.difficulty || "核心"}): ${kp.summary || "重要考点"}`);
      }
      lines.push("");
    }

    // 5. 教师预制答疑卡 (权威先验库)
    if (includeCards && Array.isArray(materialContext.confirmedCards) && materialContext.confirmedCards.length > 0) {
      lines.push("【教师预制答疑卡 (权威先验库)】");
      for (const card of materialContext.confirmedCards) {
        lines.push(`- [教师预制答疑: ${card.id}] 问题: ${card.question || card.title}`);
        lines.push(`  标准解答: ${card.answer}`);
        if (card.keywords) {
          lines.push(`  匹配关键词: ${card.keywords}`);
        }
      }
      lines.push("");
    }

    // 6. 伴学助教纪律与交互规范
    lines.push("【伴学助教纪律与交互规范】");
    lines.push("1. 证据溯源纪律：当回答涉及协议时序、报文头部格式、拓扑结构或抓包截图时，必须严格使用句式：“根据第 X 页图表 [图表标题]...”，让学生有据可循。");
    lines.push("2. 权威答疑优先：若学生提问与上述【教师预制答疑卡】匹配，必须明确注明“根据教师推荐答疑：...”，并优先遵循教师标准解释。");
    lines.push("3. 紧扣用户图表引用：当学生在输入中带有“> [引用第 X 页图表: ...]”证据块时，必须优先解读该图表对应的标志位、序号演变与状态机迁移。");
    lines.push("4. 苏格拉底式启发教学：遇到学生抓包异常或疑问，引导学生观察抓包过滤器与标志位，鼓励自主推导原因，切勿直接给出作业代码答案。");
    lines.push("5. 严守事实防幻觉：未在课件和图表证据中体现的内容不得凭空揣测，严守实验与技术标准规范。");

    const fullPrompt = lines.join("\n");

    // 7. 安全字符裁剪
    return truncateContext(fullPrompt, maxLength);
  }

  /**
   * 格式化图表引用
   * @param {object | string} quoteItem 
   */
  formatQuoteEvidence(quoteItem) {
    return formatQuoteEvidence(quoteItem);
  }

  /**
   * 校验来自前端或 iframe 的桥接消息
   * @param {any} message 
   */
  validateBridgeMessage(message) {
    return validateBridgeMessage(message);
  }

  /**
   * 构造桥接响应
   * @param {string} type 
   * @param {object} [data] 
   * @param {object} [originalMessage] 
   */
  createBridgeResponse(type, data, originalMessage) {
    return createBridgeResponse(type, data, originalMessage);
  }

  /**
   * 一站式处理传入的 Bridge 消息并返回响应对象
   * @param {object} message 
   * @returns {object}
   */
  handleBridgeMessage(message) {
    const validation = validateBridgeMessage(message);
    if (!validation.valid) {
      return createBridgeResponse("learnbuddy:error", { message: validation.error }, message);
    }

    if (message.type === "learnbuddy:init") {
      return createBridgeResponse("learnbuddy:ready", { status: "ready" }, message);
    }

    if (message.type === "learnbuddy:context") {
      return createBridgeResponse("learnbuddy:received", { receivedLength: (message.text || "").length }, message);
    }

    if (message.type === "learnbuddy:quote") {
      const quoteText = formatQuoteEvidence(message.quoteItem || message);
      return createBridgeResponse("learnbuddy:quoted", { quoteText }, message);
    }

    // 默认通用已确认响应
    return createBridgeResponse("learnbuddy:ack", { messageType: message.type }, message);
  }

  /**
   * 获取课件 DSH 会话初始化元数据快照
   * 
   * @param {string} materialId 
   * @param {object} [options] 
   * @returns {object | null}
   */
  getSessionContext(materialId, options = {}) {
    const store = options.store || this.store;
    const userId = options.userId || null;
    const maxLength = typeof options.maxLength === "number" ? options.maxLength : DEFAULT_MAX_CONTEXT_LENGTH;

    const materialContext = this.materialContextService.buildMaterialContext(materialId, {
      userId,
      store
    });

    if (!materialContext) {
      return null;
    }

    const prompt = this.buildDshSessionPrompt(materialId, {
      userId,
      store,
      maxLength,
      ...options
    });

    return {
      ok: true,
      materialId: materialContext.materialId,
      id: materialContext.materialId,
      title: materialContext.title,
      courseId: materialContext.courseId,
      courseName: materialContext.courseName,
      courseCode: materialContext.courseCode,
      pages: materialContext.pages,
      prompt,
      promptLength: prompt ? prompt.length : 0,
      diagrams: materialContext.diagrams || [],
      figures: materialContext.diagrams || [],
      knowledgePoints: materialContext.knowledgePoints || [],
      cardsCount: materialContext.cardsCount || 0,
      confirmedCardsCount: materialContext.confirmedCardsCount || 0,
      truncated: Boolean(prompt && prompt.length >= maxLength)
    };
  }
}

// 导出便捷单例函数
export function buildDshSessionPrompt(materialId, options = {}) {
  const service = new DshContextBridgeService({
    store: options.store || null,
    materialContextService: options.materialContextService || null
  });
  return service.buildDshSessionPrompt(materialId, options);
}
