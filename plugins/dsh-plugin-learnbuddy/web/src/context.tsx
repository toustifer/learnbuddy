import { useEffect, useRef, useState, type ReactNode } from "react";
import { Context } from "./store-context";
import { users, freshState, fixtureGrades } from "./seed";
import { assertTeacher } from "./domain";
import { readState, writeState, clearBlobs } from "./storage";
import type { DemoState, Route, User } from "./types";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function parseRoute(): Route {
  const [page, id] = location.hash.slice(1).split("/");
  if (["material", "assignment", "grading", "report"].includes(page) && id)
    return { page, id: decodeURIComponent(id) } as Route;
  if (page === "assignments" || page === "insights") return { page };
  return { page: "library" };
}
export function Provider({ children }: { children: ReactNode }) {
  const [initial] = useState(readState);
  const [state, setState] = useState(initial.state);
  const stateRef = useRef(state);
  const [user, setUser] = useState<User | null>(() => {
    try {
      return (
        users.find((u) => u.id === sessionStorage.getItem("learnbuddy-user")) ||
        null
      );
    } catch {
      return null;
    }
  });
  const [route, setRoute] = useState<Route>(parseRoute);
  const [courseId, setCourseId] = useState("all");
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const running = useRef(new Set<string>());
  const [notice, setNotice] = useState<{
    message: string;
    error: boolean;
  } | null>(initial.warning ? { message: initial.warning, error: true } : null);
  useEffect(() => {
    const change = () => setRoute(parseRoute());
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
      writeState(next);
    } catch {
      notify("未能保存更改，请检查浏览器存储空间后重试。", true);
      throw new Error("保存失败");
    }
    stateRef.current = next;
    setState(next);
  }
  function go(r: Route) {
    location.hash = r.page + ("id" in r ? "/" + encodeURIComponent(r.id) : "");
    setRoute(r);
  }
  function login(u: User) {
    setUser(u);
    setCourseId("all");
    try {
      sessionStorage.setItem("learnbuddy-user", u.id);
    } catch {
      /* session remains usable in memory */
    }
    go({ page: "library" });
  }
  function logout() {
    setUser(null);
    setCourseId("all");
    try {
      sessionStorage.removeItem("learnbuddy-user");
    } catch {
      /* memory logout still applies */
    }
    go({ page: "library" });
  }
  async function job(key: string, action: () => void | Promise<void>) {
    if (running.current.has(key)) return;
    running.current.add(key);
    setBusy(Object.fromEntries([...running.current].map((k) => [k, true])));
    try {
      await delay(750);
      await action();
    } catch (e) {
      notify(e instanceof Error ? e.message : "操作失败，请重试。", true);
    } finally {
      running.current.delete(key);
      setBusy(Object.fromEntries([...running.current].map((k) => [k, true])));
    }
  }
  async function gradeReports(ids: string[]) {
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
    if (running.current.size)
      return notify("请等待当前任务结束后再重置。", true);
    await clearBlobs();
    update(() => freshState());
    go({ page: "library" });
    notify("已恢复初始演示数据。");
  }
  return (
    <Context.Provider
      value={{
        state,
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
