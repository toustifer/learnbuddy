import { randomUUID } from "node:crypto";
import { resolveActorFromRequest } from "../services/auth.js";
import { projectSubmissions } from "../contracts/projection.js";

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

export function buildWorkspace(store, userId) {
  const user = userId && store.getUser(userId);
  if (!user) fail(401, "请先登录。");
  const courses = store.getUserCourses(user.id);
  const assignments = store.getAssignments(user.id);
  // 字段裁剪一律交给投影契约（见 src/contracts/projection.js）。
  // 此前这里是**第三处**手写投影，而且比 store 里那两处多清了 history ——
  // 三处规则不一致，正是投影必须收敛到一处的理由。
  const submissions = projectSubmissions(
    assignments.flatMap((a) => store.getSubmissions(user.id, a.id)),
    user
  );
  const roster = user.role === "teacher"
    ? courses.flatMap((c) => store.listUsers()
      .filter((u) => u.role === "student" && store.isEnrolled(c.id, u.id))
      .map((u) => ({ courseId: c.id, student: u })))
    : [];
  return { courses, assignments, submissions, roster };
}

export function saveAssignment(store, userId, input, id) {
  const user = userId && store.getUser(userId);
  if (!user) fail(401, "请先登录。");
  const current = id ? store.getAssignment(id, userId) : null;
  if (id && !current) fail(404, "作业不存在或无权访问。");
  const courseId = current?.courseId || input.courseId;
  if (user.role !== "teacher" || !store.hasCourse(userId, courseId))
    fail(403, "仅任课教师可以管理作业。");
  const title = String(input.title || "").trim();
  const description = String(input.description || "").trim();
  if (!title || title.length > 120 || description.length > 12000)
    fail(400, "请填写作业名称，并检查文字长度。");
  const due = String(input.due || "");
  if (due && (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$/.test(due) || Number.isNaN(Date.parse(due))))
    fail(400, "截止时间格式不正确。");
  const rubric = input.rubric;
  if (!Array.isArray(rubric) || rubric.length > 30)
    fail(400, "评分标准格式不正确。");
  if (rubric.some((r) => !r.id || !String(r.title || "").trim() ||
    !String(r.criterion || "").trim() || typeof r.max !== "number" || !Number.isFinite(r.max) || r.max <= 0 || r.max > 1000) ||
    new Set(rubric.map((r) => r.id)).size !== rubric.length)
    fail(400, "每项评分标准需要唯一编号、名称、要求及有效分值。");
  const published = input.published === true;
  if (published && (!description || !rubric.length || input.confirmed !== true))
    fail(400, "发布前请填写任务要求并确认评分标准。");
  if (current && store.listSubmissions(id).length &&
    (JSON.stringify(rubric) !== JSON.stringify(current.rubric) || !published))
    fail(409, "已有学生提交，请保留原评分标准和发布状态。");
  const materialIds = Array.isArray(input.materialIds) ? input.materialIds : [];
  if (materialIds.some((m) => {
    const material = store.getMaterialById(m, userId);
    return !material || material.courseId !== courseId || material.visibility !== "course";
  })) fail(400, "作业只能关联本课程已共享的资料。");
  const assignment = { id: id || randomUUID(), courseId, title, description, due,
    rubric: rubric.map(({ id: rubricId, title, criterion, max }) => ({ id: rubricId, title: String(title).trim(), criterion: String(criterion).trim(), max })),
    materialIds, confirmed: input.confirmed === true, published };
  return current ? store.updateAssignment(id, assignment) : store.createAssignment(assignment);
}

export function registerTeachingRoutes(server, { store, readJson, sendJson }) {
  server.use(async (req, res, next) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const edit = path.match(/^\/api\/learnbuddy\/assignments\/([^/]+)$/);
    const workspace = req.method === "GET" && path === "/api/learnbuddy/workspace";
    const create = req.method === "POST" && path === "/api/learnbuddy/assignments";
    if (!workspace && !create && !(edit && req.method === "PUT")) return next();
    try {
      // 身份绑定：本中间件注册在 api.js 的统一门槛之前，必须自己解析身份，
      // 否则 /workspace 与作业增改会绕过鉴权。解析逻辑复用 auth.js，不另写一套。
      const auth = resolveActorFromRequest(store, req);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
      const userId = auth.user.id;

      if (workspace) return sendJson(res, 200, { ok: true, ...buildWorkspace(store, userId) });
      const body = await readJson(req);
      const assignment = saveAssignment(store, userId, body, edit ? decodeURIComponent(edit[1]) : null);
      return sendJson(res, create ? 201 : 200, { ok: true, assignment });
    } catch (error) {
      return sendJson(res, error.status || 400, { ok: false, error: error.message });
    }
  });
}
