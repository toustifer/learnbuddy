import { useEffect, useState } from "react";
import { ArrowDownToLine, ArrowLeft, ArrowRight, Plus, RefreshCw, Search, X } from "lucide-react";
import { LIVE_MODE, fileUrl } from "../api";
import { visibleAssignments, visibleCourses } from "../domain";
import { enrollments, users } from "../seed";
import { useStore } from "../store-context";
import { CourseBadge, Empty, PageHeading } from "../ui";
import type { Submission } from "../types";
import { DshAssistant } from "../components/DshAssistant";

export function dateLabel(value?: string) {
  if (!value) return "未设置";
  const date = new Date(value.length === 10 ? `${value}T23:59:00` : value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date).replaceAll("/", "-");
}
export const scoreOf = (submission?: Submission) => submission?.grades.length
  ? Math.round(submission.grades.reduce((sum, g) => sum + (g.score ?? 0), 0) * 10) / 10 : null;
export function latestSubmission(submissions: Submission[], assignmentId: string, studentId: string) {
  return submissions.filter((s) => s.assignmentId === assignmentId && s.studentId === studentId)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || a.id.localeCompare(b.id))[0];
}
export function SubmissionStatus({ submission, teacher = false }: { submission?: Submission; teacher?: boolean }) {
  const status = submission?.status;
  const labels = {
    submitted: teacher ? "待评阅" : "已提交",
    grading: teacher ? "评阅中" : "老师评阅中",
    review: teacher ? "待复核" : "老师复核中",
    published: "已发布",
    failed: teacher ? "评阅异常" : "老师处理中",
  };
  return <span className={`state-label ${!status ? "neutral" : status === "published" ? "success" : status === "failed" && teacher ? "danger" : "pending"}`}>{status ? labels[status] : "未提交"}</span>;
}
export function AcademicNotice() {
  const { academicLoading, academicError, academic, refreshAcademic } = useStore();
  if (!LIVE_MODE) return null;
  if (academicError) return <div className="data-notice" role="alert"><span>{academicError} 课程和提交数据未更新。</span><button className="text-button" onClick={() => void refreshAcademic()}><RefreshCw size={14} />重试</button></div>;
  if (academicLoading && !academic) return <p className="data-notice" role="status">正在读取课程与提交记录…</p>;
  return null;
}
function exportTable(headers: string[], rows: (string | number)[][], name: string) {
  const cell = (value: string | number) => {
    const text = String(value);
    return `"${(/^[=+@\-\t\r]/.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`;
  };
  const url = URL.createObjectURL(new Blob(["\uFEFF" + [headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AcademicAssignments() {
  const { state, user, courseId, academic, academicLoading, academicError, refreshAcademic, go } = useStore();
  const teacher = user!.role === "teacher";
  const [view, setView] = useState<"assignments" | "students">("assignments");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("due");
  useEffect(() => { setSearch(""); setFilter("all"); }, [courseId, view]);
  const assignments = visibleAssignments(state, user!).filter((a) => courseId === "all" || a.courseId === courseId);
  const roster = LIVE_MODE ? academic?.roster || [] : enrollments.map((e) => ({ courseId: e.courseId, student: users.find((u) => u.id === e.studentId)! }));
  const assignmentRows = assignments.map((assignment) => {
    const students = roster.filter((r) => r.courseId === assignment.courseId).map((r) => r.student);
    const latest = students.map((s) => latestSubmission(state.submissions, assignment.id, s.id)).filter(Boolean) as Submission[];
    return { assignment, students, latest, mine: latestSubmission(state.submissions, assignment.id, user!.id) };
  });
  const studentRows = assignmentRows.flatMap(({ assignment, students }) => students.map((student) => ({ assignment, student, submission: latestSubmission(state.submissions, assignment.id, student.id) })));
  const visibleStudentRows = studentRows.filter((r) => `${r.student.name} ${r.student.username} ${r.assignment.title}`.toLowerCase().includes(search.toLowerCase()) &&
    (filter === "all" || (filter === "missing" ? !r.submission : r.submission?.status === filter)))
    .sort((a, b) => sort === "score" ? (scoreOf(b.submission) ?? -1) - (scoreOf(a.submission) ?? -1) : a.student.name.localeCompare(b.student.name, "zh"));
  const visibleAssignmentRows = assignmentRows.filter(({ assignment, mine }) => assignment.title.toLowerCase().includes(search.toLowerCase()) &&
    (filter === "all" || (teacher ? filter === "draft" ? !assignment.published : assignment.published : filter === "missing" ? !mine : filter === "published" ? mine?.status === "published" : mine && mine.status !== "published")))
    .sort((a, b) => sort === "name" ? a.assignment.title.localeCompare(b.assignment.title, "zh") : (a.assignment.due || "9999").localeCompare(b.assignment.due || "9999"));
  const submittedCount = teacher ? studentRows.filter((r) => r.submission).length : assignmentRows.filter((r) => r.mine).length;
  const reviewedCount = teacher ? studentRows.filter((r) => r.submission?.status === "review").length : assignmentRows.filter((r) => r.mine?.status === "published").length;
  const ready = !LIVE_MODE || !!academic;
  const course = visibleCourses(user!).find((c) => c.id === courseId);
  return <div className="page academic-page">
    <PageHeading title={teacher ? "作业管理" : "我的作业"} description={teacher ? "查看提交进度，复核评分，统一发布反馈。" : "查看任务要求、提交进度和老师反馈。"}
      action={teacher ? <button className="button primary" disabled={!ready} onClick={() => go({ page: "assignment", id: "new" })}><Plus size={16} />新建作业</button> : undefined} />
    <AcademicNotice />
    {ready && <>
      <div className="summary-line" aria-label="作业概况">
        <span><strong>{assignments.length}</strong> 项作业</span>
        <span><strong>{submittedCount}</strong> {teacher ? "份已提交" : "项已提交"}</span>
        <span><strong>{reviewedCount}</strong> {teacher ? "份待复核" : "项已反馈"}</span>
        <span className="summary-scope">{course?.title || "全部课程"}</span>
      </div>
      {teacher && <div className="view-tabs" role="tablist" aria-label="作业视图">
        <button role="tab" aria-selected={view === "assignments"} onClick={() => setView("assignments")}>作业列表</button>
        <button role="tab" aria-selected={view === "students"} onClick={() => setView("students")}>学生成绩与完成情况</button>
      </div>}
      <div className="table-controls">
        <div className="search-field compact"><Search size={15} /><input value={search} onChange={(e) => setSearch(e.target.value)} aria-label={view === "students" ? "搜索学生或作业" : "搜索作业"} placeholder={view === "students" ? "搜索学生、账号或作业…" : "搜索作业名称…"} />{search && <button aria-label="清空搜索" onClick={() => setSearch("")}><X size={13} /></button>}</div>
        <select className="compact-select" aria-label="筛选状态" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">全部状态</option>
          {teacher && view === "assignments" ? <><option value="active">已发布任务</option><option value="draft">草稿</option></> : <>
            <option value="missing">未提交</option>
            {teacher ? <><option value="submitted">待评阅</option><option value="review">待复核</option><option value="failed">评阅异常</option></> : <option value="submitted">已提交 · 待反馈</option>}
            <option value="published">已发布反馈</option>
          </>}
        </select>
        <select className="compact-select" aria-label="排序方式" value={sort} onChange={(e) => setSort(e.target.value)}>
          {view === "students" ? <><option value="due">按学生姓名</option><option value="score">按分数从高到低</option></> : <><option value="due">按截止时间</option><option value="name">按作业名称</option></>}
        </select>
        <div className="table-control-actions">
          {teacher && view === "students" && <button className="button secondary small" onClick={() => exportTable(["学生", "账号", "课程", "作业", "提交状态", "提交时间", "评分状态", "分数"], visibleStudentRows.map((r) => [r.student.name, r.student.username, visibleCourses(user!).find((c) => c.id === r.assignment.courseId)?.title || r.assignment.courseId, r.assignment.title, r.submission ? "已提交" : "未提交", r.submission?.submittedAt || "", r.submission?.status || "", scoreOf(r.submission) ?? ""]), "LearnBuddy-学生完成情况.csv")}><ArrowDownToLine size={14} />导出表格</button>}
          {LIVE_MODE && <button className="icon-button" aria-label="刷新作业数据" disabled={academicLoading} onClick={() => void refreshAcademic()}><RefreshCw size={15} className={academicLoading ? "spin" : ""} /></button>}
        </div>
      </div>
      <div className="table-scroll" tabIndex={0} aria-label={view === "students" ? "学生成绩与完成情况" : "作业列表"}>
        {teacher && view === "students" ? <table className="data-table gradebook"><thead><tr><th>学生</th><th>作业 / 课程</th><th>提交状态</th><th>提交时间</th><th className="numeric">分数</th><th>操作</th></tr></thead><tbody>
          {visibleStudentRows.map(({ assignment, student, submission }) => <tr key={assignment.id + student.id}>
            <td><strong>{student.name}</strong><small>{student.username}</small></td>
            <td><button className="cell-link" onClick={() => go({ page: "grading", id: assignment.id })}>{assignment.title}</button><small><CourseBadge id={assignment.courseId} /></small></td>
            <td><SubmissionStatus submission={submission} teacher /></td>
            <td className="cell-muted">{submission ? dateLabel(submission.submittedAt) : "—"}</td>
            <td className="numeric"><strong>{scoreOf(submission) ?? "—"}</strong>{submission?.status === "review" && <small>建议分</small>}</td>
            <td><button className="text-button" onClick={() => { try { sessionStorage.setItem("learnbuddy-review-selection", JSON.stringify({ assignmentId: assignment.id, submissionId: submission?.id })); } catch { /* Selection persistence is optional. */ } go({ page: "grading", id: assignment.id }); }}>{submission ? "查看 / 复核" : "查看任务"}<ArrowRight size={13} /></button></td>
          </tr>)}
        </tbody></table> : <table className="data-table assignment-register"><thead><tr><th>作业名称</th><th>截止时间</th>{teacher ? <><th className="numeric">提交 / 应交</th><th className="numeric">待复核</th><th className="numeric">已发布反馈</th></> : <><th>我的状态</th><th className="numeric">成绩</th></>}<th>操作</th></tr></thead><tbody>
          {visibleAssignmentRows.map(({ assignment, students, latest, mine }) => <tr key={assignment.id}>
            <td><button className="cell-link" onClick={() => go({ page: teacher ? "grading" : "assignment", id: assignment.id })}>{assignment.title}</button><small><CourseBadge id={assignment.courseId} />{!assignment.published && <span className="state-label neutral">草稿</span>}</small></td>
            <td className="cell-muted">{dateLabel(assignment.due)}</td>
            {teacher ? <><td className="numeric"><strong>{latest.length}</strong><span className="cell-muted"> / {students.length}</span></td><td className="numeric">{latest.filter((s) => s.status === "review").length || "—"}</td><td className="numeric">{latest.filter((s) => s.status === "published").length || "—"}</td></> : <><td><SubmissionStatus submission={mine} /></td><td className="numeric">{mine?.status === "published" ? scoreOf(mine) ?? "—" : "—"}</td></>}
            <td><div className="cell-actions">{teacher ? <><button className="text-button" onClick={() => go({ page: "grading", id: assignment.id })}>评阅</button><button className="text-button muted" onClick={() => go({ page: "assignment", id: assignment.id })}>设置</button></> : <button className="text-button" onClick={() => go(mine?.status === "published" ? { page: "report", id: mine.id } : { page: "assignment", id: assignment.id })}>{mine?.status === "published" ? "查看反馈" : "查看任务"}<ArrowRight size={13} /></button>}</div></td>
          </tr>)}
        </tbody></table>}
      </div>
      {!(teacher && view === "students" ? visibleStudentRows : visibleAssignmentRows).length && <Empty title={search || filter !== "all" ? "没有符合筛选条件的记录" : "当前课程暂无作业"} action={(search || filter !== "all") && <button className="text-button" onClick={() => { setSearch(""); setFilter("all"); }}>清除筛选</button>} />}
      <p className="table-footnote">{teacher ? "每位学生展示最近一次提交；未发布的建议分仅教师可见。" : "成绩与反馈在老师复核发布后展示。"}{LIVE_MODE ? " 数据来自当前教学服务。" : " 当前为本地演示数据。"}</p>
    </>}
    {!ready && !academicLoading && !academicError && <Empty title="暂无课程数据" />}
  </div>;
}

export function OnlineReport({ id }: { id: string }) {
  const { state, user, academicLoading, go } = useStore();
  const [assistant, setAssistant] = useState(false);
  const submission = state.submissions.find((s) => s.id === id && (user!.role === "teacher" || s.studentId === user!.id));
  const assignment = state.assignments.find((a) => a.id === submission?.assignmentId);
  if (!submission || !assignment) return <div className="page"><AcademicNotice />{!academicLoading && <Empty title="暂时无法查看这份报告" action={<button className="text-button" onClick={() => go({ page: "assignments" })}>返回我的作业</button>} />}</div>;
  const published = submission.status === "published";
  return <div className="page report-feedback-page">
    <button className="text-button" onClick={() => go({ page: "assignments" })}><ArrowLeft size={14} />返回作业</button>
    <PageHeading title={assignment.title} description={submission.fileName} action={<SubmissionStatus submission={submission} />} />
    <div className="feedback-layout">
      <section>
        <div className="feedback-score"><div><span>老师核定成绩</span><strong>{published ? scoreOf(submission) ?? "—" : "待发布"}</strong></div><span>满分 {assignment.rubric.reduce((n, r) => n + r.max, 0)} · {dateLabel(submission.submittedAt)} 提交</span></div>
        {published ? <>
          <section className="feedback-summary"><h2>老师反馈</h2><p>{submission.summary || "老师未填写综合评语。"}</p></section>
          <h2 className="section-title">评分明细</h2>
          <div className="table-scroll"><table className="data-table rubric-result"><thead><tr><th>评分项与反馈</th><th className="numeric">得分</th></tr></thead><tbody>{assignment.rubric.map((r) => {
            const grade = submission.grades.find((g) => g.rubricId === r.id);
            return <tr key={r.id}><td><strong>{r.title}</strong><p>{grade?.comment || "暂无逐项评语"}</p>{grade?.evidence && <details><summary>查看原文依据{grade.page ? ` · 第 ${grade.page} 页` : ""}</summary><blockquote>{grade.evidence}</blockquote></details>}</td><td className="numeric"><strong>{grade?.score ?? "—"}</strong> / {r.max}</td></tr>;
          })}</tbody></table></div>
        </> : <Empty title="报告已提交，等待老师发布反馈" description="评分与评语会在老师复核后统一显示。" />}
        <div className="online-actions">{submission.blobId && <a className="button secondary" href={fileUrl(submission.blobId)} target="_blank" rel="noreferrer">查看提交原件</a>}{published && <button className="button secondary" onClick={() => setAssistant((v) => !v)}>{assistant ? "收起反馈助手" : "请助手解释反馈"}</button>}</div>
      </section>
      {assistant && published && <aside className="feedback-assistant"><DshAssistant report={submission} /></aside>}
    </div>
  </div>;
}

export function CourseOverview() {
  const { academic, state, user, setCourseId } = useStore();
  return <div className="page"><PageHeading title="学情分析" description="先看各课程的提交与反馈，再进入课程查看评分项表现。" /><AcademicNotice />{academic && <div className="table-scroll"><table className="data-table"><thead><tr><th>课程</th><th className="numeric">学生</th><th className="numeric">作业</th><th className="numeric">已提交</th><th className="numeric">已发布</th><th className="numeric">均分</th><th>操作</th></tr></thead><tbody>{visibleCourses(user!).map((course) => {
    const assignments = state.assignments.filter((a) => a.courseId === course.id);
    const submissions = assignments.flatMap((a) => academic.roster.filter((r) => r.courseId === course.id).map((r) => latestSubmission(state.submissions, a.id, r.student.id))).filter(Boolean) as Submission[];
    const published = submissions.filter((s) => s.status === "published" && scoreOf(s) !== null);
    const average = published.length ? Math.round(published.reduce((sum, s) => sum + scoreOf(s)!, 0) / published.length * 10) / 10 : "—";
    return <tr key={course.id}><td><button className="cell-link" onClick={() => setCourseId(course.id)}>{course.title}</button><small>{course.code}</small></td><td className="numeric">{academic.roster.filter((r) => r.courseId === course.id).length}</td><td className="numeric">{assignments.length}</td><td className="numeric">{submissions.length}</td><td className="numeric">{published.length}</td><td className="numeric">{average}</td><td><button className="text-button" onClick={() => setCourseId(course.id)}>查看分析<ArrowRight size={13} /></button></td></tr>;
  })}</tbody></table></div>}<p className="table-footnote">均分仅统计已发布成绩，保留各作业原始分值；不同总分的作业不适合直接横向比较。</p></div>;
}
