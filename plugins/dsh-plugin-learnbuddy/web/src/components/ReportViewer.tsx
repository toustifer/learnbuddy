import React, { useState, useEffect, useMemo, useRef } from "react";
import { DocumentPage, ReportAnnotation, ReportImageRef } from "../types";
import { fileUrl, previewUrl } from "../api";
import { findEvidenceSpans } from "../evidence-highlight";

export interface ReportViewerProps {
  fileName?: string;
  /** Some embedded browsers cannot paint PDFs; a caller may prefer parsed text. */
  initialView?: "source" | "formatted";
  /** Synthetic source material has no actual student-uploaded original. */
  syntheticMaterial?: boolean;
  /**
   * 报告原件的 blobId（内容寻址，带扩展名）。
   *
   * 有它就优先渲染**原件** —— 教师复核时最需要的是「学生交的那份东西本身」，
   * 而不是我们重新排版过的文本（版式、表格、图表位置都在原件里，重排会丢）。
   */
  blobId?: string | null;
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
  /** 原件本身的真实页数（转 PDF 后数出来的）；null/缺省表示没取到 */
  originalPages?: number | null;
  /** 页数由标题/段落结构估算 */
  pagesEstimated?: boolean;
  onPageChange?: (page: number) => void;
  onAddAnnotation?: (annotation: Omit<ReportAnnotation, "id" | "createdAt">) => void;
  onDeleteAnnotation?: (id: string) => void;
}

/** 浏览器能**直接**渲染的格式（不用后端转换） */
const INLINE_PREVIEWABLE = /\.(pdf|png|jpe?g|gif|webp|bmp|svg)$/i;

/** 后端能用 LibreOffice 转成 PDF 的格式 */
const CONVERTIBLE = /\.(docx?|odt|rtf|txt|pptx?|odp|xlsx?|ods|csv)$/i;

/**
 * 能不能在页面里内嵌出原件？
 *
 * 直接的（PDF/图片）与**可转换的**（Word 等）都算能 ——
 * 后者由后端 `/preview` 转成 PDF 再给。只有既不能直接渲染、又转不了的格式才退回「打开原件」。
 */
const canPreviewInline = (blobId?: string | null) =>
  Boolean(blobId && (INLINE_PREVIEWABLE.test(String(blobId)) || CONVERTIBLE.test(String(blobId))));

/** 取扩展名用于提示文案 */
const extOf = (blobId?: string | null) =>
  String(blobId || "").split(".").pop()?.toUpperCase() || "";

export const ReportViewer: React.FC<ReportViewerProps> = ({
  fileName = "学生提交报告",
  initialView,
  syntheticMaterial = false,
  blobId = null,
  pages,
  activePage,
  highlightQuote,
  annotations,
  images = [],
  imageWarnings = [],
  warnings = [],
  completeness = "complete",
  originalPages = null,
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
  // 叁种视图：原件 / 解析文本（排版视图）/ 带批注视图
  // 默认值按「能不能内嵌原件」决定 —— 能就默认给原件（教师最想看的就是它）
  const [viewMode, setViewMode] = useState<"source" | "formatted" | "preview">(
    initialView === "formatted" ? "formatted" : canPreviewInline(blobId) ? "source" : "formatted"
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const readerScrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const hasEvidenceMatch = useMemo(() => Boolean(highlightQuote && pages.some((page) =>
    page.paragraphs.some((paragraph) => findEvidenceSpans(paragraph, highlightQuote).length > 0)
  )), [highlightQuote, pages]);

  // 换报告时重新决定默认视图：能看原件就默认原件，不能就回到解析文本
  useEffect(() => {
    setViewMode(initialView === "formatted" ? "formatted" : canPreviewInline(blobId) ? "source" : "formatted");
  }, [blobId, initialView]);

  // 证据定位滚动阅读器自身；避免 scrollIntoView 把整页及右侧操作栏推走。
  useEffect(() => {
    if (viewMode === "source") return;
    const frame = requestAnimationFrame(() => {
      const scroller = readerScrollRef.current;
      const page = pageRefs.current[activePage];
      const target = (highlightQuote && (page?.querySelector(".lb-mark") || scroller?.querySelector(".lb-mark"))) || page;
      if (!scroller || !target) return;
      const offset = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTo({ top: scroller.scrollTop + offset - (highlightQuote ? scroller.clientHeight * .3 : 12), behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [activePage, highlightQuote, viewMode, pages]);

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

  /** 只高亮确实出现在解析文本里的原文片段。 */
  const renderHighlightedText = (text: string, currentQuote?: string | null) => {
    const spans = currentQuote ? findEvidenceSpans(text, currentQuote) : [];
    if (!spans.length) return text;
    let cursor = 0;
    return (
      <>
        {spans.map((span, index) => {
          const before = text.slice(cursor, span.start);
          const match = text.slice(span.start, span.end);
          cursor = span.end;
          return <React.Fragment key={`${span.start}-${index}`}>{before}<mark className="lb-mark" title="Rubric 评分关联证据">{match}</mark></React.Fragment>;
        })}
        {text.slice(cursor)}
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
            {blobId && (
              <button
                className={viewMode === "source" ? "on" : ""}
                onClick={() => setViewMode("source")}
                title={syntheticMaterial ? "测试材料没有学生上传的原件" : "直接看学生交的那份原件"}
              >
                原件
              </button>
            )}
            <button className={viewMode === "formatted" ? "on" : ""} onClick={() => setViewMode("formatted")}>
              解析文本
            </button>
            <button className={viewMode === "preview" ? "on" : ""} onClick={() => setViewMode("preview")}>
              批注
            </button>
          </div>
          {blobId && <a className="lb-btn" href={fileUrl(blobId)} target="_blank" rel="noreferrer">{syntheticMaterial ? "打开测试 PDF" : "打开原件"}</a>}
        </div>
      </div>

      {highlightQuote && !hasEvidenceMatch && (
        <div className="lb-evidence-unmatched" role="status">这条证据摘录无法在解析文本中精确定位，请核对原件。</div>
      )}

      {/* ── 原件视图：直接渲染学生交的那份文件 ──
          能内嵌的（PDF / 图片）用 iframe 原生渲染；
          不能内嵌的（Word 等）如实说明并给出「打开原件」，绝不糊一个空白框。 */}
      {viewMode === "source" && (
        <div className="lb-source">
          {syntheticMaterial ? (
            <div className="lb-source-fallback">
              <strong>模拟数据，暂无文件</strong>
              <p>这是用于运行真实 AutoGrader 的测试材料，没有学生上传的原件。可在“解析文本”中核对内容，或单独打开生成的测试 PDF。</p>
              <div className="lb-source-actions">
                <button className="lb-btn primary" onClick={() => setViewMode("formatted")}>查看解析文本</button>
                {blobId && <a className="lb-btn" href={fileUrl(blobId)} target="_blank" rel="noreferrer">打开测试 PDF</a>}
              </div>
            </div>
          ) : canPreviewInline(blobId) ? (
            <iframe
              className="lb-source-frame"
              src={previewUrl(blobId as string)}
              title={`${fileName} 原件`}
            />
          ) : (
            <div className="lb-source-fallback">
              <strong>这份原件是 {extOf(blobId) || "该"} 格式，无法在这里内嵌显示</strong>
              <p>
                浏览器不能直接渲染这种格式，后端也无法把它转成可预览的 PDF。
                你可以打开原件查看，或切到「解析文本」看提取出来的内容（注意：那不是原件的版式）。
              </p>
              <div className="lb-source-actions">
                <a className="lb-btn primary" href={fileUrl(blobId as string)} target="_blank" rel="noreferrer">
                  在新窗口打开原件
                </a>
                <a className="lb-btn" href={fileUrl(blobId as string, true)}>
                  下载原件
                </a>
                <button className="lb-btn" onClick={() => setViewMode("formatted")}>
                  改看解析文本
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 报告正文主滚动区域（A4 纸张排版） */}
      <div className="lb-reader-scroll" ref={readerScrollRef} onMouseUp={handleMouseUp} style={viewMode === "source" ? { display: "none" } : undefined}>
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

        {/* 页数：拿到原件真实页数就报真实值；拿不到才说「估算」，不冒充 */}
        {originalPages
          ? <p className="lb-note">原件共 {originalPages} 页（真实页数）</p>
          : pagesEstimated
            ? <p className="lb-note">页码为估算值</p>
            : null}
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
