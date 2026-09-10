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
const patch = path.join(preview, "learnbuddy.patch.yml");
await writeFile(
  patch,
  JSON.stringify(
    [
      {
        insert: [
          { id: "learnbuddy-ui", name: path.join(webRoot, "dsh-ui/host.js") },
        ],
      },
    ],
    null,
    2,
  ),
);
await writeFile(
  path.join(cwd, "README.md"),
  "# LearnBuddy 本地 DSH 界面预览\n\n这里只用于验证界面、资料引用和原生会话，未配置模型。\n",
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
