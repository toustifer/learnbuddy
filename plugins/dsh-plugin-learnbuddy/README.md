# LearnBuddy DSH 插件使用与运维指南 (嘉俊专用版)

欢迎嘉俊！本插件目录 `plugins/dsh-plugin-learnbuddy` 是 LearnBuddy 系统的核心后端与智能体引擎插件。

---

## 插件结构一览

```text
plugins/dsh-plugin-learnbuddy/
├── package.json          # 插件依赖与元信息
├── src/
│   ├── index.js          # 插件入口，接入 DSH Cordis 生命周期 (apply)
│   ├── routes/
│   │   └── api.js        # HTTP/REST 路由实现（单入口登录、课件、答疑卡检索、AutoGrader 评分）
│   └── skills/
│       └── index.js      # 注册 DSH Skills (learnbuddy-companion / learnbuddy-autograder)
└── README.md
```

---

## 快速接入 DSH 步骤

### 方式 1：本地通过 DSH Profile 挂载加载（推荐）

在当前机器或远端测试服务器上，若 DSH 配置文件位于 `~/.dsh/profiles/web/` 或项目的 `cordis.patch.yml` 中：

1. 进入插件目录安装依赖（**含原生绑定，必须执行**，详见下一节）：
   ```bash
   cd plugins/dsh-plugin-learnbuddy
   npm ci          # 无 lockfile 时用 npm install
   ```

2. 在 DSH profile 目录下添加本本地插件：
   ```bash
   dsh plugin --profile web add "D:/obi/collected_program/经历/learnbuddy/plugins/dsh-plugin-learnbuddy"
   ```
   *或者在开发配置中直接引入 `plugins/dsh-plugin-learnbuddy`。*

3. 启动 DSH Web 实例：
   ```bash
   dsh web
   ```
   启动后控制台会输出：
   ```text
   [LearnBuddy Plugin] Initializing LearnBuddy DSH Plugin v0.1.0...
   [LearnBuddy Plugin] Skills registered successfully.
   [LearnBuddy Plugin] Web API routes mounted at /api/learnbuddy/*
   ```

---

## 课件真实解析（anydoc）：依赖安装、失败语义与内嵌图片

`src/services/material-parser.js` 从 **task-14 起用真实解析引擎** `@firecrawl/anydoc`
（Rust napi-rs 原生绑定）解析 PDF / DOCX / PPTX / XLSX / ODT·ODS·ODP / RTF / EPUB / CSV / DOC（含 .docm/.pptm 等容器变体）。

> ⚠️ task-14 之前，`_parsePdfBasic()` / `_parseOfficeDoc()` **根本不读文件**，直接返回写死的示例文字，
> 且 `catch` 分支把解析失败伪装成「解析成功」。那段假实现已删除，**不得恢复**。

### 依赖安装（原生绑定按平台分发）

| 平台 | 需要装上的可选依赖 |
| --- | --- |
| 服务器（Linux x64 glibc） | `@firecrawl/anydoc-linux-x64-gnu` |
| 本机（Windows x64） | `@firecrawl/anydoc-win32-x64-msvc` |
| macOS | `@firecrawl/anydoc-darwin-x64` / `-arm64` |

```bash
cd plugins/dsh-plugin-learnbuddy
npm ci            # 依赖 package-lock.json，按当前平台自动拉取对应 .node 绑定
# 无 lockfile 的旧部署：npm install @firecrawl/anydoc
node -e "import('@firecrawl/anydoc').then(m=>console.log(typeof m.toMarkdownBytes))"   # 应打印 function
```

若某个平台的可选依赖没装上（离线安装、镜像裁剪、`--no-optional`），代码会给出**可读错误**
（`errorCode:"engineUnavailable"` 并指出当前平台该装哪个包），**不会**让上传链路直接崩。

### 失败语义（禁止静默失败）

`parseAndExtract(filePath, originalName)` 签名与成功返回结构不变，失败时返回**显式失败标记**：

```json
{ "status": "failed", "errorCode": "malformed", "error": "文档解析失败 [malformed]：...",
  "knowledgePoints": [], "rawContentSummary": "", "pages": 0 }
```

| `errorCode` | 含义 |
| --- | --- |
| `malformed` | 结构损坏、提不出有意义内容 |
| `encrypted` | 加密 / 需要密码 |
| `unsupported` | 格式不支持（内容与扩展名都识别不出来） |
| `resourceLimit` | 越过解压 / 嵌套 / 节点数安全上限 |
| `missingPart` | 关键部件缺失 |
| `io` | 文件读不出来 |
| `needsOcr` | PDF 是扫描件/纯图片（错误信息里带具体页码；anydoc 不做 OCR） |
| `engineUnavailable` | anydoc 或当前平台原生绑定没装上 |

**失败时绝不调用 LLM 编造知识点**，`knowledgePoints` 恒为 `[]`；
上传接口会把 `parseStatus` / `parseError` / `parseErrorCode` 一并返回，材料状态记为 `pending`（不是 `ready`），
原件仍安全落盘、可在线预览。

> 注意区分两层降级：**解析层失败**一律如实报错（上表）；**模型层失败**（未配密钥 / 模型不可用）
> 仍走既有的标杆模板兜底（见上一节），因为正文此时已经真实解析出来了。

### 内嵌图片（真·多模态）

用 `toDocument()` 把文档里的图片资产（PPT 图表、文档截图）抽出来，与正文一起送**视觉模型**
（`LLM_MODEL_VISION=deepseek-flash`）。上限保护（硬需求）：

- 最多 `MAX_EMBEDDED_IMAGES = 4` 张；
- 单张不超过 `MAX_EMBEDDED_IMAGE_BYTES = 2MB`；
- 超限/非图片资产**跳过并计数**（`result.embeddedImages = { total, inlined, skipped }`）并记日志，不让解析失败。

PDF 的 Markdown 通道没有文档模型（`toDocument` 对 PDF 报 `unsupported`），故 PDF 目前只取正文。

### 回归测试（真实文件，不 mock 解析）

```bash
cd plugins/dsh-plugin-learnbuddy
npm test                       # 全量；task-14 基线 164 → 新增 14 个真解析用例
node --test test/material-parser-real.test.js
```

测试用的真实 PDF / DOCX / XLSX 字节由零依赖构造器
[`scripts/lib/doc-fixtures.mjs`](scripts/lib/doc-fixtures.mjs) 现场生成（与 `scripts/lib/png-text.mjs` 同一纪律），
断言的是「解析出来的内容 == 我们写进去的内容」，因此能真正证明是**真解析**而不是写死文字。

---

## 公网网关（server.js）运维说明

网关监听 `0.0.0.0:3088`，职责：托管 `/learnbuddy/*` 前端、处理 `/api/learnbuddy/*` 业务接口、
其余流量（HTTP + WebSocket）反向代理到 `127.0.0.1:3080`（DSH Web）。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3088` | 网关监听端口 |
| `DSH_PORT` | `3080` | DSH Web 端口（代理目标，同时决定注入 cookie 的 authority） |
| `DSH_HOST` | `127.0.0.1` | 代理目标主机 |
| `LEARNBUDDY_WEB_DIST` | `plugins/dsh-plugin-learnbuddy/web/dist` | 前端产物目录 |
| `LEARNBUDDY_DB_PATH` | `plugins/dsh-plugin-learnbuddy/data/learnbuddy.db` | SQLite 路径 |
| `LEARNBUDDY_DSH_SESSION_INJECT` | 未设置（关闭） | 设为 `1` 开启「为转发到 DSH 的请求注入会话凭据」 |
| `DSH_HOME` | `~/.dsh` | DSH home；注入器从这里读 `.credentials.yaml` |

---

## 大模型接入层（多供应商，DeepSeek 默认）

`src/services/llm.js` 是**环境变量驱动的多供应商多模态接入层**，默认接 **DeepSeek**，
同时完整保留 **智谱 GLM** 路径。切换供应商**只改环境变量，不改代码**。

### 环境变量清单

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LLM_PROVIDER` | `deepseek` | 供应商：`deepseek` \| `zhipu`。填非法值会告警并回落 `deepseek` |
| `LLM_API_KEY` | 空 | **通用密钥**（优先级最高）。DeepSeek 与智谱都用它 |
| `LLM_BASE_URL` | 见下方预设 | 覆盖 API 根地址（不要带 `/chat/completions`，代码会自己拼） |
| `LLM_MODEL_VISION` | 见下方预设 | **可读图**的视觉模型（课件图片解析、报告截图核验走这条） |
| `LLM_MODEL_TEXT` | 回落视觉模型 | 纯文本任务模型。不配就沿用视觉模型，保证旧部署零行为变化 |
| `LLM_TIMEOUT_MS` | `45000` | 单次请求超时（毫秒）。非法/非正值回落默认 |

供应商专属变量（**向后兼容**，老部署不改环境也能跑）：

| 变量 | 归属 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | DeepSeek | 等价于只给 DeepSeek 配密钥（不配 `LLM_PROVIDER` 时自动判定为 deepseek） |
| `DEEPSEEK_BASE_URL` | DeepSeek | 覆盖 DeepSeek 根地址 |
| `ZHIPU_API_KEY` / `GLM_API_KEY` | 智谱 | **只配这两个之一且未配 `LLM_API_KEY` 时，自动判定 `provider=zhipu`**（旧部署零改动） |
| `ZHIPU_BASE_URL` | 智谱 | 覆盖智谱根地址 |
| `GLM_MODEL` | 智谱 | 等价于旧版的视觉模型配置 |

### 供应商预设

| provider | base URL | 视觉模型 | 文本模型 |
| --- | --- | --- | --- |
| `deepseek` | `https://api.deepseek.com` | `deepseek-flash` | 未配置时回落 `deepseek-flash` |
| `zhipu` | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-flash` | 未配置时回落 `glm-4v-flash` |

> **模型选择要点（Leader 实测）**：DeepSeek 官方 `/models` 提供 `deepseek-flash` 与 `deepseek-v4-pro`。
> 其中 **`deepseek-flash` 可读图**（对图片中的英文文本可做到逐字识别），
> **`deepseek-v4-pro` 不支持图片**（同样请求返回空 content）。
> 因此 `LLM_MODEL_VISION` 必须指向可读图模型；若要给纯文本任务换更强模型，
> 只设 `LLM_MODEL_TEXT`（如 `deepseek-v4-pro`），**不要**去动 `LLM_MODEL_VISION`。

### ⚠️ 推理模型（Reasoning Model）必读：`reasoning_content` 与 max_tokens 陷阱

`deepseek-flash` / `deepseek-v4-pro` 是**推理模型**：它们**先把思维链写进 `message.reasoning_content`，
最终答案才写进 `message.content`**。实测响应形状：

```jsonc
{
  "choices": [{
    "message": {
      "content": "收到",                                        // ← 最终答案（**可能为空**）
      "reasoning_content": "The user is asking me to reply..." // ← 思维链
    },
    "finish_reason": "stop"          // token 被截断时是 "length"
  }],
  "usage": {
    "completion_tokens": 16,
    "completion_tokens_details": { "reasoning_tokens": 14 }     // ← 思考消耗可观测
  }
}
```

**核心陷阱：`max_tokens` 给小了，token 会被思考过程吃光，于是返回 `finish_reason="length"` +
`content=""`，但 HTTP 依然是 200、不报任何错**（静默空结果）。Leader 用真实密钥实测对照：

| 请求 | 结果 |
| --- | --- |
| `max_tokens: 20` | `content=""`、`finish_reason="length"`、输出全在 `reasoning_content` |
| `max_tokens: 800` | `content="收到"`、`finish_reason="stop"`、`completion_tokens=16` |
| 不传 `max_tokens` | `content="收到"`（走 API 默认，最安全） |

**max_tokens 建议值**：

| 场景 | 建议 | 说明 |
| --- | --- | --- |
| 业务代码（grader / material-parser / autograder-pipeline / 伴学答疑） | **不传 maxTokens** | 走 API 默认。这是生产链路的既有前提，**不要**给业务代码加 maxTokens |
| 必须显式指定时（如 `scripts/verify-live-llm.mjs`） | **>= 512**（脚本用 1024） | 见 `MIN_REASONING_MODEL_MAX_TOKENS` / `REASONING_SAFE_VERIFY_TOKENS` |

**空 content 不会被静默放过**：`llm.js` 判定为「推理 token 耗尽」（`finish_reason === "length"`，
或 `reasoning_tokens` 已达 `max_tokens`）时，返回 `ok:false` + `truncated:true` + `error` +
`diagnostics`（含 `finishReason` / `reasoningTokens` / `maxTokens` / `reasoningContentPreview`），
上层（AutoGrader / 课件解析 / 伴学答疑）据此走降级，**不会把空结果当成有效输出**。
`content` 非空时行为与旧版**完全一致**；无密钥时的 Mock 兜底路径也**完全不变**。

> **`LLM_MODEL_VISION` 必须用 `deepseek-flash`**（可读图）。运维陷阱：`deepseek-v4-pro` 读图时
> **静默返回空 content**（同样 200、不报错）。图片解析相关故障请先核对这个变量。
> 验证脚本 `scripts/verify-live-llm.mjs` 已不再使用 32/64 这类过小 token 值，
> 若模型仍返回空 content，脚本会把可辨识诊断原样打印出来。

多模态消息体为 OpenAI 风格（与 DeepSeek 实测一致）：

```jsonc
{
  "model": "deepseek-flash",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "请识别图中文字" },
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
    ]
  }],
  "response_format": { "type": "json_object" }   // 仅结构化抽取/评分任务带上
}
```

### 无密钥兜底（演示防翻车）

**未配置任何密钥时不会报错**：客户端进入 Mock 模式，返回结构合法的
`{ ok: true, content, mock: true }`（评分意图会返回可解析的 Rubric JSON），
`MaterialParser` 也会降级到内置标杆知识点模板。因此演示环境即使没配 key 也能完整走通流程。

> ⚠️ 该兜底**只覆盖模型层**：文件本身的解析失败（损坏 / 加密 / 不支持格式 / 扫描件）一律如实上报
> `status:"failed"`，不会用假正文伪装成成功 —— 见下方「课件真实解析（anydoc）」一节。

### 服务器上线：环境变量与重启命令

```powershell
# ── 1) 配置 DeepSeek（推荐，默认 provider）────────────────────────────
$env:LLM_PROVIDER      = "deepseek"                     # 可省略，默认就是 deepseek
$env:LLM_API_KEY       = "sk-************"              # 用户提供的 DeepSeek 官方密钥
$env:LLM_MODEL_VISION  = "deepseek-flash"               # 可读图模型（务必用这个）
# $env:LLM_MODEL_TEXT  = "deepseek-v4-pro"              # 可选：纯文本换更强模型
# $env:LLM_BASE_URL    = "https://api.deepseek.com"     # 可选，默认即此值
# $env:LLM_TIMEOUT_MS  = "45000"                        # 可选，默认 45s

# ── 2) 重启网关（环境变量是**进程级**的，改完必须重启才生效）─────────
# 按监听端口精确找到旧网关进程并结束（默认 3088；用 netstat 定位 pid）
$port = if ($env:PORT) { [int]$env:PORT } else { 3088 }
$pid3088 = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($pid3088) { Stop-Process -Id $pid3088 -Force; Write-Host "已结束旧网关 pid=$pid3088" }

# 用**同一份环境变量**重新拉起
node plugins/dsh-plugin-learnbuddy/server.js
# 启动日志应包含业务路由挂载信息：
#   [LearnBuddy Plugin] Web API routes mounted at /api/learnbuddy/*

# ── 3) 验证接入是否生效（用真实密钥，脚本自行生成图片做 OCR 断言）───
node plugins/dsh-plugin-learnbuddy/scripts/verify-live-llm.mjs
# 预期：7/7 项通过，退出码 0
# 若①/② 报「空 content 诊断」，按诊断里的 finish_reason / reasoning_tokens / max_tokens 排查：
#   finish_reason=length → max_tokens 不够（推理模型的思维链吃光了预算）
#   图片用例失败        → 先确认 LLM_MODEL_VISION=deepseek-flash（deepseek-v4-pro 读图会静默返回空）
```

> **回滚到智谱**：把 `LLM_PROVIDER` 设为 `zhipu` 并配 `ZHIPU_API_KEY` 即可；
> 或干脆**清空全部 `LLM_*` 变量、只保留 `ZHIPU_API_KEY`**——接入层会自动判定为智谱。
>
> **密钥安全**：代码只从 `process.env` 读取密钥，不落盘、不打日志（`describe()` 只输出脱敏串）。
> 仓库内（含测试）不得出现任何真实密钥，测试一律使用 `sk-test-placeholder` 之类的占位值。
> 若你选择用本地 `.env` 文件承载密钥，请确认它已被 `.gitignore` 覆盖（仓库根 `.gitignore` 已含 `.env` / `.env.local` / `.env.*.local`）。

### 内嵌助手 401 问题与开启方式

前端伴学助手 iframe 指向 `location.origin/?learnbuddy=embedded`，经网关转发到 DSH 时
会被 DSH 自身的浏览器会话鉴权拦下（401）。原因与机制见
[`docs/DSH-AUTH-REVERSE-ENGINEERING.md`](../../docs/DSH-AUTH-REVERSE-ENGINEERING.md)。

开启注入（**默认关闭**）：

```powershell
# 1) 确认 DSH 至少启动过一次，凭据文档里有 browser-session 签名密钥
Get-Content "$env:USERPROFILE\.dsh\.credentials.yaml"   # 需含 records.client-connection/browser-session

# 2) 设置开关后重启网关（进程环境变量，不是 .env）
$env:LEARNBUDDY_DSH_SESSION_INJECT = "1"
node plugins/dsh-plugin-learnbuddy/server.js
# 启动日志会打印：
#   [DSH SessionInject] ⚠️ 安全告警：已开启 DSH 会话注入 ...
```

> ⚠️ **安全边界**：开启后公网任意访问者都能以本机身份使用 DSH Web（含本机读写与命令执行能力）。
> 按用户当前决策先跑通效果，但**用完请立即关闭**；后续收紧方案（IP 白名单、单独受限 profile、
> 反向代理层加 Basic Auth 等）不在本任务范围。

开启时网关会把转发给 DSH 的 **`Host` 与 `Origin` 一起改写**成 `127.0.0.1:<DSH_PORT>`：
DSH 的 `/api` 与 WebSocket 在鉴权之前还有一道信任栅栏（`isTrustedApiRequest`），
要求「带 `Origin` 时必须与 Host 同源」。只改 Host 会让真实浏览器（`Origin: http://<公网地址>:3088`）
拿到 **403**。细节与实测对照见
[`docs/DSH-AUTH-REVERSE-ENGINEERING.md` §4.1](../../docs/DSH-AUTH-REVERSE-ENGINEERING.md)。

### 验收命令（服务器上执行）

```powershell
# 内嵌助手入口：开启后应为 200（不再是 401）
curl.exe -s -o NUL -w "%{http_code}`n" "http://127.0.0.1:3088/?learnbuddy=embedded"
# ⚠️ 必须带上浏览器真实会发的 Origin（Host/Origin 都要是公网 authority），
#    否则测的是一条浏览器根本不会走的路径（task-08 全绿却线上 403 的原因）
curl.exe -s -o NUL -w "%{http_code}`n" -H "Host: 129.204.52.57:3088" -H "Origin: http://129.204.52.57:3088" -H "Sec-Fetch-Site: same-origin" "http://129.204.52.57:3088/?learnbuddy=embedded"
# WebSocket 握手：带 Origin 时也应为 101（不带 Origin 时为 101 不算通过）
curl.exe -i -s -N -H "Host: 129.204.52.57:3088" -H "Origin: http://129.204.52.57:3088" -H "Sec-Fetch-Site: same-origin" -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" "http://129.204.52.57:3088/api/remote.mux" | Select-String "HTTP/"
# /api/* 带 Origin 不得再 403（真实 DSH 对未知路由回 404）
curl.exe -s -o NUL -w "%{http_code}`n" -H "Host: 129.204.52.57:3088" -H "Origin: http://129.204.52.57:3088" "http://129.204.52.57:3088/api/nonexistent"
# 静态托管与业务接口回归
curl.exe -s -o NUL -w "%{http_code}`n" "http://127.0.0.1:3088/learnbuddy/"
curl.exe -s "http://127.0.0.1:3088/api/learnbuddy/materials" | Select-Object -First 1
```

---

## 接口速查（直接提供给黄山联调前端 Demo）

所有接口默认支持跨域（CORS），黄山本地无论是 Vite、Webpack 还是直接页面访问均可畅通调用：

### 1. 单入口登录接口
- **URL**: `POST /api/learnbuddy/auth/login`
- **Request Body**:
  ```json
  { "username": "user", "password": "123" }
  ```
- **Response**:
  ```json
  {
    "ok": true,
    "token": "mock-token-learnbuddy-user-123",
    "user": { "username": "user", "name": "学习者/助教测试账户", "role": "user" }
  }
  ```

### 2. 课件列表接口
- **URL**: `GET /api/learnbuddy/materials`
- **Response**:
  ```json
  {
    "ok": true,
    "materials": [
      {
        "id": "mat-cs101-01",
        "title": "实验一：Wireshark抓包与TCP三次握手分析.pdf",
        "size": "2.4 MB",
        "uploadedAt": "2026-09-08 14:30",
        "status": "parsed",
        "keyPointsCount": 4,
        "pages": 12
      }
    ]
  }
  ```

### 3. 伴学提问接口（内置答疑卡极速响应）
- **URL**: `POST /api/learnbuddy/qa/ask`
- **Request Body**:
  ```json
  { "question": "抓包出现红色 TCP RST 是怎么回事？" }
  ```
- **Response**（命中教师预设答疑卡，0延迟，0幻觉）：
  ```json
  {
    "ok": true,
    "source": "teacher_card",
    "cardId": "card-001",
    "title": "抓包中出现红色 TCP RST 的常见排查",
    "answer": "抓包中看到红色的 RST 通常表示目标端口未开启监听，或服务端主动拒绝/重置连接..."
  }
  ```

### 4. AutoGrader 实验报告评分接口
- **URL**: `POST /api/learnbuddy/grader/submit`
- **Request Body**:
  ```json
  { "reportTitle": "计算机网络实验一报告.pdf" }
  ```
- **Response**:
  ```json
  {
    "ok": true,
    "totalScore": 92,
    "maxScore": 100,
    "summaryReview": "报告格式规范，TCP 三次握手 Wireshark 抓包截图清晰...",
    "rubricChecks": [
      { "item": "实验拓扑与网络环境描述", "score": 10, "max": 10, "status": "pass" },
      { "item": "Wireshark 抓包截图与过滤语法", "score": 12, "max": 20, "status": "warning" },
      { "item": "三次握手报文序号与时序图分析", "score": 40, "max": 40, "status": "pass" },
      { "item": "网络异常/连接重置案例诊断", "score": 30, "max": 30, "status": "pass" }
    ]
  }
  ```
