import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RefreshCw } from "lucide-react";
import { request, fileUrl, ApiError } from "../api";
import { visibleAssignments, visibleCourses } from "../domain";
import { useStore } from "../store-context";
import { CourseBadge, Empty, PageHeading } from "../ui";
import type { Rubric, ServerGrade, ServerReview } from "../types";
import { VoiceInput } from "../components/VoiceInput";

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

export function OnlineAssignments() {
  const { state, user, courseId, go } = useStore();
  const assignments = visibleAssignments(state, user!).filter(
    (a) => courseId === "all" || a.courseId === courseId,
  );
  return (
    <div className="page">
      <PageHeading
        title="作业与报告"
        eyebrow="ASSIGNMENTS"
        description="从课程实验出发，查看任务要求与评阅反馈。"
      />
      <p className="integration-note">
        当前任务目录来自团队提供的固定演示条目。服务器尚未开放作业列表、报告提交与成绩明细查询；这里不显示推测的提交状态或成绩。
      </p>
      <div className="online-assignment-list">
        {assignments.map((assignment) => (
          <article key={assignment.id}>
            <CourseBadge id={assignment.courseId} />
            <h2>{assignment.title}</h2>
            <p>{assignment.description}</p>
            <div className="online-actions">
              <button
                className="button secondary"
                onClick={() => go({ page: "assignment", id: assignment.id })}
              >
                查看任务要求
                <ArrowRight size={15} />
              </button>
              {user!.role === "teacher" && (
                <button
                  className="button primary"
                  onClick={() => go({ page: "grading", id: assignment.id })}
                >
                  进入评阅管理
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {!assignments.length && <Empty title="当前课程暂无已配置的演示作业" />}
      {user!.role === "student" && (
        <div className="parse-notice">
          <strong>报告提交与提交门禁等待服务接入</strong>
          <p>
            后续会检查是否交错作业、任务点是否完整，并把异常状态同步给老师。目前不会把文件上传到资料库冒充提交报告。
          </p>
          <button className="button secondary" disabled>
            提交报告暂不可用
          </button>
        </div>
      )}
    </div>
  );
}

export function OnlineAssignment({ id }: { id: string }) {
  const { state, user, go } = useStore();
  const assignment = visibleAssignments(state, user!).find((a) => a.id === id);
  const [draft, setDraft] = useState("");
  if (!assignment) return <Empty title="无法查看这份作业" />;
  return (
    <div className="page">
      <button
        className="text-button"
        onClick={() => go({ page: "assignments" })}
      >
        <ArrowLeft size={14} />
        返回作业列表
      </button>
      <PageHeading
        title={assignment.title}
        eyebrow="EXPERIMENT"
        description="团队提供的任务样例；服务器任务配置接口待开放。"
      />
      <CourseBadge id={assignment.courseId} />
      <p className="assignment-description">{assignment.description}</p>
      <h2>任务要求与评分标准样例</h2>
      <div className="online-rubric-list">
        {assignment.rubric.map((item) => (
          <article key={item.id}>
            <strong>{item.title}</strong>
            <span>{item.max} 分</span>
            <p>{item.criterion}</p>
          </article>
        ))}
      </div>
      {user!.role === "teacher" && (
        <>
          <label>
            新的实验安排草稿
            <textarea
              rows={5}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="写下实验目标、任务点与报告要求…"
            />
          </label>
          <VoiceInput
            onText={(text) => setDraft((previous) => previous + text)}
          />
          <p className="inline-note">
            草稿仅在当前页面保留；创建、修改和发布任务接口尚未开放。
          </p>
          <button
            className="button primary"
            onClick={() => go({ page: "grading", id })}
          >
            评阅已有提交
          </button>
        </>
      )}
    </div>
  );
}

const demoSubmissions: Record<string, { id: string; label: string }[]> = {
  "lab-tcp": [
    { id: "sub-zhou-net", label: "周可 · 计网演示提交" },
    { id: "sub-xu-net", label: "许然 · 计网演示提交" },
  ],
  "lab-os": [
    { id: "sub-xu-os", label: "许然 · 操作系统演示提交" },
    { id: "sub-yi-os", label: "林一 · 操作系统演示提交" },
  ],
  "lab-db": [{ id: "sub-zhou-db", label: "周可 · 数据库演示提交" }],
};
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
  } = useStore();
  const assignment = visibleAssignments(state, user!).find((a) => a.id === id);
  const query = useQuery<AssignmentAnalytics>(
    assignment && user!.role === "teacher"
      ? `/analytics/assignment/${encodeURIComponent(id)}?skipLLM=1`
      : "",
  );
  const [selected, setSelected] = useState(demoSubmissions[id]?.[0]?.id || "");
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
  const current = reviews[selected];
  const isBusy = !!pending || !!busy["server-grade:" + id];
  const rubric: Rubric[] =
    query.data?.rubricAnalytics.map((item) => ({
      id: item.rubricId,
      title: item.title,
      max: item.max,
      criterion: item.criterion,
    })) || [];
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
            throw new Error("请按服务器评分标准补齐全部合法分数。");
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
        eyebrow="REVIEW"
        description="逐项核对报告证据，由教师确认后发布。"
      />
      <QueryNotice {...query} />
      {query.data && (
        <div className="online-metrics">
          <div>
            <strong>{query.data.totalSubmissions}</strong>
            <span>服务器提交总数</span>
          </div>
          <div>
            <strong>{query.data.publishedCount}</strong>
            <span>已发布报告</span>
          </div>
          <div>
            <strong>{query.data.failedCount}</strong>
            <span>评阅失败</span>
          </div>
        </div>
      )}
      <p className="integration-note">
        提交列表接口尚未开放，以下仅列出对接指南中的固定演示提交，状态未知。开始评阅、重试和发布会修改服务器记录；分数与证据只展示本次服务响应。结果会保留到退出登录或刷新页面。
      </p>
      <label>
        选择已有演示提交
        <select
          value={selected}
          disabled={isBusy}
          onChange={(e) => {
            setSelected(e.target.value);
            setError("");
            setConfirmPublish(false);
          }}
        >
          {(demoSubmissions[id] || []).map((item) => (
            <option value={item.id} key={item.id}>
              {item.label}（{item.id}）
            </option>
          ))}
        </select>
      </label>
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
          {pending === "grade-submission" ? "正在评阅…" : "开始服务器评阅"}
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
          重试失败评阅
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
            失败”的报告。当前批量接口只返回汇总结果，无法继续读取每份明细；需要逐项复核时请使用单份评阅。
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
          title="暂无本次评阅结果"
          description="选择一份演示提交并开始评阅。已有的历史成绩需等待提交详情接口开放后读取。"
        />
      )}
      {current && (
        <section className="server-review">
          <h2>
            {current.status === "published"
              ? "成绩已发布"
              : current.status === "review"
                ? "服务器评阅结果 · 待教师复核"
                : "评阅未完成"}
          </h2>
          <p>
            返回总分：{current.totalScore} / {current.maxScore}
            {current.reviewVersion
              ? ` · 第 ${current.reviewVersion} 次复核`
              : ""}
          </p>
          <p className="inline-note">
            分数和原文引用来自服务器；当前响应没有模型来源字段，因此不将它单独认定为真实模型评分。
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
                    {grade.page ? `报告第 ${grade.page} 页` : "服务未提供页码"}
                  </strong>
                  <blockquote>
                    {grade.evidence ||
                      "服务未提供原文引用，请查看报告原件核对。"}
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
                    将核定分数和综合反馈写入服务器。当前学生成绩查询入口尚未开放。
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
  const { user, courseId, setCourseId, go } = useStore();
  const myCourses = visibleCourses(user!);
  const chosen = courseId === "all" ? myCourses[0]?.id : courseId;
  const query = useQuery<CourseAnalytics>(
    chosen && user!.role === "teacher"
      ? `/analytics/course/${encodeURIComponent(chosen)}?skipLLM=1`
      : "",
  );
  if (user!.role !== "teacher") return <Empty title="教学反馈仅对教师开放" />;
  return (
    <div className="page">
      <PageHeading
        title="教学反馈"
        eyebrow="TEACHING INSIGHTS"
        description="依据服务器中的已发布报告，安排下一次课堂。"
      />
      <label>
        课程
        <select
          value={chosen || ""}
          onChange={(event) => setCourseId(event.target.value)}
        >
          {myCourses.map((course) => (
            <option key={course.id} value={course.id}>
              {course.title}
            </option>
          ))}
        </select>
      </label>
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
            数据来自服务器；均分、分数段和薄弱项只统计已发布报告。教学建议为规则汇总，引用页码与图表需教师核对。
          </p>
          {!query.data.totalPublishedSubmissionsCount && (
            <Empty
              title="暂无已发布报告"
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
