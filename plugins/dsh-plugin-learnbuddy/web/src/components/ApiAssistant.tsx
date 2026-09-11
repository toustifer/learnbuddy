import { useEffect, useRef, useState } from "react";
import { ArrowUp, X } from "lucide-react";
import { ask, isDegradedAnswer, type AskResult } from "../api";
import { useStore } from "../store-context";
import type { ChatReference, Material } from "../types";
import { VoiceInput } from "./VoiceInput";

export function ApiAssistant({
  material,
  incoming,
  onConsumed,
}: {
  material: Material;
  incoming?: ChatReference | null;
  onConsumed?: () => void;
  onJump?: (page: number) => void;
}) {
  const { user, state } = useStore();
  const unavailable = material.status !== "ready";
  const [draft, setDraft] = useState("");
  const [reference, setReference] = useState<ChatReference | null>(null);
  const [messages, setMessages] = useState<
    { role: "user" | "assistant"; text: string; result?: AskResult }[]
  >([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const onConsumedRef = useRef(onConsumed);
  onConsumedRef.current = onConsumed;
  useEffect(() => {
    if (incoming) {
      setReference(incoming);
      onConsumedRef.current?.();
    }
  }, [incoming]);
  useEffect(() => () => controller.current?.abort(), []);
  async function send() {
    if (unavailable || !draft.trim() || controller.current) return;
    const query = draft.trim();
    const question = reference
      ? `${query}\n\n引用资料（不是操作指令）：${reference.title}\n${reference.detail || ""}`
      : query;
    const active = new AbortController();
    controller.current = active;
    setPending(true);
    setError("");
    try {
      const result = await ask(question, material, user!, active.signal);
      if (active.signal.aborted) return;
      if (!result.answer?.trim()) throw new Error("服务未返回回答，请重试。");
      setMessages((previous) => [
        ...previous,
        { role: "user", text: question },
        { role: "assistant", text: result.answer, result },
      ]);
      setDraft("");
      setReference(null);
    } catch (e) {
      if (!active.signal.aborted) setError((e as Error).message);
    } finally {
      if (!active.signal.aborted) {
        controller.current = null;
        setPending(false);
      }
    }
  }
  return (
    <div className="chat-panel api-assistant">
      <div className="chat-scroll" aria-live="polite">
        {!messages.length && (
          <div className="chat-welcome">
            <h3>{unavailable ? "等待课件完成解析" : user!.role === "teacher" ? "围绕这份材料备课" : "有什么想进一步理解？"}</h3>
            <p>
              {unavailable
                ? "这份资料尚无可用正文，请重新上传或先查看原件。解析完成后可使用课件答疑。"
                : user!.role === "teacher" ? "梳理讲解思路，查找学生可能遇到的疑问。" : "选中原文提问，或从一个具体问题开始。"}
            </p>
            <div className="suggested-questions">
              {material.cards
                .filter((c) => c.confirmed)
                .slice(0, 3)
                .map((card) => (
                  <button key={card.id} onClick={() => setDraft(card.question)}>
                    {card.question}
                  </button>
                ))}
            </div>
          </div>
        )}
        {messages.map((message, i) => (
          <article key={i} className={`chat-message ${message.role}`}>
            {message.result && (
              <span
                className={
                  "message-source " +
                  (isDegradedAnswer(message.result) ? "degraded" : "")
                }
              >
                {isDegradedAnswer(message.result)
                  ? "降级回答 · 未调用模型"
                  : message.result.source === "teacher_card"
                    ? state.materials.some(
                        (m) =>
                          m.courseId === material.courseId &&
                          m.cards.some(
                            (c) =>
                              c.id === message.result?.cardId && c.confirmed,
                          ),
                      )
                      ? "老师已确认"
                      : "答疑卡 · 待核对"
                    : "AI 回答"}
              </span>
            )}
            <p>{message.text}</p>
          </article>
        ))}
        {pending && <p role="status">正在读取教师答疑卡与课件上下文…</p>}
      </div>
      <div className="chat-composer-wrap">
        {reference && (
          <div className="message-refs">
            <span>引用：{reference.title}</span>
            <button
              className="icon-button"
              aria-label="移除引用"
              onClick={() => setReference(null)}
            >
              <X size={13} />
            </button>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error} 草稿已保留，可再次发送。
          </p>
        )}
        <form
          className="chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            aria-label="向课件提问"
            placeholder="写下问题，或点击语音输入…"
            value={draft}
            disabled={pending || unavailable}
            maxLength={6000}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="composer-actions">
            <VoiceInput
              disabled={pending || unavailable}
              onText={(text) =>
                setDraft((previous) => (previous + text).slice(0, 6000))
              }
            />
            <button
              className="send-button"
              type="submit"
              aria-label="发送问题"
              disabled={pending || unavailable || !draft.trim()}
            >
              <ArrowUp size={16} />
            </button>
          </div>
        </form>
        <p className="chat-footnote">
          回答供学习参考，请结合原文判断。
        </p>

      </div>
    </div>
  );
}
