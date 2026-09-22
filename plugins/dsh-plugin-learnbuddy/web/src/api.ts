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
 * 访问令牌（身份绑定）。
 *
 * 放在模块级而不是每次现取：`request()` 是所有请求的唯一出口，
 * 令牌在这里统一附加，避免某个调用点忘了带。
 *
 * 令牌由服务端登录接口签发；前端不再往任何请求里塞 `userId` ——
 * 之前后端信任调用方自报的 `userId`，任何人都能冒充教师拿到全班成绩。
 */
let accessToken = "";

export function setAccessToken(token: string) {
  accessToken = typeof token === "string" ? token : "";
}

export function getAccessToken() {
  return accessToken;
}

/**
 * 会话失效通知（401 自动恢复）。
 *
 * 为什么需要：令牌可能在**运行到一半**失效 —— 会话到期，或者部署换了数据路径
 * 导致旧令牌在服务端已经不存在。此前这种请求只抛一个普通错误，界面仍显示
 * 「已登录」，但每个操作都在报错，**演示时最容易被这个卡住**。
 *
 * 现在：401 且**本次请求确实带了令牌**时，清掉令牌并通知上层回到登录页。
 * 只在「有令牌 → 令牌失效」这一跳通知一次，所以登录接口本身的 401（密码错）
 * 与之后的无令牌请求都不会反复触发。
 */
let unauthorizedHandler: (() => void) | null = null;

export function onUnauthorized(handler: (() => void) | null) {
  unauthorizedHandler = handler;
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
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
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
      // 会话失效：清令牌 + 通知上层回登录页。
      // 登录/登出接口自身的 401 不算会话失效（那是密码错），排除掉。
      if (res.status === 401 && !path.startsWith("/auth/") && accessToken) {
        setAccessToken("");
        unauthorizedHandler?.();
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

/** 把服务端返回的用户补全成前端使用的形状（课程列表 + 头像首字）。 */
async function completeAccount(user: User): Promise<User> {
  if (!user?.id || !["student", "teacher"].includes(user.role))
    throw new ApiError("服务返回的账号身份不完整。");
  const courses = user.courses ?? (await request<{ courses: Course[] }>("/workspace")).courses;
  if (!Array.isArray(courses)) throw new ApiError("服务未返回有效的课程列表。");
  return {
    ...user,
    courses,
    initials: user.initials || user.name.slice(0, 1),
  };
}

export async function loginAccount(
  username: string,
  password: string,
): Promise<User> {
  const data = await request<{ user: User; token?: string }>(
    "/auth/login",
    post({ username: username.trim(), password }),
  );
  if (!data.token) throw new ApiError("服务未返回访问令牌，无法继续使用。");
  // 令牌要在后续请求之前装好，否则紧随其后的 /workspace 会被判为未登录
  setAccessToken(data.token);
  return completeAccount(data.user);
}

/** 用已有令牌换回当前身份（页面刷新后恢复登录态）。 */
export async function fetchCurrentAccount(): Promise<User> {
  const data = await request<{ user: User }>("/auth/me");
  return completeAccount(data.user);
}

/** 退出登录：先让服务端作废令牌，再清本地。服务端失败也要清本地。 */
export async function logoutAccount(): Promise<void> {
  try {
    await request("/auth/logout", { method: "POST" });
  } catch {
    /* 令牌可能已过期；本地清理照做 */
  }
  setAccessToken("");
}

export async function listMaterials(signal?: AbortSignal) {
  const data = await request<{ materials: Material[] }>("/materials", { signal });
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
  signal?: AbortSignal,
) {
  const data = await request<{ context: MaterialContext }>(
    `/materials/${encodeURIComponent(id)}/context`,
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
  // 归属由服务端从登录令牌取，不再由前端声明 ownerId
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
  signal?: AbortSignal,
) =>
  request<AskResult>(
    "/qa/ask",
    {
      ...post({
        question,
        materialId: material.id,
        courseId: material.courseId,
      }),
      signal,
    },
    90000,
  );
/**
 * 原件预览 / 下载地址。
 *
 * 这两个端点由浏览器直接发起（`<img src>` / `<a href>`），无法附加 Authorization 头，
 * 因此把令牌放进查询串。服务端仍会校验令牌，只是取令牌的位置不同。
 */
/**
 * 「可内嵌渲染」的预览地址。
 *
 * 与 `fileUrl` 的区别：
 *   fileUrl    → 永远给你**原件**（保真、用于下载/新窗口打开）
 *   previewUrl → 给**浏览器能直接渲染的东西**：PDF/图片原样，
 *                Word 之类由后端转成 PDF 再给（按 blobId 缓存）
 *
 * 所以「原件」视图要内嵌时用 previewUrl，拿不到再退回 fileUrl。
 */
export const previewUrl = (id: string) =>
  `${API_BASE}/files/${encodeURIComponent(id)}/preview` +
  (accessToken ? `?token=${encodeURIComponent(accessToken)}` : "");

export const fileUrl = (id: string, download = false) =>
  `${API_BASE}/files/${encodeURIComponent(id)}/${download ? "download" : "view"}` +
  (accessToken ? `?token=${encodeURIComponent(accessToken)}` : "");
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
