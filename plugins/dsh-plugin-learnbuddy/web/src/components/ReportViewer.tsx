import React, { useState, useEffect, useRef } from "react";
import { DocumentPage, AnnotationItem } from "../types";

export interface ReportViewerProps {
  fileName?: string;
  pages: DocumentPage[];
  activePage: number;
  highlightQuote?: string | null;
  annotations: AnnotationItem[];
  onPageChange?: (page: number) => void;
  onAddAnnotation?: (annotation: Omit<AnnotationItem, "id" | "createdAt">) => void;
  onDeleteAnnotation?: (id: string) => void;
}

export const ReportViewer: React.FC<ReportViewerProps> = ({
  fileName = "学生实验与设计报告.pdf",
  pages,
  activePage,
  highlightQuote,
  annotations,
  onPageChange,
  onAddAnnotation,
  onDeleteAnnotation,
}) => {
  const [zoom, setZoom] = useState<number>(100);
  const [selectedText, setSelectedText] = useState<string>("");
  const [showAnnotationModal, setShowAnnotationModal] = useState<boolean>(false);
  const [newAnnotationComment, setNewAnnotationComment] = useState<string>("");
  const [annotationColor, setAnnotationColor] = useState<AnnotationItem["color"]>("yellow");
  const [viewMode, setViewMode] = useState<"formatted" | "source" | "preview">("formatted");
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});

  // 监听 activePage 变动，平滑滚动至对应页
  useEffect(() => {
    if (pageRefs.current[activePage]) {
      pageRefs.current[activePage]?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [activePage]);

  // 处理用户在阅读区划词
  const handleMouseUp = () => {
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
      setSelectedText(selection.toString().trim());
    }
  };

  const handleCreateAnnotation = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAnnotationComment.trim() && !selectedText) return;

    if (onAddAnnotation) {
      onAddAnnotation({
        page: activePage,
        text: newAnnotationComment.trim() || "教师高亮标记",
        quote: selectedText || undefined,
        author: "teacher",
        color: annotationColor,
      });
    }

    setShowAnnotationModal(false);
    setNewAnnotationComment("");
    setSelectedText("");
  };

  // 高亮渲染文本辅助函数
  const renderHighlightedText = (text: string, currentQuote?: string | null) => {
    if (!currentQuote || !currentQuote.trim()) return text;
    const cleanQuote = currentQuote.trim();
    if (!text.toLowerCase().includes(cleanQuote.toLowerCase())) return text;

    const parts = text.split(new RegExp(`(${cleanQuote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
    return (
      <>
        {parts.map((part, i) =>
          part.toLowerCase() === cleanQuote.toLowerCase() ? (
            <mark
              key={i}
              className="bg-amber-200 text-amber-950 font-medium px-1 py-0.5 rounded shadow-sm border border-amber-300 ring-2 ring-amber-400/50 transition-all animate-pulse"
              title="Rubric 评分关联证据"
            >
              {part}
            </mark>
          ) : (
            part
          )
        )}
      </>
    );
  };

  const currentPageAnnotations = annotations.filter((a) => a.page === activePage);

  return (
    <div className="flex flex-col h-full bg-slate-100 border-r border-slate-200 relative select-text" ref={containerRef}>
      {/* 顶部工具栏 */}
      <div className="h-12 bg-white border-b border-slate-200 px-4 flex items-center justify-between shadow-xs select-none">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold px-2 py-0.5 bg-blue-50 text-blue-700 rounded border border-blue-200">
            {fileName.endsWith(".docx") ? "DOCX 原文解析" : "PDF 结构化版面"}
          </span>
          <span className="text-xs text-slate-600 font-medium truncate max-w-[200px]" title={fileName}>
            {fileName}
          </span>
        </div>

        {/* 翻页与缩放控制器 */}
        <div className="flex items-center gap-1.5 text-xs text-slate-600">
          <button
            onClick={() => onPageChange && onPageChange(Math.max(1, activePage - 1))}
            disabled={activePage <= 1}
            className="px-2 py-1 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            title="上一页"
          >
            ◀
          </button>
          <span className="px-1.5 font-medium">
            第 <strong className="text-slate-800">{activePage}</strong> / {pages.length} 页
          </span>
          <button
            onClick={() => onPageChange && onPageChange(Math.min(pages.length, activePage + 1))}
            disabled={activePage >= pages.length}
            className="px-2 py-1 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            title="下一页"
          >
            ▶
          </button>

          <div className="h-4 w-px bg-slate-200 mx-1.5" />

          {/* 缩放 */}
          <button
            onClick={() => setZoom((z) => Math.max(75, z - 10))}
            className="p-1 hover:bg-slate-100 rounded text-slate-600"
            title="缩小"
          >
            🔍-
          </button>
          <span className="w-10 text-center font-mono text-[11px]">{zoom}%</span>
          <button
            onClick={() => setZoom((z) => Math.min(150, z + 10))}
            className="p-1 hover:bg-slate-100 rounded text-slate-600"
            title="放大"
          >
            🔍+
          </button>
        </div>

        {/* 右侧批注操作与视图切换 */}
        <div className="flex items-center gap-2">
          {selectedText && (
            <button
              onClick={() => setShowAnnotationModal(true)}
              className="text-xs bg-indigo-600 hover:bg-indigo-700 text-white px-2.5 py-1 rounded shadow-xs flex items-center gap-1 transition animate-bounce"
            >
              ✍️ 添加批注/高亮
            </button>
          )}

          <div className="flex bg-slate-100 p-0.5 rounded border border-slate-200 text-[11px]">
            <button
              onClick={() => setViewMode("formatted")}
              className={`px-2 py-0.5 rounded ${
                viewMode === "formatted" ? "bg-white text-slate-800 font-semibold shadow-xs" : "text-slate-500"
              }`}
            >
              排版视图
            </button>
            <button
              onClick={() => setViewMode("preview")}
              className={`px-2 py-0.5 rounded ${
                viewMode === "preview" ? "bg-white text-slate-800 font-semibold shadow-xs" : "text-slate-500"
              }`}
            >
              带批注视图
            </button>
          </div>
        </div>
      </div>

      {/* 报告正文主滚动区域（A4纸张仿真排版） */}
      <div
        className="flex-1 overflow-y-auto p-6 flex flex-col items-center gap-6"
        onMouseUp={handleMouseUp}
      >
        {pages.map((page, index) => {
          const pageNum = index + 1;
          const isActive = pageNum === activePage;
          const pageAnnotations = annotations.filter((a) => a.page === pageNum);

          return (
            <div
              key={pageNum}
              ref={(el) => (pageRefs.current[pageNum] = el)}
              style={{ transform: `scale(${zoom / 100})`, transformOrigin: "top center" }}
              className={`w-full max-w-3xl bg-white rounded-lg shadow-md border transition-all duration-200 p-8 min-h-[950px] relative flex flex-col justify-between ${
                isActive ? "ring-2 ring-blue-500 border-blue-400" : "border-slate-200"
              }`}
              onClick={() => onPageChange && onPageChange(pageNum)}
            >
              {/* 页眉信息 */}
              <div>
                <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-6">
                  <span className="text-[11px] font-mono tracking-wider uppercase text-slate-400">
                    {page.eyebrow || "STUDENT TECHNICAL REPORT"}
                  </span>
                  <span className="text-xs px-2 py-0.5 bg-slate-100 text-slate-600 rounded font-mono font-medium">
                    PAGE {pageNum}
                  </span>
                </div>

                {/* 章节标题 */}
                <h2 className="text-xl font-bold text-slate-900 mb-4 tracking-tight">
                  {page.heading}
                </h2>

                {/* 正文段落 */}
                <div className="space-y-4 text-sm text-slate-700 leading-relaxed font-sans">
                  {page.paragraphs.map((p, pIdx) => (
                    <p key={pIdx} className="text-justify text-slate-700">
                      {renderHighlightedText(p, highlightQuote)}
                    </p>
                  ))}
                </div>

                {/* 代码或配置展示 */}
                {page.code && (
                  <div className="my-5 rounded-md overflow-hidden border border-slate-200 bg-slate-900 text-slate-50 font-mono text-xs p-4 shadow-inner">
                    <div className="text-[10px] text-slate-400 border-b border-slate-700 pb-1 mb-2">
                      CODE / SCRIPT SNIPPET
                    </div>
                    <pre className="overflow-x-auto whitespace-pre-wrap">{page.code}</pre>
                  </div>
                )}

                {/* 架构图 / 实验截图拟真展示 */}
                {page.diagram && (
                  <div className="my-5 p-4 bg-slate-50 border border-dashed border-slate-300 rounded-lg flex flex-col items-center">
                    <div className="w-full h-44 bg-white border border-slate-200 rounded flex items-center justify-center relative shadow-xs p-4">
                      {page.diagram === "handshake" ? (
                        <div className="flex items-center gap-6 text-xs text-slate-600 font-mono">
                          <div className="border border-blue-300 bg-blue-50 px-3 py-2 rounded text-center">
                            Client<br /><span className="text-[10px] text-blue-500">SYN (Seq=x)</span>
                          </div>
                          <div className="text-slate-400">➔ ➔ ➔</div>
                          <div className="border border-indigo-300 bg-indigo-50 px-3 py-2 rounded text-center">
                            Server<br /><span className="text-[10px] text-indigo-500">SYN-ACK</span>
                          </div>
                        </div>
                      ) : page.diagram === "queue" ? (
                        <div className="flex items-center gap-3 text-xs font-mono">
                          <div className="bg-emerald-50 text-emerald-700 border border-emerald-200 px-3 py-2 rounded">
                            Producer
                          </div>
                          <div className="text-slate-400">➔</div>
                          <div className="bg-amber-50 text-amber-700 border border-amber-200 px-4 py-2 rounded">
                            [ Kafka / RabbitMQ Queue ]
                          </div>
                          <div className="text-slate-400">➔</div>
                          <div className="bg-purple-50 text-purple-700 border border-purple-200 px-3 py-2 rounded">
                            Consumer
                          </div>
                        </div>
                      ) : (
                        <div className="text-center text-slate-500 text-xs">
                          📊 [图表解析: 实验系统架构与度量指标监控图表]
                        </div>
                      )}
                    </div>
                    {page.caption && (
                      <div className="text-xs text-slate-500 mt-2 italic text-center">
                        图 {pageNum}.1: {page.caption}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 页面底部的当前页批注与教师留言 */}
              {pageAnnotations.length > 0 && (
                <div className="mt-8 pt-4 border-t border-slate-200">
                  <div className="text-xs font-bold text-slate-700 mb-2 flex items-center gap-1.5">
                    <span>📌 页面批注 ({pageAnnotations.length})</span>
                  </div>
                  <div className="space-y-2">
                    {pageAnnotations.map((ann) => (
                      <div
                        key={ann.id}
                        className="text-xs p-2.5 rounded-md border bg-amber-50/70 border-amber-200 text-slate-800 flex items-start justify-between gap-2"
                      >
                        <div>
                          {ann.quote && (
                            <div className="text-[11px] text-amber-800 italic border-l-2 border-amber-400 pl-2 mb-1">
                              "{ann.quote}"
                            </div>
                          )}
                          <div className="font-medium text-slate-900">{ann.text}</div>
                          <div className="text-[10px] text-slate-400 mt-1">
                            批注人: {ann.author === "teacher" ? "教师 (人工)" : "AutoGrader (AI)"} · {ann.createdAt}
                          </div>
                        </div>
                        {onDeleteAnnotation && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteAnnotation(ann.id);
                            }}
                            className="text-slate-400 hover:text-red-600 text-xs px-1"
                            title="删除批注"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 页脚 */}
              <div className="mt-6 pt-2 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-400">
                <span>LearnBuddy AutoGrader Multi-Modal Evidence View</span>
                <span>Page {pageNum} of {pages.length}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* 快捷添加批注弹窗 */}
      {showAnnotationModal && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-md p-5 animate-in fade-in zoom-in-95">
            <h3 className="text-sm font-bold text-slate-800 mb-2 flex items-center gap-1.5">
              ✍️ 为报告第 {activePage} 页添加批注
            </h3>

            {selectedText && (
              <div className="mb-3 p-2 bg-slate-50 border border-slate-200 rounded text-xs text-slate-600 italic">
                <span className="font-semibold text-slate-500 not-italic">选中文本：</span>
                "{selectedText}"
              </div>
            )}

            <form onSubmit={handleCreateAnnotation}>
              <textarea
                value={newAnnotationComment}
                onChange={(e) => setNewAnnotationComment(e.target.value)}
                placeholder="请输入您的批注意见、扣分原因或指导建议..."
                rows={3}
                className="w-full text-xs p-2.5 border border-slate-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:outline-none mb-3"
                autoFocus
              />

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs text-slate-600">
                  <span>标记类型:</span>
                  <select
                    value={annotationColor}
                    onChange={(e) => setAnnotationColor(e.target.value as any)}
                    className="text-xs border border-slate-200 rounded px-2 py-1 bg-white"
                  >
                    <option value="yellow">🟡 普通关注</option>
                    <option value="green">🟢 规范好评</option>
                    <option value="red">🔴 缺失/错误</option>
                    <option value="blue">🔵 补充说明</option>
                  </select>
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAnnotationModal(false);
                      setSelectedText("");
                    }}
                    className="px-3 py-1 text-xs text-slate-600 hover:bg-slate-100 rounded"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded font-medium shadow-xs"
                  >
                    确认添加
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
