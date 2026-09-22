import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RefreshCw, Search } from "lucide-react";
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
  const [activeHighlightQuote, setActiveHighlightQuote] = useState<string | null>(null);
  const [activePage, setActivePage] = useState<number | undefined>();
  // 当前选中的评分项：用于右侧面板选中态与左侧原文定位的联动
  const [activeRubricId, setActiveRubricId] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<ReportAnnotation[]>([]);
  const [parsedReport, setParsedReport] = useState<ParsedReportContent | null>(null);
  const saved = submissions.find((s) => s.id === selected);
  // current 必须在使用它的 useEffect 之前声明，
  // 否则依赖数组里的引用会触发 TDZ（Cannot access 'current' before initialization）
  const current = reviews[selected];
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

  // 把后端返回的**真实解析产物**投影给左侧阅读器。
  // 拿不到真实解析结果就显示「解析不可用」空态 —— 不在前端构造演示正文
  //（返工单 P1-4：不允许生成看起来正常的假内容）。
  useEffect(() => {
    if (!saved) {
      setParsedReport(null);
      return;
    }
    const parsed = (current as { parsedContent?: ParsedReportContent } | undefined)?.parsedContent;
    setParsedReport(parsed ?? null);
    // 切换报告必须清掉上一份的定位、高亮与批注，避免沿用上一份的引用
    setActivePage(undefined);
    setActiveHighlightQuote(null);
    setActiveRubricId(null);
    setAnnotations([]);
  }, [selected, saved, current]);
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
        <div className="lb-review-split">
          {/* 左侧：真实报告阅读器。只渲染后端解析产物，拿不到就显示空态 */}
          <div style={{ position: "sticky", top: "20px" }}>
            {/* 只要有原件或有解析产物，就渲染阅读器 ——
                未评分的提交也应当能先看原件（教师本来就要先读报告再打分）。 */}
            {(parsedReport?.structuredPages?.length ?? 0) > 0 || saved?.blobId ? (
              <>
                {parsedReport?.source === "fixture" && (
                  <div style={{ marginBottom: 10 }}>
                    <span className="lb-chip warn">内置演示样例 · 不作为正式评分依据</span>
                  </div>
                )}
                <ReportViewer
                  fileName={parsedReport?.title || saved?.fileName}
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
                  onAddAnnotation={(ann) =>
                    setAnnotations((prev) => [
                      ...prev,
                      {
                        ...ann,
                        id: `anno-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                        createdAt: new Date().toISOString().slice(0, 16).replace("T", " "),
                      },
                    ])
                  }
                  onDeleteAnnotation={(annId) =>
                    setAnnotations((prev) => prev.filter((a) => a.id !== annId))
                  }
                />
              </>
            ) : (
              <div className="lb-empty">
                <strong>没有可显示的内容</strong>
                <span>
                  这份提交既没有原件（blobId），也没有可渲染的解析结果。请核对学生是否真的上传了文件。
                </span>
              </div>
            )}
          </div>

          {/* 右侧：Rubric 评分复核与 Teacher-in-the-loop 人机协同面板 */}
          <div>
            <RubricEvaluationPanel
              grades={panelGrades}
              activeRubricId={activeRubricId}
              activeEvidenceQuote={activeHighlightQuote ?? null}
              totalScore={current.totalScore}
              maxScore={current.maxScore}
              summary={current.summary}
              isPublished={current.status === "published"}
              isSaving={isBusy}
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
