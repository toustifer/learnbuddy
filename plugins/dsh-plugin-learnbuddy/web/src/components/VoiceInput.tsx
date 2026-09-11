import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Mic, Square } from "lucide-react";
import { API_BASE } from "../api";
import { createDictation, type DictationPhase } from "../speech";

export function VoiceInput({ onText, disabled = false }: { onText: (text: string) => void; disabled?: boolean }) {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [hint, setHint] = useState("");
  const callback = useRef(onText); callback.current = onText;
  const dictation = useRef<ReturnType<typeof createDictation> | null>(null);
  useEffect(() => {
    dictation.current = createDictation({ endpoint: API_BASE + "/speech", onState: setPhase,
      onText: (text) => { callback.current(text); setHint("已填入文字，可继续编辑。"); }, onError: setHint });
    return () => dictation.current?.destroy();
  }, []);
  useEffect(() => { if (disabled) dictation.current?.stop(); }, [disabled]);
  const waiting = phase === "requesting" || phase === "transcribing";
  return <div className={`voice-input ${phase}`}>
    <button type="button" className="text-button" title="免费本地语音转写，最长录制 60 秒" aria-pressed={phase === "recording"}
      disabled={disabled || waiting} onClick={() => { setHint(""); if (phase === "recording") dictation.current?.stop(); else void dictation.current?.start(); }}>
      {waiting ? <LoaderCircle size={14} className="spin" /> : phase === "recording" ? <Square size={14} /> : <Mic size={14} />}
      {phase === "recording" ? "结束录音" : phase === "transcribing" ? "正在转写…" : phase === "requesting" ? "打开麦克风…" : "语音输入"}
    </button>
    {phase === "recording" ? <small role="status">正在录音 · 最长 60 秒</small> : hint && <small role="status">{hint}</small>}
  </div>;
}
