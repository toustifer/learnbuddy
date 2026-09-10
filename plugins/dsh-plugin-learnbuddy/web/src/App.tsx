import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  GraduationCap,
  LogOut,
  Menu,
  Search,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react";
import { Provider } from "./context";
import { useStore } from "./store-context";
import { authenticate, visibleCourses, visibleMaterials } from "./domain";
import { courses, users } from "./seed";
import { Brand, CourseBadge, FileIcon, MiniArt, Modal } from "./ui";
import { Library } from "./pages/Library";
import { MaterialWorkspace } from "./pages/Material";
import {
  Assignments,
  AssignmentEditor,
  Grading,
  ReportWorkspace,
  Insights,
} from "./pages/Assignments";

function Login() {
  const { login } = useStore();
  const [username, setUsername] = useState("student.lin");
  const [password, setPassword] = useState("123");
  const [error, setError] = useState("");
  function enter(name = username) {
    const u = authenticate(name, password);
    if (!u) return setError("账号或密码不正确。演示账号密码均为 123。");
    login(u);
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
            <span /> 交互演示
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
            <button className="button primary full" type="submit">
              进入工作台
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
                onClick={() => {
                  const account = authenticate(u.username, "123");
                  if (account) login(account);
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
            课程与人物均为虚构示例；AI 输出为模拟。数据只保存在当前浏览器。
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
      ? "课程资料"
      : navPage === "insights"
        ? "教学反馈"
        : "作业与报告";
  const course = courses.find((c) => c.id === courseId);
  return (
    <div className="app-shell">
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
        <div className="workspace-label">
          <GraduationCap size={14} />
          我的{user.role === "teacher" ? "教学" : "学习"}空间<span>DEMO</span>
        </div>
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
            课程资料
          </button>
          <button
            className={navPage === "assignments" ? "active" : ""}
            onClick={() => go({ page: "assignments" })}
          >
            <ClipboardList size={17} />
            作业与报告
          </button>
          {user.role === "teacher" && (
            <button
              className={navPage === "insights" ? "active" : ""}
              onClick={() => go({ page: "insights" })}
            >
              <TrendingUp size={17} />
              教学反馈
            </button>
          )}
        </nav>
        <div className="sidebar-section-title">
          我的课程<span>{myCourses.length}</span>
        </div>
        <nav className="course-nav" aria-label="课程筛选">
          <button
            className={courseId === "all" ? "selected" : ""}
            onClick={() => {
              setCourseId("all");
              go({ page: "library" });
            }}
          >
            <span className="all-course-icon">▦</span>全部课程
          </button>
          {myCourses.map((c) => (
            <button
              key={c.id}
              className={courseId === c.id ? "selected" : ""}
              onClick={() => {
                setCourseId(c.id);
                go({ page: "library" });
              }}
            >
              <span className={"course-square " + c.color}>
                {c.title.slice(0, 1)}
              </span>
              {c.title}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="help-button" onClick={() => setModal("about")}>
            <CircleHelp size={15} />
            演示说明
            <span className="subtle-dot" />
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
            <span>{user.role === "teacher" ? "教学空间" : "学习空间"}</span>
            <ChevronRight size={12} />
            <button onClick={() => go({ page: navPage })}>{title}</button>
            {course && (
              <>
                <ChevronRight size={12} />
                <span className="breadcrumb-course">{course.title}</span>
              </>
            )}
          </div>
          <button className="demo-pill" onClick={() => setModal("about")}>
            <span />
            交互演示<span className="desktop-only"> · 模型待接入</span>
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
          {route.page === "assignments" && <Assignments />}
          {route.page === "assignment" && <AssignmentEditor id={route.id} />}
          {route.page === "grading" && <Grading id={route.id} />}
          {route.page === "report" && <ReportWorkspace id={route.id} />}
          {route.page === "insights" && <Insights />}
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
                  login(u);
                  setModal(null);
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
                    {visibleCourses(u)
                      .map((c) => c.title)
                      .join(" / ")}
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
                  m.title + courses.find((c) => c.id === m.courseId)?.title
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
          title="这是一份可操作的初始 Demo"
          description="用完整流程验证页面、交互与师生关系。"
          onClose={() => setModal(null)}
        >
          <div className="about-content">
            <p>
              你可以切换账号、浏览课程资料、引用图文提问、准备答疑卡和作业标准，再体验提交、批量评阅、教师复核和反馈。
            </p>
            <p>
              课程、人物、课件和报告均为虚构教学示例。学习对话已嵌入本地
              DSH，模型尚未配置；课件整理与评阅仍采用演示逻辑。真实上传文件保存在浏览器，解析仍待接入。
            </p>
            <p>
              账号与权限仅用于前端交互演示，不能替代服务端权限校验。教师教学反馈只基于本课程提交的报告，不读取学生个人聊天。
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
              重置演示数据
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
