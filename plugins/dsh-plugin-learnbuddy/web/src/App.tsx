import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  LogOut,
  Menu,
  Search,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react";
import { Provider } from "./context";
import { useStore } from "./store-context";
import { visibleCourses, visibleMaterials } from "./domain";
import { LIVE_MODE } from "./api";
import { users } from "./seed";
import { Brand, CourseBadge, FileIcon, MiniArt, Modal } from "./ui";
import {
  OnlineGrading,
  OnlineInsights,
} from "./pages/Online";
import { AcademicAssignments, OnlineReport } from "./pages/Academic";
import { OnlineAssignmentForm } from "./pages/AssignmentForm";
import { Library } from "./pages/Library";
import { MaterialWorkspace } from "./pages/Material";
import {
  Assignments,
  AssignmentEditor,
  Grading,
  ReportWorkspace,
  Insights,
} from "./pages/Assignments";

const LOCAL_SERVICE = import.meta.env.VITE_DATA_SOURCE === "local";

function Login() {
  const { login } = useStore();
  const [username, setUsername] = useState("student.lin");
  const [password, setPassword] = useState("123");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function enter(name = username, pass = password) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await login(name, pass);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="login-page">
      <section className="login-story">
        <Brand />
        <div className="login-copy">
          <span className="eyebrow">让理解，自然发生</span>
          <h1>
            每一份材料，
            <br />
            都能打开新的理解。
          </h1>
          <p>
            把课件读懂，把问题问透。
            <br />
            在有依据的反馈中，看见下一步。
          </p>
          <div className="login-illustration">
            <div className="illustration-paper">
              <span className="tiny-caps">COMPUTER NETWORKS</span>
              <h3>一次握手，连接知识。</h3>
              <MiniArt />
              <div className="fake-line" />
              <div className="fake-line short" />
              <div className="illustration-note">
                <Sparkles size={16} />
                <span>从原文出发，让疑问有回应。</span>
              </div>
            </div>
            <span className="floating-label">
              <BookOpen size={15} />
              读懂课件
            </span>
            <span className="floating-label second">
              <ClipboardList size={15} />
              看见依据
            </span>
          </div>
        </div>
        <footer>Learn together. Understand better.</footer>
      </section>
      <section className="login-form-section">
        <div className="login-form">
          <span className="status green">
            <span /> {LIVE_MODE ? "连接教学服务" : "本地交互演示"}
          </span>
          <h2>欢迎回到 LearnBuddy</h2>
          <p>从一份课件，或一个问题开始。</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              enter();
            }}
          >
            <label>
              账号
              <input
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  setError("");
                }}
                autoComplete="username"
                required
              />
            </label>
            <label>
              密码
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="button primary full"
              type="submit"
              disabled={pending}
            >
              {pending ? "正在登录…" : "进入工作台"}
              <ArrowRight size={17} />
            </button>
          </form>
          <div className="login-divider">
            <span>或选择演示账号</span>
          </div>
          <div className="account-grid">
            {users.slice(0, 4).map((u) => (
              <button
                key={u.id}
                disabled={pending}
                onClick={() => void enter(u.username, "123")}
              >
                <span
                  className={
                    "avatar " + (u.role === "teacher" ? "teacher" : "")
                  }
                >
                  {u.initials}
                </span>
                <span>
                  <strong>{u.name}</strong>
                  <small>
                    {u.role === "teacher" ? "教师" : "学生"} · {u.username}
                  </small>
                </span>
                <ChevronRight size={14} />
              </button>
            ))}
          </div>
          <p className="login-disclaimer">
            全部账号密码为 123，user / 123 也可进入。
            <br />
            {LIVE_MODE
              ? LOCAL_SERVICE ? "本机独立教学样例库；课程与人物均为虚构示例。" : "使用教学演示账号；课件与回答来源会在页面标注。"
              : "课程与人物均为虚构示例；数据只保存在当前浏览器。"}
          </p>
        </div>
      </section>
    </div>
  );
}
function Shell() {
  const {
    user,
    route,
    go,
    courseId,
    setCourseId,
    logout,
    login,
    state,
    reset,
    busy,
    notify,
  } = useStore();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => matchMedia("(max-width: 760px)").matches,
  );
  const sidebarRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    const query = matchMedia("(max-width: 760px)");
    const change = () => setIsMobile(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (isMobile && mobileOpen)
      sidebarRef.current
        ?.querySelector<HTMLButtonElement>(".mobile-only")
        ?.focus();
    else if (wasOpen.current) menuRef.current?.focus();
    wasOpen.current = mobileOpen;
  }, [isMobile, mobileOpen]);
  const [modal, setModal] = useState<"account" | "search" | "about" | null>(
    null,
  );
  const [search, setSearch] = useState("");
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && user) {
        e.preventDefault();
        setModal("search");
      }
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [user]);
  useEffect(() => {
    setMobileOpen(false);
  }, [route]);
  if (!user) return <Login />;
  const myCourses = visibleCourses(user);
  const navPage = ["material", "library"].includes(route.page)
    ? "library"
    : route.page === "insights"
      ? "insights"
      : "assignments";
  const title =
    navPage === "library"
      ? user.role === "teacher" ? "教学资料" : "课程学习"
      : navPage === "insights"
        ? "学情分析"
        : user.role === "teacher" ? "作业管理" : "我的作业";
  const routeCourseId =
    route.page === "material"
      ? state.materials.find((m) => m.id === route.id)?.courseId
      : ["assignment", "grading"].includes(route.page) && "id" in route
        ? state.assignments.find((a) => a.id === route.id)?.courseId
        : courseId;
  const course = myCourses.find((c) => c.id === routeCourseId);
  return (
    <div className={`app-shell role-${user.role}`}>
      {mobileOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="关闭导航"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        ref={sidebarRef}
        inert={isMobile && !mobileOpen}
        className={"sidebar " + (mobileOpen ? "open" : "")}
      >
        <div className="sidebar-brand">
          <Brand />
          <button
            className="icon-button mobile-only"
            onClick={() => setMobileOpen(false)}
            aria-label="关闭导航"
          >
            <X size={17} />
          </button>
        </div>
        <label className="course-switcher">
          <span>{user.role === "teacher" ? "任教课程" : "我的课程"}</span>
          <select aria-label="切换课程" value={courseId} onChange={(event) => {
            setCourseId(event.target.value);
            go({ page: navPage });
          }}>
            <option value="all">全部课程</option>
            {myCourses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        </label>
        <button
          className="sidebar-search"
          onClick={() => {
            setSearch("");
            setModal("search");
          }}
        >
          <Search size={16} />
          <span>搜索资料</span>
          <kbd>⌘ K</kbd>
        </button>
        <nav aria-label="主导航">
          <button
            className={navPage === "library" ? "active" : ""}
            onClick={() => go({ page: "library" })}
          >
            <BookOpen size={17} />
            {user.role === "teacher" ? "教学资料" : "课程学习"}
          </button>
          <button
            className={navPage === "assignments" ? "active" : ""}
            onClick={() => go({ page: "assignments" })}
          >
            <ClipboardList size={17} />
            {user.role === "teacher" ? "作业管理" : "我的作业"}
          </button>
          {user.role === "teacher" && (
            <button
              className={navPage === "insights" ? "active" : ""}
              onClick={() => go({ page: "insights" })}
            >
              <TrendingUp size={17} />
              学情分析
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <button className="help-button" onClick={() => setModal("about")}>
            <CircleHelp size={15} />
            使用说明
          </button>
          <button
            className="profile-button"
            onClick={() => setModal("account")}
          >
            <span
              className={"avatar " + (user.role === "teacher" ? "teacher" : "")}
            >
              {user.initials}
            </span>
            <span>
              <strong>{user.name}</strong>
              <small>{user.role === "teacher" ? "教师账号" : "学生账号"}</small>
            </span>
            <ChevronDown size={15} />
          </button>
        </div>
      </aside>
      <div className="app-content" inert={isMobile && mobileOpen}>
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              ref={menuRef}
              className="icon-button mobile-only"
              onClick={() => setMobileOpen(true)}
              aria-label="打开导航"
            >
              <Menu size={19} />
            </button>
            <button
              onClick={() => go({ page: user.role === "teacher" ? "assignments" : "library" })}
            >
              {user.role === "teacher" ? "教学空间" : "学习空间"}
            </button>
            <ChevronRight size={12} />
            <button
              onClick={() => {
                go({ page: navPage });
              }}
            >
              {title}
            </button>
            {course && (
              <>
                <ChevronRight size={12} />
                <button
                  className="breadcrumb-course"
                  onClick={() => {
                    setCourseId(course.id);
                    go({ page: navPage });
                  }}
                >
                  {course.title}
                </button>
              </>
            )}
          </div>
          <button className="demo-pill" onClick={() => setModal("about")}>
            <span />
            {LIVE_MODE ? LOCAL_SERVICE ? "本机预览" : "在线" : "演示数据"}
          </button>
        </header>
        <main
          className={
            "main " +
            (route.page === "material" || route.page === "report"
              ? "workspace-main"
              : "")
          }
          id="main-content"
          key={user.id + ":" + route.page + ("id" in route ? route.id : "")}
        >
          {route.page === "library" && <Library />}
          {route.page === "material" && <MaterialWorkspace id={route.id} />}
          {route.page === "assignments" &&
            (LIVE_MODE ? <AcademicAssignments /> : <Assignments />)}
          {route.page === "assignment" &&
            (LIVE_MODE ? (
              <OnlineAssignmentForm id={route.id} />
            ) : (
              <AssignmentEditor id={route.id} />
            ))}
          {route.page === "grading" &&
            (LIVE_MODE ? (
              <OnlineGrading id={route.id} />
            ) : (
              <Grading id={route.id} />
            ))}
          {route.page === "report" &&
            (LIVE_MODE ? (
              <OnlineReport id={route.id} />
            ) : (
              <ReportWorkspace id={route.id} />
            ))}
          {route.page === "insights" &&
            (LIVE_MODE ? <OnlineInsights /> : <Insights />)}
        </main>
      </div>
      {modal === "account" && (
        <Modal
          title="切换演示账号"
          description="账号决定课程与资料的可见范围。所有人物均为虚构。"
          onClose={() => setModal(null)}
        >
          <div className="switch-accounts">
            {users.map((u) => (
              <button
                key={u.id}
                className={user.id === u.id ? "current" : ""}
                onClick={() => {
                  void login(u.username, "123")
                    .then(() => setModal(null))
                    .catch((e) => notify(e.message, true));
                }}
              >
                <span
                  className={
                    "avatar " + (u.role === "teacher" ? "teacher" : "")
                  }
                >
                  {u.initials}
                </span>
                <span>
                  <strong>
                    {u.name} · {u.role === "teacher" ? "教师" : "学生"}
                  </strong>
                  <small>
                    {u.username}
                  </small>
                </span>
                {user.id === u.id ? (
                  <span className="status green">当前</span>
                ) : (
                  <ChevronRight size={16} />
                )}
              </button>
            ))}
          </div>
          <div className="modal-footer">
            <button
              className="button secondary"
              onClick={() => {
                logout();
                setModal(null);
              }}
            >
              <LogOut size={15} />
              退出登录
            </button>
          </div>
        </Modal>
      )}
      {modal === "search" && (
        <Modal title="搜索课程资料" onClose={() => setModal(null)}>
          <div className="search-field">
            <Search size={17} />
            <input
              autoFocus
              aria-label="搜索资料名称"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="输入资料名称或课程…"
            />
          </div>
          <div className="search-results">
            {visibleMaterials(state, user)
              .filter((m) =>
                (
                  m.title + myCourses.find((c) => c.id === m.courseId)?.title
                ).includes(search),
              )
              .map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    go({ page: "material", id: m.id });
                    setModal(null);
                  }}
                >
                  <FileIcon kind={m.kind} />
                  <span>
                    <strong>{m.title}</strong>
                    <CourseBadge id={m.courseId} />
                  </span>
                  <ChevronRight size={15} />
                </button>
              ))}
          </div>
        </Modal>
      )}
      {modal === "about" && (
        <Modal
          title={LIVE_MODE ? "当前接入范围" : "本地交互演示"}
          description="用完整流程验证页面、交互与师生关系。"
          onClose={() => setModal(null)}
        >
          <div className="about-content">
            <p>
              教师可管理作业、查看学生提交与成绩、复核和发布已有评分；学生可阅读课程资料，查看自己的任务、提交记录与已发布反馈。
            </p>
            <p>
              {LIVE_MODE
                ? `${LOCAL_SERVICE ? "当前连接本机独立教学样例库。" : "当前连接教学服务。"}课程、作业、名单和提交记录来自数据库；新报告接收与完整性检查仍待接入。未配置模型时，答疑明确显示降级状态。`
                : "课程、人物、课件和报告为虚构教学示例。文件和模拟结果保存在当前浏览器。"}
            </p>
            <p>
              界面按账号角色显示功能；当前后端的密码与令牌校验尚不完整，不能作为正式权限隔离。教师教学反馈只基于本课程报告，不读取学生个人聊天。
            </p>
          </div>
          <div className="modal-footer">
            <button
              className="button secondary"
              disabled={Object.values(busy).some(Boolean)}
              onClick={() => {
                void reset().then(() => setModal(null));
              }}
            >
              {LIVE_MODE ? "刷新服务器资料" : "重置演示数据"}
            </button>
            <button className="button primary" onClick={() => setModal(null)}>
              继续体验
              <ArrowRight size={15} />
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
export default function App() {
  return (
    <Provider>
      <Shell />
    </Provider>
  );
}
