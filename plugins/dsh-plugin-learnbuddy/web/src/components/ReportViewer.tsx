import React, { useState, useEffect, useRef } from "react";
import { DocumentPage, ReportAnnotation, ReportImageRef } from "../types";
import { fileUrl } from "../api";

export interface ReportViewerProps {
  fileName?: string;
  pages: DocumentPage[];
  activePage: number;
  highlightQuote?: string | null;
  annotations: ReportAnnotation[];
  /** 真实落盘的报告内嵌图片；空数组表示确实没有图，不做占位 */
  images?: ReportImageRef[];
  /** 未能落盘的图片原因，如实展示 */
  imageWarnings?: string[];
  /** 解析过程中的降级 / 缺失告警 */
  warnings?: string[];
  /** partial 表示正文拿到了、但有内容缺失（不等于解析失败） */
  completeness?: "complete" | "partial";
  /** 页数由标题/段落结构估算 */
  pagesEstimated?: boolean;
  onPageChange?: (page: number) => void;
  onAddAnnotation?: (annotation: Omit<ReportAnnotation, "id" | "createdAt">) => void;
  onDeleteAnnotation?: (id: string) => void;
}

export const ReportViewer: React.FC<ReportViewerProps> = ({
  fileName = "学生提交报告",
  pages,
  activePage,
  highlightQuote,
  annotations,
  images = [],
  imageWarnings = [],
  warnings = [],
  completeness = "complete",
  pagesEstimated = false,
  onPageChange,
  onAddAnnotation,
  onDeleteAnnotation,
}) => {
  const [zoom, setZoom] = useState<number>(100);
  const [selectedText, setSelectedText] = useState<string>("");
  const [showAnnotationModal, setShowAnnotationModal] = useState<boolean>(false);
  const [newAnnotationComment, setNewAnnotationComment] = useState<string>("");
  const [annotationColor, setAnnotationColor] = useState<ReportAnnotation["color"]>("yellow");
  const [viewMode, setViewMode] = useState<"formatted" | "preview">("formatted");
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
    // 新增批注后自动切到「带批注视图」，否则教师看不到刚写下的标注
    setViewMode("preview");
  };

  /** 在段落文本里定位证据原文并高亮（仅当 quote 真实存在于正文时才高亮） */
  const renderHighlightedText = (text: string, currentQuote?: string | null) => {
    if (!currentQuote || !currentQuote.trim()) return text;
    const cleanQuote = currentQuote.trim();
    if (!text.toLowerCase().includes(cleanQuote.toLowerCase())) return text;

    const parts = text.split(new RegExp(`(${cleanQuote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
    return (
      <>
        {parts.map((part, i) =>
          part.toLowerCase() === cleanQuote.toLowerCase() ? (
            <mark className="lb-mark" key={i} title="Rubric 评分关联证据">
              {part}
            </mark>
          ) : (
            part
          )
        )}
      </>
    );
  };

  // 工具栏只显示文件格式，不写「原文解析 / 结构化版面」这类解释性措辞
  const extLabel = (fileName.match(/\.([a-z0-9]+)$/i)?.[1] || "原文").toUpperCase();

  return (
    <div className="lb-reader" ref={containerRef}>
      {/* 顶部工具栏 */}
      <div className="lb-reader-bar">
        <div className="lb-reader-meta">
          <span className="lb-chip">{extLabel}</span>
          {completeness === "partial" && <span className="lb-chip warn">解析不完整</span>}
          <span className="lb-reader-file" title={fileName}>
            {fileName}
          </span>
        </div>

        {/* 翻页与缩放控制器 */}
        <div className="lb-reader-tools">
          <button
            className="lb-btn"
            onClick={() => onPageChange && onPageChange(Math.max(1, activePage - 1))}
            disabled={activePage <= 1}
            title="上一页"
          >
            ◀
          </button>
          <span className="lb-pager">
            第 <strong>{activePage}</strong> / {pages.length} 页
          </span>
          <button
            className="lb-btn"
            onClick={() => onPageChange && onPageChange(Math.min(pages.length, activePage + 1))}
            disabled={activePage >= pages.length}
            title="下一页"
          >
            ▶
          </button>

          <span aria-hidden="true" style={{ width: 1, height: 16, background: "var(--line)", margin: "0 4px" }} />

          <button
            className="lb-btn"
            onClick={() => setZoom((z) => Math.max(75, z - 10))}
            disabled={zoom <= 75}
            title="缩小"
          >
            −
          </button>
          <span style={{ minWidth: 38, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>{zoom}%</span>
          <button
            className="lb-btn"
            onClick={() => setZoom((z) => Math.min(150, z + 10))}
            disabled={zoom >= 150}
            title="放大"
          >
            +
          </button>
        </div>

        {/* 右侧批注操作与视图切换 */}
        <div className="lb-reader-tools">
          {selectedText && (
            <button className="lb-btn primary" onClick={() => setShowAnnotationModal(true)}>
              添加批注
            </button>
          )}

          <div className="lb-seg">
            <button className={viewMode === "formatted" ? "on" : ""} onClick={() => setViewMode("formatted")}>
              排版视图
            </button>
            <button className={viewMode === "preview" ? "on" : ""} onClick={() => setViewMode("preview")}>
              带批注视图
            </button>
          </div>
        </div>
      </div>

      {/* 报告正文主滚动区域（A4 纸张排版） */}
      <div className="lb-reader-scroll" onMouseUp={handleMouseUp}>
        {pages.map((page, index) => {
          const pageNum = index + 1;
          const isActive = pageNum === activePage;
          const pageAnnotations = annotations.filter((a) => a.page === pageNum);

          return (
            <div
              key={pageNum}
              ref={(el) => {
                pageRefs.current[pageNum] = el;
              }}
              style={{ transform: `scale(${zoom / 100})`, transformOrigin: "top center" }}
              className={`lb-paper${isActive ? " active" : ""}`}
              onClick={() => onPageChange && onPageChange(pageNum)}
            >
              {/* 页眉信息 */}
              <div className="lb-paper-head">
                <span className="lb-paper-eyebrow">{page.eyebrow || "STUDENT TECHNICAL REPORT"}</span>
                <span className="lb-paper-no">PAGE {pageNum}</span>
              </div>

              {/* 章节标题：解析拿不到标题时不渲染空标题占位 */}
              {page.heading ? <h2>{page.heading}</h2> : null}

              {/* 正文段落 */}
              <div className="lb-paper-body">
                {page.paragraphs.map((p, pIdx) => (
                  <p key={pIdx}>{renderHighlightedText(p, highlightQuote)}</p>
                ))}
              </div>

              {/* 代码或配置展示 */}
              {page.code && (
                <div className="lb-code">
                  <div className="lb-code-title">CODE / SCRIPT SNIPPET</div>
                  <pre>{page.code}</pre>
                </div>
              )}

              {/* 报告内嵌的示意图（真实截图见下方「报告内嵌图」区） */}
              {page.diagram && (
                <div className="lb-figure">
                  <div className="lb-figure-canvas">
                    {page.diagram === "handshake" ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 22, fontSize: 12 }}>
                        <div className="lb-diagram-node">
                          Client
                          <span>SYN (Seq=x)</span>
                        </div>
                        <span style={{ color: "#a8b4a6" }}>➔ ➔ ➔</span>
                        <div className="lb-diagram-node alt">
                          Server
                          <span>SYN-ACK</span>
                        </div>
                      </div>
                    ) : page.diagram === "queue" ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12 }}>
                        <div className="lb-diagram-node">Producer</div>
                        <span style={{ color: "#a8b4a6" }}>➔</span>
                        <div className="lb-diagram-node alt">Queue</div>
                        <span style={{ color: "#a8b4a6" }}>➔</span>
                        <div className="lb-diagram-node">Consumer</div>
                      </div>
                    ) : (
                      <span>包含图表，见原件</span>
                    )}
                  </div>
                  {page.caption && <div className="lb-figure-caption">图 {pageNum}.1：{page.caption}</div>}
                </div>
              )}

              {/* 页面底部的当前页批注（「带批注视图」下显示） */}
              {viewMode === "preview" && pageAnnotations.length > 0 && (
                <div className="lb-annotations">
                  <div className="lb-annotations-title">页面批注（{pageAnnotations.length}）</div>
                  {pageAnnotations.map((ann) => (
                    <div className="lb-annotation" key={ann.id}>
                      <div style={{ minWidth: 0 }}>
                        {ann.quote && <div className="lb-annotation-quote">“{ann.quote}”</div>}
                        <div className="lb-annotation-text">{ann.text}</div>
                        <div className="lb-annotation-meta">
                          {ann.author === "teacher" ? "教师" : "AutoGrader"} · {ann.createdAt}
                        </div>
                      </div>
                      {onDeleteAnnotation && (
                        <button
                          className="lb-annotation-del"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteAnnotation(ann.id);
                          }}
                          title="删除批注"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* 页脚 */}
              <div className="lb-paper-foot">
                <span>LearnBuddy</span>
                <span>
                  Page {pageNum} / {pages.length}
                </span>
              </div>
            </div>
          );
        })}

        {/* 报告内嵌图片：只展示真实落盘的图；未能落盘的如实说明，不做占位欺骗 */}
        {(images.length > 0 || imageWarnings.length > 0) && (
          <div className="lb-images">
            <div className="lb-images-head">
              <strong>内嵌图（{images.length}）</strong>
            </div>

            {images.length > 0 && (
              <div className="lb-images-grid">
                {images.map((image) => (
                  <figure className="lb-image-card" key={image.fileId}>
                    <img src={fileUrl(image.fileId)} alt={`报告内嵌图 ${image.index}`} loading="lazy" />
                    <figcaption>
                      图 {image.index} · {image.mimeType}
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}

          </div>
        )}

        {/* 解析告警：正文 / 图片提取过程中的降级与缺失，如实列出，不静默吞掉 */}
        {(warnings.length > 0 || imageWarnings.length > 0) && (
          <ul className="lb-image-warnings">
            {[...warnings, ...imageWarnings].map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        )}

        {pagesEstimated && <p className="lb-note">页码为估算值</p>}
      </div>

      {/* 划词批注弹窗 */}
      {showAnnotationModal && (
        <div className="lb-modal-mask">
          <div className="lb-modal">
            <h3>第 {activePage} 页批注</h3>

            {selectedText && (
              <div className="lb-modal-quote">
                选中文本：“{selectedText}”
              </div>
            )}

            <form onSubmit={handleCreateAnnotation}>
              <textarea
                value={newAnnotationComment}
                onChange={(e) => setNewAnnotationComment(e.target.value)}
                placeholder="填写批注……"
                autoFocus
              />

              <div className="lb-modal-foot">
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted)" }}>
                  标记类型
                  <select
                    value={annotationColor}
                    onChange={(e) => setAnnotationColor(e.target.value as ReportAnnotation["color"])}
                  >
                    <option value="yellow">普通关注</option>
                    <option value="green">规范好评</option>
                    <option value="red">缺失 / 错误</option>
                    <option value="blue">补充说明</option>
                  </select>
                </label>

                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="lb-btn"
                    onClick={() => {
                      setShowAnnotationModal(false);
                      setSelectedText("");
                    }}
                  >
                    取消
                  </button>
                  <button type="submit" className="lb-btn primary">
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
