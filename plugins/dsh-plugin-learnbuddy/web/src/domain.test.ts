import { describe, expect, it } from "vitest";
import {
  authenticate,
  canSeeMaterial,
  chatKey,
  courseStats,
  criterionStats,
  gradeTotal,
  hasCourse,
  MAX_FILE_BYTES,
  publishReview,
  validateFile,
  visibleAssignments,
  visibleCourses,
  visibleMaterials,
  visibleSubmissions,
} from "./domain";
import { freshState, fixtureGrades, users } from "./seed";
const teacher = users[0],
  otherTeacher = users[1],
  student = users[2],
  otherStudent = users[3];
describe("account and course boundaries", () => {
  it("requires the fixed demo password and derives identity from the account", () => {
    expect(authenticate("admin", "anything")).toBeUndefined();
    expect(authenticate("teacher.chen", "bad")).toBeUndefined();
    expect(authenticate("user", "123")?.id).toBe(student.id);
    expect(authenticate("teacher.chen", "123")?.role).toBe("teacher");
  });
  it("supports one teacher owning multiple courses and many-to-many enrollment", () => {
    expect(visibleCourses(teacher).map((c) => c.id)).toEqual(["network", "os"]);
    expect(visibleCourses(otherTeacher).map((c) => c.id)).toEqual(["database"]);
    expect(visibleCourses(student).map((c) => c.id)).toEqual(["network", "os"]);
    expect(visibleCourses(otherStudent).map((c) => c.id)).toEqual([
      "network",
      "database",
    ]);
  });
  it("keeps student private materials hidden from teachers and other students", () => {
    const state = freshState();
    const material = {
      ...state.materials[0],
      id: "private-study",
      ownerId: student.id,
      visibility: "private" as const,
    };
    state.materials.push(material);
    expect(canSeeMaterial(student, material)).toBe(true);
    expect(canSeeMaterial(teacher, material)).toBe(false);
    expect(canSeeMaterial(otherStudent, material)).toBe(false);
    expect(
      visibleMaterials(state, student).some((m) => m.id === "mat-net-teach"),
    ).toBe(false);
    expect(
      visibleMaterials(state, otherTeacher).some(
        (m) => m.courseId === "network",
      ),
    ).toBe(false);
  });
  it("does not expose unconfirmed grades to students, even on their own report", () => {
    const state = freshState();
    const draft = {
      ...state.submissions[0],
      id: "my-review",
      studentId: student.id,
      status: "review" as const,
      grades: fixtureGrades(state.assignments[0], student.id),
      summary: "private teacher draft",
    };
    state.submissions.push(draft);
    const visible = visibleSubmissions(state, student);
    expect(visible.some((s) => s.studentId !== student.id)).toBe(false);
    expect(visible.find((s) => s.id === draft.id)).toMatchObject({
      grades: [],
      summary: "",
    });
    expect(
      visibleSubmissions(state, teacher).find((s) => s.id === draft.id)?.grades,
    ).toHaveLength(4);
  });
  it("keeps draft assignments private and separates chat namespaces by user", () => {
    const state = freshState();
    state.assignments[0].published = false;
    expect(
      visibleAssignments(state, student).some((a) => a.id === "lab-tcp"),
    ).toBe(false);
    expect(
      visibleAssignments(state, teacher).some((a) => a.id === "lab-tcp"),
    ).toBe(true);
    expect(chatKey(teacher, "mat-tcp")).not.toBe(chatKey(student, "mat-tcp"));
    expect(hasCourse(otherTeacher, "network")).toBe(false);
  });
});
describe("evidence review and statistics", () => {
  it("validates each criterion, missing values, duplicate identifiers, and boundaries", () => {
    const a = freshState().assignments[0];
    const grades = fixtureGrades(a, "s-xu");
    expect(gradeTotal(grades, a)).toBe(84);
    expect(() => gradeTotal(grades.slice(1), a)).toThrow();
    expect(() =>
      gradeTotal(
        grades.map((g, i) => (i === 0 ? { ...g, score: 21 } : g)),
        a,
      ),
    ).toThrow();
    expect(() =>
      gradeTotal(
        grades.map((g, i) => (i === 0 ? { ...g, score: -1 } : g)),
        a,
      ),
    ).toThrow();
    expect(() =>
      gradeTotal(
        grades.map((g, i) => (i === 0 ? { ...g, score: null } : g)),
        a,
      ),
    ).toThrow();
    expect(() =>
      gradeTotal(
        grades.map((g, i) => (i === 0 ? { ...g, score: NaN } : g)),
        a,
      ),
    ).toThrow();
    expect(() =>
      gradeTotal([grades[0], grades[0], grades[2], grades[3]], a),
    ).toThrow();
  });
  it("allows only the owning teacher to publish valid feedback and retains history", () => {
    const state = freshState();
    const a = state.assignments[0];
    const report = state.submissions[0];
    const grades = fixtureGrades(a, report.studentId);
    expect(() =>
      publishReview(state, student, report.id, grades, "test"),
    ).toThrow();
    expect(() =>
      publishReview(state, otherTeacher, report.id, grades, "test"),
    ).toThrow();
    const next = publishReview(state, teacher, report.id, grades, "confirmed");
    expect(next.submissions[0].status).toBe("published");
    expect(next.submissions[0].history).toHaveLength(1);
    expect(state.submissions[0].status).toBe("submitted");
    expect(
      visibleSubmissions(next, otherStudent).find((s) => s.id === report.id)
        ?.summary,
    ).toBe("confirmed");
  });
  it("does not allow confirmation while grading or before rubric confirmation", () => {
    const state = freshState();
    const a = state.assignments[0];
    const report = state.submissions[0];
    const grades = fixtureGrades(a, report.studentId);
    report.status = "grading";
    expect(() =>
      publishReview(state, teacher, report.id, grades, ""),
    ).toThrow();
    report.status = "review";
    a.confirmed = false;
    expect(() =>
      publishReview(state, teacher, report.id, grades, ""),
    ).toThrow();
  });
  it("uses only confirmed course reports for learning statistics and ignores private chat", () => {
    const state = freshState();
    state.chats[chatKey(student, "mat-tcp")] = [
      { id: "secret", role: "user", text: "private question" },
    ];
    const before = courseStats(state, teacher, "network");
    expect(before.average).toBeNull();
    expect(before.confirmed).toHaveLength(0);
    expect(before.reports).toHaveLength(2);
    const a = state.assignments[0];
    const report = state.submissions[0];
    const next = publishReview(
      state,
      teacher,
      report.id,
      fixtureGrades(a, report.studentId),
      "",
    );
    expect(courseStats(next, teacher, "network").average).toBe(88);
    expect(() => courseStats(state, otherTeacher, "network")).toThrow();
    expect(() => courseStats(state, student, "network")).toThrow();
  });
});
describe("custom grading criteria", () => {
  it("requires manual review for criteria outside the supported sample", () => {
    const a = freshState().assignments[0];
    a.rubric.push({
      id: "custom",
      title: "自定义要求",
      criterion: "新的要求",
      max: 5,
    });
    const grades = fixtureGrades(a, "s-xu");
    expect(grades[4].score).toBeNull();
    expect(grades[4].evidence).toBe("");
    expect(() => gradeTotal(grades, a)).toThrow();
  });
  it("does not combine different rubric criteria just because they occupy the same position", () => {
    const state = freshState();
    const a = state.assignments[0];
    const altered = {
      ...a,
      id: "lab-new",
      rubric: a.rubric.map((r, i) =>
        i === 0 ? { ...r, title: "另一种能力", criterion: "不同判据" } : r,
      ),
    };
    state.assignments.push(altered);
    const original = state.submissions[0];
    state.submissions[0] = {
      ...original,
      status: "published",
      grades: fixtureGrades(a, original.studentId),
    };
    state.submissions.push({
      ...original,
      id: "different",
      assignmentId: altered.id,
      status: "published",
      grades: fixtureGrades(a, original.studentId),
    });
    const groups = criterionStats(state, teacher, "network");
    expect(groups).toHaveLength(5);
    expect(groups.find((g) => g.title === "另一种能力")?.count).toBe(1);
  });
});
describe("file validation", () => {
  it("supports all agreed formats and rejects empty, unsupported, and over-limit files", () => {
    for (const ext of ["pdf", "ppt", "pptx", "docx", "png", "jpg", "jpeg"])
      expect(validateFile({ name: "file." + ext, size: MAX_FILE_BYTES })).toBe(
        ext === "jpeg" ? "JPG" : ext.toUpperCase(),
      );
    expect(() =>
      validateFile({ name: "a.pdf", size: MAX_FILE_BYTES + 1 }),
    ).toThrow();
    expect(() => validateFile({ name: "a.exe", size: 100 })).toThrow();
    expect(() => validateFile({ name: "a.pdf", size: 0 })).toThrow();
  });
});
