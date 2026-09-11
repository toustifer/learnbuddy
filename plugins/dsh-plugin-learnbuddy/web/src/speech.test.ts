import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDictation } from "./speech";

describe("local dictation lifecycle", () => {
  const trackStop = vi.fn();
  const microphone = vi.fn();
  const fetcher = vi.fn();
  let recording: FakeRecorder;
  class FakeRecorder {
    static isTypeSupported() { return true; }
    state = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { recording = this; }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["test-audio-payload-".repeat(5)]) }); this.onstop?.(); }
  }
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks();
    vi.stubGlobal("window", { isSecureContext: true, MediaRecorder: FakeRecorder });
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: microphone } });
    vi.stubGlobal("fetch", fetcher);
    microphone.mockResolvedValue({ getTracks: () => [{ stop: trackStop }] });
    fetcher.mockResolvedValue({ ok: true, json: async () => ({ ready: true, ok: true, text: "测试转写" }) });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  function setup() {
    const onText = vi.fn(), onError = vi.fn(), onState = vi.fn();
    return { onText, onError, onState, dictation: createDictation({ onText, onError, onState }) };
  }
  it("checks the service before requesting the microphone", async () => {
    fetcher.mockResolvedValue({ json: async () => ({ ready: false }) });
    const s = setup(); await s.dictation.start();
    expect(microphone).not.toHaveBeenCalled(); expect(s.onError).toHaveBeenCalled();
  });
  it("stops all tracks and appends the transcript only after recording stops", async () => {
    const s = setup(); await s.dictation.start();
    expect(s.onText).not.toHaveBeenCalled(); s.dictation.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(trackStop).toHaveBeenCalledOnce(); expect(s.onText).toHaveBeenCalledWith("测试转写");
    expect(fetcher.mock.calls[1][0]).toBe("/api/learnbuddy/speech/transcribe");
    expect(s.onState).toHaveBeenLastCalledWith("idle"); s.dictation.destroy();
  });
  it("does not upload or append after the containing page is closed", async () => {
    const s = setup(); await s.dictation.start(); s.dictation.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(trackStop).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(s.onText).not.toHaveBeenCalled();
  });
  it("does not transcribe a recorder error's trailing stop event", async () => {
    const s = setup(); await s.dictation.start(); recording.onerror?.(); recording.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.onError).toHaveBeenCalledWith("录音中断，请重试。"); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(s.onText).not.toHaveBeenCalled(); s.dictation.destroy();
  });
  it("automatically finishes recording at one minute", async () => {
    const s = setup(); await s.dictation.start(); await vi.advanceTimersByTimeAsync(60000);
    expect(trackStop).toHaveBeenCalledOnce(); expect(s.onText).toHaveBeenCalledOnce(); s.dictation.destroy();
  });
});
