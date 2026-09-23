import { createId } from "../id";
import { useState } from "react";
import { ArrowLeft, Check, LockKeyhole, Plus, Save, Trash2 } from "lucide-react";
import { request } from "../api";
import { visibleCourses } from "../domain";
import { useStore } from "../store-context";
import { CourseBadge, Empty, Modal, PageHeading } from "../ui";
import { VoiceInput } from "../components/VoiceInput";
import type { Assignment, Rubric } from "../types";
import { AcademicNotice, dateLabel, latestSubmission, SubmissionStatus } from "./Academic";

export function OnlineAssignmentForm({ id }: { id: string }) {
  const { state, user, academicLoading } = useStore();
  const assignment = state.assignments.find((a) => a.id === id);
  if (id !== "new" && !assignment) return <div className="page"><AcademicNotice />{!academicLoading && <Empty title="作业不存在或无权查看" />}</div>;
  if (user!.role === "student") return assignment?.published ? <StudentAssignment assignment={assignment} /> : <Empty title="无法查看这份作业" />;
  return <TeacherAssignment key={id} assignment={assignment} />;
}

function TeacherAssignment({ assignment }: { assignment?: Assignment }) {
  const { state, user, courseId, refreshAcademic, go, notify } = useStore();
  const courses = visibleCourses(user!);
  const [course, setCourse] = useState(assignment?.courseId || (courseId === "all" ? courses[0]?.id || "" : courseId));
  const [title, setTitle] = useState(assignment?.title || "");
  const [due, setDue] = useState(assignment?.due ? (assignment.due.length === 10 ? assignment.due + "T23:59" : assignment.due.slice(0, 16)) : "");
  const [description, setDescription] = useState(assignment?.description || "");
  const [rubric, setRubric] = useState<Rubric[]>(assignment?.rubric || []);
  const [materialIds, setMaterialIds] = useState<string[]>(assignment?.materialIds || []);
  const [publishConfirm, setPublishConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submissionCount = state.submissions.filter((s) => s.assignmentId === assignment?.id).length;
  const hasSubmissions = submissionCount > 0;
  const materials = state.materials.filter((m) => m.courseId === course && m.visibility === "course");
  const total = rubric.reduce((n, r) => n + (Number.isFinite(r.max) ? r.max : 0), 0);
  const rubricReady = rubric.length > 0 && rubric.every((r) => r.title.trim() && r.criterion.trim() && Number.isFinite(r.max) && r.max > 0 && r.max <= 1000);
  function patchRubric(id: string, patch: Partial<Rubric>) {
    setRubric((rs) => rs.map((r) => r.id === id ? { ...r, ...patch } : r));
  }
  async function save(published: boolean) {
    if (saving) return;
    if (rubric.length && !rubricReady) {
      setError("请补齐每项评分的名称、判断标准和有效分值后再保存。");
      return;
    }
    if (published && (!description.trim() || !rubricReady)) {
      setError("发布前请填写任务要求和完整的评分标准。");
      return;
    }
    setSaving(true); setError("");
    try {
      const result = await request<{ assignment: Assignment }>(assignment ? `/assignments/${encodeURIComponent(assignment.id)}` : "/assignments", {
        method: assignment ? "PUT" : "POST", body: JSON.stringify({ courseId: course, title, due, description, rubric, materialIds, confirmed: published || assignment?.confirmed === true, published }),
      });
      await refreshAcademic();
      setPublishConfirm(false);
      notify(published ? "作业已保存并向课程学生发布。" : "作业草稿已保存。");
      go({ page: "assignment", id: result.assignment.id });
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }
  return <div className="page assignment-form-page">
    <button className="text-button" onClick={() => go({ page: "assignments" })}><ArrowLeft size={14} />返回作业管理</button>
    <PageHeading title={assignment ? "作业设置" : "新建作业"} description={hasSubmissions ? "任务信息可继续更新；已有学生提交，评分标准已锁定。" : "填写任务要求与评分标准，保存后可发布给学生。"} action={assignment && <span className={`state-label ${assignment.published ? "success" : "neutral"}`}>{assignment.published ? "已发布" : "草稿"}</span>} />
    <form onSubmit={(event) => { event.preventDefault(); void save(assignment?.published || false); }}>
      <section className="form-section"><h2>基本信息</h2><div className="form-grid"><label>所属课程<select disabled={!!assignment || saving} value={course} onChange={(e) => { setCourse(e.target.value); setMaterialIds([]); }}>{courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label><label>截止时间<input type="datetime-local" value={due} disabled={saving} onChange={(e) => setDue(e.target.value)} /></label></div><label>作业名称<input required maxLength={120} value={title} disabled={saving} onChange={(e) => setTitle(e.target.value)} placeholder="例如：实验一 · TCP 三次握手分析" /></label></section>
      <section className="form-section"><div className="section-heading"><h2>任务要求</h2><VoiceInput disabled={saving} onText={(text) => setDescription((d) => (d + text).slice(0, 12000))} /></div><label className="sr-only" htmlFor="assignment-description">任务要求</label><textarea id="assignment-description" rows={7} value={description} maxLength={12000} disabled={saving} onChange={(e) => setDescription(e.target.value)} placeholder="说明实验目标、必须完成的任务、报告内容与提交要求。" /><details className="form-disclosure"><summary>关联课程资料{materialIds.length ? ` · ${materialIds.length} 份` : ""}</summary><div className="material-checklist">{materials.map((m) => <label key={m.id}><input type="checkbox" checked={materialIds.includes(m.id)} disabled={saving} onChange={(e) => setMaterialIds((ids) => e.target.checked ? [...ids, m.id] : ids.filter((item) => item !== m.id))} />{m.title}</label>)}{!materials.length && <p className="muted">本课程暂无共享资料。</p>}</div></details></section>
      <section className="form-section">
        <div className="section-heading rubric-heading">
          <h2>评分标准 <span className="muted">总分 {total}</span>{hasSubmissions && <span className="rubric-lock-badge"><LockKeyhole size={13} />已锁定</span>}</h2>
          <button type="button" className={`rubric-add-action${hasSubmissions ? " is-locked" : ""}`} disabled={saving || hasSubmissions} aria-label={hasSubmissions ? "添加评分项已锁定：已有学生提交" : "添加评分项"} title={hasSubmissions ? "已有学生提交，不能添加评分项" : undefined} onClick={() => setRubric((rs) => [...rs, { id: createId(), title: "", criterion: "", max: 10 }])}>{hasSubmissions ? <LockKeyhole size={14} /> : <Plus size={14} />}{hasSubmissions ? "无法添加评分项" : "添加评分项"}</button>
        </div>
        {hasSubmissions && <p className="rubric-lock-notice"><LockKeyhole size={17} aria-hidden="true" /><span><strong>{submissionCount} 份报告已提交，评分标准已锁定。</strong>名称、判断标准、分值以及新增和删除操作都不可修改；任务说明和截止时间仍可保存。</span></p>}
        <div className="table-scroll"><table className={`data-table rubric-editor${hasSubmissions ? " is-locked" : ""}`}><thead><tr><th>评分项</th><th>判断标准</th><th>分值</th><th aria-label="操作" /></tr></thead><tbody>{rubric.map((r, index) => <tr key={r.id}><td><input aria-label={`第 ${index + 1} 项名称`} value={r.title} disabled={saving || hasSubmissions} onChange={(e) => patchRubric(r.id, { title: e.target.value })} placeholder="评分项名称" /></td><td><textarea aria-label={`第 ${index + 1} 项要求`} rows={2} value={r.criterion} disabled={saving || hasSubmissions} onChange={(e) => patchRubric(r.id, { criterion: e.target.value })} placeholder="学生需要完成什么，如何判定" /></td><td><input type="number" aria-label={`第 ${index + 1} 项分值`} min={1} max={1000} step={1} value={Number.isFinite(r.max) ? r.max : ""} disabled={saving || hasSubmissions} onChange={(e) => patchRubric(r.id, { max: e.target.value ? Number(e.target.value) : NaN })} /></td><td><button type="button" className={`rubric-remove-action${hasSubmissions ? " is-locked" : ""}`} aria-label={hasSubmissions ? `移除第 ${index + 1} 项已锁定` : `移除第 ${index + 1} 项`} title={hasSubmissions ? "已有学生提交，不能删除评分项" : "删除评分项"} disabled={saving || hasSubmissions} onClick={() => setRubric((rs) => rs.filter((item) => item.id !== r.id))}>{hasSubmissions ? <LockKeyhole size={14} /> : <Trash2 size={15} />}</button></td></tr>)}</tbody></table></div>
        {!rubric.length && <p className="table-empty">添加评分项，写清每项要求与对应分值。</p>}
        {!hasSubmissions && !rubricReady && rubric.length > 0 && <p className="rubric-help">每项需要填写名称、判断标准和有效分值，才能保存或发布。</p>}
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-action-bar"><button type="button" className="button secondary" onClick={() => go({ page: "assignments" })} disabled={saving}>返回列表</button><span />{assignment?.published ? <button className="button primary" disabled={saving}><Save size={15} />{saving ? "正在保存…" : "保存修改"}</button> : <><button className="button secondary" disabled={saving || !title.trim() || !course || (rubric.length > 0 && !rubricReady)}><Save size={15} />保存草稿</button><button type="button" className="button primary" disabled={saving || !rubricReady || !description.trim() || !title.trim()} onClick={() => setPublishConfirm(true)}><Check size={15} />发布作业</button></>}</div>
    </form>
    {publishConfirm && <Modal title="发布这份作业" description="课程学生将看到任务要求与评分标准。" onClose={() => !saving && setPublishConfirm(false)}><div className="publish-summary"><strong>{title}</strong><p>{courses.find((c) => c.id === course)?.title} · {rubric.length} 个评分项 · 总分 {total}</p><p>截止时间：{dateLabel(due)}</p></div><div className="modal-footer"><button className="button secondary" disabled={saving} onClick={() => setPublishConfirm(false)}>继续检查</button><button className="button primary" disabled={saving} onClick={() => void save(true)}>{saving ? "正在发布…" : "确认发布"}</button></div>{error && <p role="alert" className="form-error">{error}</p>}</Modal>}
  </div>;
}

function StudentAssignment({ assignment }: { assignment: Assignment }) {
  const { state, user, go } = useStore();
  const mine = latestSubmission(state.submissions, assignment.id, user!.id);
  return <div className="page student-task-page">
    <button className="text-button" onClick={() => go({ page: "assignments" })}><ArrowLeft size={14} />返回我的作业</button>
    <PageHeading title={assignment.title} action={<SubmissionStatus submission={mine} />} />
    <div className="task-meta"><CourseBadge id={assignment.courseId} /><span>截止 {dateLabel(assignment.due)}</span><span>满分 {assignment.rubric.reduce((n, r) => n + r.max, 0)}</span></div>
    <div className="student-task-layout"><section><section className="form-section"><h2>任务要求</h2><p className="task-description">{assignment.description || "老师尚未填写补充说明。"}</p></section>
      <section className="form-section"><h2>评分标准</h2><div className="table-scroll"><table className="data-table"><thead><tr><th>需要完成的内容</th><th className="numeric">分值</th></tr></thead><tbody>{assignment.rubric.map((r) => <tr key={r.id}><td><strong>{r.title}</strong><p>{r.criterion}</p></td><td className="numeric">{r.max}</td></tr>)}</tbody></table></div></section>
      {!!assignment.materialIds.length && <section className="form-section"><h2>参考资料</h2>{assignment.materialIds.map((id) => { const material = state.materials.find((m) => m.id === id); return material && <button className="reference-row" key={id} onClick={() => go({ page: "material", id })}>{material.title}<ArrowLeft size={14} style={{ transform: "rotate(180deg)" }} /></button>; })}</section>}
    </section><aside className="submission-summary"><h2>我的提交</h2>{mine ? <><SubmissionStatus submission={mine} /><strong>{mine.fileName}</strong><p>{dateLabel(mine.submittedAt)} 提交</p><button className="button primary full" onClick={() => go({ page: "report", id: mine.id })}>{mine.status === "published" ? "查看老师反馈" : "查看提交记录"}</button></> : <><p>完成任务后，在这里提交实验报告。</p><button className="button secondary full" disabled>提交入口待接入</button><small>报告接收与完整性检查服务尚未开放。</small></>}</aside></div>
  </div>;
}
