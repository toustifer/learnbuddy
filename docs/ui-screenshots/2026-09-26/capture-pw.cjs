/**
 * LearnBuddy 线上界面批量截图（Playwright 驱动，单进程，绕开 agent-browser daemon）
 *
 * 为什么不用 agent-browser CLI：本机上它的 daemon ↔ Chrome CDP 连接反复超时
 * （Failed to read ... os error 10060），CLI 分散调用还会留下孤儿 Chrome。
 * 直接 Playwright 更稳，而且能用一个持久化 profile 把慢加载的构建产物缓存住。
 *
 * 运行：
 *   node capture-pw.cjs
 */
const path = require("path");
const fs = require("fs");
const PW = require("C:/Users/lanch/.workbuddy/binaries/node/workspace/node_modules/playwright-core");

const CHROME = "C:/Users/lanch/.agent-browser/browsers/chrome-153.0.8010.52/chrome.exe";
const PROFILE = "C:/Users/lanch/.workbuddy/tmp/ui-shots/pw-profile";
const BASE = "http://129.204.52.57:3088/learnbuddy/";
const API = "http://129.204.52.57:3088/api/learnbuddy";
const OUT = "D:/学习文档/AI-work/Learnbuddy/docs/ui-screenshots/2026-09-26";

const LOG = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function loginToken(username) {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "123" })
  });
  const data = await res.json();
  if (!data.token) throw new Error(`login failed for ${username}: ${JSON.stringify(data)}`);
  return data.token;
}

// 页面清单：[slug, hash, 角色, 说明]
const PAGES = [
  ["00-login",                "home",                        "anonymous", "登录页：账号密码 + 演示账号快捷入口"],
  ["10-teacher-home",         "home",                        "teacher",   "教学空间（教师首页）"],
  ["11-teacher-courses",      "courses",                     "teacher",   "课程库"],
  ["12-teacher-course",       "course/database",             "teacher",   "课程工作区"],
  ["13-teacher-material",     "material/mat-db",             "teacher",   "课件工作区"],
  ["14-teacher-assignments",  "assignments/database",        "teacher",   "作业列表"],
  ["15-teacher-assignment",   "assignment/lab-db",           "teacher",   "作业详情 / 布置"],
  ["16-teacher-grading",      "grading/lab-db",              "teacher",   "评阅台（全班）"],
  ["17-teacher-review",       "grading/lab-db/sub-xu-db",    "teacher",   "在线评阅（聚焦单份）"],
  ["18-teacher-report",       "report/sub-xu-db",            "teacher",   "报告工作区"],
  ["19-teacher-insights",     "insights/database",           "teacher",   "学情分析"],
  ["20-student-home",         "home",                        "student",   "学习空间（学生首页）"],
  ["21-student-courses",      "courses",                     "student",   "课程库（学生所见）"],
  ["22-student-course",       "course/database",             "student",   "课程工作区"],
  ["23-student-material",     "material/mat-db",             "student",   "课件阅读 + 学习助手"],
  ["24-student-assignments",  "assignments/database",        "student",   "我的作业"],
  ["25-student-assignment",   "assignment/lab-db",           "student",   "作业提交页"],
  ["26-student-report",       "report/sub-xu-db",            "student",   "我的报告"],
  ["27-student-insights",     "insights/database",           "student",   "我的学情"]
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const teacherToken = await loginToken("teacher.lin");
  const studentToken = await loginToken("student.xu");
  LOG(`tokens ok (teacher=${teacherToken.length}, student=${studentToken.length})`);

  const ctx = await PW.chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
    // 本机直连线上服务器极慢（226KB 要 ~75s）；本机代理只要 ~23s。
    // 注意：CDP 走的是 Playwright 自己的管道，不经过这里的 proxy 设置，所以不会被劫持。
    proxy: { server: "http://127.0.0.1:7890", bypass: "localhost,127.0.0.1,::1" },
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.setDefaultTimeout(120000);

  const manifest = [];

  // 错误态包含：接口截断导致的读取失败、以及**被登出退回登录页**
  // （reload 时只要有一次 auth/me 因慢链路失败，前端就会清掉令牌 → 登录页）
  const ERROR_STATE = /暂时无法读取|无法查看这份资料|服务返回了无法读取|加载失败|出错了|让理解，自然发生/;

  /** 每页导航前都重新注入登录态 —— 防止中途被登出后一路拍成登录页 */
  async function injectAuth(token, user) {
    if (!token) return;
    await page
      .evaluate(
        ([t, u]) => {
          sessionStorage.setItem("learnbuddy-token", t);
          sessionStorage.setItem("learnbuddy-user", u);
        },
        [token, user]
      )
      .catch(() => {});
  }

  async function loadAndSettle(hash, token, user) {
    const target = `${BASE}#${hash}`;
    await injectAuth(token, user);
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 300000 });
    // 等 hash 落到该页（注意 location.hash 是带 "#" 的）
    await page.waitForFunction((h) => location.hash.replace(/^#/, "") === h, hash, { timeout: 45000 }).catch(() => {});
    // 等 React 真正挂载（入口模块执行完才会有子节点）
    await page.waitForFunction(
      () => {
        const r = document.getElementById("root");
        return r && r.children.length > 0;
      },
      null,
      { timeout: 300000 }
    );
    // 等正文渲染出来（避免截到 loading 骨架）
    await page.waitForFunction(() => document.body.innerText.trim().length > 40, null, { timeout: 60000 }).catch(() => {});
    // 等页内「读取中 / 正在读取 / 助手正在打开」这类加载态消失 ——
    // API 与学习助手都走这条慢链路，不等它就会截到一堆占位符
    await page.waitForFunction(
      () => !/正在读取|读取中|加载中|Loading|正在打开学习对话|正在连接学习助手/.test(document.body.innerText),
      null,
      { timeout: 120000 }
    ).catch(() => {});
    await page.waitForTimeout(1500);
  }

  async function bootAndShoot(slug, hash, role, title, token, user) {
    const file = path.join(OUT, `${slug}.png`);
    const isAnon = role === "anonymous";
    try {
      await loadAndSettle(hash, token, user);
      // 慢链路偶尔会把响应体截断，前端就会落到"暂时无法读取"这类错误态；
      // 被登出退回登录页同理。命中就重载重试（未登录页本身就是登录页，跳过判定）
      for (let attempt = 1; !isAnon && attempt <= 3; attempt++) {
        const text = await page.evaluate(() => document.body.innerText);
        if (!ERROR_STATE.test(text)) break;
        LOG(`  · ${slug} 命中错误态（第 ${attempt} 次），重载重试`);
        await page.reload({ waitUntil: "domcontentloaded", timeout: 300000 });
        await page.waitForTimeout(2500);
        await loadAndSettle(hash, token, user);
      }

      await page.screenshot({ path: file, fullPage: true });
      const info = await page.evaluate(() => ({
        hash: location.hash,
        title: document.title,
        text: document.body.innerText.replace(/\s+/g, " ").slice(0, 80),
        h: document.body.scrollHeight
      }));
      const bytes = fs.statSync(file).size;
      // 注意：info.title 是 document.title，不能让它覆盖描述性标题（曾把整列刷成同一个值）
      manifest.push({
        slug,
        role,
        hash: `#${hash}`,
        title,
        file: `${slug}.png`,
        bytes,
        docTitle: info.title,
        text: info.text,
        h: info.h
      });
      LOG(`✓ ${slug}  ${bytes}B  h=${info.h}  "${info.text.slice(0, 40)}"`);
      return true;
    } catch (err) {
      LOG(`✗ ${slug}  FAILED: ${err.message.split("\n")[0]}`);
      manifest.push({ slug, role, hash: `#${hash}`, title, file: null, error: err.message.split("\n")[0] });
      return false;
    }
  }

  // ---- 0) 未登录页 ----
  await bootAndShoot("00-login", "home", "anonymous", "登录页", null, null);
  await page.evaluate(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  // ---- 1) 教师 ----
  await page.evaluate((t) => {
    sessionStorage.setItem("learnbuddy-token", t);
    sessionStorage.setItem("learnbuddy-user", "t-lin");
  }, teacherToken);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 300000 });
  await page.waitForFunction(
    () => {
      const r = document.getElementById("root");
      return r && r.children.length > 0;
    },
    null,
    { timeout: 300000 }
  );
  await page.waitForTimeout(2000);
  for (const [slug, hash, role, title] of PAGES.filter((p) => p[2] === "teacher")) {
    await bootAndShoot(slug, hash, role, title, teacherToken, "t-lin");
  }

  // ---- 2) 学生 ----
  await page.evaluate((t) => {
    sessionStorage.setItem("learnbuddy-token", t);
    sessionStorage.setItem("learnbuddy-user", "s-xu");
  }, studentToken);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 300000 });
  await page.waitForFunction(
    () => {
      const r = document.getElementById("root");
      return r && r.children.length > 0;
    },
    null,
    { timeout: 300000 }
  );
  await page.waitForTimeout(2000);
  for (const [slug, hash, role, title] of PAGES.filter((p) => p[2] === "student")) {
    await bootAndShoot(slug, hash, role, title, studentToken, "s-xu");
  }

  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  LOG(`完成，共 ${manifest.length} 条，成功 ${manifest.filter((m) => m.file).length} 条`);
  await ctx.close();
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
