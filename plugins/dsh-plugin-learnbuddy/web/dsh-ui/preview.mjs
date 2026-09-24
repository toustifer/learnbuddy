import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import "./build.mjs";

if (Number(process.versions.node.split(".")[0]) < 22) {
  throw new Error(
    "DSH 预览需要 Node.js 22.19+ 或 24+。LearnBuddy 网页可继续使用原 Node 环境。",
  );
}
const webRoot = fileURLToPath(new URL("../", import.meta.url));
if (existsSync(path.join(webRoot, ".env.local"))) process.loadEnvFile(path.join(webRoot, ".env.local"));
const { resolveLLMConfig } = await import("../../src/services/llm.js");
const llm = resolveLLMConfig();
// Both services read the same server-only key; never serialize it into a patch.
if (llm.apiKey) process.env.LEARNBUDDY_DSH_API_KEY = llm.apiKey;
const preview = path.join(webRoot, ".dsh-preview");
const home = path.join(preview, "home");
const cwd = path.join(preview, "workspace");
const bin = path.join(
  preview,
  "runtime/node_modules/@deepseek-ai/dsh/lib/bin.js",
);
if (!existsSync(bin))
  throw new Error("请先运行 npm run setup:dsh 安装本地 DSH 预览依赖。");
await mkdir(cwd, { recursive: true });
await mkdir(home, { recursive: true });
// Keep this preview self-contained. Never reuse the user's DSH home or server.
const profileFile = path.join(home, "profiles/web/package.json");
if (!existsSync(profileFile)) {
  // Use DSH's own profile initializer, then disable profile file watchers for this preview.
  const initialized = spawnSync(process.execPath, [bin, "--profile", "web", "--dump-config"], {
    cwd, env: { ...process.env, DSH_HOME: home }, stdio: "ignore", timeout: 30000,
  });
  if (initialized.status !== 0 || !existsSync(profileFile)) {
    throw new Error("DSH 预览配置初始化失败，请检查安装与当前 Node 版本。");
  }
}
if (existsSync(profileFile)) {
  const profile = JSON.parse(await readFile(profileFile, "utf8"));
  profile.dsh.profile.patchReload = "startup";
  await writeFile(profileFile, JSON.stringify(profile, null, 2));
}
/**
 * 伴学场景用不到的 DSH 客户端插件，逐个禁用。
 *
 * 为什么必须在这里禁用：DSH 的浏览器插件清单是在启动时算好、内联进
 * `window.__DSH_BOOT__` 的，之后所有 client.js 会被合并成**一个** `??` 请求
 * 一次性下发（实测集合被整体签名，抽掉任一模块整包即拒绝）。所以"按需加载"
 * 走不通，只能从清单里摘掉。
 *
 * 收益最大的一条是 `ui-sidebar-documentpreview`：它把整个 PDF.js
 * （pdfjs-dist）打进了客户端，单模块实测 6726.9 KB 裸传 / 2896.9 KB gzip，
 * **占全包 61.6%**。而 LearnBuddy 的课件阅读是自己实现的
 * （web/src/pages/Material.tsx + BlobPreview），不用 DSH 的侧栏文档预览。
 *
 * 注意：这些是**清单行的 id**（来自 `dsh --dump-config`），不是包名——
 * 写错时 DSH 只 warn 不报错，会静默失效。改完请用
 * `--dump-config` 核对 disabled 真的生效了。
 */
const LEARNBUDDY_DISABLED_PLUGINS = [
  // 收益最大：PDF.js 全家桶，占全包 61.6%
  "ui-sidebar-documentpreview",
];

const patch = path.join(preview, "learnbuddy.patch.yml");
await writeFile(
  patch,
  JSON.stringify(
    [
      { id: "llm-deepseek", config: { apiKeyEnv: "LEARNBUDDY_DSH_API_KEY", baseURL: llm.baseUrl, maxTokens: 8192 } },
      { id: "agent-default-model", config: { provider: "deepseek-official", model: llm.textModel } },
      {
        insert: [
          { id: "learnbuddy-ui", name: path.join(webRoot, "dsh-ui/host.js") },
        ],
      },
      ...LEARNBUDDY_DISABLED_PLUGINS.map((id) => ({ id, disabled: true })),
    ],
    null,
    2,
  ),
);
await writeFile(
  path.join(cwd, "README.md"),
  "# LearnBuddy 本地 DSH 教学工作区\n\n用于课程资料引用与对话。模型配置来自 web/.env.local；没有 API Key 时不会产生真实模型回答。\n",
);
const child = spawn(
  process.execPath,
  [
    bin,
    "--profile",
    "web",
    "--patch",
    patch,
    "--no-open",
    "--host",
    "127.0.0.1",
    "--port",
    "3089",
  ],
  {
    cwd,
    stdio: "inherit",
    env: { ...process.env, DSH_HOME: home, LEARNBUDDY_PREVIEW_WORKSPACE: cwd },
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
