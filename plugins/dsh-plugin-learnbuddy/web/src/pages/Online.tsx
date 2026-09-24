import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, FileText, RefreshCw, Search } from "lucide-react";
import { Button } from "@radix-ui/themes";
import { request, ApiError } from "../api";
import { visibleAssignments, visibleCourses } from "../domain";
import { useStore } from "../store-context";
import { Empty, PageHeading } from "../ui";
import type { Rubric, ServerGrade, ServerReview, ReportAnnotation, ParsedReportContent } from "../types";
import { CourseOverview, dateLabel, latestSubmission, scoreOf, SubmissionStatus } from "./Academic";
import { ReportViewer } from "../components/ReportViewer";
import { RubricEvaluationPanel } from "../components/RubricEvaluationPanel";
import { RubricRadarChart } from "../components/RubricRadarChart";

export interface AssignmentAnalytics {
  assignmentId: string;
  assignmentTitle: string;
  courseId: string;
  totalStudents: number;
  totalSubmissions: number;
  publishedCount: number;
  reviewedCount: number;
  failedCount: number;
  averageScore: number;
  maxScore: number;
  scoreDistribution: { band: string; count: number }[];
  rubricAnalytics: {
    rubricId: string;
    title: string;
    criterion: string;
    max: number;
    scoreRate: number;
    avgScore: number;
  }[];
  teachingSuggestions: {
    topic: string;
    suggestion: string;
    actionPlan: string;
  }[];
}
interface CourseAnalytics {
  courseTitle: string;
  totalStudents: number;
  totalSubmissionsCount: number;
  totalPublishedSubmissionsCount: number;
  overallAverageScore: number;
  assignmentAnalytics: AssignmentAnalytics[];
}
const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});
function useQuery<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setData(null);
    if (!path) {
      setLoading(false);
      return;
    }
    void request<T>(path, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, attempt]);
  return {
    data,
    error,
    loading,
    retry: () => setAttempt((value) => value + 1),
  };
}
function QueryNotice({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: string;
  retry: () => void;
}) {
  if (loading)
    return (
      <p className="inline-note" role="status">
        正在读取服务器数据…
      </p>
    );
  if (error)
    return (
      <div className="parse-notice" role="alert">
        <p>{error}</p>
        <button className="button secondary" onClick={retry}>
          <RefreshCw size={14} />
          重新加载
        </button>
      </div>
    );
  return null;
}

export function validateServerGrades(grades: ServerGrade[], rubric: Rubric[]) {
  if (
    !rubric.length ||
    grades.length !== rubric.length ||
    new Set(grades.map((g) => g.rubricId)).size !== rubric.length
  )
    return false;
  return rubric.every((item) => {
    const grade = grades.find((g) => g.rubricId === item.id);
    return (
      grade &&
      Number.isFinite(grade.score) &&
      grade.score >= 0 &&
      grade.score <= item.max
    );
  });
}

export function updateReviewGrade(review: ServerReview, index: number, patch: Partial<ServerGrade>): ServerReview {
  const grades = review.grades.map((grade, i) => i === index ? { ...grade, ...patch } : grade);
  const totalScore = Math.round(grades.reduce((sum, grade) => sum + (Number.isFinite(grade.score) ? grade.score : 0), 0) * 10) / 10;
  return { ...review, grades, totalScore };
}

interface StoredAnnotation {
  id: string;
  page: number;
  quote?: string;
  comment?: string;
  color?: ReportAnnotation["color"];
  createdAt: string;
}

interface StoredReviewDraft {
  submissionId: string;
  grades: ServerGrade[];
  summary: string;
  version: number;
  baseReviewVersion: number;
  updatedAt: string;
}
type DraftStatus = "loading" | "saved" | "dirty" | "saving" | "error";

function toReportAnnotation(annotation: StoredAnnotation): ReportAnnotation {
  const createdAt = new Date(annotation.createdAt);
  return {
    id: annotation.id,
    page: annotation.page,
    quote: annotation.quote,
    text: annotation.comment || "",
    color: annotation.color,
    createdAt: Number.isNaN(createdAt.valueOf()) ? annotation.createdAt : new Intl.DateTimeFormat("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(createdAt),
    author: "teacher",
  };
}

export function OnlineGrading({ id, submissionId }: { id: string; submissionId?: string }) {
  const focusMode = Boolean(submissionId);
  const {
    state,
    user,
    go,
    reviewResults: reviews,
    updateReviewResults: setReviews,
    busy,
    job,
    academic,
    refreshAcademic,
  } = useStore();
  const assignment = visibleAssignments(state, user!).find((a) => a.id === id);
  const query = useQuery<AssignmentAnalytics>(
    assignment && user!.role === "teacher"
      ? `/analytics/assignment/${encodeURIComponent(id)}?skipLLM=1`
      : "",
  );
  const members = academic?.roster.filter((r) => r.courseId === assignment?.courseId) || [];
  const submissions = state.submissions.filter((s) => s.assignmentId === id);
  const [selected, setSelected] = useState(() => {
    if (submissionId) return submissionId;
    try {
      const previous = JSON.parse(sessionStorage.getItem("learnbuddy-review-selection") || "null");
      if (previous?.assignmentId === id && submissions.some((s) => s.id === previous.submissionId)) return previous.submissionId as string;
    } catch { /* optional selection preference */ }
    return submissions[0]?.id || "";
  });
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [studentSearch, setStudentSearch] = useState("");
  const [studentFilter, setStudentFilter] = useState("all");
  useEffect(() => {
    if (!selected && submissions.length) setSelected(submissions[0].id);
  }, [selected, submissions]);
  const [pending, setPending] = useState("");
  const running = useRef(false);
  const [error, setError] = useState("");
  const [batch, setBatch] = useState<{
    total: number;
    succeeded: number;
    failed: number;
    results: {
      id: string;
      success: boolean;
      error?: string;
      totalScore?: number;
    }[];
  } | null>(null);
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [activeHighlightQuote, setActiveHighlightQuote] = useState<string | null>(null);
  const [activePage, setActivePage] = useState<number | undefined>();
  // 当前选中的评分项：用于右侧面板选中态与左侧原文定位的联动
  const [activeRubricId, setActiveRubricId] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<ReportAnnotation[]>([]);
  const [parsedReport, setParsedReport] = useState<ParsedReportContent | null>(null);
  const saved = submissions.find((s) => s.id === selected);
  const legacySampleScore = saved?.summary?.startsWith("本地测试评分，共") === true;
  // current 必须在使用它的 useEffect 之前声明，
  // 否则依赖数组里的引用会触发 TDZ（Cannot access 'current' before initialization）
  const current = reviews[selected];
  const reviewRef = useRef<ServerReview | null>(current || null);
  reviewRef.current = current || reviewRef.current;
  const draftVersion = useRef(0);
  const draftBaseReviewVersion = useRef(0);
  const draftReady = useRef(false);
  const editSequence = useRef(0);
  const savedSequence = useRef(0);
  const savePromise = useRef<Promise<boolean> | null>(null);
  const [draftStatus, setDraftStatus] = useState<DraftStatus>(focusMode ? "loading" : "saved");
  const [draftError, setDraftError] = useState("");
  useEffect(() => {
    // 有评分、或有持久化的解析产物，都应建立 review 视图：
    // 解析与评分是两件事，模型不可用时教师仍应能看到报告内容
    const hasReviewData = Boolean(saved && (saved.grades?.length || saved.parsedContent));
    if (assignment && user!.role === "teacher" && hasReviewData && !reviews[selected]) {
      setReviews((previous) => ({ ...previous, [selected]: {
        submissionId: saved!.id, status: saved!.status, totalScore: scoreOf(saved!) || 0,
        maxScore: assignment!.rubric.reduce((n, r) => n + r.max, 0),
        grades: (saved!.grades || []).map((g) => ({ ...g, score: g.score ?? NaN })),
        summary: saved!.summary,
        parsedContent: saved!.parsedContent ?? null,
        submission: saved!,
      } }));
    }
  }, [selected, saved, reviews, setReviews, assignment]);

  useEffect(() => {
    if (!focusMode || !saved || !assignment) return;
    let cancelled = false;
    draftReady.current = false;
    setDraftStatus("loading");
    setDraftError("");
    void request<{ draft: StoredReviewDraft | null }>(
      `/submissions/${encodeURIComponent(selected)}/review-draft`,
    ).then(({ draft }) => {
      if (cancelled) return;
      const baseVersion = saved.history?.length || 0;
      if (draft && draft.baseReviewVersion !== baseVersion) {
        throw new Error("正式成绩已更新，请刷新页面后再评阅。");
      }
      draftVersion.current = draft?.version || 0;
      draftBaseReviewVersion.current = baseVersion;
      if (draft) {
        setReviews((previous) => {
          const base = previous[selected] || {
            submissionId: selected,
            status: saved.status,
            totalScore: scoreOf(saved) || 0,
            maxScore: assignment.rubric.reduce((sum, item) => sum + item.max, 0),
            grades: saved.grades as ServerGrade[],
            summary: saved.summary,
            parsedContent: saved.parsedContent ?? null,
          };
          const next: ServerReview = {
            ...base,
            grades: draft.grades,
            summary: draft.summary,
            totalScore: Math.round(draft.grades.reduce((sum, grade) => sum + grade.score, 0) * 100) / 100,
          };
          reviewRef.current = next;
          return { ...previous, [selected]: next };
        });
      }
      draftReady.current = true;
      setDraftStatus("saved");
    }).catch((cause) => {
      if (cancelled) return;
      setDraftStatus("error");
      setDraftError((cause as Error).message);
    });
    return () => { cancelled = true; };
  }, [focusMode, selected, saved?.id, assignment?.id]);

  useEffect(() => {
    if (!focusMode || draftStatus !== "dirty") return;
    const timer = window.setTimeout(() => { void persistDraft(); }, 800);
    return () => window.clearTimeout(timer);
  }, [focusMode, draftStatus, current?.grades, current?.summary]);

  useEffect(() => {
    if (!focusMode || (draftStatus !== "dirty" && draftStatus !== "saving" && draftStatus !== "error")) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [focusMode, draftStatus]);

  // 评分数据刷新时只更新正文；教师批注和证据定位属于当前报告的编辑状态。
  useEffect(() => {
    const parsed = (current as { parsedContent?: ParsedReportContent } | undefined)?.parsedContent ?? saved?.parsedContent;
    setParsedReport(parsed ?? null);
  }, [saved?.parsedContent, current?.parsedContent]);
  useEffect(() => {
    // 切换提交时清理临时定位，并读取该提交已保存的教师批注。
    setActivePage(undefined);
    setActiveHighlightQuote(null);
    setActiveRubricId(null);
    setAnnotations([]);
    if (!selected) return;
    const controller = new AbortController();
    void request<{ annotations: StoredAnnotation[] }>(
      `/submissions/${encodeURIComponent(selected)}/annotations`,
      { signal: controller.signal },
    ).then((result) => {
      if (!controller.signal.aborted) setAnnotations((result.annotations || []).map(toReportAnnotation));
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(`批注读取失败：${(cause as Error).message}`);
    });
    return () => controller.abort();
  }, [selected]);
  const isBusy = !!pending || !!busy["server-grade:" + id];
  const rubric: Rubric[] = assignment?.rubric || [];
  // 把后端评分项与作业 Rubric 对齐成面板需要的形状：
  // 后端只返回 rubricId/score/comment/evidence/coverage，
  // 标题与满分要从 Rubric 补齐，coverage 要从嵌套对象摊平
  const panelGrades: ServerGrade[] = (current?.grades || []).map((grade) => {
    const item = rubric.find((r) => r.id === grade.rubricId);
    return {
      ...grade,
      title: grade.title || item?.title,
      max: grade.max ?? item?.max,
      coveredPoints: grade.coveredPoints ?? grade.coverage?.coveredPoints,
      missingPoints: grade.missingPoints ?? grade.coverage?.missingPoints,
    };
  });
  if (!assignment || user!.role !== "teacher")
    return <Empty title="仅本课程教师可评阅" />;
  async function run(
    action: "grade-submission" | "retry" | "review-publish" | "batch",
  ) {
    if (running.current || isBusy || !selected) return;
    running.current = true;
    setPending(action);
    setError("");
    await job("server-grade:" + id, async () => {
      try {
        if (action === "batch") {
          const result = await request<NonNullable<typeof batch>>(
            "/grader/batch",
            jsonPost({
              assignmentId: id,
              concurrency: 2,
              options: { strictLLM: true },
            }),
            180000,
          );
          setBatch(result);
          setConfirmBatch(false);
        } else {
          if (action === "review-publish" && focusMode && !await persistDraft()) {
            throw new Error("草稿未保存成功，请先重试保存，再发布成绩。");
          }
          const reviewToPublish = reviewRef.current || current;
          if (
            action === "review-publish" &&
            (!reviewToPublish || !validateServerGrades(reviewToPublish.grades, rubric))
          )
            throw new Error("请按作业评分标准补齐全部有效分数。");
          const body =
            action === "review-publish"
              ? {
                  submissionId: selected,
                  teacherId: user!.id,
                  grades: reviewToPublish!.grades,
                  summary: reviewToPublish!.summary,
                  strictRange: true,
                }
              : { submissionId: selected, options: { strictLLM: true } };
          const result = await request<ServerReview>(
            "/grader/" + action,
            jsonPost(body),
            120000,
          );
          if (
            result.submissionId !== selected ||
            !Array.isArray(result.grades) ||
            (result.submission?.assignmentId &&
              result.submission.assignmentId !== id)
          )
            throw new Error(
              "服务未返回完整评分明细；请让维护人员核对状态后再操作。",
            );
          reviewRef.current = result;
          setReviews((previous) => ({ ...previous, [selected]: result }));
          if (action === "review-publish" || action === "grade-submission" || action === "retry") {
            draftVersion.current = 0;
            draftBaseReviewVersion.current = action === "review-publish"
              ? result.reviewVersion || draftBaseReviewVersion.current + 1
              : draftBaseReviewVersion.current;
            savedSequence.current = editSequence.current;
            setDraftStatus("saved");
          }
          setConfirmPublish(false);
        }
        query.retry();
        await refreshAcademic();
      } catch (e) {
        setError(
          (e as Error).message +
            (!(e instanceof ApiError) || e.status === 0 ? " 请求结果尚未确认，请先由维护人员核对状态，不要重复发布。" : ""),
        );
      } finally {
        running.current = false;
        setPending("");
      }
    });
  }
  function persistDraft(): Promise<boolean> {
    if (!focusMode || editSequence.current <= savedSequence.current) return Promise.resolve(true);
    if (!draftReady.current) return Promise.resolve(false);
    if (savePromise.current) return savePromise.current;
    const operation = (async () => {
      while (editSequence.current > savedSequence.current) {
        const review = reviewRef.current;
        if (!review || !validateServerGrades(review.grades, rubric)) {
          setDraftError("请先补齐有效分数，再保存草稿。");
          setDraftStatus("error");
          return false;
        }
        const sequence = editSequence.current;
        setDraftStatus("saving");
        try {
          const result = await request<{ draft: StoredReviewDraft }>(
            `/submissions/${encodeURIComponent(selected)}/review-draft`,
            {
              method: "PUT",
              body: JSON.stringify({
                grades: review.grades,
                summary: review.summary,
                expectedVersion: draftVersion.current,
                baseReviewVersion: draftBaseReviewVersion.current,
              }),
            },
          );
          draftVersion.current = result.draft.version;
          savedSequence.current = sequence;
          setDraftError("");
        } catch (cause) {
          setDraftError((cause as Error).message);
          setDraftStatus("error");
          return false;
        }
      }
      setDraftStatus("saved");
      return true;
    })();
    savePromise.current = operation;
    void operation.finally(() => {
      if (savePromise.current === operation) savePromise.current = null;
    });
    return operation;
  }
  async function navigateAfterSave(nextSubmissionId?: string) {
    if (!await persistDraft()) return;
    go(nextSubmissionId ? { page: "grading", id, submissionId: nextSubmissionId } : { page: "grading", id });
  }
  function editReview(change: (review: ServerReview) => ServerReview) {
    const base = reviewRef.current || current;
    if (!base || (focusMode && !draftReady.current)) return;
    const next = change(base);
    reviewRef.current = next;
    setReviews((previous) => ({ ...previous, [selected]: next }));
    if (focusMode) {
      editSequence.current += 1;
      setDraftStatus("dirty");
      setDraftError("");
    }
  }
  function patchGrade(index: number, patch: Partial<ServerGrade>) {
    editReview((review) => updateReviewGrade(review, index, patch));
  }
  async function addAnnotation(annotation: Omit<ReportAnnotation, "id" | "createdAt">) {
    const submissionId = selected;
    const id = `anno-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const result = await request<{ annotation: StoredAnnotation }>(
        `/submissions/${encodeURIComponent(submissionId)}/annotations`,
        jsonPost({ id, page: annotation.page, quote: annotation.quote, comment: annotation.text, color: annotation.color }),
      );
      if (selectedRef.current === submissionId) {
        setAnnotations((previous) => [...previous, toReportAnnotation(result.annotation)]);
      }
    } catch (cause) {
      if (selectedRef.current === submissionId) setError(`批注保存失败：${(cause as Error).message}`);
    }
  }
  async function deleteAnnotation(annotationId: string) {
    const submissionId = selected;
    try {
      await request(
        `/submissions/${encodeURIComponent(submissionId)}/annotations/${encodeURIComponent(annotationId)}`,
        { method: "DELETE" },
      );
      if (selectedRef.current === submissionId) {
        setAnnotations((previous) => previous.filter((annotation) => annotation.id !== annotationId));
      }
    } catch (cause) {
      if (selectedRef.current === submissionId) setError(`批注删除失败：${(cause as Error).message}`);
    }
  }
  const reportQueue = members
    .map(({ student }) => ({ student, submission: latestSubmission(submissions, id, student.id) }))
    .filter((entry) => Boolean(entry.submission));
  const queueIndex = reportQueue.findIndex((entry) => entry.submission?.id === selected);
  const selectedStudent = reportQueue[queueIndex]?.student;
  const reviewChanged = Boolean(current && saved && (
    current.summary !== saved.summary || current.grades.some((grade) => {
      const original = saved.grades.find((item) => item.rubricId === grade.rubricId);
      return !original || original.score !== grade.score || original.comment !== grade.comment;
    })
  ));
  return (
    <div className={`page online-grading${focusMode ? " review-focus-page" : ""}`}>
      {focusMode ? (
        <div className="review-focus-header">
          <button className="review-focus-back" onClick={() => void navigateAfterSave()}><ArrowLeft size={17} />返回学生列表</button>
          <div className="review-focus-identity">
            <span>{assignment.title}</span>
            <h1>{selectedStudent?.name || "学生"}的报告</h1>
            <small title={saved?.fileName}>{saved?.fileName || "正在读取报告…"}</small>
          </div>
          <div className="review-focus-controls">
            <span className={`review-draft-status ${draftStatus}`} role="status">
              {draftStatus === "loading" ? "读取草稿…" : draftStatus === "saving" ? "正在保存…" : draftStatus === "dirty" ? "待保存" : draftStatus === "error" ? "保存失败" : "草稿已保存"}
            </span>
            {draftStatus === "error" && <button className="text-button" onClick={() => draftReady.current ? void persistDraft() : location.reload()}>重试</button>}
            <div className="review-focus-stepper">
              <button disabled={queueIndex <= 0} onClick={() => void navigateAfterSave(reportQueue[queueIndex - 1]?.submission?.id)} aria-label="上一份报告">上一份</button>
              <span>{queueIndex >= 0 ? queueIndex + 1 : 0} / {reportQueue.length}</span>
              <button disabled={queueIndex < 0 || queueIndex >= reportQueue.length - 1} onClick={() => void navigateAfterSave(reportQueue[queueIndex + 1]?.submission?.id)} aria-label="下一份报告">下一份</button>
            </div>
          </div>
        </div>
      ) : <>
      <button
        className="text-button"
        onClick={() => go({ page: "assignments" })}
      >
        <ArrowLeft size={14} />
        返回作业列表
      </button>
      <PageHeading
        title={assignment.title}
        description="逐项核对报告证据，由教师确认后发布。"
      />
      <QueryNotice {...query} />
      {query.data && (
        <div className="online-metrics">
          <div>
            <strong>{query.data.totalSubmissions}</strong>
            <span>已提交</span>
          </div>
          <div>
            <strong>{query.data.publishedCount}</strong>
            <span>已发布反馈</span>
          </div>
          <div>
            <strong>{query.data.failedCount}</strong>
            <span>评阅失败</span>
          </div>
        </div>
      )}
      <div className="review-register">
        <div className="table-controls">
          <div className="search-field compact"><Search size={14} /><input aria-label="搜索学生" placeholder="搜索学生姓名…" value={studentSearch} onChange={(e) => setStudentSearch(e.target.value)} /></div>
          <select className="compact-select" aria-label="筛选提交状态" value={studentFilter} onChange={(e) => setStudentFilter(e.target.value)}><option value="all">全班学生</option><option value="missing">未提交</option><option value="submitted">待评阅</option><option value="review">待复核</option><option value="published">已发布</option><option value="failed">异常</option></select>
          <span className="table-control-actions muted">{members.length} 名学生</span>
        </div>
        <div className="table-scroll"><table className="data-table"><thead><tr><th>学生</th><th>提交文件</th><th>提交时间</th><th>状态</th><th className="numeric">分数</th><th>操作</th></tr></thead><tbody>
          {members.map(({ student }) => ({ student, submission: latestSubmission(submissions, id, student.id) })).filter(({ student, submission }) => student.name.includes(studentSearch) && (studentFilter === "all" || (studentFilter === "missing" ? !submission : submission?.status === studentFilter))).map(({ student, submission }) => <tr key={student.id} className={submission?.id === selected ? "selected-row" : ""}>
            <td><strong>{student.name}</strong><small>{student.username}</small></td><td>{submission?.fileName || "—"}{submission?.sampleKey && <small>教学样例</small>}{submission?.fileName.startsWith("本地测试 ·") && <small>本地测试报告</small>}</td><td className="cell-muted">{submission ? dateLabel(submission.submittedAt) : "—"}</td><td><SubmissionStatus teacher submission={submission && reviews[submission.id] ? { ...submission, status: reviews[submission.id].status as typeof submission.status } : submission} /></td><td className="numeric">{submission ? reviews[submission.id]?.totalScore ?? scoreOf(submission) ?? "—" : "—"}</td><td><button className="review-action report-open-action" disabled={!submission || isBusy} onClick={() => go({ page: "grading", id, submissionId: submission!.id })}><FileText size={14} />查看报告</button></td>
          </tr>)}
        </tbody></table></div>
      </div>
      <div className="online-actions overview-batch-action">
        <button className="button secondary" disabled={isBusy} onClick={() => setConfirmBatch((value) => !value)}>全班批量评阅</button>
      </div>
      </>}
      {focusMode && <>
      <div className="online-actions">
        <button
          className="button primary"
          disabled={
            isBusy ||
            !selected ||
            current?.status === "published" ||
            current?.status === "review"
          }
          onClick={() => void run("grade-submission")}
        >
          {pending === "grade-submission" ? "正在评阅…" : "AI 辅助评阅"}
        </button>
        <button
          className="button secondary"
          disabled={
            isBusy ||
            !selected ||
            current?.status === "published" ||
            current?.status === "review"
          }
          onClick={() => void run("retry")}
        >
          重试评阅
        </button>
      </div>
      </>}
      {!focusMode && confirmBatch && (
        <div className="parse-notice">
          <p>
            将评阅本作业全部“已提交 /
            失败”的报告。完成后将更新学生列表，逐份核对后再发布反馈。
          </p>
          <button
            className="button secondary"
            disabled={isBusy}
            onClick={() => setConfirmBatch(false)}
          >
            取消
          </button>
          <button
            className="button primary"
            disabled={isBusy}
            onClick={() => void run("batch")}
          >
            {pending === "batch" ? "正在批量评阅…" : "确认批量评阅"}
          </button>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {focusMode && draftError && <p className="form-error review-draft-error" role="alert">草稿保存：{draftError}</p>}
      {!focusMode && batch && (
        <div className="parse-notice">
          <strong>
            本批次：{batch.total} 份，成功 {batch.succeeded} 份，失败{" "}
            {batch.failed} 份
          </strong>
          {batch.results.map((result) => (
            <p key={result.id}>
              {result.id} ·{" "}
              {result.success ? "评阅完成，待复核" : result.error || "评阅失败"}
            </p>
          ))}
        </div>
      )}
      {focusMode && !current && (
        <Empty
          title={saved ? "报告尚未评阅" : "选择一份学生报告"}
          description={saved ? "AI 辅助评阅需要已配置模型；最终分数与反馈由老师复核。" : "先从上方学生列表选择要查看的报告。"}
        />
      )}
      {focusMode && current && (
        <div className="lb-review-split">
          {/* 左侧：真实报告阅读器。只渲染后端解析产物，拿不到就显示空态 */}
          <div className="review-reader-column">
            {/* 只要有原件或有解析产物，就渲染阅读器 ——
                未评分的提交也应当能先看原件（教师本来就要先读报告再打分）。 */}
            {(parsedReport?.structuredPages?.length ?? 0) > 0 || saved?.blobId ? (
              <>
                {parsedReport?.source === "fixture" && (
                  <div style={{ marginBottom: 10 }}>
                    <span className="lb-chip warn">内置演示样例 · 不作为正式评分依据</span>
                  </div>
                )}
                {legacySampleScore && (
                  <div style={{ marginBottom: 10 }}>
                    <span className="lb-chip warn">历史模拟评分 · 仅供演示复核</span>
                  </div>
                )}
                <ReportViewer
                  fileName={parsedReport?.title || saved?.fileName}
                  initialView={saved?.fileName.startsWith("本地测试 ·") ? "formatted" : undefined}
                  syntheticMaterial={saved?.fileName.startsWith("本地测试 ·")}
                  blobId={saved?.blobId}
                  pages={parsedReport?.structuredPages || []}
                  activePage={activePage ?? 1}
                  highlightQuote={activeHighlightQuote}
                  annotations={annotations}
                  images={parsedReport?.images || []}
                  imageWarnings={parsedReport?.imageWarnings || []}
                  warnings={parsedReport?.warnings || []}
                  completeness={parsedReport?.completeness}
                  originalPages={parsedReport?.originalPages ?? null}
                  pagesEstimated={parsedReport?.pagesEstimated === true}
                  onPageChange={setActivePage}
                  onAddAnnotation={(annotation) => void addAnnotation(annotation)}
                  onDeleteAnnotation={(annotationId) => void deleteAnnotation(annotationId)}
                />
              </>
            ) : (
              <div className="lb-empty">
                <strong>{saved?.sampleKey ? "模拟数据，暂无文件" : "没有可显示的内容"}</strong>
                <span>{saved?.sampleKey ? "这条历史教学样例没有学生报告原件。可选择带测试报告的提交，运行真实 AutoGrader。" : "这份提交没有原件或可渲染的解析结果，请核对上传记录。"}</span>
              </div>
            )}
          </div>

          {/* 右侧：Rubric 评分复核与 Teacher-in-the-loop 人机协同面板 */}
          <div className="review-panel-column">
            <RubricEvaluationPanel
              grades={panelGrades}
              activeRubricId={activeRubricId}
              activeEvidenceQuote={activeHighlightQuote ?? null}
              totalScore={current.totalScore}
              maxScore={current.maxScore}
              summary={current.summary}
              isPublished={current.status === "published"}
              isSaving={isBusy || draftStatus === "loading" || draftStatus === "saving"}
              editingDisabled={!draftReady.current}
              reviewChanged={reviewChanged}
              confirmPublish={confirmPublish}
              onSetConfirmPublish={setConfirmPublish}
              onSelectGrade={(grade) => {
                // 点击评分项 → 左侧阅读器跳到该证据所在页并高亮
                setActiveRubricId(grade.rubricId);
                if (grade.page) setActivePage(grade.page);
                setActiveHighlightQuote(grade.evidence || null);
              }}
              onScoreChange={(rubricId, score) => {
                const index = current.grades.findIndex((g) => g.rubricId === rubricId);
                if (index >= 0) patchGrade(index, { score });
              }}
              onCommentChange={(rubricId, comment) => {
                const index = current.grades.findIndex((g) => g.rubricId === rubricId);
                if (index >= 0) patchGrade(index, { comment });
              }}
              onSummaryChange={(summary) => editReview((review) => ({ ...review, summary }))}
              onConfirmGrades={() => void run("review-publish")}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export function OnlineInsights() {
  const { user, courseId, go } = useStore();
  const myCourses = visibleCourses(user!);
  const chosen = courseId === "all" ? "" : courseId;
  const query = useQuery<CourseAnalytics>(
    chosen && user!.role === "teacher"
      ? `/analytics/course/${encodeURIComponent(chosen)}?skipLLM=1`
      : "",
  );
  if (user!.role !== "teacher") return <Empty title="教学反馈仅对教师开放" />;
  if (!chosen) return <CourseOverview />;
  return (
    <div className="page">
      <Button className="insights-back" variant="ghost" color="gray" onClick={() => go({ page: "insights" })}><ArrowLeft size={15} />全部课程学情</Button>
      <PageHeading
        title="学情分析"
        description={myCourses.find((c) => c.id === chosen)?.title || "查看已发布成绩与评分项表现。"}
      />
      <QueryNotice {...query} />
      {query.data && (
        <>
          <div className="online-metrics">
            <div>
              <strong>{query.data.totalStudents}</strong>
              <span>选课学生</span>
            </div>
            <div>
              <strong>{query.data.totalSubmissionsCount}</strong>
              <span>提交报告</span>
            </div>
            <div>
              <strong>{query.data.totalPublishedSubmissionsCount}</strong>
              <span>已发布成绩</span>
            </div>
            <div>
              <strong>
                {query.data.totalPublishedSubmissionsCount
                  ? query.data.overallAverageScore
                  : "—"}
              </strong>
              <span>已发布作业均分</span>
            </div>
          </div>
          <p className="inline-note">均分、分数段与薄弱项仅统计已发布反馈。</p>
          {!query.data.totalPublishedSubmissionsCount && (
            <Empty
              title="暂无已发布反馈"
              description="教师完成复核并发布后，这里才会展示成绩分布和教学建议。"
            />
          )}
          {query.data.assignmentAnalytics.map((assignment) => (
            <section className="online-analysis" key={assignment.assignmentId}>
              <h2>{assignment.assignmentTitle}</h2>
              <p>
                {assignment.totalSubmissions} 份提交 ·{" "}
                {assignment.publishedCount} 份已发布
              </p>
              {assignment.publishedCount > 0 && (
                <>
                  <div className="lb-analysis-grid">
                    <div className="lb-chart-card">
                      <h3>评分项达成率</h3>
                      <RubricRadarChart
                        dimensions={assignment.rubricAnalytics.map((item) => ({
                          label: item.title,
                          value: item.scoreRate,
                          detail: `${item.avgScore} / ${item.max} 分`,
                        }))}
                      />
                    </div>

                    <div className="lb-chart-card">
                      <h3>分数段分布</h3>
                      <p>已发布 {assignment.publishedCount} 份</p>
                      <div className="lb-bands">
                        {assignment.scoreDistribution.map((band) => (
                          <div className="lb-band" key={band.band}>
                            <span>{band.band}</span>
                            <div className="lb-band-track">
                              <i
                                style={{
                                  width: `${(band.count / Math.max(1, assignment.publishedCount)) * 100}%`,
                                }}
                              />
                            </div>
                            <strong>{band.count} 人</strong>
                          </div>
                        ))}
                      </div>

                      <h3 style={{ marginTop: 20 }}>评分点表现</h3>
                      <div className="lb-rubric-bars">
                        {assignment.rubricAnalytics.map((item) => {
                          const rate = Math.min(1, Math.max(0, item.scoreRate));
                          return (
                            <div className="lb-rubric-bar" key={item.rubricId}>
                              <span title={item.title}>{item.title}</span>
                              <div className="lb-band-track">
                                <i
                                  className={rate < 0.4 ? "alert" : rate < 0.6 ? "warn" : ""}
                                  style={{ width: `${rate * 100}%` }}
                                />
                              </div>
                              <strong>
                                {item.avgScore}/{item.max}
                              </strong>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {assignment.teachingSuggestions.length > 0 && (
                    <div className="lb-suggestions">
                      {assignment.teachingSuggestions.map((suggestion, i) => (
                        <article className="lb-suggestion" key={i}>
                          <h3>{suggestion.topic}</h3>
                          <p>{suggestion.suggestion}</p>
                          <p>{suggestion.actionPlan}</p>
                        </article>
                      ))}
                    </div>
                  )}
                </>
              )}
              <button
                className="text-button"
                onClick={() =>
                  go({ page: "grading", id: assignment.assignmentId })
                }
              >
                查看评阅管理
                <ArrowRight size={14} />
              </button>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
