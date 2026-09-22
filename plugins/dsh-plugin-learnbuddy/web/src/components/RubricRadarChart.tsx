import React from "react";

export interface RadarDimension {
  /** 维度名（评分项标题） */
  label: string;
  /** 达成率，0–1 */
  value: number;
  /** 悬浮提示里的补充说明，如「18 / 20 分」 */
  detail?: string;
}

const SIZE = 330;
const CENTER = SIZE / 2;
const RADIUS = 104;
const RINGS = [0.25, 0.5, 0.75, 1];

/** 极坐标 → SVG 坐标（0 号轴从正上方开始，顺时针排布） */
function pointAt(index: number, total: number, ratio: number) {
  const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
  return {
    x: CENTER + Math.cos(angle) * RADIUS * ratio,
    y: CENTER + Math.sin(angle) * RADIUS * ratio,
  };
}

function toPath(points: { x: number; y: number }[]) {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") + " Z";
}

/** 标题过长时截断，避免轴标签互相压叠 */
function shortLabel(label: string, max = 7) {
  const text = String(label || "").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Rubric 能力雷达图。
 *
 * 数据源：AssignmentAnalytics.rubricAnalytics[].scoreRate（已发布成绩的真实达成率）。
 * 少于 3 个维度时不渲染 —— 两点连线无法构成可读的雷达图形状。
 */
export const RubricRadarChart: React.FC<{ dimensions: RadarDimension[] }> = ({ dimensions }) => {
  if (!Array.isArray(dimensions) || dimensions.length < 3) return null;

  const total = dimensions.length;
  const safeValue = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

  const dataPoints = dimensions.map((d, i) => pointAt(i, total, safeValue(d.value)));
  const average = dimensions.reduce((sum, d) => sum + safeValue(d.value), 0) / total;

  return (
    <div className="lb-radar-wrap">
      <svg className="lb-radar" viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="各评分项达成率雷达图">
        {/* 同心网格 */}
        {RINGS.map((ring) => (
          <polygon
            className="lb-radar-grid"
            key={ring}
            points={dimensions.map((_, i) => {
              const p = pointAt(i, total, ring);
              return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
            }).join(" ")}
          />
        ))}

        {/* 轴线 */}
        {dimensions.map((_, i) => {
          const p = pointAt(i, total, 1);
          return <line className="lb-radar-axis" key={i} x1={CENTER} y1={CENTER} x2={p.x} y2={p.y} />;
        })}

        {/* 数据面 */}
        <path className="lb-radar-area" d={toPath(dataPoints)} />

        {/* 顶点 */}
        {dataPoints.map((p, i) => (
          <circle className="lb-radar-dot" key={i} cx={p.x} cy={p.y} r={3.2}>
            <title>
              {dimensions[i].label} · {Math.round(safeValue(dimensions[i].value) * 100)}%
              {dimensions[i].detail ? ` (${dimensions[i].detail})` : ""}
            </title>
          </circle>
        ))}

        {/* 轴标签与达成率 */}
        {dimensions.map((d, i) => {
          const labelPoint = pointAt(i, total, 1.2);
          const valuePoint = pointAt(i, total, 1.2 + 0.14);
          const ratio = safeValue(d.value);
          // 依据标签所在象限决定对齐方式，避免文字压到图形上
          const anchor = Math.abs(labelPoint.x - CENTER) < 6 ? "middle" : labelPoint.x > CENTER ? "start" : "end";
          return (
            <g key={i}>
              <text className="lb-radar-label" x={labelPoint.x} y={labelPoint.y} textAnchor={anchor}>
                {shortLabel(d.label)}
              </text>
              <text
                className={`lb-radar-value${ratio < 0.6 ? " low" : ""}`}
                x={valuePoint.x}
                y={valuePoint.y}
                textAnchor={anchor}
              >
                {Math.round(ratio * 100)}%
              </text>
            </g>
          );
        })}
      </svg>

      <p className="lb-radar-note">
        全项平均达成率 <strong>{Math.round(average * 100)}%</strong>，仅统计已发布成绩。
      </p>
    </div>
  );
};

export default RubricRadarChart;
