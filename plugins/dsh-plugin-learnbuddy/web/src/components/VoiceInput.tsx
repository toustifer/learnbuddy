import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((event: {
        resultIndex: number;
        results: {
          length: number;
          [n: number]: { isFinal: boolean; 0: { transcript: string } };
        };
      }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

export function VoiceInput({
  onText,
  disabled = false,
}: {
  onText: (text: string) => void;
  disabled?: boolean;
}) {
  const recognition = useRef<Recognition | null>(null);
  const callback = useRef(onText);
  callback.current = onText;
  const [listening, setListening] = useState(false);
  const [hint, setHint] = useState("");
  const Speech =
    (window as SpeechWindow).SpeechRecognition ||
    (window as SpeechWindow).webkitSpeechRecognition;
  useEffect(
    () => () => {
      const current = recognition.current;
      if (current) {
        current.onresult = null;
        current.onerror = null;
        current.onend = null;
        current.abort();
      }
    },
    [],
  );
  useEffect(() => {
    if (disabled) recognition.current?.stop();
  }, [disabled]);
  function start() {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    if (!window.isSecureContext)
      return setHint(
        "此地址无法启用麦克风。请使用 HTTPS 或本机预览，当前可使用键盘输入。",
      );
    if (!Speech)
      return setHint("当前浏览器不支持语音识别，可使用系统听写或键盘输入。");
    const current = new Speech();
    recognition.current = current;
    current.lang = "zh-CN";
    current.continuous = true;
    current.interimResults = false;
    current.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal)
          callback.current(event.results[i][0].transcript);
      }
    };
    current.onerror = (event) =>
      setHint(
        (
          {
            "not-allowed": "麦克风权限未开启，请在浏览器中允许后重试。",
            network: "语音识别服务连接失败，可重试或改用键盘输入。",
            "no-speech": "没有听到声音，请重试。",
            "audio-capture": "未找到可用麦克风。",
          } as Record<string, string>
        )[event.error] || "语音识别已停止，可重试或继续输入。",
      );
    current.onend = () => {
      setListening(false);
      recognition.current = null;
    };
    try {
      current.start();
      setListening(true);
      setHint("正在听写，文字会放入草稿；请核对后手动发送。");
    } catch {
      setHint("无法开始听写，请重试。");
    }
  }
  return (
    <div className="voice-input">
      <button
        type="button"
        className="text-button"
        aria-pressed={listening}
        disabled={disabled}
        onClick={start}
      >
        {listening ? <Square size={14} /> : <Mic size={14} />}
        {listening ? "结束听写" : "语音输入"}
      </button>
      {hint && <small role="status">{hint}</small>}
    </div>
  );
}
