import React from "react";
import { ServerGrade, ServerReview, Rubric } from "../types";

/**
 * AutoGrader v0.2 复核面板（Teacher-in-the-loop）
 *
 * 契约说明（2026-09-20 修复）：
 *   本组件原本声明的是 `grades / activeRubricId / totalScore / …` 一套「受控哑组件」接口，
 *   但 `Online.tsx` 实际传的是 `current / rubric / onPatchGrade / onPublish / …`。
 *   两套接口零重叠，导致面板拿到的 `grades` 是 undefined，渲染即崩。
 *
 *   现按「方案 A」把本组件改为**接收整份复核对象 `current`**，由组件内部派生展示所需字段，
 *   从而保留 v0.2 的全部能力：证据定位联动、逐项改分与评语、覆盖/缺失展示、整体确认发布。
 */
export interface RubricEvaluationPanelProps {
  /** 当前选中的这份报告的复核结果 */
  current?: ServerReview | null;
  /** 作业的评分标准（用于取满分与校验完整性） */
  rubric: Rubric[];
  /** 是否正在执行评阅/发布等异步动作 */
  isBusy?: boolean;
  /** 当前进行中的动作名，用于按钮文案 */
  pending?: string;
  /** 教师是否已勾选「确认发布」 */
  confirmPublish?: boolean;
  /** 点击某项证据时联动左侧阅读器定位高亮 */
  onLocateEvidence?: (page: number, quote: string) => void;
  /** 按索引修改某一评分项（分数或评语） */
  onPatchGrade: (index: number, patch: Partial<ServerGrade>) => void;
  /** 修改综合评语 */
  onUpdateSummary?: (summary: string) => void;
  /** 发布成绩 */
  onPublish?: () => void;
  /** 切换确认发布勾选状态 */
  onSetConfirmPublish?: (value: boolean) => void;
  /** 校验评分项是否完整，返回 false 时不允许发布 */
  validateGrades?: () => boolean;
}

export const RubricEvaluationPanel: React.FC<RubricEvaluationPanelProps> = ({
  current = null,
  rubric = [],
  isBusy = false,
  pending = "",
  confirmPublish = false,
  onLocateEvidence,
  onPatchGrade,
  onUpdateSummary,
  onPublish,
  onSetConfirmPublish,
  validateGrades,
}) => {
  const grades: ServerGrade[] = current?.grades ?? [];
  const summary: string = current?.summary ?? "";
  const maxScore: number =
    current?.maxScore ?? rubric.reduce((n, r) => n + (Number(r.max) || 0), 0);
  // 总分由程序遍历小项累加，不信任任何单一来源的口算值
  const totalScore: number = grades.reduce((n, g) => n + (Number(g.score) || 0), 0);
  const isPublished = current?.status === "published";
  const gradesValid = validateGrades ? validateGrades() : grades.length > 0;
  const canPublish = Boolean(onPublish) && gradesValid && confirmPublish && !isBusy;

  const publishLabel = isBusy
    ? pending === "review-publish"
      ? "发布中..."
      : "处理中..."
    : isPublished
      ? "更新成绩并发布"
      : "确认成绩并发布";

  return (
    <div className="flex flex-col h-full bg-white">
      {/* 评分面板顶部状态 */}
      <div className="p-4 border-b border-slate-200 bg-slate-50">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-500 font-medium">
              AutoGrader v0.2 人机协同复核
            </div>
            <div className="text-lg font-bold text-slate-800 flex items-baseline gap-2">
              <span>总分:</span>
              <span className="text-2xl font-black text-blue-600">{totalScore}</span>
              <span className="text-sm font-normal text-slate-400">/ {maxScore} 分</span>
            </div>
          </div>

          <span
            className={`text-xs px-2.5 py-1 rounded-full font-semibold border ${
              isPublished
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : "bg-amber-50 text-amber-700 border-amber-200"
            }`}
          >
            {isPublished ? "✓ 已发布成绩" : "⏳ 教师复核中 (未发布)"}
          </span>
        </div>

        {/* 整体确认：D3 要求确认只影响可见性，不阻塞评分与统计 */}
        <div className="mt-3 flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={confirmPublish}
              disabled={isBusy || !gradesValid}
              onChange={(e) => onSetConfirmPublish && onSetConfirmPublish(e.target.checked)}
              className="w-4 h-4 accent-blue-600"
            />
            我已复核以上评分与评语，确认向学生展示
          </label>
          <button
            onClick={() => onPublish && onPublish()}
            disabled={!canPublish}
            className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-xs font-semibold rounded-lg shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {publishLabel}
          </button>
        </div>

        {!gradesValid && (
          <div className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded">
            评分项尚未覆盖完整评分标准，暂时不能发布。请先完成全部 {rubric.length} 项。
          </div>
        )}
      </div>

      {/* 评阅总体概述（可编辑，改动回写父级） */}
      <div className="p-4 border-b border-slate-200 bg-slate-50/50">
        <div className="text-xs font-bold text-slate-700 mb-1 flex items-center gap-1.5">
          <span>📋 综合学情小结 (AI 初评建议)</span>
        </div>
        <textarea
          value={summary}
          placeholder="填写本份报告的综合小结与学习建议..."
          onChange={(e) => onUpdateSummary && onUpdateSummary(e.target.value)}
          rows={3}
          className="w-full text-xs text-slate-600 leading-relaxed bg-white p-3 rounded-lg border border-slate-200 shadow-2xs focus:ring-1 focus:ring-blue-500 focus:outline-none"
        />
      </div>

      {/* Rubric 评分小项列表 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">
            Rubric 评分项与证据关联 ({grades.length})
          </span>
          <span className="text-[11px] text-slate-400">点击卡片可联动左侧原文证据</span>
        </div>

        {grades.length === 0 && (
          <div className="text-xs text-slate-400 border border-dashed border-slate-300 rounded-lg p-6 text-center">
            当前这份报告还没有生成逐项评分结果。
          </div>
        )}

        {grades.map((g, index) => {
          const isSelected = Boolean(g.page);
          const scorePercent = g.max ? ((Number(g.score) || 0) / g.max) * 100 : 0;
          const isSuggestedDiff =
            g.suggestedScore !== undefined && g.suggestedScore !== g.score;
          const evidenceQuote = g.evidence || g.comment || "";

          return (
            <div
              key={g.rubricId || index}
              onClick={() => {
                if (g.page && onLocateEvidence) onLocateEvidence(g.page, evidenceQuote);
              }}
              className={`rounded-xl border transition-all duration-200 cursor-pointer p-4 relative ${
                isSelected
                  ? "border-blue-500 bg-blue-50/20 shadow-md ring-2 ring-blue-500/20"
                  : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-xs"
              }`}
            >
              {/* 标题行与关注标识 */}
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-bold text-slate-900">
                      {g.title || g.rubricId}
                    </span>
                    {g.attentionLevel === "review_required" && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-red-100 text-red-700 font-semibold rounded">
                        需人工重点裁决
                      </span>
                    )}
                    {g.attentionLevel === "needs_attention" && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-amber-100 text-amber-800 font-semibold rounded">
                        建议复核
                      </span>
                    )}
                  </div>
                  {g.page && (
                    <div className="text-[11px] text-blue-600 font-medium flex items-center gap-1">
                      <span>📄 原文定位：第 {g.page} 页</span>
                      <span className="text-slate-300">•</span>
                      <span className="underline hover:text-blue-800">点击直达并高亮证据</span>
                    </div>
                  )}
                </div>

                {/* 分数调整区 */}
                <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-lg">
                  <input
                    type="number"
                    min={0}
                    max={g.max || 100}
                    value={g.score ?? 0}
                    onChange={(e) => {
                      e.stopPropagation();
                      onPatchGrade(index, { score: Number(e.target.value) });
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-12 text-center font-bold text-sm bg-white border border-slate-300 rounded px-1 py-0.5 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  />
                  <span className="text-xs text-slate-500 font-medium pr-1">
                    / {g.max || 10} 分
                  </span>
                </div>
              </div>

              {/* AI 建议分 vs 教师设定分 */}
              {isSuggestedDiff && (
                <div className="mb-2 text-[11px] text-amber-700 bg-amber-50 px-2.5 py-1 rounded border border-amber-200 flex items-center justify-between">
                  <span>AI 初始建议分: {g.suggestedScore} 分</span>
                  <span className="font-semibold">教师已人工修正</span>
                </div>
              )}

              {/* 得分占比条，作为分数是否合理的直观参考 */}
              {g.max ? (
                <div className="mb-2 h-1 w-full bg-slate-100 rounded overflow-hidden">
                  <div
                    className="h-full bg-blue-500 transition-all"
                    style={{ width: `${Math.max(0, Math.min(100, scorePercent))}%` }}
                  />
                </div>
              ) : null}

              {/* 覆盖与缺失指标标签 (F6) */}
              {(g.coveredPoints || g.missingPoints) && (
                <div className="my-2.5 space-y-1.5 bg-slate-50 p-2.5 rounded-lg border border-slate-100 text-xs">
                  {g.coveredPoints && g.coveredPoints.length > 0 && (
                    <div className="flex items-start gap-1.5 text-emerald-800">
                      <span className="shrink-0 font-bold">✓ 已覆盖:</span>
                      <div className="flex flex-wrap gap-1">
                        {g.coveredPoints.map((pt, i) => (
                          <span key={i} className="bg-emerald-100/70 px-1.5 py-0.5 rounded text-[11px]">
                            {pt}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {g.missingPoints && g.missingPoints.length > 0 && (
                    <div className="flex items-start gap-1.5 text-rose-700">
                      <span className="shrink-0 font-bold">✗ 缺失点:</span>
                      <div className="flex flex-wrap gap-1">
                        {g.missingPoints.map((pt, i) => (
                          <span key={i} className="bg-rose-100/70 px-1.5 py-0.5 rounded text-[11px]">
                            {pt}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* 关联证据引用 */}
              {g.evidence && (
                <div className="mt-2 text-xs bg-amber-50/50 border-l-2 border-amber-400 p-2 text-slate-700 rounded-r">
                  <span className="font-semibold text-amber-800">关联证据原文: </span>
                  <span className="italic font-serif">"{g.evidence}"</span>
                </div>
              )}

              {/* 评语编辑框 */}
              <div className="mt-3">
                <textarea
                  value={g.comment || ""}
                  placeholder="针对该项填写评语或指导意见..."
                  onChange={(e) => onPatchGrade(index, { comment: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  rows={2}
                  className="w-full text-xs p-2 rounded-lg border border-slate-200 focus:ring-1 focus:ring-blue-500 focus:outline-none bg-slate-50/30 focus:bg-white transition"
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
