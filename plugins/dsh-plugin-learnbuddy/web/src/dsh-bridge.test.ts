import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendToDsh } from "./dsh";

describe("embedded DSH connection", () => {
  let parent: EventTarget;
  const target = new URL("http://127.0.0.1:3089/?learnbuddy=embedded");
  const message = {
    type: "learnbuddy:init",
    requestId: "request-a",
    contextKey: "student-lin:mat-tcp",
  };
  beforeEach(() => {
    vi.useFakeTimers();
    parent = new EventTarget();
    vi.stubGlobal("window", parent);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  function receive(
    frame: Window,
    overrides: Record<string, unknown> = {},
    data: Record<string, unknown> = {},
  ) {
    parent.dispatchEvent(
      Object.assign(new Event("message"), {
        origin: target.origin,
        source: frame,
        ...overrides,
        data: { ...message, type: "learnbuddy:ready", ...data },
      }),
    );
  }
  it("accepts only the expected frame, origin, request, and material scope", async () => {
    const frame = { postMessage: vi.fn() } as unknown as Window;
    const done = vi.fn();
    const promise = sendToDsh(
      frame,
      target,
      message,
      "learnbuddy:ready",
      new AbortController().signal,
    ).then(done);
    receive(frame, { origin: "https://unrelated.example" });
    receive(frame, { source: {} });
    receive(frame, {}, { requestId: "other" });
    receive(frame, {}, { contextKey: "student-chen:mat-tcp" });
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    receive(frame);
    await promise;
    expect(done).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reports a runtime rejection rather than treating a loaded frame as ready", async () => {
    const frame = { postMessage: vi.fn() } as unknown as Window;
    const promise = sendToDsh(
      frame,
      target,
      message,
      "learnbuddy:ready",
      new AbortController().signal,
    );
    const rejected = expect(promise).rejects.toThrow("尚未关联课程学习会话");
    receive(
      frame,
      {},
      { type: "learnbuddy:error", message: "尚未关联课程学习会话" },
    );
    await rejected;
  });
  it("stops retries when the material panel is closed", async () => {
    const postMessage = vi.fn();
    const frame = { postMessage } as unknown as Window;
    const controller = new AbortController();
    const promise = sendToDsh(
      frame,
      target,
      message,
      "learnbuddy:ready",
      controller.signal,
    );
    const rejected = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(30000);
    expect(postMessage).toHaveBeenCalledOnce();
  });
  it("shows connection failure when no confirmation arrives", async () => {
    const frame = { postMessage: vi.fn() } as unknown as Window;
    const promise = sendToDsh(
      frame,
      target,
      message,
      "learnbuddy:ready",
      new AbortController().signal,
    );
    const rejected = expect(promise).rejects.toThrow("尚未连上学习助手");
    await vi.advanceTimersByTimeAsync(20500);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
