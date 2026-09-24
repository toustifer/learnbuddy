export type Role = "teacher" | "student";
export interface User {
  id: string;
  username: string;
  name: string;
  role: Role;
  initials: string;
  courses?: Course[];
}
export interface Course {
  id: string;
  teacherId: string;
  title: string;
  code: string;
  color: string;
  description: string;
}
export interface Enrollment {
  courseId: string;
  studentId: string;
}
export interface Knowledge {
  id: string;
  title: string;
  summary: string;
  page: number;
}
export interface QACard {
  id: string;
  question: string;
  keywords: string;
  answer: string;
  confirmed: boolean;
}
export type MaterialKind = "PDF" | "PPTX" | "PPT" | "DOCX" | "PNG" | "JPG";
export interface Material {
  source?: "server";
  id: string;
  courseId: string;
  ownerId: string;
  title: string;
  kind: MaterialKind;
  visibility: "course" | "private";
  status: "ready" | "pending";
  size: string;
  pages?: number;
  date: string;
  sampleKey?: string;
  blobId?: string;
  knowledge: Knowledge[];
  cards: QACard[];
  teaching?: string;
  contextSections?: { page: number; chapter: string; content: string }[];
  parseStatus?: "parsed" | "pending" | "failed";
  parseErrorCode?: string;
  parseError?: string;
}
export interface Rubric {
  id: string;
  title: string;
  criterion: string;
  max: number;
}
export interface Assignment {
  id: string;
  courseId: string;
  title: string;
  due: string;
  description: string;
  materialIds: string[];
  rubric: Rubric[];
  confirmed: boolean;
  published: boolean;
}
export interface Grade {
  rubricId: string;
  score: number | null;
  comment: string;
  evidence: string;
  page: number;
}
export interface ReviewVersion {
  confirmedAt: string;
  grades: Grade[];
  summary: string;
}
export interface Submission {
  id: string;
  assignmentId: string;
  studentId: string;
  fileName: string;
  submittedAt: string;
  status: "submitted" | "grading" | "review" | "published" | "failed";
  sampleKey?: string;
  blobId?: string;
  grades: Grade[];
  summary: string;
  history: ReviewVersion[];
  failure?: string;
  /** 持久化的解析产物：有它就能渲染报告，不依赖本次评分是否成功 */
  parsedContent?: ParsedReportContent | null;
}
export interface ChatReference {
  id: string;
  title: string;
  detail?: string;
  kind: "material" | "selection" | "image" | "report";
  materialId?: string;
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  refs?: ChatReference[];
  source?: "card" | "demo";
  materialId?: string;
  page?: number;
}
export interface DemoState {
  version: 1;
  materials: Material[];
  assignments: Assignment[];
  submissions: Submission[];
  chats: Record<string, Message[]>;
  generatedFeedback: Record<string, boolean>;
}
export interface AcademicWorkspace {
  courses: Course[];
  assignments: Assignment[];
  submissions: Submission[];
  roster: { courseId: string; student: User }[];
}
export type Route =
  | { page: "home" }
  | { page: "courses" }
  | { page: "course"; id: string }
  | { page: "library" }
  | { page: "material"; id: string }
  | { page: "assignments"; courseId?: string }
  | { page: "assignment"; id: string }
  | { page: "grading"; id: string; submissionId?: string }
  | { page: "report"; id: string }
  | { page: "insights"; courseId?: string };
export interface DocumentPage {
  pageNumber?: number;
  /** 章节标题取自文档自身结构；解析拿不到时为空串，由前端回退显示文件名 */
  heading: string;
  eyebrow: string;
  paragraphs: string[];
  diagram?: "handshake" | "queue" | "index" | string;
  diagramUrl?: string;
  code?: string;
  caption?: string;
  highlights?: string[];
}

/** 报告内嵌图片的可访问引用（后端落盘后返回，前端用 fileUrl(fileId) 取图） */
export interface ReportImageRef {
  index: number;
  fileId: string;
  mimeType: string;
  size?: number;
  viewUrl?: string;
}

/** 评阅记录里携带的真实解析产物投影（后端 extractReportContent → parsedContent） */
export interface ParsedReportContent {
  title: string;
  /** 阅读器渲染出来的结构页数（我们切分的结果，不等于原件页数） */
  pages: number;
  /**
   * **原件本身**的真实页数（转 PDF 后数出来的）。
   * null / 缺省表示没取到 —— 此时不要冒充真实值，继续按「估算」提示。
   */
  originalPages?: number | null;
  /** 页数由标题结构估算，仅作参考，不得当作真实页码展示 */
  pagesEstimated?: boolean;
  /** document = 真实解析；fixture = 内置演示样例，不得混入正式评分与统计 */
  source?: "document" | "fixture";
  hasImages?: boolean;
  /** 真实落盘的内嵌图片；空数组表示确实没有或未落盘 */
  images?: ReportImageRef[];
  /** 未能落盘的原因，如实展示，不用占位图掩盖 */
  imageWarnings?: string[];
  /** 解析过程中的降级 / 缺失告警 */
  warnings?: string[];
  /** partial 表示正文拿到了、但有内容缺失（不等于解析失败） */
  completeness?: "complete" | "partial";
  structuredPages: DocumentPage[];
}

/** 报告批注（教师在原文上的标注，可关联到某个评分项） */
export interface ReportAnnotation {
  id: string;
  rubricId?: string;
  page: number;
  text: string;
  author: "ai" | "teacher";
  color?: "yellow" | "green" | "blue" | "red" | "purple";
  createdAt: string;
  quote?: string;
}

export interface ServerGrade {
  rubricId: string;
  title?: string;
  max?: number;
  score: number;
  suggestedScore?: number;
  teacherScore?: number;
  page?: number;
  comment?: string;
  evidence?: string;
  judgment?: "satisfied" | "partially_satisfied" | "not_satisfied" | "unable_to_judge" | "professional_judgment";
  /** model = 模型给出的判定；score_fallback = 模型未给、由分数兜底 */
  judgmentSource?: "model" | "score_fallback";
  /** 后端 coverage 以嵌套对象返回，面板消费前需摊平成 coveredPoints/missingPoints */
  coverage?: { coveredPoints?: string[]; missingPoints?: string[] };
  coveredPoints?: string[];
  missingPoints?: string[];
  attentionLevel?: "clear" | "needs_attention" | "review_required";
}

/**
 * `EvidenceRefV1` —— 契约层（`src/contracts/evidence.js`）定义的证据引用。
 *
 * 注意这里**没有** `locator: string` 那种自定义形式：契约层统一用对象，
 * 并按文档类型给不同字段（PDF/PPTX → page/slide；DOCX → headingPath；表格 → sheet/range）。
 * 硬规则是「不猜位置」—— 拿不到就留 null，不用估算值填充。
 */
export interface EvidenceRefV1 {
  /** 稳定 ID：定位相同的证据，id 相同 */
  id: string;
  /** 文档版本：blobId（内容哈希）；无原件时为 null */
  documentVersionId: string | null;
  /** 关联的业务块，评分项为 `grade-<rubricId>` */
  blockId: string | null;
  kind: "text" | "figure" | "image" | "table" | "code" | "asset";
  locator: {
    page: number | null;
    slide: number | null;
    headingPath: string[] | null;
    sheet?: string | null;
    range?: string | null;
    figure?: string | null;
  };
  /** 原文摘录（可核对的锚点） */
  quote: string | null;
  assetId: string | null;
}
export interface ServerReview {
  submissionId: string;
  status: string;
  totalScore: number;
  maxScore: number;
  grades: ServerGrade[];
  summary: string;
  reviewVersion?: number;
  parsedContent?: ParsedReportContent | null;
  submission?: {
    assignmentId?: string;
    blobId?: string;
    fileName?: string;
    failure?: string;
  };
}
