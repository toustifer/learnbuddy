export type DictationPhase = "idle" | "requesting" | "recording" | "transcribing";
type Options = { endpoint?: string; onState: (phase: DictationPhase) => void; onText: (text: string) => void; onError: (message: string) => void };

export function createDictation({ endpoint = "/api/learnbuddy/speech", onState, onText, onError }: Options) {
  let recorder: MediaRecorder | undefined;
  let stream: MediaStream | undefined;
  let phase: DictationPhase = "idle";
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  const state = (next: DictationPhase) => { phase = next; if (!disposed) onState(next); };
  const release = () => { clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); stream = undefined; };
  const errorText = (error: unknown) => error instanceof DOMException
    ? error.name === "NotAllowedError" ? "请允许这个页面使用麦克风后重试。" : error.name === "NotFoundError" ? "没有找到麦克风。" : "暂时无法使用麦克风，请重试。"
    : error instanceof Error ? error.message : "听写失败，请重试。";
  async function transcribe(chunks: Blob[], mime: string) {
    release();
    if (disposed) return;
    state("transcribing");
    request = new AbortController();
    const timeout = setTimeout(() => request?.abort(), 120000);
    try {
      const audio = new Blob(chunks, { type: mime });
      if (audio.size < 32) throw new Error("没有录到声音，请重试。");
      if (audio.size > 8 * 1024 * 1024) throw new Error("录音过长，请分成短句听写。");
      const response = await fetch(endpoint + "/transcribe", { method: "POST", body: audio, headers: { "Content-Type": mime }, signal: request.signal });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) throw new Error(result?.error || "语音服务暂时不可用，请重试。");
      if (!result.text?.trim()) throw new Error("没有识别到清晰语音，请再试一次。");
      if (!disposed) onText(result.text.trim());
    } catch (error) { if (!disposed) onError(request.signal.aborted ? "转写等待超时，请重试。" : errorText(error)); }
    finally { clearTimeout(timeout); request = undefined; state("idle"); }
  }
  return {
    async start() {
      if (disposed || phase !== "idle") return;
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return onError("请在 HTTPS 或本机预览中使用语音输入。");
      if (!window.MediaRecorder) return onError("当前浏览器不支持录音，可使用系统听写。");
      state("requesting");
      request = new AbortController();
      const statusTimeout = setTimeout(() => request?.abort(), 6000);
      try {
        const status = await fetch(endpoint + "/status", { signal: request.signal }).then((r) => r.json()).catch(() => null);
        clearTimeout(statusTimeout);
        if (disposed) return;
        if (!status?.ready) throw new Error("语音服务尚未启动，请联系维护人员。");
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
        if (disposed) { release(); return; }
        const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type));
        recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        const chunks: Blob[] = [];
        recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
        recorder.onerror = () => { if (recorder) recorder.onstop = null; release(); if (!disposed) onError("录音中断，请重试。"); state("idle"); };
        recorder.onstop = () => void transcribe(chunks, recorder?.mimeType || "audio/webm");
        recorder.start(500);
        state("recording");
        timer = setTimeout(() => { if (recorder?.state === "recording") recorder.stop(); }, 60000);
      } catch (error) { release(); if (!disposed) onError(errorText(error)); state("idle"); }
      finally { clearTimeout(statusTimeout); }
    },
    stop() { if (recorder?.state === "recording") recorder.stop(); },
    destroy() { disposed = true; request?.abort(); if (recorder) { recorder.onstop = null; recorder.ondataavailable = null; recorder.onerror = null; if (recorder.state !== "inactive") recorder.stop(); } release(); },
  };
}
