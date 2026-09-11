import { describe, expect, it } from "vitest";
import { courseForRoute, parseRoute, routeHash } from "./navigation";
import { freshState } from "./seed";

describe("course navigation", () => {
  it("has different destinations for all three material ancestors", () => {
    const destinations = [{ page: "home" as const }, { page: "courses" as const }, { page: "course" as const, id: "network" }].map(routeHash);
    expect(new Set(destinations).size).toBe(3);
    expect(destinations.map(parseRoute)).toEqual([{ page: "home" }, { page: "courses" }, { page: "course", id: "network" }]);
  });
  it("keeps the assignment course filter in the URL for back and forward navigation", () => {
    const route = { page: "assignments" as const, courseId: "network" };
    expect(parseRoute(routeHash(route))).toEqual(route);
    expect(courseForRoute(parseRoute("#assignments/network"), freshState())).toBe("network");
    expect(courseForRoute(parseRoute("#assignments"), freshState())).toBe("all");
  });
  it("derives a material or feedback course from its actual record", () => {
    const state = freshState();
    expect(courseForRoute({ page: "material", id: "mat-tcp" }, state)).toBe("network");
    const submission = state.submissions[0];
    const assignment = state.assignments.find((a) => a.id === submission.assignmentId)!;
    expect(courseForRoute({ page: "report", id: submission.id }, state)).toBe(assignment.courseId);
    expect(courseForRoute({ page: "material", id: "missing" }, state)).toBeUndefined();
  });
  it("maps the old library link to courses and recovers malformed links", () => {
    expect(parseRoute("#library")).toEqual({ page: "courses" });
    expect(parseRoute("#material/%E0%A4%A")).toEqual({ page: "home" });
    expect(parseRoute("#unexpected")).toEqual({ page: "home" });
  });
});
