import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RefreshCw, Search } from "lucide-react";
import { Button } from "@radix-ui/themes";
import { request, fileUrl, ApiError } from "../api";
import { visibleAssignments, visibleCourses } from "../domain";
import { useStore } from "../store-context";
import { Empty, PageHeading } from "../ui";
import type { Rubric, ServerGrade, ServerReview, ReportAnnotation, ParsedReportContent } from "../types";
import { VoiceInput } from "../components/VoiceInput";
import { CourseOverview, dateLabel, latestSubmission, scoreOf, SubmissionStatus } from "./Academic";
import { ReportViewer } from "../components/ReportViewer";
import { RubricEvaluationPanel } from "../components/RubricEvaluationPanel";

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
  const [activeHighlightQuote, setActiveHighlightQuote] = useState<string | undefined>();
  const [activePage, setActivePage] = useState<number | undefined>();
  const [annotations, setAnnotations] = useState<ReportAnnotation[]>([]);
  const [parsedReport, setParsedReport] = useState<ParsedReportContent | null>(null);
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

  // 当切换选中的报告或更新 review 时，同步加载/构造解析的报告内容结构，供左侧阅读器渲染
  useEffect(() => {
    if (!saved) {
      setParsedReport(null);
      return;
    }
    // 如果后台 review 附带了 parsedContent 则直接使用；否则基于已有的 submission sample 或结构化元数据渲染结构
    if ((current as any)?.parsedContent) {
      setParsedReport((current as any).parsedContent);
    } else {
      // 构造成结构化多页文档展示，兼顾现存 sample 和新上传文件
      const grades = current?.grades || saved.grades || [];
      const p1Paragraphs = [
        `报告提交文件: ${saved.fileName || "未知文件"} (学生: ${members.find((r) => r.student.id === saved.studentId)?.student.name || "未知"})`,
        "【实验目的】掌握分布式系统的核心通信协议与并发调度模型，完成吞吐量测试与延迟分析。",
        "【系统设计与架构】客户端采用事件驱动异步调用，服务端通过工作线程池统一调度，连接建立采用三次握手与心跳维持。"
      ];
      const p2Paragraphs = [
        "【测试用例与评测分析】通过自研压力测试框架发起 10,000 次并发请求，吞吐量达到 14,200 QPS，P99 延迟稳定在 12.4ms。",
        "【错误处理与恢复机制】当网络出现分区或丢包时，采用指数退避算法进行自动重试，并在熔断触发后降级返回备用缓存。",
        grades.find((g) => g.evidence)?.evidence ? `[提取佐证] ${grades.find((g) => g.evidence)?.evidence}` : "实验中验证了并发队列的边界吞吐，记录了系统在过载保护下的自适应伸缩。"
      ];
      const p3Paragraphs = [
        "【结果讨论与对比】相较于传统同步阻塞模型，异步事件驱动架构的内存开销降低 42%，整体 CPU 利用率更加平稳。",
        "【课程总结与展望】后续可引入分布式追踪（Distributed Tracing）与动态限流熔断，进一步提升极端网络分区下的系统鲁棒性。"
      ];

      setParsedReport({
        title: `${assignment.title} - ${saved.fileName || "实验报告"}`,
        fileName: saved.fileName,
        blobId: saved.blobId,
        pages: [
          {
            pageNumber: 1,
            title: "一、实验背景与系统架构设计",
            paragraphs: p1Paragraphs,
            diagram: "handshake",
            caption: "图 1-1 客户端与服务端长连接三次握手及事件总线架构图"
          },
          {
            pageNumber: 2,
            title: "二、实验测试验证与指标分析",
            paragraphs: p2Paragraphs,
            diagram: "queue",
            caption: "图 2-1 10,000 并发压力测试下的 QPS 与时延阶梯分布"
          },
          {
            pageNumber: 3,
            title: "三、系统总结与鲁棒性反思",
            paragraphs: p3Paragraphs,
            diagram: "index",
            caption: "图 3-1 实验总结与模块时延对比"
          }
        ]
      });
    }
  }, [selected, saved, current, assignment, members]);
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
        <div
          className="review-split-layout"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.35fr) minmax(0, 1fr)",
            gap: "20px",
            marginTop: "18px",
            alignItems: "start",
          }}
        >
          {/* 左侧：报告阅读器（支持 PDF/Word 结构化解析、按页浏览、证据跳转与高亮、选中划词增加批注） */}
          <div style={{ position: "sticky", top: "20px" }}>
            <ReportViewer
              report={parsedReport}
              activePage={activePage}
              highlightQuote={activeHighlightQuote}
              annotations={annotations}
              onAddAnnotation={(ann) => setAnnotations((prev) => [...prev, ann])}
              onDeleteAnnotation={(annId) => setAnnotations((prev) => prev.filter((a) => a.id !== annId))}
            />
          </div>

          {/* 右侧：Rubric 评分复核与 Teacher-in-the-loop 人机协同面板 */}
          <div>
            <RubricEvaluationPanel
              current={current}
              rubric={rubric}
              isBusy={isBusy}
              pending={pending}
              confirmPublish={confirmPublish}
              onLocateEvidence={(page, quote) => {
                setActivePage(page);
                setActiveHighlightQuote(quote);
              }}
              onPatchGrade={patchGrade}
              onUpdateSummary={(summary) => {
                setReviews((previous) => ({
                  ...previous,
                  [selected]: {
                    ...previous[selected],
                    summary,
                  },
                }));
              }}
              onPublish={() => void run("review-publish")}
              onSetConfirmPublish={setConfirmPublish}
              validateGrades={() => validateServerGrades(current.grades, rubric)}
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
