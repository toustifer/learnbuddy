import type { Course, Knowledge, Material, User } from "./types";

export const LIVE_MODE =
  import.meta.env.VITE_DATA_MODE !== "demo" &&
  !(
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).get("mode") === "demo"
  );
export const API_BASE = (
  import.meta.env.VITE_API_BASE || "/api/learnbuddy"
).replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}

/**
 * 访问令牌的本地持久化。
 *
 * 服务端已改为「服务端签发 + 落库校验」的真鉴权（见 src/services/auth.js），
 * 除 /auth/login、/auth/me、/auth/logout 外一律要求有效令牌。
 * 前端必须把登录返回的 token 存下来并注入后续请求，否则刷新即失效。
 *
 * 用 localStorage 而不是内存变量：刷新页面后仍能恢复登录态（配合 /auth/me）。
 */
const TOKEN_KEY = "learnbuddy-token";

export function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    // 隐私模式等场景下 localStorage 不可用，退化为「本次会话内有效」
    return "";
  }
}

export function writeToken(token: string) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 存储不可用时忽略：本次会话仍靠内存中的令牌工作 */
  }
}

export function clearToken() {
  writeToken("");
}

/** 令牌失效时通知上层（用于把界面切回登录页，避免「看着已登录、数据全是空」）。 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

export async function request<T>(
  path: string,
  init: RequestInit = {},
  timeout = 30000,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, timeout);
  try {
    const headers = new Headers(init.headers);
    if (typeof init.body === "string")
      headers.set("Content-Type", "application/json");
    // 除显式声明的免鉴权端点外，统一注入 Bearer 令牌
    const token = readToken();
    if (token && !headers.has("Authorization"))
      headers.set("Authorization", `Bearer ${token}`);
    const res = await fetch(API_BASE + path, {
      ...init,
      headers,
      signal: controller.signal,
    });
    let data;
    try {
      data = await res.json();
    } catch {
      throw new ApiError(
        `服务返回了无法读取的内容（HTTP ${res.status}），请稍后重试。`,
        res.status,
      );
    }
    if (!res.ok || data?.ok !== true) {
      // 令牌过期/被撤销：清掉本地令牌并通知上层回登录页，
      // 否则会出现「界面显示已登录、但所有数据都拉不到」的静默失败。
      if (res.status === 401 && !path.startsWith("/auth/login")) {
        clearToken();
        onUnauthorized?.();
      }
      throw new ApiError(
        data?.error || `请求失败（HTTP ${res.status}）`,
        res.status,
      );
    }
    return data as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (controller.signal.aborted)
      throw new ApiError("请求已取消或等待超时，请重试。");
    throw new ApiError("暂时连不上服务，请检查网络后重试。");
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}
const post = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});
const viewerQuery = (userId: string) => {
  if (!userId.trim()) throw new ApiError("请先登录后查看资料。");
  return new URLSearchParams({ userId });
};
export async function loginAccount(
  username: string,
  password: string,
): Promise<User> {
  const data = await request<{ token?: string; user: User }>(
    "/auth/login",
    post({ username: username.trim(), password }),
  );
  if (!data.user?.id || !["student", "teacher"].includes(data.user.role))
    throw new ApiError("服务返回的账号身份不完整。");
  // 服务端签发的令牌必须立刻存下来：后续所有请求都靠它，刷新后靠它恢复登录态
  if (typeof data.token === "string" && data.token) writeToken(data.token);
  else throw new ApiError("服务未返回有效的访问令牌，请重新登录。");
  const courses = data.user.courses ?? (await request<{ courses: Course[] }>(
    `/workspace?userId=${encodeURIComponent(data.user.id)}`,
  )).courses;
  if (!Array.isArray(courses)) throw new ApiError("服务未返回有效的课程列表。");
  return {
    ...data.user,
    courses,
    initials: data.user.initials || data.user.name.slice(0, 1),
  };
}

/**
 * 用已保存的令牌换回当前用户（页面刷新后恢复登录态）。
 *
 * 无令牌时直接返回 null，不发请求；令牌失效时 request() 会自动清令牌，
 * 这里把 401 一并吞成 null，让调用方统一走「未登录」分支。
 */
export async function restoreSession(): Promise<User | null> {
  if (!readToken()) return null;
  try {
    const data = await request<{ user: User }>("/auth/me");
    if (!data.user?.id) return null;
    const courses = data.user.courses ?? (await request<{ courses: Course[] }>(
      `/workspace?userId=${encodeURIComponent(data.user.id)}`,
    )).courses;
    if (!Array.isArray(courses)) return null;
    return {
      ...data.user,
      courses,
      initials: data.user.initials || data.user.name.slice(0, 1),
    };
  } catch {
    return null;
  }
}

/** 退出登录：先作废服务端会话，再清本地令牌。 */
export async function logoutAccount(): Promise<void> {
  try {
    await request("/auth/logout", post({}));
  } catch {
    /* 服务端不可达也要让本地退出成功 */
  } finally {
    clearToken();
  }
}
export async function listMaterials(userId: string, signal?: AbortSignal) {
  const data = await request<{ materials: Material[] }>(
    `/materials?${viewerQuery(userId)}`,
    { signal },
  );
  if (!Array.isArray(data.materials))
    throw new ApiError("服务未返回有效的资料列表。");
  return data.materials.map((m) => ({
    ...m,
    source: "server" as const,
    knowledge: m.knowledge || [],
    cards: m.cards || [],
  }));
}
export interface MaterialContext {
  materialId: string;
  title: string;
  sections: {
    page: number;
    chapter: string;
    content: string;
    diagrams?: {
      id: string;
      title: string;
      description: string;
      caption?: string;
      page: number;
      imageUrl?: string;
    }[];
  }[];
  knowledgePoints: Knowledge[];
  sampleKey?: string;
}
export async function getMaterialContext(
  id: string,
  userId: string,
  signal?: AbortSignal,
) {
  const data = await request<{ context: MaterialContext }>(
    `/materials/${encodeURIComponent(id)}/context?${viewerQuery(userId)}`,
    { signal },
  );
  if (!data.context || !Array.isArray(data.context.sections))
    throw new ApiError("服务未返回可读的课件正文。");
  return data.context;
}
export async function uploadMaterial(
  file: File,
  user: User,
  courseId: string,
  visibility: "course" | "private",
) {
  const body = new FormData();
  body.append("file", file);
  body.append("courseId", courseId);
  body.append("ownerId", user.id);
  body.append("visibility", user.role === "student" ? "private" : visibility);
  const data = await request<{
    material: Material;
    parseStatus?: Material["parseStatus"];
    parseErrorCode?: string;
    parseError?: string;
  }>("/materials/upload", { method: "POST", body }, 120000);
  return {
    ...data.material,
    parseStatus: data.parseStatus ?? data.material.parseStatus,
    parseErrorCode: data.parseErrorCode ?? data.material.parseErrorCode,
    parseError: data.parseError ?? data.material.parseError,
  };
}
export interface AskResult {
  source: "teacher_card" | "agent_llm";
  answer: string;
  cardId?: string;
  fallback?: boolean;
  contextInjected?: boolean;
}
export const isDegradedAnswer = (answer: AskResult) =>
  answer.fallback === true ||
  (answer.source === "agent_llm" && answer.contextInjected !== true);
export const ask = (
  question: string,
  material: Material,
  user: User,
  signal?: AbortSignal,
) =>
  request<AskResult>(
    "/qa/ask",
    {
      ...post({
        question,
        materialId: material.id,
        courseId: material.courseId,
        userId: user.id,
      }),
      signal,
    },
    90000,
  );
/**
 * 文件预览/下载地址。
 *
 * `<img src>` 与 `<a href>` 由浏览器直接发起，**无法附加 Authorization 头**，
 * 因此这两个场景按服务端约定改走 `?token=`（见 src/services/auth.js 的 readQueryToken）。
 * 令牌仍是服务端签发并校验的，不是「自报身份」。
 */
export const fileUrl = (id: string, download = false) => {
  const token = readToken();
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${API_BASE}/files/${encodeURIComponent(id)}/${download ? "download" : "view"}${query}`;
};
export function parseErrorText(material: Material) {
  if (material.status === "ready" && material.parseStatus !== "failed") return "服务器暂未返回可用知识点，可先查看原文。";
  if (material.parseStatus !== "failed")
    return "尚未完成解析，暂时没有可用知识点；可重新上传原文件。";
  return (
    (
      {
        malformed: "文件已损坏，请重新导出后上传。",
        encrypted: "文件有密码保护，请解除加密后上传。",
        unsupported: "暂不支持解析该格式。",
        needsOcr: "扫描件需要 OCR，当前服务暂不支持。",
        resourceLimit: "文件过于复杂，请拆分后上传。",
        io: "文件读取失败，请重试。",
        engineUnavailable: "服务端解析引擎不可用，请联系维护人员。",
      } as Record<string, string>
    )[material.parseErrorCode || ""] || "解析失败，请重新上传或联系维护人员。"
  );
}
