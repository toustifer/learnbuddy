import type { DemoState, Route } from "./types";

export function parseRoute(hash: string): Route {
  const [page, value] = hash.replace(/^#/, "").split("/");
  let id = "";
  try { id = decodeURIComponent(value || ""); } catch { return { page: "home" }; }
  if (["course", "material", "assignment", "grading", "report"].includes(page) && id)
    return { page, id } as Route;
  if (page === "assignments" || page === "insights") return { page, courseId: id || "all" };
  if (page === "courses" || page === "library") return { page: "courses" };
  return { page: "home" };
}
export function routeHash(route: Route) {
  const id = "id" in route ? route.id : (route.page === "assignments" || route.page === "insights") && route.courseId !== "all" ? route.courseId : undefined;
  return `#${route.page}${id ? "/" + encodeURIComponent(id) : ""}`;
}
export function courseForRoute(route: Route, state: DemoState): string | undefined {
  if (route.page === "course") return route.id;
  if (route.page === "assignments" || route.page === "insights") return route.courseId || "all";
  if (route.page === "material") return state.materials.find((m) => m.id === route.id)?.courseId;
  const assignmentId = route.page === "report" ? state.submissions.find((s) => s.id === route.id)?.assignmentId
    : route.page === "assignment" || route.page === "grading" ? route.id : undefined;
  return assignmentId ? state.assignments.find((a) => a.id === assignmentId)?.courseId : undefined;
}
