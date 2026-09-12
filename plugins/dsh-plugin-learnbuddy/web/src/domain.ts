import { courses, enrollments, users } from "./seed";
import type {
  Assignment,
  DemoState,
  Grade,
  Material,
  Submission,
  User,
} from "./types";

export function authenticate(username: string, password: string) {
  const name = username.trim() === "user" ? "student.lin" : username.trim();
  return password === "123"
    ? users.find((u) => u.username === name)
    : undefined;
}
export function hasCourse(user: User, courseId: string) {
  if (user.courses) return user.courses.some((c) => c.id === courseId);
  return user.role === "teacher"
    ? courses.some((c) => c.id === courseId && c.teacherId === user.id)
    : enrollments.some(
        (e) => e.courseId === courseId && e.studentId === user.id,
      );
}
export function visibleCourses(user: User) {
  if (user.courses) return user.courses;
  return courses.filter((c) => hasCourse(user, c.id));
}
export function canSeeMaterial(user: User, material: Material) {
  return (
    hasCourse(user, material.courseId) &&
    (material.visibility === "course" || material.ownerId === user.id)
  );
}
export function visibleMaterials(state: DemoState, user: User) {
  return state.materials.filter((m) => canSeeMaterial(user, m));
}
export function canSeeAssignment(user: User, assignment: Assignment) {
  return (
    hasCourse(user, assignment.courseId) &&
    (user.role === "teacher" || assignment.published)
  );
}
export function visibleAssignments(state: DemoState, user: User) {
  return state.assignments.filter((a) => canSeeAssignment(user, a));
}
export function canSeeSubmission(
  state: DemoState,
  user: User,
  submission: Submission,
) {
  const assignment = state.assignments.find(
    (a) => a.id === submission.assignmentId,
  );
  return (
    !!assignment &&
    canSeeAssignment(user, assignment) &&
    (user.role === "teacher" || user.id === submission.studentId)
  );
}
export function visibleSubmissions(state: DemoState, user: User) {
  return state.submissions
    .filter((s) => canSeeSubmission(state, user, s))
    .map((s) =>
      user.role === "student" && s.status !== "published"
        ? { ...s, grades: [], summary: "", failure: undefined }
        : s,
    );
}
export function assertTeacher(user: User, assignment: Assignment) {
  if (user.role !== "teacher" || !hasCourse(user, assignment.courseId))
    throw new Error("仅本课程教师可以操作。");
}
export function gradeTotal(grades: Grade[], assignment: Assignment): number {
  if (grades.length !== assignment.rubric.length)
    throw new Error("请完成所有评分项。");
  let total = 0;
  const ids = new Set<string>();
  for (const rubric of assignment.rubric) {
    const grade = grades.find((g) => g.rubricId === rubric.id);
    if (
      !grade ||
      ids.has(grade.rubricId) ||
      grade.score === null ||
      !Number.isFinite(grade.score) ||
      grade.score < 0 ||
      grade.score > rubric.max
    )
      throw new Error("分数需在各项分值范围内，且不能留空。");
    ids.add(grade.rubricId);
    total += grade.score;
  }
  return Math.round(total * 10) / 10;
}
export function publishReview(
  state: DemoState,
  user: User,
  id: string,
  grades: Grade[],
  summary: string,
): DemoState {
  const submission = state.submissions.find((s) => s.id === id);
  if (!submission) throw new Error("报告不存在。");
  const assignment = state.assignments.find(
    (a) => a.id === submission.assignmentId,
  )!;
  assertTeacher(user, assignment);
  if (!assignment.confirmed) throw new Error("请先确认评分标准。");
  if (submission.status === "grading") throw new Error("请等待评阅结束。");
  gradeTotal(grades, assignment);
  return {
    ...state,
    submissions: state.submissions.map((s) =>
      s.id !== id
        ? s
        : {
            ...s,
            status: "published",
            grades,
            summary,
            history: [
              ...s.history,
              {
                confirmedAt: new Date().toISOString(),
                grades: structuredClone(grades),
                summary,
              },
            ],
          },
    ),
  };
}
export function chatKey(user: User, contextId: string) {
  return `${user.id}:${contextId}`;
}
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export function validateFile(file: Pick<File, "size" | "name">) {
  if (file.size > MAX_FILE_BYTES) throw new Error("单个文件不能超过 20 MB。");
  const ext = file.name.split(".").pop()?.toUpperCase();
  if (
    !ext ||
    !["PDF", "PPT", "PPTX", "DOCX", "PNG", "JPG", "JPEG"].includes(ext)
  )
    throw new Error("支持 PDF、PPT、PPTX、DOCX、PNG 和 JPG 文件。");
  if (file.size === 0) throw new Error("文件为空，请重新选择。");
  return (ext === "JPEG" ? "JPG" : ext) as Material["kind"];
}
export function courseStats(state: DemoState, user: User, courseId: string) {
  if (user.role !== "teacher" || !hasCourse(user, courseId))
    throw new Error("仅本课程教师可以查看教学反馈。");
  const assignments = state.assignments.filter(
    (a) => a.courseId === courseId && a.published,
  );
  const reports = state.submissions.filter((s) =>
    assignments.some((a) => a.id === s.assignmentId),
  );
  const confirmed = reports.filter((s) => s.status === "published");
  const totals = confirmed.map((s) => {
    const a = assignments.find((a) => a.id === s.assignmentId)!;
    return (
      (gradeTotal(s.grades, a) / a.rubric.reduce((n, r) => n + r.max, 0)) * 100
    );
  });
  return {
    reports,
    confirmed,
    studentCount: enrollments.filter((e) => e.courseId === courseId).length,
    average: totals.length
      ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length)
      : null,
  };
}
export function criterionStats(state: DemoState, user: User, courseId: string) {
  const { confirmed } = courseStats(state, user, courseId);
  const groups = new Map<string, { title: string; values: number[] }>();
  for (const report of confirmed) {
    const assignment = state.assignments.find(
      (a) => a.id === report.assignmentId,
    )!;
    for (const rubric of assignment.rubric) {
      const grade = report.grades.find((g) => g.rubricId === rubric.id);
      if (!grade || grade.score === null) continue;
      const key = rubric.title + "\n" + rubric.criterion;
      const group = groups.get(key) || { title: rubric.title, values: [] };
      group.values.push((grade.score / rubric.max) * 100);
      groups.set(key, group);
    }
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    title: group.title,
    count: group.values.length,
    value: Math.round(
      group.values.reduce((n, value) => n + value, 0) / group.values.length,
    ),
  }));
}
