import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { parseRoute, routeHash, courseForRoute } from "./navigation";
import { Context } from "./store-context";
import { users, freshState, fixtureGrades } from "./seed";
import {
  LIVE_MODE,
  listMaterials,
  loginAccount,
  logoutAccount,
  fetchCurrentAccount,
  request,
  getAccessToken,
  setAccessToken,
} from "./api";
import { authenticate, assertTeacher, visibleCourses } from "./domain";
import { readState, writeState, clearBlobs } from "./storage";
import type { DemoState, Route, User, ServerReview, AcademicWorkspace } from "./types";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 访问令牌的会话级存储键：页面刷新后据此恢复登录态，关闭标签页即失效。 */
const TOKEN_KEY = "learnbuddy-token";
export function Provider({ children }: { children: ReactNode }) {
  const [initial] = useState(() =>
    LIVE_MODE
      ? {
          state: { ...freshState(), assignments: [], materials: [], submissions: [], chats: {} },
          warning: "",
        }
      : readState(),
  );
  const [state, setState] = useState(initial.state);
  const stateRef = useRef(state);
  const [user, setUser] = useState<User | null>(() => {
    try {
      if (LIVE_MODE) return null;
      return (
        users.find((u) => u.id === sessionStorage.getItem("learnbuddy-user")) ||
        null
      );
    } catch {
      return null;
    }
  });
  const userRef = useRef(user);
  userRef.current = user;
  const [academic, setAcademic] = useState<AcademicWorkspace | null>(null);
  const [academicLoading, setAcademicLoading] = useState(false);
  const [academicError, setAcademicError] = useState("");
  const academicRequest = useRef<AbortController | null>(null);
  const refreshAcademic = useCallback(async () => {
    if (!LIVE_MODE || !user) return;
    academicRequest.current?.abort();
    const controller = new AbortController();
    academicRequest.current = controller;
    setAcademicLoading(true);
    setAcademicError("");
    try {
      const data = await request<AcademicWorkspace>("/workspace", { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!Array.isArray(data.assignments) || !Array.isArray(data.submissions) || !Array.isArray(data.roster) || !Array.isArray(data.courses)) throw new Error("课程数据不完整，请重试。");
      setAcademic(data);
      const next = { ...stateRef.current, assignments: data.assignments, submissions: data.submissions };
      stateRef.current = next;
      setState(next);
    } catch (e) {
      if (!controller.signal.aborted) setAcademicError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setAcademicLoading(false);
    }
  }, [user]);
  useEffect(() => {
    void refreshAcademic();
    return () => academicRequest.current?.abort();
  }, [refreshAcademic]);

  /**
   * 刷新页面后用已保存的令牌换回身份。
   *
   * 令牌存 sessionStorage：刷新能把人留住，关掉标签页即失效。
   * 换不回来（令牌过期/被作废）就静默回到登录页，不打断用户。
   */
  useEffect(() => {
    if (!LIVE_MODE) return;
    let stored = "";
    try {
      stored = sessionStorage.getItem(TOKEN_KEY) || "";
    } catch {
      return;
    }
    if (!stored) return;
    setAccessToken(stored);
    let cancelled = false;
    void (async () => {
      try {
        const restored = await fetchCurrentAccount();
        if (!cancelled) setUser(restored);
      } catch {
        setAccessToken("");
        try {
          sessionStorage.removeItem(TOKEN_KEY);
        } catch {
          /* 内存中的令牌已清空，够用 */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const [reviewResults, setReviewResults] = useState<
    Record<string, ServerReview>
  >({});
  function updateReviewResults(
    fn: (current: Record<string, ServerReview>) => Record<string, ServerReview>,
  ) {
    if (!user || user.id !== userRef.current?.id) return;
    setReviewResults(fn);
  }
  const [materialsLoading, setMaterialsLoading] = useState(false);
  const [materialsError, setMaterialsError] = useState("");
  const materialsRequest = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const refreshMaterials = useCallback(async () => {
    if (!LIVE_MODE || !user) return;
    materialsRequest.current?.abort();
    const controller = new AbortController();
    materialsRequest.current = controller;
    setMaterialsLoading(true);
    setMaterialsError("");
    try {
      const materials = await listMaterials(controller.signal);
      if (controller.signal.aborted) return;
      const next = { ...stateRef.current, materials };
      stateRef.current = next;
      setState(next);
    } catch (e) {
      if (!controller.signal.aborted) setMaterialsError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setMaterialsLoading(false);
    }
  }, [user]);
  useEffect(() => {
    void refreshMaterials();
    return () => {
      materialsRequest.current?.abort();
    };
  }, [refreshMaterials]);
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [courseId, setCourseId] = useState("all");
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const running = useRef(new Set<string>());
  const [notice, setNotice] = useState<{
    message: string;
    error: boolean;
  } | null>(initial.warning ? { message: initial.warning, error: true } : null);
  useEffect(() => {
    const change = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  function notify(message: string, error = false) {
    setNotice({ message, error });
  }
  function update(fn: (s: DemoState) => DemoState) {
    const next = fn(stateRef.current);
    try {
      if (!LIVE_MODE) writeState(next);
    } catch {
      notify("未能保存更改，请检查浏览器存储空间后重试。", true);
      throw new Error("保存失败");
    }
    stateRef.current = next;
    setState(next);
  }
  useEffect(() => {
    const target = courseForRoute(route, state);
    if (target === "all" || ["home", "courses", "library"].includes(route.page)) setCourseId("all");
    else if (target && user && visibleCourses(user).some((c) => c.id === target)) setCourseId(target);
  }, [route, state.materials, state.assignments, state.submissions, user]);
  function go(r: Route) {
    const target = courseForRoute(r, stateRef.current);
    if (target && userRef.current && (target === "all" || visibleCourses(userRef.current).some((c) => c.id === target))) setCourseId(target);
    if (["home", "courses", "library"].includes(r.page)) setCourseId("all");
    location.hash = routeHash(r);
    setRoute(r);
  }
  async function login(username: string, password: string) {
    const turn = ++epoch.current;
    const u = LIVE_MODE
      ? await loginAccount(username, password)
      : authenticate(username, password);
    if (!u) throw new Error("账号或密码不正确，演示账号密码为 123。");
    if (turn !== epoch.current) return;
    materialsRequest.current?.abort();
    if (LIVE_MODE) {
      const clean = {
        ...freshState(),
        assignments: [],
        materials: [],
        submissions: [],
        chats: {},
      };
      stateRef.current = clean;
      setState(clean);
      setMaterialsError("");
    }
    userRef.current = u;
    academicRequest.current?.abort();
    setAcademic(null);
    setAcademicError("");
    setReviewResults({});
    setUser(u);
    setCourseId("all");
    try {
      if (LIVE_MODE) {
        // 令牌已由 loginAccount 装进 api 层；这里持久化，供刷新后恢复登录态
        const token = getAccessToken();
        if (token) sessionStorage.setItem(TOKEN_KEY, token);
      } else {
        sessionStorage.setItem("learnbuddy-user", u.id);
      }
    } catch {
      /* 刷新后需重新登录，但本次会话仍可用 */
    }
    go({ page: "home" });
  }
  function logout() {
    epoch.current++;
    materialsRequest.current?.abort();
    academicRequest.current?.abort();
    setAcademic(null);
    setAcademicError("");
    if (LIVE_MODE) {
      const clean = {
        ...freshState(),
        assignments: [],
        materials: [],
        submissions: [],
        chats: {},
      };
      stateRef.current = clean;
      setState(clean);
    }
    userRef.current = null;
    setReviewResults({});
    setUser(null);
    setCourseId("all");
    try {
      sessionStorage.removeItem("learnbuddy-user");
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* memory logout still applies */
    }
    // 同时让服务端作废这个令牌，否则它在本机被清掉后仍然可用
    if (LIVE_MODE) void logoutAccount();
    go({ page: "home" });
  }
  async function job(key: string, action: () => void | Promise<void>) {
    if (running.current.has(key)) return;
    running.current.add(key);
    setBusy(Object.fromEntries([...running.current].map((k) => [k, true])));
    try {
      if (!LIVE_MODE) await delay(750);
      await action();
    } catch (e) {
      notify(e instanceof Error ? e.message : "操作失败，请重试。", true);
    } finally {
      running.current.delete(key);
      setBusy(Object.fromEntries([...running.current].map((k) => [k, true])));
    }
  }
  async function gradeReports(ids: string[]) {
    if (LIVE_MODE) return notify("请通过服务器评阅入口操作。", true);
    if (!user || !ids.length) return;
    const viewer = user;
    const eligible = ids.filter((id) => {
      const s = stateRef.current.submissions.find((s) => s.id === id);
      return s && !["grading", "published"].includes(s.status);
    });
    if (!eligible.length) return notify("没有可评阅的报告。");
    try {
      for (const id of eligible) {
        const s = stateRef.current.submissions.find((s) => s.id === id)!;
        const a = stateRef.current.assignments.find(
          (a) => a.id === s.assignmentId,
        )!;
        assertTeacher(viewer, a);
        if (!a.confirmed) throw new Error("请先确认本作业的评分标准。");
      }
      update((s) => ({
        ...s,
        submissions: s.submissions.map((r) =>
          eligible.includes(r.id)
            ? { ...r, status: "grading", failure: undefined }
            : r,
        ),
      }));
    } catch (e) {
      notify((e as Error).message, true);
      return;
    }
    for (const id of eligible) {
      await job("grade:" + id, () =>
        update((s) => {
          const report = s.submissions.find((r) => r.id === id)!;
          const assignment = s.assignments.find(
            (a) => a.id === report.assignmentId,
          )!;
          const result = report.sampleKey
            ? {
                ...report,
                status: "review" as const,
                grades: fixtureGrades(assignment, report.studentId),
                summary:
                  "核心实验过程已完成。请结合各项证据复核分数，重点关注原理解释、截图标注与异常分析。",
              }
            : {
                ...report,
                status: "failed" as const,
                failure:
                  "文件已保存。真实文件的解析与 AI 评阅待后端接入；可以先人工评阅，或用演示报告体验完整流程。",
              };
          return {
            ...s,
            submissions: s.submissions.map((r) => (r.id === id ? result : r)),
          };
        }),
      );
    }
    notify("本批评阅已结束，请查看各份报告的状态。");
  }
  async function reset() {
    if (LIVE_MODE) {
      await refreshMaterials();
      return;
    }
    if (running.current.size)
      return notify("请等待当前任务结束后再重置。", true);
    await clearBlobs();
    update(() => freshState());
    go({ page: "home" });
    notify("已恢复初始演示数据。");
  }
  return (
    <Context.Provider
      value={{
        academic,
        academicLoading,
        academicError,
        refreshAcademic,
        state,
        reviewResults,
        updateReviewResults,
        materialsLoading,
        materialsError,
        refreshMaterials,
        user,
        route,
        courseId,
        busy,
        update,
        login,
        logout,
        go,
        setCourseId,
        notify,
        job,
        gradeReports,
        reset,
      }}
    >
      {children}
      {notice && (
        <div
          className={"toast " + (notice.error ? "error" : "")}
          role={notice.error ? "alert" : "status"}
        >
          <span>{notice.message}</span>
          <button onClick={() => setNotice(null)} aria-label="关闭提示">
            ×
          </button>
        </div>
      )}
    </Context.Provider>
  );
}
