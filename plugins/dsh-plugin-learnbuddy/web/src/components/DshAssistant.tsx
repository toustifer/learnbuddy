import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, LoaderCircle, Plus, RefreshCw } from "lucide-react";
import { buildDshHandoff, embeddedDshUrl, sendToDsh } from "../dsh";
import { chatKey } from "../domain";
import { useStore } from "../store-context";
import { Brand, Modal, FileIcon } from "../ui";
import { visibleMaterials } from "../domain";
import type { ChatReference, Material, Submission } from "../types";

type Props = {
  material?: Material;
  report?: Submission;
  incoming?: ChatReference | null;
  onConsumed?: () => void;
  onJump?: (page: number) => void;
};

export function DshAssistant(props: Props) {
  const { user } = useStore();
  const contextKey = chatKey(user!, props.material?.id || props.report!.id);
  return (
    <EmbeddedAssistant key={contextKey} {...props} contextKey={contextKey} />
  );
}

function EmbeddedAssistant({
  material,
  report,
  incoming,
  onConsumed,
  contextKey,
}: Props & { contextKey: string }) {
  const { user, state } = useStore();
  const iframe = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(0);
  const [picker, setPicker] = useState(false);
  const [contextStatus, setContextStatus] = useState("");
  const [handoff, setHandoff] = useState(() =>
    buildDshHandoff({ material, report, references: [], question: "" }),
  );
  const target = useMemo(() => embeddedDshUrl(), []);
  const consumed = useRef(onConsumed);
  consumed.current = onConsumed;

  useEffect(() => {
    if (!incoming) return;
    setHandoff(
      buildDshHandoff({
        material,
        report,
        references: [incoming],
        question: "",
      }),
    );
    iframe.current
      ?.closest(".dsh-assistant")
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    consumed.current?.();
  }, [incoming, material, report]);

  useEffect(() => {
    const frame = iframe.current?.contentWindow;
    if (!frame) return;
    const controller = new AbortController();
    const reading = document.getElementById("main-content");
    const readingTop = reading?.scrollTop ?? 0;
    let interacted = Boolean(incoming);
    const markInteraction = () => {
      interacted = true;
    };
    const events = ["pointerdown", "wheel", "touchstart", "keydown"] as const;
    events.forEach((event) =>
      window.addEventListener(event, markInteraction, {
        capture: true,
        passive: true,
      }),
    );
    const restoreReading = () => {
      if (!interacted && !controller.signal.aborted)
        reading?.scrollTo({ top: readingTop, behavior: "instant" });
    };
    const timers: ReturnType<typeof setTimeout>[] = [];
    setStatus("loading");
    setError("");
    void sendToDsh(
      frame,
      target,
      {
        type: "learnbuddy:init",
        requestId: crypto.randomUUID(),
        contextKey,
      },
      "learnbuddy:ready",
      controller.signal,
    )
      .then(() => {
        if (controller.signal.aborted) return;
        setStatus("ready");
        // Native editor selection can scroll its containing page after mount.
        // Preserve reading position during initialization, but never fight user input.
        restoreReading();
        timers.push(
          setTimeout(restoreReading, 150),
          setTimeout(() => {
            restoreReading();
            events.forEach((event) =>
              window.removeEventListener(event, markInteraction, true),
            );
          }, 600),
        );
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setStatus("error");
        setError(e instanceof Error ? e.message : "学习助手暂时不可用。");
      });
    return () => {
      controller.abort();
      timers.forEach(clearTimeout);
      events.forEach((event) =>
        window.removeEventListener(event, markInteraction, true),
      );
    };
  }, [contextKey, target, loaded, attempt]);

  useEffect(() => {
    const frame = iframe.current?.contentWindow;
    if (status !== "ready" || !frame) return;
    const controller = new AbortController();
    setContextStatus("正在带入引用…");
    void sendToDsh(
      frame,
      target,
      { ...handoff, contextKey },
      "learnbuddy:received",
      controller.signal,
    )
      .then(() => {
        if (!controller.signal.aborted) setContextStatus("引用已就绪");
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setContextStatus(
            e instanceof Error ? e.message : "资料未带入，请重试。",
          );
      });
    return () => controller.abort();
  }, [status, target, handoff, contextKey]);

  function cite(references: ChatReference[] = []) {
    setHandoff(buildDshHandoff({ material, report, references, question: "" }));
  }

  return (
    <div className="chat-panel dsh-assistant">
      <div className="assistant-heading">
        <span className="assistant-avatar">
          <Brand small />
        </span>
        <div>
          <strong>{report ? "反馈解读" : "学习助手"}</strong>
          <span>读到哪里，就从哪里开始问</span>
        </div>
        <span className="dsh-preview-label">本地预览</span>
      </div>
      <div className="dsh-embed-wrap">
        <iframe
          key={attempt}
          ref={iframe}
          src={target.href}
          title="LearnBuddy 学习对话"
          className="dsh-embed"
          onLoad={() => setLoaded((n) => n + 1)}
        />
        {status !== "ready" && (
          <div className="dsh-embed-status" role="status">
            {status === "loading" ? (
              <>
                <LoaderCircle size={20} className="spin" />
                <p>正在打开学习对话…</p>
              </>
            ) : (
              <>
                <p>{error}</p>
                <button
                  className="button secondary"
                  onClick={() => setAttempt((n) => n + 1)}
                >
                  <RefreshCw size={14} />
                  重新连接
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="dsh-reference-toolbar">
        <button onClick={() => cite()} disabled={status !== "ready"}>
          <FileText size={13} />
          引用{report ? "当前反馈" : "本篇材料"}
        </button>
        {material && (
          <button onClick={() => setPicker(true)} disabled={status !== "ready"}>
            <Plus size={13} />
            课程资料
          </button>
        )}
        <span role="status">{contextStatus}</span>
      </div>
      <p className="dsh-preview-note">
        模型尚未配置 · 引用后可编辑，再手动发送
      </p>
      {picker && (
        <Modal
          title="引用课程资料"
          description="选择当前账号有权查看的资料。"
          onClose={() => setPicker(false)}
        >
          <div className="search-results">
            {visibleMaterials(state, user!)
              .filter((m) => m.courseId === material?.courseId)
              .map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    const source = buildDshHandoff({
                      material: m,
                      references: [],
                      question: "",
                    });
                    cite([
                      {
                        id: m.id,
                        title: m.title,
                        kind: "material",
                        materialId: m.id,
                        detail: source.text,
                      },
                    ]);
                    setPicker(false);
                  }}
                >
                  <FileIcon kind={m.kind} />
                  <span>
                    <strong>{m.title}</strong>
                  </span>
                  <Plus size={16} />
                </button>
              ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
