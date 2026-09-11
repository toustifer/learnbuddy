import type {
  Assignment,
  Course,
  DemoState,
  DocumentPage,
  Enrollment,
  Material,
  Rubric,
  Submission,
  User,
} from "./types";

export const users: User[] = [
  {
    id: "t-chen",
    username: "teacher.chen",
    name: "陈知行",
    role: "teacher",
    initials: "陈",
  },
  {
    id: "t-lin",
    username: "teacher.lin",
    name: "林悦",
    role: "teacher",
    initials: "林",
  },
  {
    id: "s-yi",
    username: "student.lin",
    name: "林一",
    role: "student",
    initials: "林",
  },
  {
    id: "s-zhou",
    username: "student.zhou",
    name: "周可",
    role: "student",
    initials: "周",
  },
  {
    id: "s-xu",
    username: "student.xu",
    name: "许然",
    role: "student",
    initials: "许",
  },
];
export const courses: Course[] = [
  {
    id: "network",
    teacherId: "t-chen",
    title: "计算机网络",
    code: "CS 203",
    color: "green",
    description: "从一次握手，理解万物互联。",
  },
  {
    id: "os",
    teacherId: "t-chen",
    title: "操作系统",
    code: "CS 301",
    color: "orange",
    description: "探索计算机如何管理每一份资源。",
  },
  {
    id: "database",
    teacherId: "t-lin",
    title: "数据库原理",
    code: "CS 205",
    color: "purple",
    description: "让数据之间的关系，变得清晰。",
  },
  {
    id: "cs101",
    teacherId: "t-chen",
    title: "计算机科学导论",
    code: "CS 101",
    color: "green",
    description: "认识计算机科学的基础概念。",
  },
];
export const enrollments: Enrollment[] = [
  { courseId: "cs101", studentId: "s-yi" },
  { courseId: "network", studentId: "s-yi" },
  { courseId: "os", studentId: "s-yi" },
  { courseId: "network", studentId: "s-zhou" },
  { courseId: "database", studentId: "s-zhou" },
  { courseId: "network", studentId: "s-xu" },
  { courseId: "os", studentId: "s-xu" },
  { courseId: "database", studentId: "s-xu" },
];
export const documents: Record<string, DocumentPage[]> = {
  handshake: [
    {
      eyebrow: "CHAPTER 03 · TRANSPORT LAYER",
      heading: "从一次握手开始，理解可靠传输",
      paragraphs: [
        "在浏览器中打开一个网页，往往只需要一次点击。但在数据真正开始传输之前，客户端与服务器已经完成了一场精确的“对话”。",
        "TCP 三次握手的目的，是让通信双方确认彼此的发送与接收能力，并同步初始序列号。每一步都为后续可靠传输提供必要的信息。",
      ],
      diagram: "handshake",
      caption: "图 3-1 · TCP 连接建立过程（教学示例）",
    },
    {
      eyebrow: "03.1 · SEQUENCE & ACKNOWLEDGMENT",
      heading: "序列号，如何确认一条消息？",
      paragraphs: [
        "序列号 seq 标记当前报文段数据的起始位置。确认号 ack 表示接收方希望收到的下一个序列号，而不是刚刚收到的最后一个字节。",
        "建立连接时，SYN 标志会消耗一个序列号。若客户端初始序列号是 x，服务器确认该 SYN 时就会返回 ack = x + 1。纯 ACK 报文不额外消耗序列号。",
        "阅读抓包结果时，先区分相对序列号与绝对序列号。Wireshark 常默认展示相对序列号，让双方各自从 0 开始，更方便理解交互过程。",
      ],
      code: "客户端 → 服务器  SYN       seq = 0\n服务器 → 客户端  SYN, ACK  seq = 0, ack = 1\n客户端 → 服务器  ACK       seq = 1, ack = 1",
    },
    {
      eyebrow: "03.2 · OBSERVE & EXPLAIN",
      heading: "在 Wireshark 中找到真实证据",
      paragraphs: [
        "启动抓包前，确认正在使用的网络接口。随后发起一次新的 TCP 连接，用显示过滤器缩小观察范围，再逐条展开 Flags、Sequence Number 和 Acknowledgment Number。",
        "实验报告需要同时包含关键截图与文字解释。截图展示“观察到了什么”，文字解释“这些字段为什么这样变化”，二者共同构成实验结论的证据。",
        "若捕获到 RST 报文，不应仅凭颜色判断故障原因。结合端口监听、应用行为和抓包位置分析，并区分连接重置与超时重传。",
      ],
      code: "tcp.flags.syn == 1\n\ntcp.stream eq 0\n\ntcp.flags.reset == 1",
      caption: "常用显示过滤表达式 · 请结合当前网络环境选择",
    },
  ],
  queue: [
    {
      eyebrow: "CHAPTER 05 · SYNCHRONIZATION",
      heading: "让生产与消费，各有节奏",
      paragraphs: [
        "生产者把数据放入缓冲区，消费者从缓冲区中取出数据。当二者并发运行时，我们需要同时解决互斥与同步问题。",
        "互斥保证同一时刻只有一个执行单元修改缓冲区；同步则保证缓冲区已满时生产者等待，缓冲区为空时消费者等待。",
      ],
      diagram: "queue",
      caption: "图 5-1 · 有界缓冲区的生产者与消费者",
    },
    {
      eyebrow: "05.1 · SEMAPHORES",
      heading: "三个信号量的不同职责",
      paragraphs: [
        "mutex 用于保护临界区，初始值为 1；empty 表示空闲槽位数，初始值为缓冲区容量 N；full 表示已占用槽位数，初始值为 0。",
        "获取 empty 或 full 应发生在进入互斥区之前，否则线程可能持有互斥锁等待另一个无法进入临界区的线程，造成死锁。",
      ],
      code: "生产者：wait(empty) → wait(mutex)\n        写入缓冲区\n        signal(mutex) → signal(full)",
    },
  ],
  index: [
    {
      eyebrow: "CHAPTER 06 · DATABASE INDEX",
      heading: "用索引，让查询少走弯路",
      paragraphs: [
        "索引是一种辅助数据结构，它让数据库在部分查询中快速找到目标记录。建立索引会占用空间，也会增加写入时的维护成本。",
        "B+ 树通过多层节点缩小查找范围，并把叶子节点连接起来，兼顾等值查询与范围查询。",
      ],
      diagram: "index",
      caption: "图 6-1 · B+ 树索引的简化结构",
    },
    {
      eyebrow: "06.1 · QUERY PLAN",
      heading: "观察执行计划，而不只比较耗时",
      paragraphs: [
        "用 EXPLAIN 查看查询计划，记录访问方式、所用索引和预计扫描行数。相同查询在不同数据规模下可能采用不同计划。",
        "实验报告应说明数据规模、查询条件与测量环境，并对比建立索引前后的执行计划。一次运行耗时不能单独证明索引一定有效。",
      ],
      code: "EXPLAIN SELECT * FROM orders\nWHERE customer_id = 42\nORDER BY created_at DESC;",
    },
  ],
};
function knowledge(key: string) {
  return documents[key].map((page, i) => ({
    id: key + "-kp-" + i,
    title: page.heading,
    summary: page.paragraphs[1] || page.paragraphs[0],
    page: i + 1,
  }));
}
export const initialMaterials: Material[] = [
  {
    id: "mat-tcp",
    courseId: "network",
    ownerId: "t-chen",
    title: "第三章 · TCP 可靠传输",
    kind: "PDF",
    visibility: "course",
    status: "ready",
    size: "2.4 MB",
    pages: 3,
    date: "2026-09-10",
    sampleKey: "handshake",
    knowledge: knowledge("handshake"),
    cards: [
      {
        id: "qa-syn",
        question: "为什么 SYN 报文会消耗一个序列号？",
        keywords: "SYN,消耗,序列号",
        answer:
          "SYN 是需要被可靠确认的控制信息，因此占用一个序列号。对端收到 seq=x 的 SYN 后，用 ack=x+1 表示已经收到它。纯 ACK 不额外消耗序列号。",
        confirmed: true,
      },
    ],
  },
  {
    id: "mat-wire",
    courseId: "network",
    ownerId: "t-chen",
    title: "Wireshark 抓包实验指导",
    kind: "PPTX",
    visibility: "course",
    status: "ready",
    size: "1.8 MB",
    pages: 3,
    date: "2026-09-09",
    sampleKey: "handshake",
    knowledge: knowledge("handshake"),
    cards: [],
  },
  {
    id: "mat-net-teach",
    courseId: "network",
    ownerId: "t-chen",
    title: "传输层课堂讲解提纲",
    kind: "DOCX",
    visibility: "private",
    status: "ready",
    size: "328 KB",
    pages: 3,
    date: "2026-09-08",
    sampleKey: "handshake",
    knowledge: knowledge("handshake"),
    cards: [],
  },
  {
    id: "mat-os",
    courseId: "os",
    ownerId: "t-chen",
    title: "第五章 · 进程同步与互斥",
    kind: "PDF",
    visibility: "course",
    status: "ready",
    size: "1.6 MB",
    pages: 2,
    date: "2026-09-08",
    sampleKey: "queue",
    knowledge: knowledge("queue"),
    cards: [],
  },
  {
    id: "mat-os-guide",
    courseId: "os",
    ownerId: "t-chen",
    title: "生产者—消费者实验指导",
    kind: "DOCX",
    visibility: "course",
    status: "ready",
    size: "420 KB",
    pages: 2,
    date: "2026-09-07",
    sampleKey: "queue",
    knowledge: knowledge("queue"),
    cards: [],
  },
  {
    id: "mat-db",
    courseId: "database",
    ownerId: "t-lin",
    title: "第六章 · 索引与查询优化",
    kind: "PDF",
    visibility: "course",
    status: "ready",
    size: "2.1 MB",
    pages: 2,
    date: "2026-09-09",
    sampleKey: "index",
    knowledge: knowledge("index"),
    cards: [],
  },
  {
    id: "mat-db-lab",
    courseId: "database",
    ownerId: "t-lin",
    title: "SQL 执行计划实验指导",
    kind: "PPTX",
    visibility: "course",
    status: "ready",
    size: "1.3 MB",
    pages: 2,
    date: "2026-09-08",
    sampleKey: "index",
    knowledge: knowledge("index"),
    cards: [],
  },
];
export function makeRubric(courseId: string): Rubric[] {
  const titles =
    courseId === "network"
      ? [
          "实验环境与抓包过程",
          "三次握手字段分析",
          "抓包截图与证据",
          "异常分析与实验总结",
        ]
      : courseId === "os"
        ? [
            "实验环境与实现说明",
            "同步与互斥逻辑",
            "运行结果与证据",
            "边界情况与总结",
          ]
        : [
            "数据准备与查询设计",
            "执行计划分析",
            "对比结果与证据",
            "性能解释与总结",
          ];
  return titles.map((title, i) => ({
    id: courseId + "-r" + i,
    title,
    max: [20, 30, 30, 20][i],
    criterion: [
      "清楚说明环境、操作步骤与关键参数，过程可复现。",
      "结合本次实验的原理与关键字段，逐项解释观察结果。",
      "提供清晰、对应当前结论的原始截图或输出，并标注必要字段。",
      "讨论异常或边界情况，给出有依据的结论与改进方向。",
    ][i],
  }));
}
export const initialAssignments: Assignment[] = [
  {
    id: "lab-tcp",
    courseId: "network",
    title: "实验一 · TCP 三次握手分析",
    due: "2026-09-18",
    description:
      "使用 Wireshark 捕获一次完整的 TCP 连接建立过程，分析 SYN、ACK 与序列号变化，结合截图给出解释，并讨论一种连接异常。提交一份包含环境、步骤、证据和总结的实验报告。",
    materialIds: ["mat-tcp", "mat-wire"],
    rubric: makeRubric("network"),
    confirmed: true,
    published: true,
  },
  {
    id: "lab-os",
    courseId: "os",
    title: "实验二 · 生产者与消费者",
    due: "2026-09-22",
    description:
      "实现有界缓冲区的生产者与消费者，使用信号量解决同步与互斥。记录空缓冲区、满缓冲区与并发运行情况，解释关键操作的执行顺序。",
    materialIds: ["mat-os", "mat-os-guide"],
    rubric: makeRubric("os"),
    confirmed: true,
    published: true,
  },
  {
    id: "lab-db",
    courseId: "database",
    title: "实验一 · 索引与执行计划",
    due: "2026-09-20",
    description:
      "准备一组订单数据，对比建立索引前后的 SQL 执行计划，分析查询条件、扫描行数与索引使用情况，并说明测量环境和局限。",
    materialIds: ["mat-db", "mat-db-lab"],
    rubric: makeRubric("database"),
    confirmed: true,
    published: true,
  },
];
export const demoReportText: Record<string, string[]> = {
  network: [
    "实验环境与过程",
    "使用 Wireshark 在本机网络接口上抓取一次 TCP 连接。启动抓包后，通过浏览器访问实验服务器，再使用 tcp.stream eq 0 过滤当前连接。",
    "关键字段与截图分析",
    "抓包中依次出现 SYN、SYN/ACK、ACK 三个报文。客户端初始相对序列号为 0，服务器确认号为 1；第三个报文的确认号也为 1。SYN 占用一个序列号。",
    "异常观察与总结",
    "连接未监听的端口时观察到 RST 响应。报告对实际过滤表达式的说明仍不充分，也未完整标出异常抓包的环境条件。",
  ],
  os: [
    "实验环境与实现",
    "使用有界缓冲区与信号量实现生产者、消费者线程。缓冲区容量为 5，mutex、empty、full 分别初始化为 1、5、0。",
    "运行观察与证据",
    "生产者先等待空槽位，再进入互斥区。消费者先等待可用数据，再进入互斥区。运行日志展示缓冲区容量在 0 至 5 之间变化。",
    "边界情况与总结",
    "报告记录了缓冲区已满时生产者等待的情况，但对空缓冲区的连续消费测试说明不充分。",
  ],
  database: [
    "数据与环境",
    "建立订单表示例数据，使用 customer_id 作为查询条件。比较建立复合索引前后的执行计划。",
    "执行计划与对比",
    "无索引时出现全表扫描，建立合适的索引后扫描行数下降。保留 EXPLAIN 输出，并说明查询使用的索引与访问类型。",
    "分析与总结",
    "索引对部分查询有帮助，但维护索引需要额外写入成本。报告未充分解释冷缓存与热缓存对单次耗时的影响。",
  ],
};
export function fixtureGrades(assignment: Assignment, studentId: string) {
  const deficits = studentId === "s-xu" ? [1, 6, 5, 4] : [0, 3, 6, 3];
  const supported = makeRubric(assignment.courseId);
  return assignment.rubric.map((r, i) =>
    i >= deficits.length ||
    !supported.some(
      (item) =>
        item.id === r.id &&
        item.criterion === r.criterion &&
        item.title === r.title,
    )
      ? {
          rubricId: r.id,
          score: null,
          page: 1,
          comment: "这个自定义评分项不在演示样例中，请教师依据原文人工填写。",
          evidence: "",
        }
      : {
          rubricId: r.id,
          score: Math.max(0, r.max - deficits[i]),
          page: Math.min(i + 1, 3),
          comment: [
            "环境和步骤基本完整，建议补充关键参数以便复现。",
            "已描述核心原理，部分字段或执行顺序仍需更准确解释。",
            "提供了相关证据，但截图标注和文字分析的对应关系不够完整。",
            "有实验总结，异常或边界条件的讨论可进一步补充。",
          ][i],
          evidence: demoReportText[assignment.courseId][[1, 3, 3, 5][i]],
        },
  );
}
const initialSubmissions: Submission[] = [
  {
    id: "sub-zhou-net",
    assignmentId: "lab-tcp",
    studentId: "s-zhou",
    fileName: "TCP实验报告_周可.pdf",
    submittedAt: "2026-09-10 09:32",
    status: "submitted",
    sampleKey: "network",
    grades: [],
    summary: "",
    history: [],
  },
  {
    id: "sub-xu-net",
    assignmentId: "lab-tcp",
    studentId: "s-xu",
    fileName: "TCP实验报告_许然.pdf",
    submittedAt: "2026-09-10 10:06",
    status: "submitted",
    sampleKey: "network",
    grades: [],
    summary: "",
    history: [],
  },
  {
    id: "sub-yi-os",
    assignmentId: "lab-os",
    studentId: "s-yi",
    fileName: "进程同步实验报告_林一.pdf",
    submittedAt: "2026-09-09 16:20",
    status: "published",
    sampleKey: "os",
    grades: fixtureGrades(initialAssignments[1], "s-xu"),
    summary:
      "能够清楚说明同步与互斥的区别。建议进一步补充空缓冲区的测试证据，并解释信号量等待顺序。",
    history: [],
  },
  {
    id: "sub-xu-os",
    assignmentId: "lab-os",
    studentId: "s-xu",
    fileName: "进程同步实验报告_许然.docx",
    submittedAt: "2026-09-10 08:45",
    status: "review",
    sampleKey: "os",
    grades: fixtureGrades(initialAssignments[1], "s-xu"),
    summary: "核心过程已完成，边界测试与证据标注尚需完善。",
    history: [],
  },
  {
    id: "sub-zhou-db",
    assignmentId: "lab-db",
    studentId: "s-zhou",
    fileName: "索引实验报告_周可.pdf",
    submittedAt: "2026-09-09 20:12",
    status: "published",
    sampleKey: "database",
    grades: fixtureGrades(initialAssignments[2], "s-zhou"),
    summary: "查询与索引选择合理，建议结合缓存条件解释耗时差异。",
    history: [],
  },
  {
    id: "sub-xu-db",
    assignmentId: "lab-db",
    studentId: "s-xu",
    fileName: "索引实验报告_许然.pdf",
    submittedAt: "2026-09-10 10:40",
    status: "submitted",
    sampleKey: "database",
    grades: [],
    summary: "",
    history: [],
  },
];
export function freshState(): DemoState {
  return structuredClone({
    version: 1,
    materials: initialMaterials,
    assignments: initialAssignments,
    submissions: initialSubmissions.map((report) =>
      report.status === "published" && !report.history.length
        ? {
            ...report,
            history: [
              {
                confirmedAt: report.submittedAt,
                grades: report.grades,
                summary: report.summary,
              },
            ],
          }
        : report,
    ),
    chats: {},
    generatedFeedback: {},
  });
}
