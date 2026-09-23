import React from "react";
import { ServerGrade } from "../types";

export interface RubricEvaluationPanelProps {
  grades: ServerGrade[];
  activeRubricId: string | null;
  activeEvidenceQuote: string | null;
  totalScore: number;
  maxScore: number;
  summary: string;
  isPublished: boolean;
  onSelectGrade: (grade: ServerGrade) => void;
  onScoreChange: (rubricId: string, score: number) => void;
  onCommentChange: (rubricId: string, comment: string) => void;
  onConfirmGrades: () => void;
  isSaving?: boolean;
  /** 发布前二次确认状态：Teacher-in-the-loop 需要显式确认，避免误点直接发布 */
  confirmPublish?: boolean;
  onSetConfirmPublish?: (value: boolean) => void;
}

/** 关注级别标签文案（与后端 attentionLevel 对齐） */
const ATTENTION_LABEL: Record<string, { text: string; tone: "alert" | "warn" }> = {
  review_required: { text: "需裁决", tone: "alert" },
  needs_attention: { text: "待复核", tone: "warn" },
};

function GradeComment({ value, rubricId, onChange }: { value: string; rubricId: string; onChange: (rubricId: string, comment: string) => void }) {
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  React.useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight + 2}px`;
  }, [value]);
  return (
    <label className="lb-comment" onClick={(event) => event.stopPropagation()}>
      <span>评语 · 可修改</span>
      <textarea
        ref={inputRef}
        value={value}
        placeholder="填写评语……"
        onChange={(event) => onChange(rubricId, event.target.value)}
        rows={2}
      />
    </label>
  );
}

export const RubricEvaluationPanel: React.FC<RubricEvaluationPanelProps> = ({
  grades,
  activeRubricId,
  activeEvidenceQuote,
  totalScore,
  maxScore,
  summary,
  isPublished,
  onSelectGrade,
  onScoreChange,
  onCommentChange,
  onConfirmGrades,
  isSaving = false,
  confirmPublish = false,
  onSetConfirmPublish,
}) => {
  return (
    <div className="lb-panel">
      {/* 面板顶部：总分与发布状态 */}
      <div className="lb-panel-head">
        <div>
          <div className="lb-panel-kicker">评分复核</div>
          <div className="lb-total">
            <strong>{totalScore}</strong>
            <em>/ {maxScore} 分</em>
          </div>
        </div>

        <div className="lb-panel-actions">
          <span className={`lb-chip${isPublished ? "" : " warn"}`}>
            {isPublished ? "已发布" : "复核中"}
          </span>
          <button
            className="lb-btn primary"
            disabled={isSaving}
            onClick={() => {
              // 有二次确认能力时先展开确认条，避免误点直接发布成绩
              if (!onSetConfirmPublish) {
                onConfirmGrades();
                return;
              }
              onSetConfirmPublish(!confirmPublish);
            }}
          >
            {isSaving ? "保存中…" : isPublished ? "更新成绩并发布" : "确认成绩并发布"}
          </button>
        </div>
      </div>

      {/* 发布前二次确认：Teacher-in-the-loop 的严肃性 */}
      {confirmPublish && (
        <div className="lb-confirm">
          <div className="lb-confirm-text">
            <strong>确认发布？</strong>
            共 {grades.length} 项 · 总分 {totalScore} / {maxScore}，发布后学生可见。
          </div>
          <div className="lb-confirm-actions">
            <button className="lb-btn" onClick={() => onSetConfirmPublish?.(false)}>
              取消
            </button>
            <button
              className="lb-btn primary"
              disabled={isSaving}
              onClick={() => {
                onSetConfirmPublish?.(false);
                onConfirmGrades();
              }}
            >
              确认发布
            </button>
          </div>
        </div>
      )}

      <div className="lb-panel-scroll">
      {/* 评阅总体概述 */}
      <div className="lb-summary">
        <div className="lb-summary-title">综合小结</div>
        <p>{summary || "暂无小结"}</p>
      </div>

      {/* Rubric 评分项列表 */}
      <div className="lb-items">
        <div className="lb-items-head">
          <strong>评分证据（{grades.length}）</strong>
        </div>

        {grades.map((g) => {
          const isSelected = activeRubricId === g.rubricId;
          const scorePercent = g.max ? (g.score / g.max) * 100 : 0;
          const isSuggestedDiff = g.suggestedScore !== undefined && g.suggestedScore !== g.score;
          // 当前在原文中定位到的证据：对应卡片给出视觉反馈，
          // 否则教师点完证据后不知道回到哪一项
          const isEvidenceActive = Boolean(
            activeEvidenceQuote && g.evidence && g.evidence.includes(activeEvidenceQuote)
          );
          const attention = g.attentionLevel ? ATTENTION_LABEL[g.attentionLevel] : undefined;

          return (
            <div
              key={g.rubricId}
              className={`lb-item${isSelected ? " selected" : ""}`}
              onClick={() => onSelectGrade(g)}
            >
              {/* 标题行与关注标识 */}
              <div className="lb-item-top">
                <div style={{ minWidth: 0 }}>
                  <div className="lb-item-title">{g.title || g.rubricId}</div>
                  <div className="lb-item-tags">
                    {attention && <span className={`lb-chip ${attention.tone}`}>{attention.text}</span>}
                    {/* 页码只显示模型给出的真实值：拿不到就整条不显示（契约层「不猜位置」）。
                        证据引用改由契约层在响应层统一派生，本面板不再自建。 */}
                    {g.page ? <span className="lb-locate">第 {g.page} 页</span> : null}
                  </div>
                </div>

                {/* 分数调整区 */}
                <div className="lb-score-box" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="number"
                    min={0}
                    max={g.max || 100}
                    value={g.score ?? 0}
                    onChange={(e) => onScoreChange(g.rubricId, Number(e.target.value))}
                    aria-label={`${g.title || g.rubricId} 得分`}
                  />
                  <span>/ {g.max || 10}</span>
                </div>
              </div>

              {/* 得分进度条：把分数占比可视化，便于教师快速扫读 */}
              <div className="lb-bar">
                <i style={{ width: `${Math.min(100, Math.max(0, scorePercent))}%` }} />
              </div>

              {/* 区分 AI 建议分 vs 教师设定分 */}
              {isSuggestedDiff && (
                <div className="lb-diff">
                  <span>AI 建议 {g.suggestedScore} 分</span>
                  <span style={{ fontWeight: 600 }}>已修正</span>
                </div>
              )}

              {/* 覆盖与缺失（F6） */}
              {(g.coveredPoints?.length || g.missingPoints?.length) ? (
                <div className="lb-coverage">
                  {g.coveredPoints && g.coveredPoints.length > 0 && (
                    <div className="lb-coverage-row ok">
                      <b>已覆盖</b>
                      <div className="lb-coverage-tags">
                        {g.coveredPoints.map((pt, i) => (
                          <span key={i}>{pt}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {g.missingPoints && g.missingPoints.length > 0 && (
                    <div className="lb-coverage-row miss">
                      <b>缺失点</b>
                      <div className="lb-coverage-tags">
                        {g.missingPoints.map((pt, i) => (
                          <span key={i}>{pt}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : null}

              {/* 关联证据引用 */}
              {g.evidence && (
                <div
                  className={`lb-evidence${isEvidenceActive ? " hot" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`定位${g.title || g.rubricId}的原文证据`}
                  onClick={(event) => { event.stopPropagation(); onSelectGrade(g); }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      onSelectGrade(g);
                    }
                  }}
                >
                  <b>证据</b>
                  <p>“{g.evidence}”</p>
                </div>
              )}

              {/* 评语编辑框 */}
              <GradeComment value={g.comment || ""} rubricId={g.rubricId} onChange={onCommentChange} />
            </div>
          );
        })}
      </div>
      </div>
    </div>
  );
};
