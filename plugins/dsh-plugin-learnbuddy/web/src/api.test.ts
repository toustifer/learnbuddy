import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  getMaterialContext,
  isDegradedAnswer,
  listMaterials,
  loginAccount,
  parseErrorText,
  onUnauthorized,
  request,
  setAccessToken,
  getAccessToken,
  uploadMaterial,
} from "./api";
import { freshState, users } from "./seed";
import { validateServerGrades } from "./pages/Online";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // 令牌是模块级状态，用例之间必须清掉，否则会互相污染
  setAccessToken("");
});
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status });
}
const bearerOf = (init: RequestInit | undefined) =>
  new Headers(init?.headers).get("Authorization");
describe("identity binding", () => {
  it("never puts the viewer id in the URL — identity comes from the token only", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(response({ ok: true, materials: [] }));
    vi.stubGlobal("fetch", fetcher);
    await listMaterials();
    expect(String(fetcher.mock.calls[0][0])).not.toContain("userId");
    // 未登录时不带 Authorization，交由服务端返回 401
    expect(bearerOf(fetcher.mock.calls[0][1])).toBeNull();
  });
  it("attaches the bearer token to every request after login", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          ok: true,
          token: "tk-1",
          user: {
            id: "t-chen",
            role: "teacher",
            name: "陈知行",
            username: "teacher.chen",
            courses: [],
          },
        }),
      )
      .mockResolvedValueOnce(response({ ok: true, materials: [] }));
    vi.stubGlobal("fetch", fetcher);
    await loginAccount("teacher.chen", "123");
    expect(String(fetcher.mock.calls[0][0])).toContain("/auth/login");

    await listMaterials();
    expect(bearerOf(fetcher.mock.calls[1][1])).toBe("Bearer tk-1");
    expect(String(fetcher.mock.calls[1][0])).not.toContain("userId");
  });
  it("refuses a login response without a token instead of acting logged in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          ok: true,
          user: {
            id: "t-chen",
            role: "teacher",
            name: "陈知行",
            username: "teacher.chen",
            courses: [],
          },
        }),
      ),
    );
    await expect(loginAccount("teacher.chen", "123")).rejects.toBeInstanceOf(
      ApiError,
    );
  });
  it("does not recover an API error using invented materials or login identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(response({ ok: false, error: "访问被拒绝" }, 403)),
    );
    await expect(listMaterials()).rejects.toThrow("访问被拒绝");
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
            token: "tk-demo",
            user: {
              id: "user-demo",
              role: "teacher",
              name: "测试教师",
              username: "user",
              courses: [],
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
  it("loads actual courses when the existing server login does not include them", async () => {
    const course = { id: "new-course", title: "服务器新增课程", teacherId: "t-new", code: "NEW", color: "green", description: "" };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ ok: true, token: "tk-new", user: { id: "s-new", role: "student", name: "新学生", username: "new" } }))
      .mockResolvedValueOnce(response({ ok: true, courses: [course] }));
    vi.stubGlobal("fetch", fetcher);
    expect((await loginAccount("new", "123")).courses).toEqual([course]);
    expect(String(fetcher.mock.calls[1][0])).toContain("/workspace");
    expect(String(fetcher.mock.calls[1][0])).not.toContain("userId");
  });
  it("rejects HTML errors and malformed successful list payloads", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("<h1>404</h1>", { status: 404 }))
      .mockResolvedValueOnce(response({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    await expect(request("/missing")).rejects.toThrow("HTTP 404");
    await expect(listMaterials()).rejects.toThrow("有效的资料列表");
  });
  it("requests material context without a viewer id", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(response({ ok: true, context: { sections: [] } }));
    vi.stubGlobal("fetch", fetcher);
    await getMaterialContext("a/b");
    expect(String(fetcher.mock.calls[0][0])).toContain("a%2Fb/context");
    expect(String(fetcher.mock.calls[0][0])).not.toContain("userId");
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
    // 归属由服务端从令牌取，前端不再声明 ownerId
    expect(form.get("ownerId")).toBeNull();
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

describe("会话失效自动恢复（401）", () => {
  it("带令牌的普通请求遇到 401：清令牌并通知上层回登录页", async () => {
    const on401 = vi.fn();
    onUnauthorized(on401);
    setAccessToken("tk-expired");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({ ok: false, code: "UNAUTHENTICATED", error: "未登录：缺少访问令牌" }, 401),
      ),
    );

    await expect(listMaterials()).rejects.toBeInstanceOf(ApiError);

    expect(on401).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBe("");
    onUnauthorized(null);
  });

  it("登录接口自身的 401（密码错）不算会话失效，不得触发回登录页", async () => {
    const on401 = vi.fn();
    onUnauthorized(on401);
    setAccessToken("tk-old");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({ ok: false, code: "UNAUTHENTICATED", error: "用户名或密码不正确" }, 401),
      ),
    );

    await expect(loginAccount("teacher.chen", "wrong")).rejects.toBeInstanceOf(ApiError);

    expect(on401).not.toHaveBeenCalled();
    onUnauthorized(null);
  });

  it("本来就没带令牌时遇到 401，不触发（避免登录页上反复弹提示）", async () => {
    const on401 = vi.fn();
    onUnauthorized(on401);
    setAccessToken("");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({ ok: false, code: "UNAUTHENTICATED", error: "未登录" }, 401),
      ),
    );

    await expect(listMaterials()).rejects.toBeInstanceOf(ApiError);

    expect(on401).not.toHaveBeenCalled();
    onUnauthorized(null);
  });

  it("令牌被清掉后，后续请求不再重复触发（只在「失效那一跳」通知一次）", async () => {
    const on401 = vi.fn();
    onUnauthorized(on401);
    setAccessToken("tk-expired");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({ ok: false, code: "UNAUTHENTICATED", error: "未登录" }, 401),
      ),
    );

    await expect(listMaterials()).rejects.toBeInstanceOf(ApiError);
    await expect(listMaterials()).rejects.toBeInstanceOf(ApiError);

    expect(on401).toHaveBeenCalledTimes(1);
    onUnauthorized(null);
  });

  it("非 401 的失败不触发会话失效", async () => {
    const on401 = vi.fn();
    onUnauthorized(on401);
    setAccessToken("tk-ok");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ ok: false, error: "作业不存在: lab-x" }, 404)),
    );

    await expect(listMaterials()).rejects.toBeInstanceOf(ApiError);

    expect(on401).not.toHaveBeenCalled();
    expect(getAccessToken()).toBe("tk-ok");
    onUnauthorized(null);
  });
});
