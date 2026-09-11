import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RefreshCw, Search } from "lucide-react";
import { request, fileUrl, ApiError } from "../api";
import { visibleAssignments, visibleCourses } from "../domain";
import { useStore } from "../store-context";
import { Empty, PageHeading } from "../ui";
import type { Rubric, ServerGrade, ServerReview } from "../types";
import { VoiceInput } from "../components/VoiceInput";
import { CourseOverview, dateLabel, latestSubmission, scoreOf, SubmissionStatus } from "./Academic";

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

export function OnlineGrading({ id }: { id: string }) {
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
    try {
      const previous = JSON.parse(sessionStorage.getItem("learnbuddy-review-selection") || "null");
      if (previous?.assignmentId === id && submissions.some((s) => s.id === previous.submissionId)) return previous.submissionId as string;
    } catch { /* optional selection preference */ }
    return submissions[0]?.id || "";
  });
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
  const saved = submissions.find((s) => s.id === selected);
  useEffect(() => {
    if (assignment && user!.role === "teacher" && saved?.grades.length && !reviews[selected]) {
      setReviews((previous) => ({ ...previous, [selected]: {
        submissionId: saved.id, status: saved.status, totalScore: scoreOf(saved) || 0,
        maxScore: assignment!.rubric.reduce((n, r) => n + r.max, 0),
        grades: saved.grades.map((g) => ({ ...g, score: g.score ?? NaN })), summary: saved.summary, submission: saved,
      } }));
    }
  }, [selected, saved, reviews, setReviews, assignment]);
  const current = reviews[selected];
  const isBusy = !!pending || !!busy["server-grade:" + id];
  const rubric: Rubric[] = assignment?.rubric || [];
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
          if (
            action === "review-publish" &&
            (!current || !validateServerGrades(current.grades, rubric))
          )
            throw new Error("请按作业评分标准补齐全部有效分数。");
          const body =
            action === "review-publish"
              ? {
                  submissionId: selected,
                  teacherId: user!.id,
                  grades: current.grades,
                  summary: current.summary,
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
          setReviews((previous) => ({ ...previous, [selected]: result }));
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
  function patchGrade(index: number, patch: Partial<ServerGrade>) {
    setReviews((previous) => ({
      ...previous,
      [selected]: {
        ...previous[selected],
        grades: previous[selected].grades.map((grade, i) =>
          i === index ? { ...grade, ...patch } : grade,
        ),
      },
    }));
  }
  return (
    <div className="page online-grading">
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
            <td><strong>{student.name}</strong><small>{student.username}</small></td><td>{submission?.fileName || "—"}{submission?.sampleKey && <small>教学样例</small>}</td><td className="cell-muted">{submission ? dateLabel(submission.submittedAt) : "—"}</td><td><SubmissionStatus teacher submission={submission && reviews[submission.id] ? { ...submission, status: reviews[submission.id].status as typeof submission.status } : submission} /></td><td className="numeric">{submission ? reviews[submission.id]?.totalScore ?? scoreOf(submission) ?? "—" : "—"}</td><td><button className="text-button" disabled={!submission || isBusy} onClick={() => { setSelected(submission!.id); setError(""); setConfirmPublish(false); }}>查看报告</button></td>
          </tr>)}
        </tbody></table></div>
      </div>
      <div className="review-selection-heading"><h2>{saved ? `${members.find((r) => r.student.id === saved.studentId)?.student.name || "学生"}的报告` : "报告评阅"}</h2>{saved && <span className="muted">{saved.fileName}</span>}</div>
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
        <button
          className="text-button"
          disabled={isBusy}
          onClick={() => setConfirmBatch((value) => !value)}
        >
          全班批量评阅
        </button>
      </div>
      {confirmBatch && (
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
      {batch && (
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
      {!current && (
        <Empty
          title={saved ? "报告尚未评阅" : "选择一份学生报告"}
          description={saved ? "AI 辅助评阅需要已配置模型；最终分数与反馈由老师复核。" : "先从上方学生列表选择要查看的报告。"}
        />
      )}
      {current && (
        <section className="server-review">
          <h2>
            {current.status === "published"
              ? "成绩已发布"
              : current.status === "review"
                ? "评分复核"
                : "评阅未完成"}
          </h2>
          <p>
            建议总分：{current.totalScore} / {current.maxScore}
            {current.reviewVersion
              ? ` · 第 ${current.reviewVersion} 次复核`
              : ""}
          </p>
          <p className="inline-note">
            这份评分来自教学服务。请核对报告原件与引用依据，再确认发布。
          </p>
          {current.submission?.blobId && (
            <a
              className="text-button"
              href={fileUrl(current.submission.blobId)}
              target="_blank"
              rel="noreferrer"
            >
              查看报告原件
            </a>
          )}
          {current.grades.map((grade, index) => {
            const item = rubric.find((r) => r.id === grade.rubricId);
            return (
              <article className="server-grade" key={grade.rubricId}>
                <h3>{item?.title || grade.title || grade.rubricId}</h3>
                <label>
                  核定得分（满分 {item?.max ?? grade.max ?? "未提供"}）
                  <input
                    type="number"
                    min={0}
                    max={item?.max ?? grade.max}
                    step="0.1"
                    disabled={isBusy || current.status === "published"}
                    value={Number.isFinite(grade.score) ? grade.score : ""}
                    onChange={(e) =>
                      patchGrade(index, {
                        score:
                          e.target.value === "" ? NaN : Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  逐项评语
                  <textarea
                    rows={2}
                    value={grade.comment || ""}
                    disabled={isBusy || current.status === "published"}
                    onChange={(e) =>
                      patchGrade(index, { comment: e.target.value })
                    }
                  />
                </label>
                <div className="evidence-excerpt">
                  <strong>
                    {grade.page ? `报告第 ${grade.page} 页` : "未标注页码"}
                  </strong>
                  <blockquote>
                    {grade.evidence ||
                      "缺少原文引用，请查看报告原件核对。"}
                  </blockquote>
                </div>
              </article>
            );
          })}
          <label>
            综合反馈
            <textarea
              rows={4}
              value={current.summary || ""}
              disabled={isBusy || current.status === "published"}
              onChange={(e) =>
                setReviews((previous) => ({
                  ...previous,
                  [selected]: {
                    ...previous[selected],
                    summary: e.target.value,
                  },
                }))
              }
            />
          </label>
          {current.status === "review" && (
            <>
              <VoiceInput
                disabled={isBusy}
                onText={(text) =>
                  setReviews((previous) => ({
                    ...previous,
                    [selected]: {
                      ...previous[selected],
                      summary: (previous[selected].summary || "") + text,
                    },
                  }))
                }
              />
              <button
                className="button primary"
                disabled={
                  isBusy || !validateServerGrades(current.grades, rubric)
                }
                onClick={() => setConfirmPublish(true)}
              >
                确认并发布反馈
              </button>
              {confirmPublish && (
                <div className="parse-notice">
                  <p>
                    将核定分数和综合反馈写入服务器。发布后学生将能查看本次成绩和反馈。
                  </p>
                  <button
                    className="button secondary"
                    disabled={isBusy}
                    onClick={() => setConfirmPublish(false)}
                  >
                    继续复核
                  </button>
                  <button
                    className="button primary"
                    disabled={isBusy}
                    onClick={() => void run("review-publish")}
                  >
                    {pending === "review-publish"
                      ? "正在发布…"
                      : "发布这份反馈"}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
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
          <p className="inline-note">
            数据来自服务器；均分、分数段和薄弱项只统计已发布反馈。教学建议为规则汇总，引用页码与图表需教师核对。
          </p>
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
                  <div className="score-distribution">
                    {assignment.scoreDistribution.map((band) => (
                      <div key={band.band}>
                        <span>{band.band}</span>
                        <meter
                          min={0}
                          max={Math.max(1, assignment.publishedCount)}
                          value={band.count}
                        />
                        <strong>{band.count} 人</strong>
                      </div>
                    ))}
                  </div>
                  <h3>各评分点表现</h3>
                  {assignment.rubricAnalytics.map((item) => (
                    <div className="rubric-performance" key={item.rubricId}>
                      <span>{item.title}</span>
                      <strong>
                        {item.avgScore} / {item.max}
                      </strong>
                      <meter min={0} max={1} value={item.scoreRate} />
                    </div>
                  ))}
                  {assignment.teachingSuggestions.map((suggestion, i) => (
                    <article className="teaching-suggestion" key={i}>
                      <h3>{suggestion.topic}</h3>
                      <p>{suggestion.suggestion}</p>
                      <p>{suggestion.actionPlan}</p>
                    </article>
                  ))}
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
