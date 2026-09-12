import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseStore } from "../src/db/store.js";
import { buildWorkspace, saveAssignment } from "../src/routes/teaching.js";

test("workspace hides another student's records and unpublished grades including history", (t) => {
  const store = new DatabaseStore({ path: ":memory:" }); t.after(() => store.close());
  const teacher = buildWorkspace(store, "t-chen");
  const target = teacher.submissions.find((s) => s.status === "review");
  assert.ok(target);
  store.updateSubmission(target.id, { history: [{ grades: [{ score: 99 }], summary: "private draft" }], failure: "internal feedback" });
  const student = buildWorkspace(store, target.studentId);
  assert.deepEqual(student.roster, []);
  assert.ok(student.submissions.every((s) => s.studentId === target.studentId));
  const own = student.submissions.find((s) => s.id === target.id);
  assert.deepEqual(own.grades, []); assert.deepEqual(own.history, []);
  assert.equal(own.summary, ""); assert.equal(own.failure, undefined);
  assert.ok(buildWorkspace(store, "t-chen").submissions.find((s) => s.id === target.id).grades.length);
  assert.throws(() => buildWorkspace(store, "unknown"), { status: 401 });
});

test("only a course teacher can create and publish a validated assignment", (t) => {
  const store = new DatabaseStore({ path: ":memory:" }); t.after(() => store.close());
  const input = { courseId: "network", title: "测试任务", description: "完成任务", due: "2026-09-22T23:59", rubric: [{ id: "r1", title: "分析", criterion: "有原文依据", max: 100 }], materialIds: [], confirmed: true, published: true };
  assert.throws(() => saveAssignment(store, "s-yi", input), { status: 403 });
  assert.throws(() => saveAssignment(store, "t-lin", input), { status: 403 });
  assert.throws(() => saveAssignment(store, "t-chen", { ...input, confirmed: false }), { status: 400 });
  assert.throws(() => saveAssignment(store, "t-chen", { ...input, rubric: [{ ...input.rubric[0], max: -1 }] }), { status: 400 });
  assert.throws(() => saveAssignment(store, "t-chen", { ...input, materialIds: ["missing-material"] }), { status: 400 });
  const saved = saveAssignment(store, "t-chen", input);
  assert.ok(buildWorkspace(store, "s-yi").assignments.some((a) => a.id === saved.id));
});

test("submitted assignments keep their original scoring standard", (t) => {
  const store = new DatabaseStore({ path: ":memory:" }); t.after(() => store.close());
  const workspace = buildWorkspace(store, "t-chen");
  const submitted = workspace.assignments.find((a) => workspace.submissions.some((s) => s.assignmentId === a.id));
  assert.throws(() => saveAssignment(store, "t-chen", { ...submitted, rubric: [{ id: "new", title: "改分", criterion: "新要求", max: 50 }] }, submitted.id), { status: 409 });
  assert.throws(() => saveAssignment(store, "t-chen", { ...submitted, published: false }, submitted.id), { status: 409 });
});
