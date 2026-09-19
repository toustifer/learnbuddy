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
}) => {
  return (
    <div className="flex flex-col h-full bg-white">
      {/* 评分面板顶部状态 */}
      <div className="p-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
        <div>
          <div className="text-xs text-slate-500 font-medium">AutoGrader v0.2 人机协同复核</div>
          <div className="text-lg font-bold text-slate-800 flex items-baseline gap-2">
            <span>总分:</span>
            <span className="text-2xl font-black text-blue-600">{totalScore}</span>
            <span className="text-sm font-normal text-slate-400">/ {maxScore} 分</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={`text-xs px-2.5 py-1 rounded-full font-semibold border ${
              isPublished
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : "bg-amber-50 text-amber-700 border-amber-200"
            }`}
          >
            {isPublished ? "✓ 已发布成绩" : "⏳ 教师复核中 (未发布)"}
          </span>
          <button
            onClick={onConfirmGrades}
            disabled={isSaving}
            className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-xs font-semibold rounded-lg shadow-sm transition disabled:opacity-50 flex items-center gap-1.5"
          >
            {isSaving ? "保存中..." : isPublished ? "更新成绩并发布" : "确认成绩并发布"}
          </button>
        </div>
      </div>

      {/* 评阅总体概述 */}
      <div className="p-4 border-b border-slate-200 bg-slate-50/50">
        <div className="text-xs font-bold text-slate-700 mb-1 flex items-center gap-1.5">
          <span>📋 综合学情小结 (AI 初评建议)</span>
        </div>
        <p className="text-xs text-slate-600 leading-relaxed bg-white p-3 rounded-lg border border-slate-200 shadow-2xs">
          {summary || "暂无评阅综合小结"}
        </p>
      </div>

      {/* Rubric 评分小项列表 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">
            Rubric 评分项与证据关联 ({grades.length})
          </span>
          <span className="text-[11px] text-slate-400">点击卡片可联动左侧原文证据</span>
        </div>

        {grades.map((g) => {
          const isSelected = activeRubricId === g.rubricId;
          const scorePercent = g.max ? (g.score / g.max) * 100 : 0;
          const isSuggestedDiff = g.suggestedScore !== undefined && g.suggestedScore !== g.score;

          return (
            <div
              key={g.rubricId}
              onClick={() => onSelectGrade(g)}
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
                      onScoreChange(g.rubricId, Number(e.target.value));
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-12 text-center font-bold text-sm bg-white border border-slate-300 rounded px-1 py-0.5 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  />
                  <span className="text-xs text-slate-500 font-medium pr-1">/ {g.max || 10} 分</span>
                </div>
              </div>

              {/* 区分 AI 建议分 vs 教师设定分 */}
              {isSuggestedDiff && (
                <div className="mb-2 text-[11px] text-amber-700 bg-amber-50 px-2.5 py-1 rounded border border-amber-200 flex items-center justify-between">
                  <span>AI 初始建议分: {g.suggestedScore} 分</span>
                  <span className="font-semibold">教师已人工修正</span>
                </div>
              )}

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
                  onChange={(e) => onCommentChange(g.rubricId, e.target.value)}
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
