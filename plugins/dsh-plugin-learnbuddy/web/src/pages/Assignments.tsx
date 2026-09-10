import { useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CheckCheck,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  Clock3,
  FileText,
  FileUp,
  LoaderCircle,
  MessageSquare,
  Plus,
  Save,
  Sparkles,
  Upload,
  Users,
  X,
} from "lucide-react";
import { useStore } from "../store-context";
import {
  assertTeacher,
  canSeeAssignment,
  courseStats,
  criterionStats,
  gradeTotal,
  hasCourse,
  publishReview,
  validateFile,
  visibleAssignments,
  visibleCourses,
  visibleMaterials,
  visibleSubmissions,
} from "../domain";
import {
  courses,
  demoReportText,
  enrollments,
  makeRubric,
  users,
} from "../seed";
import { saveBlob } from "../storage";
import {
  AILabel,
  BlobPreview,
  BusyLabel,
  CourseBadge,
  Diagram,
  Empty,
  FileIcon,
  Modal,
  PageHeading,
  SectionHeading,
  Status,
  downloadBlob,
} from "../ui";
import { ChatPanel } from "./Material";
import type { Assignment, Grade, Submission } from "../types";

function studentName(id: string) {
  return users.find((u) => u.id === id)?.name || "学生";
}
function dueLabel(date: string) {
  return date ? date.slice(5).replace("-", "月") + "日" : "暂未设置";
}
function maxScore(a: Assignment) {
  return a.rubric.reduce((n, r) => n + r.max, 0);
}
function NewAssignment({ onClose }: { onClose: () => void }) {
  const { user, courseId, update, go } = useStore();
  const mine = visibleCourses(user!);
  const [target, setTarget] = useState(
    courseId === "all" ? mine[0].id : courseId,
  );
  const [title, setTitle] = useState("");
  return (
    <Modal
      title="创建实验作业"
      description="先选课程，再准备要求与评分标准。草稿只有课程教师可见。"
      onClose={onClose}
    >
      <label>
        所属课程
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          {mine.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        作业名称
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：实验三 · TCP 重传分析"
          maxLength={80}
        />
      </label>
      <div className="modal-footer">
        <button className="button secondary" onClick={onClose}>
          取消
        </button>
        <button
          className="button primary"
          disabled={!title.trim()}
          onClick={() => {
            const id = crypto.randomUUID();
            const a: Assignment = {
              id,
              courseId: target,
              title: title.trim(),
              due: "2026-09-25",
              description: "",
              materialIds: [],
              rubric: [],
              confirmed: false,
              published: false,
            };
            update((s) => ({ ...s, assignments: [a, ...s.assignments] }));
            go({ page: "assignment", id });
            onClose();
          }}
        >
          创建草稿
          <ArrowRight size={15} />
        </button>
      </div>
    </Modal>
  );
}
export function SubmitReport({
  assignment,
  onClose,
  teacher = false,
}: {
  assignment: Assignment;
  onClose: () => void;
  teacher?: boolean;
}) {
  const { user, state, update, notify } = useStore();
  const [files, setFiles] = useState<File[]>([]);
  const [sample, setSample] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const students = enrollments
    .filter((e) => e.courseId === assignment.courseId)
    .map((e) => users.find((u) => u.id === e.studentId)!);
  const [mapping, setMapping] = useState<string[]>([
    teacher ? students[0].id : user!.id,
  ]);
  function choose(incoming: FileList) {
    try {
      const next = Array.from(incoming);
      next.forEach(validateFile);
      setFiles(next);
      setSample(false);
      setMapping(
        next.map((_, i) =>
          teacher ? students[Math.min(i, students.length - 1)].id : user!.id,
        ),
      );
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function submit() {
    if (!sample && !files.length) return;
    setSaving(true);
    try {
      if (teacher) assertTeacher(user!, assignment);
      else if (!hasCourse(user!, assignment.courseId) || !assignment.published)
        throw new Error("这份作业不可提交。");
      const ids = teacher ? mapping : files.length ? [user!.id] : [user!.id];
      if (new Set(ids).size !== ids.length)
        throw new Error("每份报告需对应不同学生，请调整账号映射。");
      for (const id of ids) {
        if (!students.some((s) => s.id === id))
          throw new Error("学生不属于当前课程。");
        const prior = state.submissions.find(
          (s) => s.assignmentId === assignment.id && s.studentId === id,
        );
        if (prior?.status === "grading")
          throw new Error("该学生报告正在评阅，请稍后替换。");
        if (teacher && prior?.status === "published")
          throw new Error(
            `${studentName(id)} 已有已反馈的报告，请选择其他学生。`,
          );
      }
      const created: Submission[] = [];
      for (let i = 0; i < ids.length; i++) {
        const id = crypto.randomUUID();
        const file = files[i];
        if (file) await saveBlob(id, file);
        const prior = state.submissions.find(
          (s) => s.assignmentId === assignment.id && s.studentId === ids[i],
        );
        created.push({
          id: prior?.id || id,
          assignmentId: assignment.id,
          studentId: ids[i],
          fileName:
            file?.name || assignment.title + "_" + studentName(ids[i]) + ".pdf",
          submittedAt: new Date().toLocaleString("sv-SE").slice(0, 16),
          status: "submitted",
          blobId: file ? id : undefined,
          sampleKey: file ? undefined : assignment.courseId,
          grades: [],
          summary: "",
          history: prior?.history.length
            ? prior.history
            : prior?.status === "published"
              ? [
                  {
                    confirmedAt: prior.submittedAt,
                    grades: prior.grades,
                    summary: prior.summary,
                  },
                ]
              : [],
        });
      }
      update((s) => ({
        ...s,
        submissions: [
          ...s.submissions.filter(
            (old) => !created.some((n) => n.id === old.id),
          ),
          ...created,
        ],
      }));
      notify(
        `${created.length} 份${sample ? "演示" : ""}报告已提交，等待教师评阅。`,
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title={teacher ? "导入学生报告" : "提交实验报告"}
      description={assignment.title}
      onClose={() => !saving && onClose()}
    >
      <input
        type="file"
        hidden
        multiple={teacher}
        ref={input}
        accept=".pdf,.ppt,.pptx,.docx,.png,.jpg,.jpeg"
        onChange={(e) => e.target.files && choose(e.target.files)}
      />
      <button className="dropzone" onClick={() => input.current?.click()}>
        <span className="upload-icon">
          <FileUp size={25} />
        </span>
        <strong>
          {files.length ? `已选择 ${files.length} 份报告` : "选择实验报告文件"}
        </strong>
        <span>支持 PDF、Office 和图片 · 单个 20 MB</span>
      </button>
      <div className="sample-option">
        <div>
          <strong>先用演示报告走一遍？</strong>
          <p>使用虚构的计算机实验内容，体验完整评阅流程。</p>
        </div>
        <button
          className={"button " + (sample ? "primary" : "secondary") + " small"}
          onClick={() => {
            setSample(true);
            setFiles([]);
            setMapping([
              teacher
                ? students.find(
                    (u) =>
                      !state.submissions.some(
                        (s) =>
                          s.assignmentId === assignment.id &&
                          s.studentId === u.id &&
                          s.status === "published",
                      ),
                  )?.id || students[0].id
                : user!.id,
            ]);
            setError("");
          }}
        >
          {sample ? <Check size={14} /> : <Sparkles size={14} />}使用演示报告
        </button>
      </div>
      {(files.length > 0 || sample) && (
        <div className="report-mapping">
          {(sample ? ["内置演示报告"] : files.map((f) => f.name)).map(
            (name, i) => (
              <div key={i}>
                <FileText size={17} />
                <span>{name}</span>
                {teacher ? (
                  <select
                    aria-label={"报告" + (i + 1) + "所属学生"}
                    value={mapping[i]}
                    onChange={(e) =>
                      setMapping((m) =>
                        m.map((v, j) => (j === i ? e.target.value : v)),
                      )
                    }
                  >
                    {students.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="status gray">{user!.name}</span>
                )}
              </div>
            ),
          )}
        </div>
      )}
      <p className="inline-note">
        {teacher
          ? "请确认报告与学生的对应关系。"
          : "重新提交会保留此前已确认反馈的记录。"}{" "}
        真实文件可查看和人工评阅，AI 解析待后端接入。
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-footer">
        <button
          className="button secondary"
          disabled={saving}
          onClick={onClose}
        >
          取消
        </button>
        <button
          className="button primary"
          disabled={saving || (!files.length && !sample)}
          onClick={() => void submit()}
        >
          <Upload size={15} />
          {saving ? "正在提交…" : teacher ? "确认导入" : "确认提交"}
        </button>
      </div>
    </Modal>
  );
}
export function Assignments() {
  const { state, user, go, courseId } = useStore();
  const [creating, setCreating] = useState(false);
  const [submit, setSubmit] = useState<Assignment | null>(null);
  const [filter, setFilter] = useState("all");
  const all = visibleAssignments(state, user!).filter(
    (a) => courseId === "all" || a.courseId === courseId,
  );
  const submissions = visibleSubmissions(state, user!);
  const assignments = all.filter(
    (a) =>
      filter === "all" ||
      (filter === "pending"
        ? !submissions.some(
            (s) => s.assignmentId === a.id && s.status === "published",
          )
        : submissions.some(
            (s) => s.assignmentId === a.id && s.status === "published",
          )),
  );
  return (
    <div className="page assignments-page">
      <PageHeading
        eyebrow={
          user!.role === "teacher"
            ? "FROM PRACTICE TO PROGRESS"
            : "LEARN BY DOING"
        }
        title="作业与报告"
        description={
          user!.role === "teacher"
            ? "从实验要求到有依据的反馈，照顾每一步学习。"
            : "完成一次实验，把理解写进报告，让反馈带你再往前一步。"
        }
        action={
          user!.role === "teacher" ? (
            <button
              className="button primary"
              onClick={() => setCreating(true)}
            >
              <Plus size={16} />
              创建实验作业
            </button>
          ) : undefined
        }
      />
      <div className="list-toolbar">
        <div className="tabs">
          <button
            className={filter === "all" ? "active" : ""}
            onClick={() => setFilter("all")}
          >
            全部作业<span className="tab-count">{all.length}</span>
          </button>
          <button
            className={filter === "pending" ? "active" : ""}
            onClick={() => setFilter("pending")}
          >
            待完成
          </button>
          <button
            className={filter === "feedback" ? "active" : ""}
            onClick={() => setFilter("feedback")}
          >
            已有反馈
          </button>
        </div>
        <span className="toolbar-note">
          {courseId === "all"
            ? "全部课程"
            : courses.find((c) => c.id === courseId)?.title}
        </span>
      </div>
      <div className="assignment-list">
        {assignments.map((a) => {
          const reports = submissions.filter((s) => s.assignmentId === a.id);
          const own = reports.find((s) => s.studentId === user!.id);
          const count = enrollments.filter(
            (e) => e.courseId === a.courseId,
          ).length;
          const course = courses.find((c) => c.id === a.courseId)!;
          return (
            <article className="assignment-card" key={a.id}>
              <div className={"assignment-icon " + course.color}>
                <ClipboardList size={24} />
              </div>
              <div className="assignment-card-main">
                <div className="assignment-card-meta">
                  <CourseBadge id={a.courseId} />
                  {!a.published && <Status status="draft" />}
                  {user!.role === "student" && own && (
                    <Status status={own.status} />
                  )}
                </div>
                <button
                  className="assignment-title"
                  onClick={() => go({ page: "assignment", id: a.id })}
                >
                  {a.title}
                  <ChevronRight size={15} />
                </button>
                <p>{a.description || "尚未填写实验要求，继续完善作业草稿。"}</p>
                <footer>
                  <span>
                    <Clock3 size={13} />
                    {dueLabel(a.due)} 截止
                  </span>
                  <span>
                    <FileText size={13} />
                    {a.rubric.length} 项评分标准 · {maxScore(a)} 分
                  </span>
                  {user!.role === "teacher" && (
                    <span>
                      <Users size={13} />
                      {reports.length}/{count} 已提交
                    </span>
                  )}
                </footer>
              </div>
              <div className="assignment-card-side">
                {user!.role === "teacher" ? (
                  <>
                    <div className="mini-progress">
                      <span>
                        <strong>
                          {
                            reports.filter((s) => s.status === "published")
                              .length
                          }
                        </strong>
                        /{reports.length}
                        <small>已反馈</small>
                      </span>
                      <div>
                        <i
                          style={{
                            width: `${reports.length ? (reports.filter((s) => s.status === "published").length / reports.length) * 100 : 0}%`,
                          }}
                        />
                      </div>
                    </div>
                    <button
                      className="button secondary"
                      onClick={() => go({ page: "grading", id: a.id })}
                    >
                      进入评阅
                      <ArrowRight size={15} />
                    </button>
                  </>
                ) : (
                  <>
                    {own?.status === "published" ? (
                      <div className="assignment-score">
                        <strong>{gradeTotal(own.grades, a)}</strong>
                        <span> / {maxScore(a)}</span>
                      </div>
                    ) : (
                      <span className="muted small-copy">
                        {own ? "已提交，等待反馈" : "还未提交报告"}
                      </span>
                    )}
                    <button
                      className={"button " + (own ? "secondary" : "primary")}
                      onClick={() =>
                        own ? go({ page: "report", id: own.id }) : setSubmit(a)
                      }
                    >
                      {own ? "查看报告" : "提交报告"}
                      <ArrowRight size={15} />
                    </button>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {!assignments.length && (
        <Empty
          title="这里还没有作业"
          description="可以调整筛选，或回到全部课程查看。"
        />
      )}
      {creating && <NewAssignment onClose={() => setCreating(false)} />}{" "}
      {submit && (
        <SubmitReport assignment={submit} onClose={() => setSubmit(null)} />
      )}
    </div>
  );
}
export function AssignmentEditor({ id }: { id: string }) {
  const { state, user, go, update, notify, job, busy } = useStore();
  const a = state.assignments.find((a) => a.id === id);
  const [submit, setSubmit] = useState(false);
  const [error, setError] = useState("");
  if (!a || !canSeeAssignment(user!, a))
    return (
      <Empty
        title="无法查看这份作业"
        description="仅课程师生可以查看已发布的作业。"
      />
    );
  const teacher = user!.role === "teacher";
  const locked = state.submissions.some((s) => s.assignmentId === id);
  const own = visibleSubmissions(state, user!).find(
    (s) => s.assignmentId === id && s.studentId === user!.id,
  );
  function patch(value: Partial<Assignment>) {
    if (!teacher) return;
    assertTeacher(user!, a!);
    update((s) => ({
      ...s,
      assignments: s.assignments.map((x) =>
        x.id === id ? { ...x, ...value } : x,
      ),
    }));
  }
  function confirm(publish: boolean) {
    try {
      if (!a!.title.trim() || !a!.description.trim() || !a!.rubric.length)
        throw new Error("请完善作业名称、要求和评分标准。");
      if (
        a!.rubric.some(
          (r) =>
            !r.title.trim() ||
            !r.criterion.trim() ||
            !Number.isFinite(r.max) ||
            r.max <= 0,
        )
      )
        throw new Error("每项标准都需要名称、判据和正数分值。");
      patch({ confirmed: true, published: publish || a!.published });
      setError("");
      notify(publish ? "作业已发布给本课程学生。" : "评分标准已确认。");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function generate() {
    if (locked) return;
    void job("rubric:" + id, () => {
      const course = courses.find((c) => c.id === a!.courseId)!;
      patch({
        description: `围绕${course.title}中的本次实验主题，完成环境准备、关键操作、结果观察与分析。报告应包括：实验目标与环境、详细步骤、原始截图或运行输出、原理解释以及异常或边界情况总结。请让每个结论都有对应的证据。`,
        rubric: makeRubric(a!.courseId),
        confirmed: false,
      });
    });
  }
  return (
    <div className="page editor-page">
      <button className="back-link" onClick={() => go({ page: "assignments" })}>
        <ArrowLeft size={14} />
        作业与报告
      </button>
      <PageHeading
        title={a.title}
        description={
          teacher
            ? "清楚的要求与标准，是有效反馈的开始。"
            : "先了解要求和评分依据，再开始你的实验。"
        }
        action={
          teacher ? (
            <>
              <button
                className="button secondary"
                onClick={() => go({ page: "grading", id })}
              >
                查看报告
              </button>
              <button
                className="button primary"
                onClick={() => confirm(!a.published)}
              >
                <CheckCheck size={15} />
                {a.published ? "确认标准" : "确认并发布"}
              </button>
            </>
          ) : (
            <button
              className="button primary"
              disabled={own?.status === "grading"}
              onClick={() => setSubmit(true)}
            >
              <Upload size={15} />
              {own ? "重新提交报告" : "提交报告"}
            </button>
          )
        }
      />
      <div className="assignment-summary-line">
        <CourseBadge id={a.courseId} />
        <span>
          <Clock3 size={13} />
          {dueLabel(a.due)} 截止
        </span>
        <span className={"status " + (a.published ? "green" : "gray")}>
          {a.published ? "已发布" : "仅教师可见的草稿"}
        </span>
        {a.confirmed && (
          <span className="saved-hint">
            <Check size={12} />
            评分标准已确认
          </span>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="editor-layout">
        <div className="editor-main">
          <section className="editor-section">
            <SectionHeading
              title="实验要求"
              action={
                teacher && !locked ? (
                  <button
                    className="button secondary small"
                    disabled={busy["rubric:" + id]}
                    onClick={generate}
                  >
                    <BusyLabel busy={busy["rubric:" + id]}>
                      一键生成要求与标准
                    </BusyLabel>
                  </button>
                ) : undefined
              }
            />
            {teacher ? (
              <>
                <div className="form-grid">
                  <label>
                    作业名称
                    <input
                      value={a.title}
                      onChange={(e) => patch({ title: e.target.value })}
                    />
                  </label>
                  <label>
                    截止日期
                    <input
                      type="date"
                      value={a.due}
                      onChange={(e) => patch({ due: e.target.value })}
                    />
                  </label>
                </div>
                <label>
                  实验内容与提交要求
                  <textarea
                    rows={7}
                    value={a.description}
                    onChange={(e) =>
                      patch({ description: e.target.value, confirmed: false })
                    }
                    placeholder="说明实验任务、需要提交的内容，以及证据要求…"
                  />
                </label>
                <span className="saved-hint">
                  <Check size={12} />
                  编辑自动保存在此浏览器 · AI 生成为模拟草稿
                </span>
              </>
            ) : (
              <p className="assignment-description">{a.description}</p>
            )}
          </section>
          <section className="editor-section">
            <SectionHeading
              title="评分标准"
              count={a.rubric.length}
              action={
                <span className="rubric-total">
                  总分 <strong>{maxScore(a)}</strong>
                </span>
              }
            />
            {locked && teacher && (
              <div className="inline-banner">
                <CircleAlert size={15} />
                已有学生报告，为保持评分依据一致，本作业的评分项已锁定。
              </div>
            )}
            <div className="rubric-items">
              {a.rubric.map((r, i) => (
                <article className="rubric-item" key={r.id}>
                  <span className="number-label">0{i + 1}</span>
                  <div>
                    {teacher && !locked ? (
                      <>
                        <input
                          aria-label={"评分项" + (i + 1) + "名称"}
                          value={r.title}
                          onChange={(e) =>
                            patch({
                              confirmed: false,
                              rubric: a.rubric.map((x) =>
                                x.id === r.id
                                  ? { ...x, title: e.target.value }
                                  : x,
                              ),
                            })
                          }
                        />
                        <textarea
                          aria-label={"评分项" + (i + 1) + "判据"}
                          rows={2}
                          value={r.criterion}
                          onChange={(e) =>
                            patch({
                              confirmed: false,
                              rubric: a.rubric.map((x) =>
                                x.id === r.id
                                  ? { ...x, criterion: e.target.value }
                                  : x,
                              ),
                            })
                          }
                        />
                      </>
                    ) : (
                      <>
                        <h3>{r.title}</h3>
                        <p>{r.criterion}</p>
                      </>
                    )}
                  </div>
                  <label className="rubric-points">
                    {teacher && !locked ? (
                      <input
                        type="number"
                        min={1}
                        max={100}
                        aria-label={"评分项" + (i + 1) + "分值"}
                        value={r.max}
                        onChange={(e) =>
                          patch({
                            confirmed: false,
                            rubric: a.rubric.map((x) =>
                              x.id === r.id
                                ? { ...x, max: Number(e.target.value) }
                                : x,
                            ),
                          })
                        }
                      />
                    ) : (
                      <strong>{r.max}</strong>
                    )}
                    <span>分</span>
                  </label>
                  {teacher && !locked && (
                    <button
                      className="icon-button"
                      onClick={() =>
                        patch({
                          confirmed: false,
                          rubric: a.rubric.filter((x) => x.id !== r.id),
                        })
                      }
                      aria-label={"删除评分项" + (i + 1)}
                    >
                      <X size={14} />
                    </button>
                  )}
                </article>
              ))}
            </div>
            {teacher && !locked && (
              <button
                className="add-rubric"
                onClick={() =>
                  patch({
                    confirmed: false,
                    rubric: [
                      ...a.rubric,
                      {
                        id: crypto.randomUUID(),
                        title: "",
                        criterion: "",
                        max: 10,
                      },
                    ],
                  })
                }
              >
                <Plus size={15} />
                添加评分项
              </button>
            )}
            {!a.rubric.length && !teacher && <Empty title="评分标准尚未提供" />}
            {teacher && !a.published && (
              <div className="editor-confirm">
                <span>也可以先确认标准，直接导入报告评阅。</span>
                <button
                  className="button secondary small"
                  onClick={() => confirm(false)}
                >
                  仅确认标准
                </button>
              </div>
            )}
          </section>
        </div>
        <aside className="editor-aside">
          <div className="aside-box">
            <h3>
              <BookOpen size={16} />
              参考材料
            </h3>
            {visibleMaterials(state, user!)
              .filter((m) => m.courseId === a.courseId)
              .map((m) => (
                <div className="reference-material" key={m.id}>
                  {teacher ? (
                    <input
                      type="checkbox"
                      aria-label={"关联" + m.title}
                      checked={a.materialIds.includes(m.id)}
                      onChange={(e) =>
                        patch({
                          materialIds: e.target.checked
                            ? [...a.materialIds, m.id]
                            : a.materialIds.filter((id) => id !== m.id),
                        })
                      }
                    />
                  ) : null}
                  {(teacher || a.materialIds.includes(m.id)) && (
                    <button onClick={() => go({ page: "material", id: m.id })}>
                      <FileIcon kind={m.kind} />
                      <span>{m.title}</span>
                      <ChevronRight size={13} />
                    </button>
                  )}
                </div>
              ))}
            {!a.materialIds.length && !teacher && (
              <p className="muted">暂未关联参考材料。</p>
            )}
          </div>
          <div className="aside-note">
            <Sparkles size={18} />
            <h3>{teacher ? "给评阅一个清楚的起点" : "把过程，也写进报告"}</h3>
            <p>
              {teacher
                ? "具体说明什么证据可以支持得分。AI 先按标准逐项给出建议，最终由你复核确认。"
                : "除了结果，也记录操作步骤、关键截图和你的解释。这些都是理解发生的证据。"}
            </p>
          </div>
        </aside>
      </div>
      {submit && (
        <SubmitReport assignment={a} onClose={() => setSubmit(false)} />
      )}
    </div>
  );
}
export function Grading({ id }: { id: string }) {
  const { state, user, go, gradeReports } = useStore();
  const a = state.assignments.find((a) => a.id === id);
  const [selected, setSelected] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [filter, setFilter] = useState("all");
  if (!a || user!.role !== "teacher" || !hasCourse(user!, a.courseId))
    return <Empty title="仅课程教师可以进入评阅" />;
  const reports = visibleSubmissions(state, user!).filter(
    (s) => s.assignmentId === id,
  );
  const list = reports.filter((s) => filter === "all" || s.status === filter);
  const eligible = reports.filter(
    (s) => !["published", "grading"].includes(s.status),
  );
  const active = reports.filter((s) => s.status === "grading");
  const reviewed = reports.filter((s) =>
    ["review", "published"].includes(s.status),
  );
  return (
    <div className="page grading-page">
      <button className="back-link" onClick={() => go({ page: "assignments" })}>
        <ArrowLeft size={14} />
        作业与报告
      </button>
      <PageHeading
        title="报告评阅"
        description={a.title}
        action={
          <>
            <button
              className="button secondary"
              onClick={() => setImporting(true)}
            >
              <Upload size={15} />
              导入报告
            </button>
            <button
              className="button primary"
              disabled={!a.confirmed || !eligible.length || active.length > 0}
              onClick={() => {
                void gradeReports(
                  selected.length ? selected : eligible.map((s) => s.id),
                );
                setSelected([]);
              }}
            >
              {active.length ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Sparkles size={15} />
              )}{" "}
              {active.length
                ? "正在评阅…"
                : selected.length
                  ? `评阅选中 ${selected.length} 份`
                  : "开始批量评阅"}
            </button>
          </>
        }
      />
      <div className="grading-overview">
        <div>
          <span>已提交报告</span>
          <strong>
            {reports.length}
            <small>份</small>
          </strong>
        </div>
        <div>
          <span>待评阅</span>
          <strong>
            {
              reports.filter(
                (s) => s.status === "submitted" || s.status === "failed",
              ).length
            }
            <small>份</small>
          </strong>
        </div>
        <div>
          <span>待教师复核</span>
          <strong className="orange-text">
            {reports.filter((s) => s.status === "review").length}
            <small>份</small>
          </strong>
        </div>
        <div>
          <span>已确认反馈</span>
          <strong className="green-text">
            {reports.filter((s) => s.status === "published").length}
            <small>份</small>
          </strong>
        </div>
      </div>
      <div className="grading-basis">
        <span className="basis-icon">
          <ClipboardList size={18} />
        </span>
        <div>
          <strong>
            {a.confirmed ? "使用已确认的评分标准" : "请先确认评分标准"}
          </strong>
          <span>
            {a.rubric.length} 项 · 满分 {maxScore(a)} 分 ·{" "}
            {a.confirmed
              ? "AI 建议经教师复核后才对学生显示"
              : "完善标准后才能开始评阅"}
          </span>
        </div>
        <button
          className="text-button"
          onClick={() => go({ page: "assignment", id })}
        >
          查看标准
          <ChevronRight size={14} />
        </button>
      </div>
      {active.length > 0 && (
        <div className="batch-progress" role="status">
          <LoaderCircle size={15} className="spin" />
          <span>正在处理 {active.length} 份报告，切换页面后仍会继续。</span>
          <div>
            <i
              style={{
                width: `${(reviewed.length / Math.max(reports.length, 1)) * 100}%`,
              }}
            />
          </div>
        </div>
      )}
      <div className="list-toolbar">
        <div className="tabs">
          {[
            ["all", "全部报告"],
            ["submitted", "待评阅"],
            ["review", "待复核"],
            ["published", "已反馈"],
            ["failed", "需处理"],
          ].map(([value, label]) => (
            <button
              key={value}
              className={filter === value ? "active" : ""}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <AILabel>示例报告使用模拟评阅</AILabel>
      </div>
      <div className="grading-table">
        <div className="grading-table-head">
          <input
            type="checkbox"
            aria-label="全选可评阅报告"
            checked={
              eligible.length > 0 &&
              eligible.every((s) => selected.includes(s.id))
            }
            onChange={(e) =>
              setSelected(e.target.checked ? eligible.map((s) => s.id) : [])
            }
          />
          <span>学生 / 报告</span>
          <span>提交时间</span>
          <span>状态</span>
          <span>总分</span>
          <span />
        </div>
        {list.map((s) => (
          <div className="grading-row" key={s.id}>
            <input
              type="checkbox"
              aria-label={"选择" + studentName(s.studentId) + "的报告"}
              checked={selected.includes(s.id)}
              disabled={["grading", "published"].includes(s.status)}
              onChange={(e) =>
                setSelected((v) =>
                  e.target.checked ? [...v, s.id] : v.filter((x) => x !== s.id),
                )
              }
            />
            <button
              className="report-name"
              onClick={() => go({ page: "report", id: s.id })}
            >
              <span className="avatar">
                {studentName(s.studentId).slice(0, 1)}
              </span>
              <span>
                <strong>{studentName(s.studentId)}</strong>
                <small>
                  {s.fileName}
                  {s.sampleKey ? " · 示例" : ""}
                </small>
              </span>
            </button>
            <span className="report-date">{s.submittedAt.slice(5)}</span>
            <Status status={s.status} />
            <span className="table-score">
              {s.grades.length
                ? s.grades.reduce((n, g) => n + (g.score || 0), 0)
                : "—"}
              {s.grades.length > 0 && <small> / {maxScore(a)}</small>}
            </span>
            <button
              className="text-button"
              onClick={() => go({ page: "report", id: s.id })}
            >
              {s.status === "review" ? "去复核" : "查看"}
              <ChevronRight size={14} />
            </button>
          </div>
        ))}
      </div>
      {!list.length && (
        <Empty
          title="暂无符合条件的报告"
          description={
            reports.length
              ? "换个筛选条件试试。"
              : "学生提交后会出现在这里，也可以先导入一份演示报告。"
          }
          action={
            !reports.length ? (
              <button
                className="button secondary"
                onClick={() => setImporting(true)}
              >
                导入报告
              </button>
            ) : undefined
          }
        />
      )}
      <div className="list-footer">
        <span>每份报告独立处理，失败后可以重试或人工评阅。</span>
        <span>{list.length} 份报告</span>
      </div>
      {importing && (
        <SubmitReport
          assignment={a}
          teacher
          onClose={() => setImporting(false)}
        />
      )}
    </div>
  );
}
export function ReportWorkspace({ id }: { id: string }) {
  const { state, user, go, update, notify, gradeReports } = useStore();
  const report = visibleSubmissions(state, user!).find((s) => s.id === id);
  const a = report
    ? state.assignments.find((a) => a.id === report.assignmentId)
    : undefined;
  const teacher = user!.role === "teacher";
  const [active, setActive] = useState(0);
  const [mode, setMode] = useState<"review" | "chat">("review");
  const [confirm, setConfirm] = useState(false);
  const [resubmit, setResubmit] = useState(false);
  const [history, setHistory] = useState(false);
  const [error, setError] = useState("");
  if (!report || !a)
    return (
      <Empty
        title="无法查看这份报告"
        description="报告仅对提交者与本课程教师可见。"
      />
    );
  const feedbackVisible = teacher || report.status === "published";
  const source = demoReportText[a.courseId];
  const grades = report.grades.length
    ? report.grades
    : a.rubric.map((r) => ({
        rubricId: r.id,
        score: null,
        comment: "",
        evidence: "",
        page: 1,
      }));
  const total = grades.reduce((sum, g) => sum + (g.score || 0), 0);
  const editable = teacher && report.status !== "grading";
  function editGrade(index: number, value: Partial<Grade>) {
    const next = grades.map((g, i) => (i === index ? { ...g, ...value } : g));
    update((s) => ({
      ...s,
      submissions: s.submissions.map((r) =>
        r.id === id ? { ...r, grades: next, status: "review" } : r,
      ),
    }));
  }
  function editSummary(value: string) {
    update((s) => ({
      ...s,
      submissions: s.submissions.map((r) =>
        r.id === id ? { ...r, summary: value, status: "review" } : r,
      ),
    }));
  }
  function publish() {
    try {
      update((s) => publishReview(s, user!, id, grades, report!.summary));
      setConfirm(false);
      notify("评阅已确认，对应学生现在可以查看反馈。");
    } catch (e) {
      setError((e as Error).message);
      setConfirm(false);
    }
  }
  function beginConfirm() {
    try {
      gradeTotal(grades, a!);
      if (!a!.confirmed) throw new Error("请先确认评分标准。");
      setError("");
      setConfirm(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function download() {
    if (!report!.blobId)
      return notify("当前为内置教学示例，原始 PDF 文件尚未提供。");
    try {
      await downloadBlob(report!.blobId, report!.fileName);
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  return (
    <div className="workspace report-workspace">
      <header className="document-titlebar">
        <button
          className="icon-button"
          aria-label="返回报告列表"
          onClick={() =>
            go(
              teacher ? { page: "grading", id: a.id } : { page: "assignments" },
            )
          }
        >
          <ArrowLeft size={17} />
        </button>
        <FileIcon kind="PDF" />
        <div>
          <h1>{a.title}</h1>
          <span>
            {studentName(report.studentId)}
            <span className="separator">/</span>
            {report.fileName}
          </span>
        </div>
        <div className="document-actions">
          <Status status={report.status} />
          <button
            className="icon-button"
            onClick={() => void download()}
            aria-label="下载报告"
          >
            <ArrowDownToLine size={17} />
          </button>
        </div>
      </header>
      <div className="workspace-columns report-columns">
        <div className="document-column">
          <div className="document-toolbar">
            <span className="toolbar-section-label">
              <FileText size={14} />
              报告原文
              <span className="muted">
                {report.sampleKey ? " · 教学示例" : ""}
              </span>
            </span>
            <CourseBadge id={a.courseId} />
          </div>
          <div className="document-scroll">
            {report.blobId ? (
              <BlobPreview blobId={report.blobId} name={report.fileName} />
            ) : (
              <article className="document-paper report-paper">
                <div className="paper-topline">
                  <span>EXPERIMENT REPORT</span>
                  <span>示例报告</span>
                </div>
                <h2>{a.title.replace(/实验[一二三] · /, "")}</h2>
                <div className="paper-meta">
                  <span>{studentName(report.studentId)}</span>
                  <span>·</span>
                  <span>{report.submittedAt.slice(0, 10)}</span>
                </div>
                <div className="paper-rule" />
                {[0, 1, 2].map((i) => (
                  <section
                    className={
                      "report-section " +
                      (feedbackVisible &&
                      grades[active]?.evidence === source[i * 2 + 1]
                        ? "evidence-active"
                        : "")
                    }
                    key={i}
                  >
                    <h3>
                      <span>0{i + 1}</span>
                      {source[i * 2]}
                    </h3>
                    <p>{source[i * 2 + 1]}</p>
                    {i === 1 && (
                      <>
                        <div className="report-evidence-label">
                          实验图示 · 内置示意，非学生真实截图
                        </div>
                        <Diagram
                          type={
                            a.courseId === "network"
                              ? "handshake"
                              : a.courseId === "os"
                                ? "queue"
                                : "index"
                          }
                        />
                      </>
                    )}
                  </section>
                ))}
                <div className="report-end">— 实验报告结束 —</div>
              </article>
            )}
          </div>
          <footer className="page-navigation">
            <span>{report.sampleKey ? "虚构教学报告" : "已保存原始文件"}</span>
            <span>{report.submittedAt} 提交</span>
          </footer>
        </div>
        <aside className="review-column">
          <div className="assistant-tabs">
            <button
              className={mode === "review" ? "active" : ""}
              onClick={() => setMode("review")}
            >
              <ClipboardList size={14} />
              {teacher ? "逐项复核" : "评阅反馈"}
            </button>
            {feedbackVisible && (
              <button
                className={mode === "chat" ? "active" : ""}
                onClick={() => setMode("chat")}
              >
                <MessageSquare size={14} />
                聊聊反馈
              </button>
            )}
          </div>
          {mode === "chat" && feedbackVisible ? (
            <ChatPanel report={report} />
          ) : (
            <div className="review-content">
              {!feedbackVisible ? (
                <div className="pending-review">
                  <span className="pending-icon">
                    <Clock3 size={28} />
                  </span>
                  <h2>报告已送达，等一份认真反馈。</h2>
                  <p>
                    教师正在安排评阅。只有经过教师确认的结果才会显示在这里。
                  </p>
                  <div className="submission-timeline">
                    <span>
                      <Check size={14} />
                      报告已提交
                    </span>
                    <i />
                    <span>
                      <Clock3 size={14} />
                      等待教师评阅与确认
                    </span>
                    <i />
                    <span className="muted">
                      <MessageSquare size={14} />
                      查看反馈与改进建议
                    </span>
                  </div>
                  <button
                    className="button secondary"
                    disabled={report.status === "grading"}
                    onClick={() => setResubmit(true)}
                  >
                    重新提交报告
                  </button>
                </div>
              ) : (
                <>
                  <div className="review-score">
                    <div>
                      <span>
                        {report.status === "published"
                          ? "教师确认总分"
                          : teacher
                            ? "当前评阅建议"
                            : "评阅总分"}
                      </span>
                      <div>
                        <strong>{total}</strong>
                        <span>/ {maxScore(a)}</span>
                      </div>
                    </div>
                    <span
                      className={
                        "score-stamp " +
                        (report.status === "published" ? "confirmed" : "")
                      }
                    >
                      <CheckCheck size={21} />
                      <span>
                        {report.status === "published" ? "已确认" : "待复核"}
                      </span>
                    </span>
                  </div>
                  {report.status === "published" ? (
                    <div className="confirmed-note">
                      <Check size={13} />
                      教师已确认，学生可见
                    </div>
                  ) : (
                    <div className="review-notice">
                      <Sparkles size={15} />
                      <span>
                        {report.sampleKey
                          ? "演示评分建议，请逐项核对后确认。"
                          : "真实文件的 AI 解析待接入，可先人工评分。"}
                      </span>
                    </div>
                  )}
                  {report.failure && (
                    <div className="inline-banner error-banner">
                      <CircleAlert size={16} />
                      <span>{report.failure}</span>
                    </div>
                  )}
                  {teacher &&
                    ["submitted", "failed"].includes(report.status) && (
                      <button
                        className="button secondary full"
                        onClick={() => void gradeReports([id])}
                      >
                        <Sparkles size={15} />
                        {report.status === "failed"
                          ? "重试 AI 评阅"
                          : "生成演示评阅建议"}
                      </button>
                    )}
                  {report.status === "grading" && (
                    <div className="loading">
                      <LoaderCircle size={18} className="spin" />
                      正在按评分标准逐项处理…
                    </div>
                  )}
                  <div className="review-items">
                    {a.rubric.map((r, i) => {
                      const g = grades[i];
                      return (
                        <article
                          className={
                            "review-item " + (active === i ? "active" : "")
                          }
                          key={r.id}
                        >
                          <button
                            className="review-item-heading"
                            onClick={() => setActive(i)}
                          >
                            <span
                              className={
                                "criterion-dot " +
                                (g.score !== null && g.score === r.max
                                  ? "green"
                                  : "orange")
                              }
                            >
                              {g.score === r.max ? <Check size={12} /> : i + 1}
                            </span>
                            <strong>{r.title}</strong>
                            <span>
                              {g.score ?? "—"}
                              <small> / {r.max}</small>
                            </span>
                            <ChevronRight size={13} />
                          </button>
                          {active === i && (
                            <div className="review-item-body">
                              <p className="criterion-description">
                                {r.criterion}
                              </p>
                              {g.evidence ? (
                                <button
                                  className="evidence-quote"
                                  onClick={() =>
                                    document
                                      .querySelector(".evidence-active")
                                      ?.scrollIntoView({
                                        behavior: "smooth",
                                        block: "center",
                                      })
                                  }
                                >
                                  <span>
                                    <FileText size={12} />
                                    原文依据
                                  </span>
                                  <p>“{g.evidence}”</p>
                                  <small>
                                    查看左侧对应段落
                                    <ArrowLeft size={11} />
                                  </small>
                                </button>
                              ) : (
                                <div className="no-evidence">
                                  {report.sampleKey
                                    ? "可先生成建议，再核对原文依据。"
                                    : "请结合左侧原文件人工核对。"}
                                </div>
                              )}
                              {editable ? (
                                <>
                                  <label className="score-input-label">
                                    本项得分
                                    <div>
                                      <input
                                        type="number"
                                        min={0}
                                        max={r.max}
                                        step="0.5"
                                        aria-label={r.title + "得分"}
                                        value={g.score ?? ""}
                                        onChange={(e) =>
                                          editGrade(i, {
                                            score:
                                              e.target.value === ""
                                                ? null
                                                : Number(e.target.value),
                                          })
                                        }
                                      />
                                      <span>/ {r.max}</span>
                                    </div>
                                  </label>
                                  <label>
                                    评语
                                    <textarea
                                      rows={3}
                                      value={g.comment}
                                      onChange={(e) =>
                                        editGrade(i, {
                                          comment: e.target.value,
                                        })
                                      }
                                      placeholder="说明得分依据与改进方向…"
                                    />
                                  </label>
                                </>
                              ) : (
                                <p className="grade-comment">{g.comment}</p>
                              )}
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                  <div className="overall-feedback">
                    <h3>{teacher ? "综合评语" : "下一步，可以这样改进"}</h3>
                    {editable ? (
                      <textarea
                        aria-label="综合评语"
                        rows={4}
                        value={report.summary}
                        onChange={(e) => editSummary(e.target.value)}
                        placeholder="写下对报告的整体反馈…"
                      />
                    ) : (
                      <p>
                        {report.summary ||
                          "结合逐项反馈，补充证据与分析，让每个结论都能被验证。"}
                      </p>
                    )}
                    {!teacher && (
                      <AILabel>学习建议示例 · 以教师反馈为准</AILabel>
                    )}
                  </div>
                  {error && (
                    <p className="form-error" role="alert">
                      {error}
                    </p>
                  )}
                  {teacher ? (
                    <div className="review-confirm">
                      <span>
                        <Save size={12} />
                        {report.status === "published"
                          ? "反馈已确认并保留记录"
                          : "修改已保存为待复核记录"}
                      </span>
                      <button
                        className="button primary full"
                        disabled={!editable}
                        onClick={beginConfirm}
                      >
                        <CheckCheck size={16} />
                        {report.status === "published"
                          ? "再次确认反馈"
                          : "确认并反馈给学生"}
                      </button>
                    </div>
                  ) : (
                    <button
                      className="button secondary full"
                      onClick={() => setResubmit(true)}
                    >
                      根据反馈重新提交
                      <ArrowRight size={14} />
                    </button>
                  )}
                </>
              )}
              {report.history.length > 0 && (
                <button
                  className="history-button"
                  onClick={() => setHistory(true)}
                >
                  <Clock3 size={13} />
                  查看 {report.history.length} 次确认记录
                  <ChevronRight size={13} />
                </button>
              )}
            </div>
          )}
        </aside>
      </div>
      {confirm && (
        <Modal
          title="确认这份评阅反馈"
          description={`${studentName(report.studentId)} · ${a.title}`}
          onClose={() => setConfirm(false)}
        >
          <div className="confirmation-score">
            <span>确认总分</span>
            <strong>
              {total}
              <small> / {maxScore(a)}</small>
            </strong>
          </div>
          <p className="inline-note">
            确认后，该学生会看到逐项分数、评语和依据。你仍可以再次修改并确认，历史记录会保留。
          </p>
          <div className="modal-footer">
            <button
              className="button secondary"
              onClick={() => setConfirm(false)}
            >
              继续复核
            </button>
            <button className="button primary" onClick={publish}>
              <CheckCheck size={15} />
              确认反馈
            </button>
          </div>
        </Modal>
      )}
      {resubmit && (
        <SubmitReport assignment={a} onClose={() => setResubmit(false)} />
      )}{" "}
      {history && (
        <Modal title="历次确认记录" onClose={() => setHistory(false)}>
          <div className="history-list">
            {report.history
              .slice()
              .reverse()
              .map((v, i) => (
                <article key={i}>
                  <span>{v.confirmedAt.slice(0, 16).replace("T", " ")}</span>
                  <strong>
                    {v.grades.reduce((n, g) => n + (g.score || 0), 0)} 分
                  </strong>
                  <p>{v.summary || "已确认逐项反馈。"}</p>
                </article>
              ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
export function Insights() {
  const { state, user, courseId, go, update, job, busy } = useStore();
  const mine = visibleCourses(user!);
  const [chosen, setChosen] = useState(
    courseId === "all" ? mine[0]?.id : courseId,
  );
  if (user!.role !== "teacher" || !chosen || !hasCourse(user!, chosen))
    return <Empty title="教学反馈仅对课程教师开放" />;
  const stats = courseStats(state, user!, chosen);
  const assignments = state.assignments.filter((a) => a.courseId === chosen);
  const averages = criterionStats(state, user!, chosen);
  const weakest = averages.length
    ? averages.reduce((a, b) => (a.value < b.value ? a : b))
    : { title: "", value: 0 };
  const hasFeedback = state.generatedFeedback[chosen];
  return (
    <div className="page insights-page">
      <PageHeading
        eyebrow="UNDERSTAND THEIR LEARNING"
        title="教学反馈"
        description="从学生交来的报告里，看见理解，也看见下一堂课的方向。"
        action={
          <select
            className="course-select"
            aria-label="反馈所属课程"
            value={chosen}
            onChange={(e) => setChosen(e.target.value)}
          >
            {mine.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        }
      />
      <div className="insights-scope">
        <CourseBadge id={chosen} />
        <span>仅统计本课程作业报告 · 不读取学生私人对话</span>
      </div>
      <div className="grading-overview insights-overview">
        <div>
          <span>课程学生</span>
          <strong>
            {stats.studentCount}
            <small>人</small>
          </strong>
        </div>
        <div>
          <span>收到报告</span>
          <strong>
            {stats.reports.length}
            <small>份</small>
          </strong>
        </div>
        <div>
          <span>已确认反馈</span>
          <strong>
            {stats.confirmed.length}
            <small>份</small>
          </strong>
        </div>
        <div>
          <span>平均得分率</span>
          <strong className="green-text">
            {stats.average ?? "—"}
            <small>{stats.average !== null ? "%" : ""}</small>
          </strong>
        </div>
      </div>
      <div className="insight-grid">
        <section className="insight-chart">
          <SectionHeading title="哪些环节，需要多一点关注" />
          <p className="muted">仅合并名称与判据相同的评分项，按得分率汇总</p>
          {stats.confirmed.length ? (
            <div className="bar-chart">
              {averages.map((r, i) => (
                <div className="bar-row" key={r.key}>
                  <span className="bar-label">
                    <span>0{i + 1}</span>
                    {r.title}
                  </span>
                  <div className="bar-track">
                    <i
                      className={r.value === weakest.value ? "weak" : ""}
                      style={{ width: r.value + "%" }}
                    />
                  </div>
                  <strong>{r.value}%</strong>
                </div>
              ))}
              <div className="chart-axis">
                <span>0%</span>
                <span>50%</span>
                <span>100%</span>
              </div>
            </div>
          ) : (
            <Empty
              title="等待第一份已确认的评阅"
              description="复核报告并反馈后，这里会显示真实汇总结果。"
              action={
                <button
                  className="button secondary"
                  onClick={() => go({ page: "assignments" })}
                >
                  去评阅报告
                  <ArrowRight size={14} />
                </button>
              }
            />
          )}
        </section>
        <section className="teaching-insight">
          <span className="insight-spark">
            <Sparkles size={24} />
          </span>
          <h2>把观察，变成下一次教学行动。</h2>
          <p>围绕已确认报告中的共性问题，整理可参考的课堂调整建议。</p>
          <button
            className="button primary"
            disabled={!stats.confirmed.length || busy["insights:" + chosen]}
            onClick={() =>
              void job("insights:" + chosen, () =>
                update((s) => ({
                  ...s,
                  generatedFeedback: { ...s.generatedFeedback, [chosen]: true },
                })),
              )
            }
          >
            <BusyLabel busy={busy["insights:" + chosen]}>
              {hasFeedback ? "更新教学建议" : "生成教学建议"}
            </BusyLabel>
          </button>
          <AILabel>模拟建议 · 依据报告汇总</AILabel>
        </section>
      </div>
      {hasFeedback && stats.confirmed.length > 0 && (
        <section className="insight-recommendations">
          <SectionHeading
            title="下一次课堂，可以从这里开始"
            action={
              <span className="muted">
                基于 {stats.confirmed.length} 份已确认报告
              </span>
            }
          />
          <div>
            {[
              {
                title: "先补齐共同的薄弱处",
                text: `当前“${weakest.title}”得分率较低（${weakest.value}%）。可以先展示一段匿名示例，让学生指出证据与解释之间的缺口。`,
              },
              {
                title: "把评分依据变成课堂练习",
                text: "选一项评分标准，请学生两两对照报告，分别指出满足标准的证据与缺少的信息。",
              },
              {
                title: "用下一次提交观察变化",
                text: "保留本次反馈，下一次检查学生是否补充了实验条件、关键标注与原理解释。小样本结果仅作教学参考。",
              },
            ].map((r, i) => (
              <article key={r.title}>
                <span className="number-label">0{i + 1}</span>
                <h3>{r.title}</h3>
                <p>{r.text}</p>
              </article>
            ))}
          </div>
        </section>
      )}
      <section className="insight-reports">
        <SectionHeading title="反馈来源" count={stats.confirmed.length} />
        {stats.confirmed.map((s) => (
          <button key={s.id} onClick={() => go({ page: "report", id: s.id })}>
            <span className="avatar">
              {studentName(s.studentId).slice(0, 1)}
            </span>
            <span>
              <strong>{studentName(s.studentId)}</strong>
              <small>
                {assignments.find((a) => a.id === s.assignmentId)!.title}
              </small>
            </span>
            <Status status="published" />
            <ChevronRight size={15} />
          </button>
        ))}
        {!stats.confirmed.length && (
          <p className="muted">
            暂无已确认反馈。待评阅和待复核的分数不会进入统计。
          </p>
        )}
      </section>
    </div>
  );
}
