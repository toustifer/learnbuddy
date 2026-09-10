/**
 * LearnBuddy 课件多模态结构化打包与答疑卡检索服务
 * (Material Multimodal Context & Answer Card Retrieval Service)
 * 
 * 赛题核心支撑：
 * 1. buildMaterialContext(materialId, options):
 *    - 从 DatabaseStore 读取课件材料与关联课程
 *    - 组装包含标题、课程名、页码章节、每页图文说明（Diagram/Figure）、核心知识点（带 page）的完整上下文快照
 * 2. searchAnswerCards(courseId, query, options):
 *    - 对当前课程已确认（confirmed: true）的答疑卡，进行分词与关键词/模糊匹配
 *    - 计算命中相关度得分（0-100），支持按得分阈值过滤并降序返回最匹配卡片
 * 3. buildQAPromptContext(params):
 *    - 为 Agent 伴学问答生成结构化 Prompt 上下文
 *    - 严格指导 Agent 明确引用“根据第 X 页图表...”与“根据教师推荐答疑：...”
 */

// 内置标杆实验课件的图文细化先验（支持计网、操作系统、数据库）
const SAMPLE_PAGE_TEMPLATES = {
  handshake: [
    {
      page: 1,
      chapter: "第1节：TCP 协议连接概览与报文封装结构",
      content: "TCP（传输控制协议）是面向连接的、可靠的传输层通信协议。TCP 报文段由 20 字节固定头部与数据字段组成。头部包含源端口、目的端口、32 位序列号（Sequence Number）、32 位确认号（Acknowledgment Number）以及 6 个控制标志位（URG, ACK, PSH, RST, SYN, FIN）。",
      diagrams: [
        {
          id: "fig-tcp-1",
          title: "TCP 报文首部格式与关键控制标志位展开",
          caption: "Figure 1-1: TCP Header 结构与 Flags 控制位定义",
          type: "diagram",
          description: "展示 TCP 头部 20 字节固定结构，重点高亮 32 位 Sequence Number、32 位 Acknowledgment Number 与 SYN/ACK/RST 控制位。",
          page: 1
        }
      ]
    },
    {
      page: 2,
      chapter: "第2节：三次握手时序交互与序号同步机制",
      content: "TCP 建立连接必须经历三次握手：第一次握手客户端发送 SYN=1, seq=x（消耗 1 个序列号）；第二次握手服务端回应 SYN=1, ACK=1, seq=y, ack=x+1；第三次握手客户端回应 ACK=1, seq=x+1, ack=y+1。三次握手确保双方具备双向收发能力，并安全同步初始序列号（ISN）。",
      diagrams: [
        {
          id: "fig-tcp-2",
          title: "TCP 三次握手时序交互阶梯图",
          caption: "Figure 2-1: 客户端与服务端三次握手时序流及 seq/ack 演进图",
          type: "diagram",
          description: "时序图呈现 SYN(seq=x) -> SYN+ACK(seq=y, ack=x+1) -> ACK(seq=x+1, ack=y+1) 交互过程，标注连接状态由 LISTEN -> SYN_SENT -> SYN_RCVD -> ESTABLISHED 的迁移。",
          page: 2
        }
      ]
    },
    {
      page: 3,
      chapter: "第3节：Wireshark 实测抓包与连接异常排查（RST）",
      content: "在 Wireshark 抓包实测中，通过显示过滤器（如 tcp.port == 80）捕获并展开 TCP 树形结构。重点观察 Relative Sequence Numbers 相对序号与真实绝对序号的转换。若目标端口未开放监听，服务端内核会响应带有 RST+ACK 标志的报文，直接终止连接，Wireshark 抓包列表以红底黑字醒目呈现。",
      diagrams: [
        {
          id: "fig-tcp-3",
          title: "Wireshark 报文详情树与 RST 异常连接抓包记录",
          caption: "Figure 3-1: Wireshark 抓包明细与端口拒绝 RST 异常包捕获",
          type: "screenshot",
          description: "Wireshark Packet Details 展开截图，高亮 Flags: 0x014 (RST, ACK)，并展示 Connection reset by peer 诊断提示。",
          page: 3
        }
      ]
    }
  ],
  queue: [
    {
      page: 1,
      chapter: "第1节：进程同步互斥与信号量原语",
      content: "在多道程序并发环境下，多个进程共享临界资源必须满足互斥访问条件。信号量（Semaphore）是用于进程同步与互斥的核心原语，包含 P（wait）操作和 V（signal）操作。",
      diagrams: [
        {
          id: "fig-os-1",
          title: "信号量 PV 操作与临界区访问状态机",
          caption: "Figure 1-1: 信号量与临界区访问互斥示意图",
          type: "diagram",
          description: "展示 mutex 信号量对临界资源的保护机制，以及进程进入、等待队列与唤醒时序。",
          page: 1
        }
      ]
    },
    {
      page: 2,
      chapter: "第2节：有界缓冲区生产者-消费者模型实现",
      content: "生产者消费者模型中，使用 empty 信号量表示空缓冲区数量，full 信号量表示满缓冲区数量，mutex 保证对缓冲区的互斥操作。必须遵循先 wait(empty/full) 再 wait(mutex) 的加锁顺序，以防止死锁。",
      diagrams: [
        {
          id: "fig-os-2",
          title: "有界循环缓冲区环形队列与同步屏障",
          caption: "Figure 2-1: 循环缓冲区读写指针与并发时序图",
          type: "diagram",
          description: "展示容量为 N 的循环队列中，生产者 in 指针与消费者 out 指针的前进过程及满/空边界保护。",
          page: 2
        }
      ]
    }
  ],
  index: [
    {
      page: 1,
      chapter: "第1节：B+ 树索引结构与聚簇索引原理",
      content: "B+ 树是关系型数据库（如 InnoDB）最主流的索引组织结构。所有叶子节点位于同一深度，且通过双向链表互相串联，极大优化了范围查询。主键索引为聚簇索引，叶子节点直接存放完整行记录。",
      diagrams: [
        {
          id: "fig-db-1",
          title: "B+ 树三层多路平衡查找树结构",
          caption: "Figure 1-1: InnoDB 聚簇索引与二级索引寻址模型",
          type: "diagram",
          description: "展示根节点、内部节点路由指针与叶子节点数据页链表，说明二次回表查询机制。",
          page: 1
        }
      ]
    },
    {
      page: 2,
      chapter: "第2节：EXPLAIN 执行计划与查询优化分析",
      content: "通过 EXPLAIN 关键字分析 SQL 执行计划，关注 select_type、type（system > const > eq_ref > ref > range > index > ALL）、possible_keys、key 以及 rows 等核心指标。通过覆盖索引（Covering Index）避免回表，显著降低 I/O 成本。",
      diagrams: [
        {
          id: "fig-db-2",
          title: "EXPLAIN 结果字段解读与全表扫描/索引扫描成本对比",
          caption: "Figure 2-1: SQL 执行计划指标拆解图",
          type: "chart",
          description: "对比使用索引前后扫描行数（rows）与访问类型（type）的性能差异，标注索引失效的常见场景。",
          page: 2
        }
      ]
    }
  ]
};

/**
 * 文本分词与子串抽取工具（中英文混合分词）
 * @param {string} text 
 * @returns {string[]}
 */
export function tokenizeText(text = "") {
  if (!text || typeof text !== "string") return [];
  const normalized = text.toLowerCase();
  
  const tokens = new Set();
  
  // 1. 提取英文/数字词
  const alphanumericWords = normalized.match(/[a-z0-9_+-]+/g) || [];
  for (const w of alphanumericWords) {
    if (w.length >= 2) tokens.add(w);
  }

  // 2. 提取连续中文词组并生成 2~4 字滑动窗口
  const cjkSequences = normalized.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const seq of cjkSequences) {
    if (seq.length <= 4) {
      tokens.add(seq);
    }
    // 2-gram
    for (let i = 0; i < seq.length - 1; i++) {
      tokens.add(seq.slice(i, i + 2));
    }
    // 3-gram
    for (let i = 0; i < seq.length - 2; i++) {
      tokens.add(seq.slice(i, i + 3));
    }
  }

  return Array.from(tokens);
}

/**
 * 答疑卡关键字解析
 * @param {string | string[]} keywords 
 * @returns {string[]}
 */
export function parseKeywords(keywords) {
  if (!keywords) return [];
  if (Array.isArray(keywords)) {
    return keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean);
  }
  if (typeof keywords === "string") {
    return keywords
      .split(/[,，;\s]+/)
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

export class MaterialContextService {
  /**
   * @param {import('../db/store.js').DatabaseStore} store
   */
  constructor(store = null) {
    this.store = store;
  }

  /**
   * 设置或更新底层 DatabaseStore 实例
   * @param {import('../db/store.js').DatabaseStore} store 
   */
  setStore(store) {
    this.store = store;
  }

  /**
   * 构建课件材料的多模态结构化上下文快照
   * 
   * @param {string} materialId 课件 ID
   * @param {object} [options] 配置选项
   * @param {string} [options.userId] 请求发起者（用于严格权限隔离校验）
   * @param {import('../db/store.js').DatabaseStore} [options.store] 覆盖默认 store
   * @returns {object | null} 课件结构化快照，不存在或无权查看时返回 null
   */
  buildMaterialContext(materialId, options = {}) {
    const store = options.store || this.store;
    if (!store || !materialId) return null;

    const userId = options.userId || null;
    const material = store.getMaterialById(materialId, userId);
    if (!material) return null;

    const course = store.getCourse ? store.getCourse(material.courseId) : null;
    const courseName = course?.title || material.courseId;
    const courseCode = course?.code || "";

    // 格式化知识点列表并确保包含页码
    const rawKnowledge = Array.isArray(material.knowledge) ? material.knowledge : [];
    const knowledgePoints = rawKnowledge.map((kp, idx) => ({
      id: kp.id || `kp-${material.id}-${idx + 1}`,
      name: kp.name || kp.title || `考点 ${idx + 1}`,
      title: kp.title || kp.name || `考点 ${idx + 1}`,
      summary: kp.summary || "",
      page: Number(kp.page) || 1,
      difficulty: kp.difficulty || "核心"
    }));

    // 组装每页图文说明（Diagram / Figure / Chapter）
    const pageCount = Math.max(1, Number(material.pages) || 1);
    let sections = [];

    // 1. 若命中内置标杆 sampleKey，加载高质量预置图文
    if (material.sampleKey && SAMPLE_PAGE_TEMPLATES[material.sampleKey]) {
      sections = JSON.parse(JSON.stringify(SAMPLE_PAGE_TEMPLATES[material.sampleKey]));
    } else {
      // 2. 通用兜底：根据页码和已抽取知识点动态合成结构化图文段落
      for (let p = 1; p <= pageCount; p++) {
        const pageKps = knowledgePoints.filter((kp) => kp.page === p);
        const chapterTitle = pageKps.length > 0
          ? `第${p}节：${pageKps[0].name}`
          : `第${p}节：${material.title} 核心讲解`;
        
        const contentText = pageKps.length > 0
          ? pageKps.map((k) => k.summary).join("；")
          : `${material.title} 第 ${p} 页重点阐述与实验操作内容。`;

        const diagrams = [
          {
            id: `fig-${material.id}-p${p}`,
            title: pageKps.length > 0 ? `${pageKps[0].name} 示意图` : `${material.title} 第 ${p} 页原理解构图`,
            caption: `Figure ${p}-1: 第 ${p} 页实验要点与图文说明`,
            type: "diagram",
            description: pageKps.length > 0
              ? `展示第 ${p} 页核心考点「${pageKps[0].name}」的原理架构与关键交互。`
              : `展示第 ${p} 页涉及的技术拓扑与配置参数。`,
            page: p
          }
        ];

        sections.push({
          page: p,
          chapter: chapterTitle,
          content: contentText,
          diagrams
        });
      }
    }

    // 汇总材料内部所有图表清单
    const allDiagrams = [];
    for (const sec of sections) {
      if (Array.isArray(sec.diagrams)) {
        allDiagrams.push(...sec.diagrams);
      }
    }

    // 过滤材料附带的已确认答疑卡
    const allCards = Array.isArray(material.cards) ? material.cards : [];
    const confirmedCards = allCards
      .filter((card) => Boolean(card.confirmed))
      .map((card) => ({
        id: card.id,
        question: card.question || card.title || "",
        title: card.question || card.title || "",
        keywords: card.keywords || "",
        answer: card.answer || "",
        confirmed: true,
        materialId: material.id,
        materialTitle: material.title,
        courseId: material.courseId
      }));

    return {
      materialId: material.id,
      id: material.id,
      title: material.title,
      courseId: material.courseId,
      courseName,
      courseCode,
      kind: material.kind,
      size: material.size,
      pages: pageCount,
      visibility: material.visibility,
      status: material.status,
      date: material.date,
      blobId: material.blobId,
      sampleKey: material.sampleKey,
      sections,
      pageContents: sections, // 兼容别名
      diagrams: allDiagrams,
      figures: allDiagrams, // 兼容别名
      knowledgePoints,
      cardsCount: allCards.length,
      confirmedCardsCount: confirmedCards.length,
      confirmedCards
    };
  }

  /**
   * 检索当前课程已确认（confirmed: true）的答疑卡
   * 
   * @param {string | null} courseId 课程 ID（若为 null 则在所有可用材料中检索）
   * @param {string} query 检索词 / 学生提问
   * @param {object} [options] 检索配置
   * @param {number} [options.threshold=15] 命中得分阈值（0~100）
   * @param {number} [options.limit=5] 最大返回条数
   * @param {string} [options.userId] 用户 ID（用于权限过滤）
   * @param {import('../db/store.js').DatabaseStore} [options.store] 覆盖 store
   * @returns {Array<object>} 命中卡片列表（包含 score 相关度评分，按降序排列）
   */
  searchAnswerCards(courseId, query, options = {}) {
    const store = options.store || this.store;
    if (!store) return [];

    const rawQ = (query || "").trim();
    if (!rawQ) return [];

    const threshold = typeof options.threshold === "number" ? options.threshold : 15;
    const limit = typeof options.limit === "number" ? options.limit : 5;
    const userId = options.userId || null;

    // 1. 获取目标课件列表
    let materials = [];
    if (userId) {
      materials = store.getMaterials(userId, courseId);
    } else if (courseId) {
      const all = store.listMaterials ? store.listMaterials() : [];
      materials = all.filter((m) => m.courseId === courseId);
    } else {
      materials = store.listMaterials ? store.listMaterials() : [];
    }

    // 2. 收集所有已确认（confirmed: true）答疑卡
    const candidateCards = [];
    for (const mat of materials) {
      const cards = Array.isArray(mat.cards) ? mat.cards : [];
      for (const card of cards) {
        // 严格过滤：仅检索已确认卡片
        if (!card.confirmed) continue;

        candidateCards.push({
          id: card.id,
          question: card.question || card.title || "",
          title: card.question || card.title || "",
          keywords: card.keywords || card.triggerKeywords || "",
          answer: card.answer || "",
          confirmed: true,
          materialId: mat.id,
          materialTitle: mat.title,
          courseId: mat.courseId
        });
      }
    }

    // 3. 多维度相关度评分计算
    const lowerQ = rawQ.toLowerCase();
    const queryTokens = tokenizeText(rawQ);

    const scoredCards = candidateCards.map((card) => {
      let score = 0;
      const cardKeywords = parseKeywords(card.keywords);
      const cardQ = (card.question || "").toLowerCase();
      const cardA = (card.answer || "").toLowerCase();

      // A. 关键词精准命中（最高权重）
      let matchedKeywordCount = 0;
      for (const kw of cardKeywords) {
        if (!kw) continue;
        if (lowerQ.includes(kw)) {
          score += 40;
          matchedKeywordCount++;
        } else if (queryTokens.includes(kw)) {
          score += 30;
          matchedKeywordCount++;
        } else if (kw.includes(lowerQ) && lowerQ.length >= 2) {
          score += 25;
          matchedKeywordCount++;
        }
      }

      // B. 问题标题匹配度
      if (cardQ && (cardQ === lowerQ)) {
        score += 60;
      } else if (cardQ && (lowerQ.includes(cardQ) || cardQ.includes(lowerQ))) {
        score += 35;
      } else if (cardQ) {
        let titleOverlap = 0;
        for (const token of queryTokens) {
          if (token.length >= 2 && cardQ.includes(token)) {
            titleOverlap += Math.min(token.length * 4, 15);
          }
        }
        score += Math.min(titleOverlap, 30);
      }

      // C. 答案正文词汇命中
      if (cardA) {
        let answerOverlap = 0;
        for (const token of queryTokens) {
          if (token.length >= 2 && cardA.includes(token)) {
            answerOverlap += Math.min(token.length * 2, 8);
          }
        }
        score += Math.min(answerOverlap, 20);
      }

      // 归一化得分至 0 ~ 100
      const finalScore = Math.min(100, Math.round(score));

      return {
        ...card,
        score: finalScore,
        matchedKeywordCount
      };
    });

    // 4. 阈值过滤与排序
    return scoredCards
      .filter((item) => item.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * 为问答生成结构化 Prompt 注入上下文
   * 严格规范：让 Agent 回答时能够明确引用“根据第 X 页图表...”与“根据教师推荐答疑：...”
   * 
   * @param {object} params
   * @param {object} [params.materialContext] 课件结构化上下文快照
   * @param {Array<object>} [params.matchedCards] 检索到的高相关教师答疑卡
   * @param {string} [params.query] 当前学生提问
   * @returns {string} 格式化后的 Prompt 注入内容
   */
  buildQAPromptContext(params = {}) {
    let materialContext = params.materialContext || null;
    let matchedCards = params.matchedCards || [];
    let query = params.query || "";

    // 兼容位置传参 buildQAPromptContext(matContext, matchedCards, query)
    if (arguments.length > 1 || (params && !params.materialContext && params.materialId)) {
      materialContext = arguments[0];
      matchedCards = Array.isArray(arguments[1]) ? arguments[1] : [];
      query = typeof arguments[2] === "string" ? arguments[2] : (arguments[2]?.query || "");
    }

    const lines = [];

    lines.push("【课件多模态结构化参考资料】");
    if (materialContext) {
      lines.push(`课程名称: ${materialContext.courseName || materialContext.courseId} (${materialContext.courseCode || "无编号"})`);
      lines.push(`课件材料: ${materialContext.title}（共 ${materialContext.pages || 1} 页）`);
      lines.push("");

      // 页码图文段落与图表说明
      const sections = materialContext.sections || materialContext.pageContents || [];
      if (sections.length > 0) {
        lines.push("【逐页章节正文与图文证据 (含图表说明)】");
        for (const sec of sections) {
          lines.push(`- 第 ${sec.page} 页 [${sec.chapter}]:`);
          if (sec.content) {
            lines.push(`  正文阐述: ${sec.content}`);
          }
          if (Array.isArray(sec.diagrams) && sec.diagrams.length > 0) {
            lines.push(`  关联图表/截图:`);
            for (const diag of sec.diagrams) {
              lines.push(`    * [第 ${sec.page} 页图表] ${diag.caption || diag.title}: ${diag.description}`);
            }
          }
        }
        lines.push("");
      }

      // 核心考点溯源
      if (Array.isArray(materialContext.knowledgePoints) && materialContext.knowledgePoints.length > 0) {
        lines.push("【核心考点与知识点溯源】");
        for (const kp of materialContext.knowledgePoints) {
          lines.push(`- [第 ${kp.page} 页] ${kp.title || kp.name}: ${kp.summary} (难度: ${kp.difficulty || "核心"})`);
        }
        lines.push("");
      }
    } else {
      lines.push("未指定特定课件上下文，请基于全局课程背景知识解答。");
      lines.push("");
    }

    // 教师推荐答疑卡
    if (Array.isArray(matchedCards) && matchedCards.length > 0) {
      lines.push("【教师推荐答疑卡（高可信度权威先验）】");
      for (const card of matchedCards) {
        lines.push(`- [教师推荐答疑] 问题: ${card.question || card.title}`);
        lines.push(`  权威解答: ${card.answer}`);
        if (card.materialTitle) {
          lines.push(`  (来源课件: ${card.materialTitle}，匹配度得分: ${card.score || "已确认"})`);
        }
      }
      lines.push("");
    }

    // 严格引用与回答纪律
    lines.push("【回答规范与证据引用纪律】");
    lines.push("1. 忠实于材料：回答内容必须完全立足于上述课件正文与实验依据，不得无中生有。");
    lines.push("2. 明确引用图表：在解释时序图、报文首部、网络拓扑或实验抓包截图时，必须在回答中明确使用句式：“根据第 X 页图表 [图表标题]...”，让学生有据可查。");
    lines.push("3. 明确引用教师答疑：若命中了上述教师推荐答疑卡，必须在回答中明确标注：“根据教师推荐答疑：...”，并优先采纳其中的标准解释。");
    lines.push("4. 启发式教学：遇到学生抓包异常（如红色 RST、超时未确认等），引导学生对照过滤语法与标志位展开排查，培养工程排错思维。");

    if (query) {
      lines.push("");
      lines.push(`【当前学生提问】: ${query}`);
    }

    return lines.join("\n");
  }
}

// 导出便捷单例/函数形式
export function buildMaterialContext(materialId, options = {}) {
  const service = new MaterialContextService(options.store || null);
  return service.buildMaterialContext(materialId, options);
}

export function searchAnswerCards(courseId, query, options = {}) {
  const service = new MaterialContextService(options.store || null);
  return service.searchAnswerCards(courseId, query, options);
}

export function buildQAPromptContext(params, ...args) {
  const service = new MaterialContextService();
  return service.buildQAPromptContext(params, ...args);
}
