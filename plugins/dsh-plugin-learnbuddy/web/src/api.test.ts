import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  getMaterialContext,
  isDegradedAnswer,
  listMaterials,
  loginAccount,
  parseErrorText,
  request,
  uploadMaterial,
} from "./api";
import { freshState, users } from "./seed";
import { validateServerGrades } from "./pages/Online";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status });
}
describe("server data boundaries", () => {
  it("requires a viewer for every material list and detail request", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(response({ ok: true, materials: [] }));
    vi.stubGlobal("fetch", fetcher);
    await expect(listMaterials("")).rejects.toThrow("登录");
    await expect(getMaterialContext("mat-private", "")).rejects.toThrow("登录");
    expect(fetcher).not.toHaveBeenCalled();
    await listMaterials("s-yi");
    expect(String(fetcher.mock.calls[0][0])).toContain("userId=s-yi");
    fetcher.mockResolvedValueOnce(
      response({ ok: true, context: { sections: [] } }),
    );
    await getMaterialContext("a/b", "t-chen");
    expect(String(fetcher.mock.calls[1][0])).toContain(
      "a%2Fb/context?userId=t-chen",
    );
  });
  it("does not recover an API error using invented materials or login identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(response({ ok: false, error: "访问被拒绝" }, 403)),
    );
    await expect(listMaterials("s-yi")).rejects.toThrow("访问被拒绝");
    await expect(loginAccount("teacher.chen", "123")).rejects.toBeInstanceOf(
      ApiError,
    );
  });
  it("takes login identity from the server instead of the selected account shortcut", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response({
            ok: true,
            user: {
              id: "user-demo",
              role: "teacher",
              name: "测试教师",
              username: "user",
            },
          }),
        ),
    );
    expect(await loginAccount("user", "123")).toMatchObject({
      id: "user-demo",
      role: "teacher",
      initials: "测",
    });
  });
  it("rejects HTML errors and malformed successful list payloads", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("<h1>404</h1>", { status: 404 }))
      .mockResolvedValueOnce(response({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    await expect(request("/missing")).rejects.toThrow("HTTP 404");
    await expect(listMaterials("s-yi")).rejects.toThrow("有效的资料列表");
  });
  it("preserves parse failure even when upload succeeded and forces student visibility to private", async () => {
    const material = freshState().materials[0];
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        response({
          ok: true,
          material: { ...material, status: "pending", knowledge: [] },
          parseStatus: "failed",
          parseErrorCode: "malformed",
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    const result = await uploadMaterial(
      new File(["broken"], "example.pdf"),
      users[2],
      "network",
      "course",
    );
    const form = fetcher.mock.calls[0][1].body as FormData;
    expect(form.get("visibility")).toBe("private");
    expect(form.get("ownerId")).toBe("s-yi");
    expect(
      new Headers(fetcher.mock.calls[0][1].headers).has("Content-Type"),
    ).toBe(false);
    expect(result.parseStatus).toBe("failed");
    expect(result.knowledge).toEqual([]);
    expect(parseErrorText(result)).toContain("损坏");
  });
  it("distinguishes confirmed responses from degraded or incomplete model responses", () => {
    expect(
      isDegradedAnswer({ source: "teacher_card", answer: "教师答案" }),
    ).toBe(false);
    expect(
      isDegradedAnswer({ source: "agent_llm", answer: "兜底", fallback: true }),
    ).toBe(true);
    expect(isDegradedAnswer({ source: "agent_llm", answer: "未知来源" })).toBe(
      true,
    );
    expect(
      isDegradedAnswer({
        source: "agent_llm",
        answer: "模型答案",
        contextInjected: true,
      }),
    ).toBe(false);
  });
  it("aborts requests instead of leaving the interface busy forever", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) =>
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            ),
          ),
      ),
    );
    const result = expect(request("/slow", {}, 50)).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(50);
    await result;
  });
});
describe("teacher review validation uses the server rubric", () => {
  const rubric = [
    { id: "r1", title: "过程", criterion: "证据", max: 20 },
    { id: "r2", title: "分析", criterion: "解释", max: 30 },
  ];
  it("rejects missing, duplicate, unknown, blank and out-of-range grades", () => {
    expect(validateServerGrades([{ rubricId: "r1", score: 18 }], rubric)).toBe(
      false,
    );
    expect(
      validateServerGrades(
        [
          { rubricId: "r1", score: 18 },
          { rubricId: "r1", score: 20 },
        ],
        rubric,
      ),
    ).toBe(false);
    expect(
      validateServerGrades(
        [
          { rubricId: "r1", score: 18 },
          { rubricId: "bad", score: 20 },
        ],
        rubric,
      ),
    ).toBe(false);
    expect(
      validateServerGrades(
        [
          { rubricId: "r1", score: NaN },
          { rubricId: "r2", score: 20 },
        ],
        rubric,
      ),
    ).toBe(false);
    expect(
      validateServerGrades(
        [
          { rubricId: "r1", score: 21 },
          { rubricId: "r2", score: 20 },
        ],
        rubric,
      ),
    ).toBe(false);
    expect(
      validateServerGrades(
        [
          { rubricId: "r1", score: 18 },
          { rubricId: "r2", score: 20 },
        ],
        rubric,
      ),
    ).toBe(true);
  });
});
