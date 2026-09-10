/**
 * LearnBuddy SQLite Database Schema and Seed Data
 * Compatible with Node 22 (node:sqlite DatabaseSync)
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
  initials TEXT
);

CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  title TEXT NOT NULL,
  code TEXT NOT NULL,
  color TEXT DEFAULT 'blue',
  description TEXT DEFAULT '',
  FOREIGN KEY (teacher_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS enrollments (
  course_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  PRIMARY KEY (course_id, student_id),
  FOREIGN KEY (course_id) REFERENCES courses(id),
  FOREIGN KEY (student_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'PDF',
  visibility TEXT NOT NULL CHECK (visibility IN ('course', 'private')),
  status TEXT NOT NULL CHECK (status IN ('ready', 'pending')) DEFAULT 'ready',
  size TEXT DEFAULT '0 KB',
  pages INTEGER DEFAULT 1,
  date TEXT,
  sample_key TEXT,
  blob_id TEXT,
  knowledge TEXT DEFAULT '[]',
  cards TEXT DEFAULT '[]',
  teaching TEXT,
  FOREIGN KEY (course_id) REFERENCES courses(id),
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  title TEXT NOT NULL,
  due TEXT,
  description TEXT DEFAULT '',
  material_ids TEXT DEFAULT '[]',
  rubric TEXT DEFAULT '[]',
  confirmed INTEGER DEFAULT 0,
  published INTEGER DEFAULT 0,
  FOREIGN KEY (course_id) REFERENCES courses(id)
);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitted', 'grading', 'review', 'published', 'failed')) DEFAULT 'submitted',
  sample_key TEXT,
  blob_id TEXT,
  grades TEXT DEFAULT '[]',
  summary TEXT DEFAULT '',
  history TEXT DEFAULT '[]',
  failure TEXT,
  FOREIGN KEY (assignment_id) REFERENCES assignments(id),
  FOREIGN KEY (student_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id);
CREATE INDEX IF NOT EXISTS idx_materials_course ON materials(course_id);
CREATE INDEX IF NOT EXISTS idx_materials_owner ON materials(owner_id);
CREATE INDEX IF NOT EXISTS idx_assignments_course ON assignments(course_id);
CREATE INDEX IF NOT EXISTS idx_submissions_assignment ON submissions(assignment_id);
CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_id);
`;

export const DEFAULT_USERS = [
  {
    id: "t-chen",
    username: "teacher.chen",
    name: "陈知行",
    role: "teacher",
    initials: "陈"
  },
  {
    id: "t-lin",
    username: "teacher.lin",
    name: "林悦",
    role: "teacher",
    initials: "林"
  },
  {
    id: "s-yi",
    username: "student.lin",
    name: "林一",
    role: "student",
    initials: "林"
  },
  {
    id: "s-zhou",
    username: "student.zhou",
    name: "周可",
    role: "student",
    initials: "周"
  },
  {
    id: "s-xu",
    username: "student.xu",
    name: "许然",
    role: "student",
    initials: "许"
  }
];

export const DEFAULT_COURSES = [
  {
    id: "network",
    teacherId: "t-chen",
    title: "计算机网络",
    code: "CS 203",
    color: "green",
    description: "从一次握手，理解万物互联。"
  },
  {
    id: "os",
    teacherId: "t-chen",
    title: "操作系统",
    code: "CS 301",
    color: "orange",
    description: "探索计算机如何管理每一份资源。"
  },
  {
    id: "database",
    teacherId: "t-lin",
    title: "数据库原理",
    code: "CS 205",
    color: "purple",
    description: "让数据之间的关系，变得清晰。"
  },
  {
    id: "cs101",
    teacherId: "t-chen",
    title: "计算机科学导论",
    code: "CS 101",
    color: "blue",
    description: "计算机系统与算法基础初探。"
  }
];

export const DEFAULT_ENROLLMENTS = [
  { courseId: "network", studentId: "s-yi" },
  { courseId: "os", studentId: "s-yi" },
  { courseId: "network", studentId: "s-zhou" },
  { courseId: "database", studentId: "s-zhou" },
  { courseId: "network", studentId: "s-xu" },
  { courseId: "os", studentId: "s-xu" },
  { courseId: "database", studentId: "s-xu" },
  { courseId: "cs101", studentId: "s-yi" },
  { courseId: "cs101", studentId: "s-zhou" },
  { courseId: "cs101", studentId: "s-xu" }
];

export const DEFAULT_MATERIALS = [
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
    knowledge: [
      {
        id: "handshake-kp-0",
        title: "从一次握手开始，理解可靠传输",
        summary: "TCP 三次握手的目的，是让通信双方确认彼此的发送与接收能力，并同步初始序列号。",
        page: 1
      },
      {
        id: "handshake-kp-1",
        title: "序列号，如何确认一条消息？",
        summary: "建立连接时，SYN 标志会消耗一个序列号。若客户端初始序列号是 x，服务器确认该 SYN 时就会返回 ack = x + 1。",
        page: 2
      },
      {
        id: "handshake-kp-2",
        title: "在 Wireshark 中找到真实证据",
        summary: "实验报告需要同时包含关键截图与文字解释。截图展示“观察到了什么”，文字解释“这些字段为什么这样变化”。",
        page: 3
      }
    ],
    cards: [
      {
        id: "qa-syn",
        question: "为什么 SYN 报文会消耗一个序列号？",
        keywords: "SYN,消耗,序列号",
        answer: "SYN 是需要被可靠确认的控制信息，因此占用一个序列号。对端收到 seq=x 的 SYN 后，用 ack=x+1 表示已经收到它。纯 ACK 不额外消耗序列号。",
        confirmed: true
      }
    ]
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
    knowledge: [],
    cards: []
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
    knowledge: [],
    cards: []
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
    knowledge: [
      {
        id: "queue-kp-0",
        title: "让生产与消费，各有节奏",
        summary: "互斥保证同一时刻只有一个执行单元修改缓冲区；同步则保证缓冲区已满时生产者等待，缓冲区为空时消费者等待。",
        page: 1
      }
    ],
    cards: []
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
    knowledge: [
      {
        id: "index-kp-0",
        title: "用索引，让查询少走弯路",
        summary: "B+ 树通过多层节点缩小查找范围，并把叶子节点连接起来，兼顾等值查询与范围查询。",
        page: 1
      }
    ],
    cards: []
  }
];

export const DEFAULT_ASSIGNMENTS = [
  {
    id: "lab-tcp",
    courseId: "network",
    title: "实验一 · TCP 三次握手分析",
    due: "2026-09-18",
    description: "使用 Wireshark 捕获一次完整的 TCP 连接建立过程，分析 SYN、ACK 与序列号变化，结合截图给出解释，并讨论一种连接异常。",
    materialIds: ["mat-tcp", "mat-wire"],
    rubric: [
      { id: "network-r0", title: "实验环境与抓包过程", max: 20, criterion: "清楚说明环境、操作步骤与关键参数，过程可复现。" },
      { id: "network-r1", title: "三次握手字段分析", max: 30, criterion: "结合本次实验的原理与关键字段，逐项解释观察结果。" },
      { id: "network-r2", title: "抓包截图与证据", max: 30, criterion: "提供清晰、对应当前结论的原始截图或输出，并标注必要字段。" },
      { id: "network-r3", title: "异常分析与实验总结", max: 20, criterion: "讨论异常或边界情况，给出有依据的结论与改进方向。" }
    ],
    confirmed: true,
    published: true
  },
  {
    id: "lab-os",
    courseId: "os",
    title: "实验二 · 生产者与消费者",
    due: "2026-09-22",
    description: "实现有界缓冲区的生产者与消费者，使用信号量解决同步与互斥。",
    materialIds: ["mat-os"],
    rubric: [
      { id: "os-r0", title: "实验环境与实现说明", max: 20, criterion: "清楚说明环境、操作步骤与关键参数，过程可复现。" },
      { id: "os-r1", title: "同步与互斥逻辑", max: 30, criterion: "结合本次实验的原理与关键字段，逐项解释观察结果。" },
      { id: "os-r2", title: "运行结果与证据", max: 30, criterion: "提供清晰、对应当前结论的原始截图或输出，并标注必要字段。" },
      { id: "os-r3", title: "边界情况与总结", max: 20, criterion: "讨论异常或边界情况，给出有依据的结论与改进方向。" }
    ],
    confirmed: true,
    published: true
  },
  {
    id: "lab-db",
    courseId: "database",
    title: "实验一 · 索引与执行计划",
    due: "2026-09-20",
    description: "准备一组订单数据，对比建立索引前后的 SQL 执行计划，分析查询条件、扫描行数与索引使用情况。",
    materialIds: ["mat-db"],
    rubric: [
      { id: "database-r0", title: "数据准备与查询设计", max: 20, criterion: "清楚说明环境、操作步骤与关键参数，过程可复现。" },
      { id: "database-r1", title: "执行计划分析", max: 30, criterion: "结合本次实验的原理与关键字段，逐项解释观察结果。" },
      { id: "database-r2", title: "对比结果与证据", max: 30, criterion: "提供清晰、对应当前结论的原始截图或输出，并标注必要字段。" },
      { id: "database-r3", title: "性能解释与总结", max: 20, criterion: "讨论异常或边界情况，给出有依据的结论与改进方向。" }
    ],
    confirmed: true,
    published: true
  }
];

export const DEFAULT_SUBMISSIONS = [
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
    history: []
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
    history: []
  },
  {
    id: "sub-yi-os",
    assignmentId: "lab-os",
    studentId: "s-yi",
    fileName: "进程同步实验报告_林一.pdf",
    submittedAt: "2026-09-09 16:20",
    status: "published",
    sampleKey: "os",
    grades: [
      { rubricId: "os-r0", score: 20, page: 1, comment: "环境和步骤基本完整，建议补充关键参数以便复现。", evidence: "使用有界缓冲区与信号量实现生产者、消费者线程。" },
      { rubricId: "os-r1", score: 27, page: 2, comment: "已描述核心原理，部分字段或执行顺序仍需更准确解释。", evidence: "运行日志展示缓冲区容量在 0 至 5 之间变化。" },
      { rubricId: "os-r2", score: 24, page: 2, comment: "提供了相关证据，但截图标注和文字分析的对应关系不够完整。", evidence: "运行日志展示缓冲区容量在 0 至 5 之间变化。" },
      { rubricId: "os-r3", score: 17, page: 3, comment: "有实验总结，异常或边界条件的讨论可进一步补充。", evidence: "对空缓冲区的连续消费测试说明不充分。" }
    ],
    summary: "能够清楚说明同步与互斥的区别。建议进一步补充空缓冲区的测试证据，并解释信号量等待顺序。",
    history: [
      {
        confirmedAt: "2026-09-09 16:20",
        grades: [
          { rubricId: "os-r0", score: 20, page: 1, comment: "环境和步骤基本完整，建议补充关键参数以便复现。", evidence: "使用有界缓冲区与信号量实现生产者、消费者线程。" },
          { rubricId: "os-r1", score: 27, page: 2, comment: "已描述核心原理，部分字段或执行顺序仍需更准确解释。", evidence: "运行日志展示缓冲区容量在 0 至 5 之间变化。" },
          { rubricId: "os-r2", score: 24, page: 2, comment: "提供了相关证据，但截图标注和文字分析的对应关系不够完整。", evidence: "运行日志展示缓冲区容量在 0 至 5 之间变化。" },
          { rubricId: "os-r3", score: 17, page: 3, comment: "有实验总结，异常或边界条件的讨论可进一步补充。", evidence: "对空缓冲区的连续消费测试说明不充分。" }
        ],
        summary: "能够清楚说明同步与互斥的区别。建议进一步补充空缓冲区的测试证据，并解释信号量等待顺序。"
      }
    ]
  },
  {
    id: "sub-xu-os",
    assignmentId: "lab-os",
    studentId: "s-xu",
    fileName: "进程同步实验报告_许然.docx",
    submittedAt: "2026-09-10 08:45",
    status: "review",
    sampleKey: "os",
    grades: [
      { rubricId: "os-r0", score: 19, page: 1, comment: "环境与实现步骤清晰。", evidence: "使用有界缓冲区与信号量实现生产者、消费者线程。" },
      { rubricId: "os-r1", score: 24, page: 2, comment: "互斥锁保护临界区描述清楚，信号量增减顺序可再推导。", evidence: "运行日志展示缓冲区容量在 0 至 5 之间变化。" },
      { rubricId: "os-r2", score: 25, page: 2, comment: "测试输出截图完整。", evidence: "运行日志展示缓冲区容量在 0 至 5 之间变化。" },
      { rubricId: "os-r3", score: 16, page: 3, comment: "边界条件讨论有待深化。", evidence: "对空缓冲区的连续消费测试说明不充分。" }
    ],
    summary: "核心过程已完成，边界测试与证据标注尚需完善。",
    history: []
  },
  {
    id: "sub-zhou-db",
    assignmentId: "lab-db",
    studentId: "s-zhou",
    fileName: "索引实验报告_周可.pdf",
    submittedAt: "2026-09-09 20:12",
    status: "published",
    sampleKey: "database",
    grades: [
      { rubricId: "database-r0", score: 20, page: 1, comment: "数据与测试环境详尽完整。", evidence: "建立订单表示例数据，使用 customer_id 作为查询条件。" },
      { rubricId: "database-r1", score: 27, page: 2, comment: "EXPLAIN 执行计划分析到位。", evidence: "建立合适的索引后扫描行数下降。" },
      { rubricId: "database-r2", score: 24, page: 2, comment: "索引建立前后对比清晰。", evidence: "建立合适的索引后扫描行数下降。" },
      { rubricId: "database-r3", score: 17, page: 3, comment: "总结客观务实。", evidence: "索引对部分查询有帮助，但维护索引需要额外写入成本。" }
    ],
    summary: "查询与索引选择合理，建议结合缓存条件解释耗时差异。",
    history: []
  }
];

/**
 * Initialize database schema
 * @param {import('node:sqlite').DatabaseSync} db 
 */
export function initSchema(db) {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_SQL);
}

/**
 * Seed database with initial default data
 * @param {import('node:sqlite').DatabaseSync} db 
 * @param {object} [seedData]
 */
export function seedDatabase(db, seedData = {}) {
  const users = seedData.users || DEFAULT_USERS;
  const courses = seedData.courses || DEFAULT_COURSES;
  const enrollments = seedData.enrollments || DEFAULT_ENROLLMENTS;
  const materials = seedData.materials || DEFAULT_MATERIALS;
  const assignments = seedData.assignments || DEFAULT_ASSIGNMENTS;
  const submissions = seedData.submissions || DEFAULT_SUBMISSIONS;

  // Insert users
  const insertUser = db.prepare(`
    INSERT OR REPLACE INTO users (id, username, name, role, initials)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const u of users) {
    insertUser.run(u.id, u.username, u.name, u.role, u.initials || u.name.slice(0, 1));
  }

  // Insert courses
  const insertCourse = db.prepare(`
    INSERT OR REPLACE INTO courses (id, teacher_id, title, code, color, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const c of courses) {
    insertCourse.run(c.id, c.teacherId, c.title, c.code, c.color || "blue", c.description || "");
  }

  // Insert enrollments
  const insertEnrollment = db.prepare(`
    INSERT OR REPLACE INTO enrollments (course_id, student_id)
    VALUES (?, ?)
  `);
  for (const e of enrollments) {
    insertEnrollment.run(e.courseId, e.studentId);
  }

  // Insert materials
  const insertMaterial = db.prepare(`
    INSERT OR REPLACE INTO materials (
      id, course_id, owner_id, title, kind, visibility, status,
      size, pages, date, sample_key, blob_id, knowledge, cards, teaching
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const m of materials) {
    insertMaterial.run(
      m.id,
      m.courseId,
      m.ownerId,
      m.title,
      m.kind || "PDF",
      m.visibility || "course",
      m.status || "ready",
      m.size || "0 KB",
      m.pages || 1,
      m.date || new Date().toISOString().slice(0, 10),
      m.sampleKey || null,
      m.blobId || null,
      JSON.stringify(m.knowledge || []),
      JSON.stringify(m.cards || []),
      m.teaching || null
    );
  }

  // Insert assignments
  const insertAssignment = db.prepare(`
    INSERT OR REPLACE INTO assignments (
      id, course_id, title, due, description, material_ids, rubric, confirmed, published
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const a of assignments) {
    insertAssignment.run(
      a.id,
      a.courseId,
      a.title,
      a.due || "",
      a.description || "",
      JSON.stringify(a.materialIds || []),
      JSON.stringify(a.rubric || []),
      a.confirmed ? 1 : 0,
      a.published ? 1 : 0
    );
  }

  // Insert submissions
  const insertSubmission = db.prepare(`
    INSERT OR REPLACE INTO submissions (
      id, assignment_id, student_id, file_name, submitted_at, status,
      sample_key, blob_id, grades, summary, history, failure
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const s of submissions) {
    insertSubmission.run(
      s.id,
      s.assignmentId,
      s.studentId,
      s.fileName,
      s.submittedAt,
      s.status || "submitted",
      s.sampleKey || null,
      s.blobId || null,
      JSON.stringify(s.grades || []),
      s.summary || "",
      JSON.stringify(s.history || []),
      s.failure || null
    );
  }
}
