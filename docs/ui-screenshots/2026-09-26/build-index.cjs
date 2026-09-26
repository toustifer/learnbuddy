/**
 * 依据 manifest.json 生成可检索的索引：
 *   - index.html  ：带搜索框的分组画廊（按角色分组，卡片可直接点开大图）
 *   - README.md   ：Markdown 清单表（列：页面 / 路由 / 角色 / 文件 / 说明）
 *
 * 运行： node build-index.cjs
 */
const fs = require("fs");
const path = require("path");

const OUT = "D:/学习文档/AI-work/Learnbuddy/docs/ui-screenshots/2026-09-26";
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, "manifest.json"), "utf-8"));

const ROLE_LABEL = { anonymous: "公共（未登录）", teacher: "教师（teacher.lin）", student: "学生（student.xu）" };
const ROLE_ORDER = ["anonymous", "teacher", "student"];
const ENV_LABEL = "线上演示环境 http://129.204.52.57:3088/learnbuddy/";
const TODAY = "2026-09-26";

const ok = manifest.filter((m) => m.file);
const totalBytes = ok.reduce((s, m) => s + (m.bytes || 0), 0);
const mb = (totalBytes / 1048576).toFixed(1);

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------- index.html ----------------
const cards = ROLE_ORDER.map((role) => {
  const items = ok.filter((m) => m.role === role);
  if (!items.length) return "";
  const inner = items
    .map(
      (m) => `
      <article class="card" data-search="${esc((m.title + " " + m.hash + " " + m.slug + " " + (m.text || "")).toLowerCase())}">
        <a class="shot" href="${esc(m.file)}" target="_blank" rel="noreferrer">
          <img loading="lazy" src="${esc(m.file)}" alt="${esc(m.title)}" />
        </a>
        <div class="meta">
          <h3>${esc(m.title)}</h3>
          <p class="route"><code>${esc(m.hash)}</code></p>
          <p class="sub">${esc(m.file)} · ${(m.bytes / 1024).toFixed(0)} KB · 页面高 ${esc(m.h)}px</p>
          <p class="sub dim">${esc((m.text || "").slice(0, 70))}</p>
          ${m.note ? `<p class="note">${esc(m.note)}</p>` : ""}
        </div>
      </article>`
    )
    .join("\n");
  return `  <section class="group">
    <h2>${esc(ROLE_LABEL[role])} <span class="count">${items.length} 张</span></h2>
    <div class="grid">${inner}
    </div>
  </section>`;
}).join("\n");

const failed = manifest.filter((m) => !m.file);
const failedBlock = failed.length
  ? `<section class="group"><h2>未拍到 <span class="count">${failed.length} 张</span></h2><ul>${failed
      .map((m) => `<li><code>${esc(m.hash)}</code> ${esc(m.title)} — ${esc(m.error)}</li>`)
      .join("")}</ul></section>`
  : "";

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>LearnBuddy 界面截图索引 · ${TODAY}</title>
<style>
  :root { --line:#e5e7eb; --dim:#6b7280; --bg:#f8fafc; --ink:#0f172a; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; color:var(--ink); background:var(--bg); }
  header { position:sticky; top:0; z-index:10; background:#fff; border-bottom:1px solid var(--line); padding:18px 24px 14px; }
  h1 { margin:0 0 4px; font-size:19px; }
  .lead { margin:0 0 12px; color:var(--dim); font-size:13px; }
  input[type=search] { width:100%; max-width:520px; padding:9px 12px; border:1px solid var(--line); border-radius:8px; font-size:14px; }
  .hint { color:var(--dim); font-size:12px; margin:8px 0 0; }
  main { padding:20px 24px 60px; }
  h2 { font-size:15px; margin:26px 0 12px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  .count { color:var(--dim); font-weight:400; font-size:12px; margin-left:6px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:16px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:10px; overflow:hidden; display:flex; flex-direction:column; }
  .card.hide { display:none; }
  .shot { display:block; height:210px; overflow:hidden; background:#eef2f7; border-bottom:1px solid var(--line); }
  .shot img { width:100%; height:100%; object-fit:cover; object-position:top center; display:block; }
  .meta { padding:10px 12px 12px; }
  .meta h3 { margin:0 0 4px; font-size:14px; }
  .route code { background:#eef2f7; padding:1px 6px; border-radius:5px; font-size:12px; }
  .sub { margin:4px 0 0; font-size:12px; color:var(--dim); }
  .sub.dim { color:#9ca3af; }
  .note { margin:7px 0 0; font-size:12px; line-height:1.5; color:#92400e; background:#fffbeb; border-left:3px solid #fcd34d; padding:5px 8px; border-radius:4px; }
  ul { color:var(--dim); }
  footer { padding:0 24px 40px; color:var(--dim); font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>LearnBuddy 界面截图索引 · ${TODAY}</h1>
  <p class="lead">环境：${esc(ENV_LABEL)}　共 ${ok.length} 张，合计约 ${mb} MB。点任意卡片可看原图。</p>
  <input id="q" type="search" placeholder="搜索页面名 / 路由 / 文件名，例如「评阅」「#insights」「teacher」" autocomplete="off" />
  <p class="hint">按角色分组；输入即过滤（匹配标题、路由、文件名与页面正文片段）。</p>
</header>
<main>
${cards}
${failedBlock}
</main>
<footer>由 <code>capture-pw.cjs</code> 采集、<code>build-index.cjs</code> 生成；清单见 <code>manifest.json</code> 与 <code>README.md</code>。</footer>
<script>
  var q = document.getElementById("q");
  q.addEventListener("input", function () {
    var v = q.value.trim().toLowerCase();
    document.querySelectorAll(".card").forEach(function (c) {
      c.classList.toggle("hide", v && c.dataset.search.indexOf(v) === -1);
    });
    document.querySelectorAll(".group").forEach(function (g) {
      var cards = g.querySelectorAll(".card");
      if (!cards.length) return;
      var shown = g.querySelectorAll(".card:not(.hide)").length;
      g.style.display = shown ? "" : "none";
    });
  });
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(OUT, "index.html"), html, "utf-8");

// ---------------- README.md ----------------
const rows = ok
  .map(
    (m) =>
      `| ${m.title} | \`${m.hash}\` | ${ROLE_LABEL[m.role]} | [\`${m.file}\`](./${m.file}) | ${(m.bytes / 1024).toFixed(0)} KB | ${m.note ? m.note.replace(/\n/g, " ") : "—"} |`
  )
  .join("\n");

const md = `# LearnBuddy 界面截图清单

> 采集日期：${TODAY}　采集环境：${ENV_LABEL}
> 共 **${ok.length}** 张，合计约 **${mb} MB**。

**想直接找页面**：打开 [\`index.html\`](./index.html)（带搜索框，输入页面名 / 路由 / 文件名即可过滤）。

采集方式：Playwright 驱动 Chrome 153，视口 1440×900、deviceScaleFactor 2，全页截图；
登录态由服务端令牌注入（教师 \`teacher.lin\`、学生 \`student.xu\`，演示口令 \`123\`）。

## 清单

| 页面 | 路由 | 角色 | 文件 | 体积 | 备注 |
| :--- | :--- | :--- | :--- | ---: | :--- |
${rows}

## 复现

\`\`\`bash
# 0) 依赖：Node 18+ 与 playwright-core（Chrome 直接复用 agent-browser 已装的那个）
#    npm install playwright-core --proxy http://127.0.0.1:7890 --https-proxy http://127.0.0.1:7890

# 1) 预热（可选但强烈建议）：线上链路对本机很慢，先把构建产物灌进持久化 profile 的缓存
node warmup.cjs 25

# 2) 采集：教师 10 页 + 学生 8 页 + 登录页，共 19 张
node capture-pw.cjs

# 3) 重新生成索引（index.html / README.md / IMA-导入说明.md）
node build-index.cjs
\`\`\`

采集脚本里几个**必须保留**的等待，删了就会截到半成品：
等到 \`#root\` 有子节点（入口模块执行完）、等到页内不再出现「读取中」、
以及命中「暂时无法读取 / 被登出退回登录页」时**重载重试**（慢链路会把响应体截断，
而任意一次 \`auth/me\` 失败都会让前端清掉令牌 —— 所以每页导航前都要重新注入令牌）。

## 注意

- 截图取自**线上演示环境**，反映的是该环境当前部署的版本；本地未合并的改动不会出现在这里。
- 环境变量里带代理时，若浏览器启动失败，参考仓库记忆里记录的 \`--no-sandbox\` 与 CDP 连接坑。
${failed.length ? `\n## 未拍到的页面\n\n${failed.map((m) => `- \`${m.hash}\` ${m.title} —— ${m.error}`).join("\n")}\n` : ""}`;
fs.writeFileSync(path.join(OUT, "README.md"), md, "utf-8");

// ---------------- IMA 导入说明 ----------------
const imaRows = ok
  .map(
    (m) =>
      `| ${m.file} | 【${ROLE_LABEL[m.role].split("（")[0]}】${m.title} | \`${m.hash}\` | LearnBuddy / 界面截图 / ${m.role === "teacher" ? "教师端" : m.role === "student" ? "学生端" : "公共页"} |`
  )
  .join("\n");

const ima = `# 界面截图 → IMA 知识库 导入说明

> 目录：\`docs/ui-screenshots/${TODAY}/\`　共 ${ok.length} 张，约 ${mb} MB。
> 目的：**别人想找「某个页面长什么样」时，能按页面名/角色/路由直接搜到。**

## 为什么需要这份说明

本机 IMA 连接器未连接，无法由助手直接写入知识库。
所以这里给出一份**可直接照做的导入清单**：图片文件已在仓库里，按下面的标题与标签导入即可。

## 导入建议

1. 目标知识库：**艾玛知识库 / LearnBuddy**（与 \`docs/ima-handoff/\` 下其他文档同库）
2. 逐张上传本目录下的 PNG（文件名保持原样，便于和仓库对应）
3. 每张图的**标题**与**标签**按下表填写 —— 标题里带上页面名与角色，标签里带上路由，这样「评阅」「学情」「#insights」都能搜到
4. 可选：把 \`index.html\` 与 \`README.md\` 一起上传，作为总览入口

## 标题与标签对照表

| 文件 | 建议标题 | 建议标签（含路由） | 所属分类 |
| :--- | :--- | :--- | :--- |
${imaRows}

## 备注

- 截图采集自**线上演示环境** ${ENV_LABEL}
- 采集脚本与索引生成脚本：\`capture-pw.cjs\` / \`build-index.cjs\`
`;
fs.writeFileSync(path.join(OUT, "IMA-导入说明.md"), ima, "utf-8");

console.log(`index.html / README.md / IMA-导入说明.md 已生成：${ok.length} 张 / ${mb} MB`);
