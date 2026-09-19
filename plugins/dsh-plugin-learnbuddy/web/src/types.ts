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
  | { page: "grading"; id: string }
  | { page: "report"; id: string }
  | { page: "insights"; courseId?: string };
export interface DocumentPage {
  pageNumber?: number;
  heading: string;
  eyebrow: string;
  paragraphs: string[];
  diagram?: "handshake" | "queue" | "index" | string;
  diagramUrl?: string;
  code?: string;
  caption?: string;
  highlights?: string[];
}

export interface AnnotationItem {
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
  judgment?: "satisfied" | "partially_satisfied" | "not_satisfied" | "professional_judgment";
  coveredPoints?: string[];
  missingPoints?: string[];
  attentionLevel?: "clear" | "needs_attention" | "review_required";
}
export interface ServerReview {
  submissionId: string;
  status: string;
  totalScore: number;
  maxScore: number;
  grades: ServerGrade[];
  summary: string;
  reviewVersion?: number;
  submission?: {
    assignmentId?: string;
    blobId?: string;
    fileName?: string;
    failure?: string;
  };
}
