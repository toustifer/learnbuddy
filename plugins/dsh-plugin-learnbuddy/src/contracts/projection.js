/**
 * 契约层：投影
 *
 * 依据《契约层规范》的「投影契约」与 D2：
 *   教师确认后学生才可查看自己的分数、详细评语与依据；
 *   **确认前由「服务端」移除敏感评分字段及历史泄漏**。
 *
 * ## 为什么要有这个文件
 *
 * 原先投影散在三处，各写各的规则，而且都是**黑名单**（把 `grades` 清空、
 * 把 `summary` 清空）：
 *
 *   - `store.getSubmission`（学生·未发布）清 `grades` / `summary` / `failure`
 *   - `store.getSubmissions`（学生·未发布）同上
 *   - `teaching.buildWorkspace`（学生·未发布）**额外清了 `history`**
 *
 * 三处规则不一致，而 `history` 里**装着历次评分的 grades 与 summary**
 * ——黑名单漏掉它，就等于留了一条分数泄漏通道（只要某份提交变成
 * 「未发布但 history 非空」，学生就能从 `history` 里读到分）。
 *
 * ## 为什么改成白名单
 *
 * 黑名单的失效模式是「**忘了加新字段**」，而漏掉的字段迟早会出现；
 * 白名单的失效模式是「新字段默认不可见」，**错了也不会泄漏**。
 * 投影是安全边界，必须让它**默认安全**。
 *
 * 因此：**未列出的字段一律不对外暴露**。将来给提交加字段，默认谁都看不到，
 * 要暴露必须显式写进下面的白名单。
 */

/**
 * 提交对象的对外字段白名单。
 *
 * ⚠️ 这份表就是「学生能看到什么」的唯一定义处。
 * 要暴露新字段，必须显式加到对应分组，并同步更新本文件的说明与测试。
 */
export const SUBMISSION_VIEW_FIELDS = {
  /** 与发布状态无关：任何**有权限**的身份都能看到（权限本身由路由与 store 判定） */
  always: [
    "id",
    "assignmentId",
    "studentId",
    "fileName",
    "submittedAt",
    "status",
    "sampleKey",
    "blobId"
  ],

  /**
   * 评分相关：**学生仅在已发布时可见**，未发布时置空。
   *
   * `history` 必须在这里：它装着历次评分的 `grades` 与 `summary`，
   * 是黑名单写法最容易漏掉的一条泄漏通道。
   */
  graded: ["grades", "summary", "history"],

  /**
   * 仅教师可见。**学生视图永不包含**（不是置空，是整个键都不出现）。
   *
   * `failure` 里是内部失败原因，可能带解析细节或模型错误，不适合给学生看。
   */
  teacherOnly: ["failure"]
};

/** 未发布时，评分相关字段的置空值。保持键存在，形状才稳定（对 Agent 也更好用）。 */
const EMPTIED = { grades: [], summary: "", history: [] };

/**
 * 教师视图：完整对象（白名单内的字段全给，值不裁剪）。
 *
 * @param {object|null} submission `mapSubmission` 产出的对象
 * @returns {object|null}
 */
export function toTeacherSubmissionView(submission) {
  if (!submission) return null;
  const view = {};
  for (const field of SUBMISSION_VIEW_FIELDS.always) view[field] = submission[field];
  for (const field of SUBMISSION_VIEW_FIELDS.graded) view[field] = submission[field];
  for (const field of SUBMISSION_VIEW_FIELDS.teacherOnly) view[field] = submission[field];
  return view;
}

/**
 * 学生视图：只含白名单字段；未发布时评分相关字段置空。
 *
 * **`teacherOnly` 里的字段一个都不会出现**，因此不存在「漏清某个字段」的可能。
 *
 * @param {object|null} submission
 * @returns {object|null}
 */
export function toStudentSubmissionView(submission) {
  if (!submission) return null;
  const published = submission.status === "published";

  const view = {};
  for (const field of SUBMISSION_VIEW_FIELDS.always) view[field] = submission[field];
  for (const field of SUBMISSION_VIEW_FIELDS.graded) {
    view[field] = published ? submission[field] : EMPTIED[field];
  }
  return view;
}

/**
 * 按身份分发投影。**服务端只在这里决定「谁看到什么」**，
 * 前端不得依赖自身过滤（规范明确要求投影在服务端完成）。
 *
 * @param {object|null} submission
 * @param {{role?: string}|null} actor
 * @returns {object|null}
 */
export function projectSubmission(submission, actor) {
  if (!submission) return null;
  return actor && actor.role === "teacher"
    ? toTeacherSubmissionView(submission)
    : toStudentSubmissionView(submission);
}

/**
 * 批量投影。
 *
 * @param {object[]} submissions
 * @param {{role?: string}|null} actor
 * @returns {object[]}
 */
export function projectSubmissions(submissions, actor) {
  if (!Array.isArray(submissions)) return [];
  return submissions.map((s) => projectSubmission(s, actor));
}

/**
 * 判断某份提交对当前身份是否「成绩可见」。
 *
 * 这一条直接对应错误码 `NOT_REVIEWED`：学生问成绩而教师尚未确认时，
 * 系统应当明确回答「老师还在复核」，而不是给出空数据让 Agent 去猜。
 *
 * @param {object} submission
 * @param {{role?: string}|null} actor
 * @returns {boolean}
 */
export function isGradeVisible(submission, actor) {
  if (!submission) return false;
  if (actor && actor.role === "teacher") return true;
  return submission.status === "published";
}
