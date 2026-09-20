import { createId } from "../id";
import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, LoaderCircle, Plus, RefreshCw, Sparkles } from "lucide-react";
import { Button, Tooltip } from "@radix-ui/themes";
import { LIVE_MODE, getMaterialContext } from "../api";
import { buildDshHandoff, embeddedDshUrl, sendToDsh } from "../dsh";
import { chatKey } from "../domain";
import { useStore } from "../store-context";
import { Modal, FileIcon } from "../ui";
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
  const { user, state, notify } = useStore();
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
    if (!material?.contextSections) return;
    setHandoff(
      buildDshHandoff({ material, report, references: [], question: "" }),
    );
  }, [material?.contextSections]);

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
        requestId: createId(),
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
      <header className="assistant-heading"><span className="assistant-avatar"><Sparkles size={18} /></span><div><strong>{user!.role === "teacher" ? "备课助手" : "学习助手"}</strong><span>围绕原文，把问题想明白</span></div><Tooltip content={status === "ready" ? "会话已连接" : status === "loading" ? "正在连接" : "连接暂不可用"}><span className={`assistant-connection is-${status}`} aria-label={status === "ready" ? "会话已连接" : "等待连接"} /></Tooltip></header>
      <div className="dsh-embed-wrap">
        <iframe
          key={attempt}
          ref={iframe}
          src={target.href}
          title="LearnBuddy 学习助手"
          allow="microphone"
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
                <p className="inline-note">若刚重启本机服务，请先在当前浏览器打开启动时显示的 DSH 登录链接，再重新连接。</p>
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
        <Button size="1" variant="ghost" color="gray" onClick={() => cite()} disabled={status !== "ready"}>
          <FileText size={13} />
          引用{report ? "当前反馈" : "当前资料"}
        </Button>
        {material && (
          <Button size="1" variant="ghost" color="gray" onClick={() => setPicker(true)} disabled={status !== "ready"}>
            <Plus size={13} />
            更多资料
          </Button>
        )}
        <span role="status">{contextStatus}</span>
      </div>
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
                  onClick={async () => {
                    try {
                      const sourceMaterial = LIVE_MODE
                        ? {
                            ...m,
                            contextSections: (
                              await getMaterialContext(m.id)
                            ).sections,
                          }
                        : m;
                      const source = buildDshHandoff({
                        material: sourceMaterial,
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
                    } catch (e) {
                      notify((e as Error).message, true);
                    }
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
