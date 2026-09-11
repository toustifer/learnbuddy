# 验证脚本（人工执行，不参与 `npm test`）

这些脚本**不是**自动化测试（`npm test` 只跑 `test/*.test.js`，task-10 后共 147 个用例）。
它们需要真实外部依赖（本机 DSH / 大模型密钥），用于上线前/交付时的端到端取证。

## `verify-live-llm.mjs`（大模型接入层实盘验证）

```powershell
cd plugins/dsh-plugin-learnbuddy

# DeepSeek（默认 provider）
$env:LLM_API_KEY = "sk-****"          # 真实密钥，仅本进程可见
node scripts/verify-live-llm.mjs

# 智谱 GLM（旧部署回归）
$env:LLM_PROVIDER = "zhipu"; $env:ZHIPU_API_KEY = "****"
node scripts/verify-live-llm.mjs
```

做的事：从环境变量读密钥，直连供应商做 7 项断言：

| # | 场景 | 期望 |
| --- | --- | --- |
| 1 | 纯文本对话（`LLM_MODEL_TEXT`） | 200 且 `content` 非空 |
| 2 | 纯文本对话回显哨兵串 `PONG-7391` | `content` 含该串（证明链路真的通） |
| 3 | 图片理解（`LLM_MODEL_VISION`） | 200 且 `content` 非空 |
| 4 | 图片理解读出图中文字 `DEEPSEEK` | `content` 含该词（**OCR 级断言**） |
| 5 | 视觉/文本模型名均已解析 | 二者皆非空 |
| 6 | DeepSeek 预设默认 base | `https://api.deepseek.com` |
| 7 | 实际 base 未被意外篡改 | 是合法 http(s) URL |

**无密钥时会友好跳过并退出码 0**（打印 SKIP 与用法提示），不会报错、不会误判 CI。
**有失败项时退出码 1**，并打印 401 / 超时 / 视觉模型的排查提示。

验证图由 `scripts/lib/png-text.mjs`（零依赖，`node:zlib` 手写 PNG，5x7 点阵字体）
**现场生成**，不依赖任何外部素材；内容固定为 `DEEPSEEK`，因此可以对「模型是否读出了该文字」
做硬断言。该渲染器的正确性由 `test/png-text.test.js` 离线钉死（含 CRC、PNG chunk 结构、
编码/解码往返、字形结构断言）。

> 🔒 密钥纪律：脚本只从 `process.env` 读取密钥，绝不落盘；日志里只打印脱敏串（`sk-***er`）。

## `verify-live-dsh.mjs`

```powershell
cd plugins/dsh-plugin-learnbuddy
node scripts/verify-live-dsh.mjs
```

做的事：起两个**隔离端口**的真实网关实例（关闭注入 / 开启注入）代理到
真实 `127.0.0.1:3080`，用真实 `ws` 客户端与真实 HTTP 验证 12 条标准。
**所有浏览器场景都显式携带 `Host`/`Origin`/`Sec-Fetch-*`**（默认模拟公网
`129.204.52.57:3088`，可用 `PUBLIC_AUTHORITY` 覆盖），复刻真实浏览器行为：

| # | 场景 | 期望 |
| --- | --- | --- |
| 0 | 直连 DSH（不经网关）+ 公网 `Origin` | 403（`isTrustedApiRequest` 同源校验，根因） |
| 1 | 直连 DSH + `Origin` 与 Host 同源 | 非 403（401） |
| 2 | 直连 DSH 不带 `Origin` | 非 403（401） |
| 3 | 开关关闭 `GET /?learnbuddy=embedded` | 401（与现状一致） |
| 4 | 开关开启 `GET /?learnbuddy=embedded` + 公网 `Origin` | 200 + HTML |
| 5 | 开关开启 `GET /` + 公网 `Origin` | 200 |
| 6 | 开关关闭 `/api/remote.mux` WebSocket | 401 |
| 7 | 开关开启 `/api/remote.mux` WebSocket（不带 `Origin`） | 101 |
| 8 | 开关开启 `/api/remote.mux` WebSocket + 公网 `Origin` + `Sec-Fetch-Site` | 101（task-09 修复目标） |
| 9 | 开关开启 `/api/nonexistent` + 公网 `Origin` | 非 403（真实 DSH 回 404） |
| 10 | 开关关闭 `/api/remote.mux` + 公网 `Origin` | 403（未放宽成「都放行」） |
| 11 | 开关开启 `/api/learnbuddy/materials` + 公网 `Origin` | 200 `{ok:true}`（业务路由零回归） |

前置条件：

1. DSH 已在 `127.0.0.1:3080` 运行；
2. `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/`）含
   `records.client-connection/browser-session.payload.secret`；
3. 能加载到 `ws` 包：默认从 `C:/Users/15775/.npm-global/node_modules/@deepseek-ai/dsh/` 借，
   可用环境变量 `DSH_PACKAGE_ROOT` 覆盖（本插件刻意保持零依赖，不引入 `ws`）。

该脚本**不改动**线上 3088 端口的进程，只在自己起的临时端口上验证。

---

## `lib/png-text.mjs`（内部工具，供 `verify-live-llm.mjs` 使用）

零依赖的「文本 → PNG」渲染器：5x7 点阵字体 + `node:zlib` 手写 PNG 编码（灰度 8bit）。
引入它的原因：本插件刻意保持 **零运行时依赖**（`package.json` 的 `dependencies` 为空），
实盘验证脚本不应为了画一张验证图而引入 `canvas` / `sharp` 之类的原生依赖。

导出 `renderTextPng(text, scale)`、`renderTextBitmap`、`encodePng`、`decodeGrayscalePng`、`crc32`。
正确性由 `test/png-text.test.js` 覆盖（12 个用例）。
