import { useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  BookOpen,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  Minus,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Quote,
  Sparkles,
  X,
} from "lucide-react";
import { useStore } from "../store-context";
import { canSeeMaterial } from "../domain";
import { courses, documents } from "../seed";
import {
  AILabel,
  BlobPreview,
  BusyLabel,
  CourseBadge,
  Diagram,
  Empty,
  FileIcon,
  Modal,
  downloadBlob,
} from "../ui";
import type { ChatReference, Knowledge, Material, QACard } from "../types";

export { DshAssistant as ChatPanel } from "../components/DshAssistant";
import { DshAssistant as ChatPanel } from "../components/DshAssistant";

function TeacherPreparation({
  material,
  tab,
}: {
  material: Material;
  tab: "teaching" | "cards";
}) {
  const { update, job, busy, notify } = useStore();
  const [editing, setEditing] = useState<QACard | null>(null);
  const [teaching, setTeaching] = useState(material.teaching || "");
  function saveCards(cards: QACard[]) {
    update((s) => ({
      ...s,
      materials: s.materials.map((m) =>
        m.id === material.id ? { ...m, cards } : m,
      ),
    }));
  }
  function generate() {
    if (!material.sampleKey)
      return notify("这份真实文件尚未完成解析，不能生成基于内容的材料。", true);
    void job(tab + ":" + material.id, () => {
      if (tab === "teaching") {
        const value = `一、课堂目标\n${material.knowledge.map((k) => "• " + k.title).join("\n")}\n\n二、讲解顺序\n从一个实际问题切入，带学生阅读关键概念，再结合图示逐步解释。\n\n三、课堂讨论\n请学生指出图中的关键关系，并用自己的话解释每一步的作用。\n\n四、检查理解\n结合本课程实验，要求学生展示原始证据，再说明依据。`;
        setTeaching(value);
        update((s) => ({
          ...s,
          materials: s.materials.map((m) =>
            m.id === material.id ? { ...m, teaching: value } : m,
          ),
        }));
      } else {
        const cards = material.knowledge.map((k, i) => ({
          id: crypto.randomUUID(),
          question:
            material.sampleKey === "handshake"
              ? [
                  "为什么需要三次握手？",
                  "SYN 为什么消耗一个序列号？",
                  "看到 RST 应该如何排查？",
                ][i]
              : "如何理解：" + k.title + "？",
          keywords:
            material.sampleKey === "handshake"
              ? ["三次,握手", "SYN,序列号", "RST,重置"][i]
              : k.title,
          answer: k.summary,
          confirmed: false,
        }));
        saveCards([
          ...material.cards,
          ...cards.filter(
            (c) => !material.cards.some((old) => old.question === c.question),
          ),
        ]);
      }
    });
  }
  return (
    <div className="preparation-content">
      <div className="preparation-heading">
        <div>
          <span className="eyebrow">
            {tab === "teaching" ? "TEACHING NOTES" : "TEACHER KNOWLEDGE"}
          </span>
          <h2>
            {tab === "teaching"
              ? "让一份材料，变成一堂好课"
              : "把高频问题，提前讲清楚"}
          </h2>
          <p>
            {tab === "teaching"
              ? "一键整理讲解提纲，也可以继续编辑你的备课思路。"
              : "先生成完整答疑卡，确认后优先用于学生问答。"}
          </p>
        </div>
        <button
          className="button primary"
          disabled={busy[tab + ":" + material.id]}
          onClick={generate}
        >
          <BusyLabel busy={busy[tab + ":" + material.id]}>
            一键生成{tab === "teaching" ? "提纲" : "答疑卡"}
          </BusyLabel>
        </button>
      </div>
      <AILabel>基于示例课件的模拟生成</AILabel>
      {tab === "teaching" ? (
        <>
          <label className="large-editor-label">
            讲解提纲
            <textarea
              className="teaching-editor"
              value={teaching}
              onChange={(e) => {
                setTeaching(e.target.value);
                update((s) => ({
                  ...s,
                  materials: s.materials.map((m) =>
                    m.id === material.id
                      ? { ...m, teaching: e.target.value }
                      : m,
                  ),
                }));
              }}
              placeholder="点击一键生成，或直接写下你的讲解思路…"
            />
          </label>
          <span className="saved-hint">
            <Check size={12} />
            修改自动保存在此浏览器
          </span>
        </>
      ) : (
        <>
          <div className="cards-toolbar">
            <span>
              {material.cards.length} 张答疑卡 ·{" "}
              {material.cards.filter((c) => c.confirmed).length} 张已确认
            </span>
            {material.cards.some((c) => !c.confirmed) && (
              <button
                className="button secondary small"
                onClick={() => {
                  saveCards(
                    material.cards.map((c) => ({ ...c, confirmed: true })),
                  );
                  notify("答疑卡已全部确认，可用于优先命中。");
                }}
              >
                <CheckCheck size={14} />
                全部确认
              </button>
            )}
          </div>
          {!material.cards.length ? (
            <Empty
              title="还没有答疑卡"
              description="先生成一组草稿，再按课堂需要进行调整。"
            />
          ) : (
            material.cards.map((c, i) => (
              <article className="qa-card" key={c.id}>
                <header>
                  <span className="number-label">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <h3>{c.question}</h3>
                  <span
                    className={"status " + (c.confirmed ? "green" : "orange")}
                  >
                    {c.confirmed ? "已确认" : "待确认"}
                  </span>
                </header>
                <p>{c.answer}</p>
                <footer>
                  <span>关键词：{c.keywords}</span>
                  <button
                    className="text-button"
                    onClick={() => setEditing({ ...c })}
                  >
                    编辑
                  </button>
                  {!c.confirmed && (
                    <button
                      className="text-button"
                      onClick={() =>
                        saveCards(
                          material.cards.map((x) =>
                            x.id === c.id ? { ...x, confirmed: true } : x,
                          ),
                        )
                      }
                    >
                      确认使用
                      <Check size={13} />
                    </button>
                  )}
                </footer>
              </article>
            ))
          )}
        </>
      )}
      {editing && (
        <Modal title="编辑答疑卡" onClose={() => setEditing(null)}>
          <label>
            问题
            <input
              value={editing.question}
              onChange={(e) =>
                setEditing({ ...editing, question: e.target.value })
              }
            />
          </label>
          <label>
            关键词，用逗号分隔
            <input
              value={editing.keywords}
              onChange={(e) =>
                setEditing({ ...editing, keywords: e.target.value })
              }
            />
          </label>
          <label>
            回答
            <textarea
              rows={6}
              value={editing.answer}
              onChange={(e) =>
                setEditing({ ...editing, answer: e.target.value })
              }
            />
          </label>
          <div className="modal-footer">
            <button
              className="button secondary"
              onClick={() => setEditing(null)}
            >
              取消
            </button>
            <button
              className="button primary"
              disabled={
                !editing.question.trim() ||
                !editing.answer.trim() ||
                !editing.keywords.trim()
              }
              onClick={() => {
                saveCards(
                  material.cards.map((c) =>
                    c.id === editing.id ? { ...editing, confirmed: true } : c,
                  ),
                );
                setEditing(null);
              }}
            >
              保存并确认
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
export function MaterialWorkspace({ id }: { id: string }) {
  const { state, user, go, notify, update } = useStore();
  const [editKnowledge, setEditKnowledge] = useState<Knowledge | null>(null);
  const material = state.materials.find((m) => m.id === id);
  const [tab, setTab] = useState<
    "original" | "knowledge" | "teaching" | "cards"
  >("original");
  const [page, setPage] = useState(1);
  const [fontSize, setFontSize] = useState(15);
  const [side, setSide] = useState<"chat" | "knowledge">("chat");
  const [open, setOpen] = useState(true);
  const [incoming, setIncoming] = useState<ChatReference | null>(null);
  const [selection, setSelection] = useState("");
  if (!material || !canSeeMaterial(user!, material))
    return (
      <Empty
        title="无法查看这份资料"
        description="请从自己课程的资料库中选择材料。"
        action={
          <button
            className="button secondary"
            onClick={() => go({ page: "library" })}
          >
            返回资料库
          </button>
        }
      />
    );
  const docPages = material.sampleKey ? documents[material.sampleKey] : [];
  const current = docPages[page - 1];
  function reference(
    title: string,
    detail: string,
    kind: ChatReference["kind"] = "selection",
  ) {
    setOpen(true);
    setSide("chat");
    setIncoming({
      id: crypto.randomUUID(),
      title,
      detail,
      kind,
      materialId: id,
    });
  }
  function jump(n: number) {
    setPage(Math.min(n, docPages.length || 1));
    setTab("original");
  }
  async function download() {
    try {
      if (material!.blobId)
        return await downloadBlob(material!.blobId, material!.title);
      const content = docPages
        .map(
          (p) =>
            `<h1>${p.heading}</h1>${p.paragraphs.map((t) => `<p>${t}</p>`).join("")}${p.code ? "<pre>" + p.code + "</pre>" : ""}`,
        )
        .join("<hr>");
      const blob = new Blob(
        [
          `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${material!.title}（教学示例）</title><style>body{max-width:760px;margin:60px auto;font:16px/1.9 sans-serif;color:#27372e}pre{white-space:pre-wrap;background:#f3f5f2;padding:24px}</style><p>LearnBuddy 虚构教学示例，非真实上传文件</p>${content}</html>`,
        ],
        { type: "text/html" },
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = material!.title + "-教学示例.html";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("已下载教学示例 HTML；原始 PDF / Office 文件尚未提供。");
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  return (
    <div className="workspace">
      <header className="document-titlebar">
        <button
          className="icon-button"
          onClick={() => go({ page: "library" })}
          aria-label="返回资料库"
        >
          <ArrowLeft size={17} />
        </button>
        <FileIcon kind={material.kind} />
        <div>
          <h1>{material.title}</h1>
          <span>
            <CourseBadge id={material.courseId} />
            <span className="desktop-only">
              {material.sampleKey ? "示例内容" : "原始文件"} · {material.size}
            </span>
          </span>
        </div>
        <div className="document-actions">
          <button
            className="icon-button"
            onClick={() => void download()}
            aria-label="下载资料"
          >
            <ArrowDownToLine size={17} />
          </button>
          <button
            className="icon-button"
            onClick={() => setOpen(!open)}
            aria-label={open ? "收起学习助手" : "打开学习助手"}
          >
            {open ? (
              <PanelRightClose size={18} />
            ) : (
              <PanelRightOpen size={18} />
            )}
          </button>
        </div>
      </header>
      <div className="workspace-columns">
        <div className="document-column">
          <div className="document-toolbar">
            <div className="tabs">
              <button
                className={tab === "original" ? "active" : ""}
                onClick={() => setTab("original")}
              >
                原文
              </button>
              <button
                className={tab === "knowledge" ? "active" : ""}
                onClick={() => setTab("knowledge")}
              >
                知识点
                <span className="tab-count">{material.knowledge.length}</span>
              </button>
              {user!.role === "teacher" && (
                <>
                  <button
                    className={tab === "teaching" ? "active" : ""}
                    onClick={() => setTab("teaching")}
                  >
                    教学准备
                  </button>
                  <button
                    className={tab === "cards" ? "active" : ""}
                    onClick={() => setTab("cards")}
                  >
                    答疑卡
                  </button>
                </>
              )}
            </div>
            <div className="reader-tools">
              <button
                className="icon-button"
                disabled={fontSize <= 13}
                onClick={() => setFontSize((x) => x - 1)}
                aria-label="缩小正文"
              >
                <Minus size={13} />
              </button>
              <span>Aa</span>
              <button
                className="icon-button"
                disabled={fontSize >= 19}
                onClick={() => setFontSize((x) => x + 1)}
                aria-label="放大正文"
              >
                <Plus size={13} />
              </button>
            </div>
          </div>
          <div className="document-scroll">
            {tab === "original" &&
              (material.blobId ? (
                <BlobPreview blobId={material.blobId} name={material.title} />
              ) : current ? (
                <article
                  className="document-paper"
                  style={{ fontSize }}
                  onMouseUp={() => {
                    const text = window.getSelection()?.toString().trim();
                    if (text) setSelection(text.slice(0, 2000));
                  }}
                >
                  <div className="paper-topline">
                    <span>LEARNBUDDY / COURSE NOTES</span>
                    <span>示例课件</span>
                  </div>
                  <span className="document-eyebrow">{current.eyebrow}</span>
                  <h2>{current.heading}</h2>
                  <div className="paper-meta">
                    <span>
                      {courses.find((c) => c.id === material.courseId)!.code}
                    </span>
                    <span>·</span>
                    <span>
                      第 {page} / {docPages.length} 页
                    </span>
                  </div>
                  <div className="paper-rule" />
                  {current.paragraphs.map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                  {current.diagram && (
                    <>
                      <Diagram
                        type={current.diagram}
                        onReference={() =>
                          reference(
                            "图 " +
                              page +
                              " · " +
                              (current.diagram === "handshake"
                                ? "TCP 三次握手"
                                : current.heading),
                            current.caption || current.heading,
                            "image",
                          )
                        }
                      />
                      <figcaption>{current.caption}</figcaption>
                    </>
                  )}
                  {current.code && (
                    <pre className="code-block">
                      <code>{current.code}</code>
                    </pre>
                  )}
                  <aside className="reading-tip">
                    <span>
                      <BookOpen size={15} />
                      阅读提示
                    </span>
                    <p>
                      试着用自己的话解释这一页。遇到不确定的概念，可以引用原文与学习助手讨论。
                    </p>
                  </aside>
                  {selection && (
                    <div className="selection-action">
                      <span>已选中 {selection.length} 字</span>
                      <button
                        onClick={() => {
                          reference(
                            selection.slice(0, 30) +
                              (selection.length > 30 ? "…" : ""),
                            selection,
                          );
                          setSelection("");
                        }}
                      >
                        <Quote size={13} />
                        带入对话
                      </button>
                      <button
                        onClick={() => setSelection("")}
                        aria-label="取消选文"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  )}
                </article>
              ) : (
                <Empty title="还没有可预览内容" />
              ))}
            {tab === "knowledge" && (
              <div className="knowledge-page">
                <span className="eyebrow">CONNECT THE DOTS</span>
                <h2>把知识，串成自己的理解。</h2>
                <p className="muted">从关键概念出发，随时回到对应原文。</p>
                {material.knowledge.length ? (
                  material.knowledge.map((k, i) => (
                    <article className="knowledge-card" key={k.id}>
                      <span className="number-label">0{i + 1}</span>
                      <div>
                        <h3>{k.title}</h3>
                        <p>{k.summary}</p>
                        {user!.role === "teacher" && (
                          <button
                            className="text-button knowledge-edit"
                            onClick={() => setEditKnowledge({ ...k })}
                          >
                            编辑知识点
                          </button>
                        )}
                        <button
                          className="source-link"
                          onClick={() => jump(k.page)}
                        >
                          返回第 {k.page} 页<ChevronRight size={12} />
                        </button>
                      </div>
                      <button
                        className="icon-button"
                        onClick={() => reference(k.title, k.summary)}
                        aria-label={"提问" + k.title}
                      >
                        <MessageSquare size={17} />
                      </button>
                    </article>
                  ))
                ) : (
                  <Empty
                    title="知识点等待解析"
                    description="真实文件内容将在接入解析服务后整理，当前不会生成无依据的知识点。"
                  />
                )}
                {user!.role === "student" && material.knowledge.length > 0 && (
                  <div className="study-suggestion">
                    <Sparkles size={18} />
                    <div>
                      <h3>可以这样继续学</h3>
                      <p>
                        先复述一个核心概念，再回到原文核对。最后把它与本课程的实验作业联系起来。
                      </p>
                      <AILabel>学习建议示例</AILabel>
                    </div>
                  </div>
                )}
              </div>
            )}
            {(tab === "teaching" || tab === "cards") &&
              user!.role === "teacher" && (
                <TeacherPreparation material={material} tab={tab} />
              )}
          </div>
          {tab === "original" && docPages.length > 0 && (
            <footer className="page-navigation">
              <span>
                <Check size={12} />
                示例内容已就绪
              </span>
              <div>
                <button
                  className="icon-button"
                  disabled={page === 1}
                  onClick={() => setPage((p) => p - 1)}
                  aria-label="上一页"
                >
                  <ChevronLeft size={15} />
                </button>
                <span>
                  {page}
                  <span className="muted"> / {docPages.length}</span>
                </span>
                <button
                  className="icon-button"
                  disabled={page === docPages.length}
                  onClick={() => setPage((p) => p + 1)}
                  aria-label="下一页"
                >
                  <ChevronRight size={15} />
                </button>
              </div>
              <span>{material.kind}</span>
            </footer>
          )}
        </div>
        {open && (
          <aside className="assistant-column">
            <div className="assistant-tabs">
              <button
                className={side === "chat" ? "active" : ""}
                onClick={() => setSide("chat")}
              >
                <Sparkles size={14} />
                学习助手
              </button>
              <button
                className={side === "knowledge" ? "active" : ""}
                onClick={() => setSide("knowledge")}
              >
                <BookOpen size={14} />
                知识速览
              </button>
            </div>
            {side === "chat" ? (
              <ChatPanel
                material={material}
                incoming={incoming}
                onConsumed={() => setIncoming(null)}
                onJump={jump}
              />
            ) : (
              <div className="quick-knowledge">
                <p className="muted">
                  {material.knowledge.length} 个关键概念 · 点击定位原文
                </p>
                {material.knowledge.map((k, i) => (
                  <button key={k.id} onClick={() => jump(k.page)}>
                    <span>0{i + 1}</span>
                    <strong>{k.title}</strong>
                    <p>{k.summary}</p>
                    <small>
                      第 {k.page} 页<ChevronRight size={12} />
                    </small>
                  </button>
                ))}
                {!material.knowledge.length && <Empty title="等待图文解析" />}
              </div>
            )}
          </aside>
        )}
      </div>
      {editKnowledge && (
        <Modal title="编辑知识点" onClose={() => setEditKnowledge(null)}>
          <label>
            知识点名称
            <input
              value={editKnowledge.title}
              onChange={(e) =>
                setEditKnowledge({ ...editKnowledge, title: e.target.value })
              }
            />
          </label>
          <label>
            概念说明
            <textarea
              rows={5}
              value={editKnowledge.summary}
              onChange={(e) =>
                setEditKnowledge({ ...editKnowledge, summary: e.target.value })
              }
            />
          </label>
          <label>
            原文页码
            <input
              type="number"
              min={1}
              max={docPages.length || undefined}
              value={editKnowledge.page}
              onChange={(e) =>
                setEditKnowledge({
                  ...editKnowledge,
                  page: Number(e.target.value),
                })
              }
            />
          </label>
          <div className="modal-footer">
            <button
              className="button secondary"
              onClick={() => setEditKnowledge(null)}
            >
              取消
            </button>
            <button
              className="button primary"
              disabled={
                !editKnowledge.title.trim() ||
                !editKnowledge.summary.trim() ||
                !Number.isInteger(editKnowledge.page) ||
                editKnowledge.page < 1 ||
                (docPages.length > 0 && editKnowledge.page > docPages.length)
              }
              onClick={() => {
                update((s) => ({
                  ...s,
                  materials: s.materials.map((m) =>
                    m.id === id
                      ? {
                          ...m,
                          knowledge: m.knowledge.map((k) =>
                            k.id === editKnowledge.id ? editKnowledge : k,
                          ),
                        }
                      : m,
                  ),
                }));
                setEditKnowledge(null);
                notify("知识点已更新。");
              }}
            >
              保存修改
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
