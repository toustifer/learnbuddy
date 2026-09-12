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
    if (!res.ok || data?.ok !== true)
      throw new ApiError(
        data?.error || `请求失败（HTTP ${res.status}）`,
        res.status,
      );
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
  const data = await request<{ user: User }>(
    "/auth/login",
    post({ username: username.trim(), password }),
  );
  if (!data.user?.id || !["student", "teacher"].includes(data.user.role))
    throw new ApiError("服务返回的账号身份不完整。");
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
export const fileUrl = (id: string, download = false) =>
  `${API_BASE}/files/${encodeURIComponent(id)}/${download ? "download" : "view"}`;
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
