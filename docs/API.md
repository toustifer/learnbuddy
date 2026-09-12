# LearnBuddy 后端接口文档（面向前端联调）

> **本文覆盖 23 个业务端点**（另含 1 个 CORS 预检处理器 `OPTIONS /api/learnbuddy/*`）。
> 其中 **18 个为 task-16 实测版本**，**5 个为 task-17 补齐的课程/作业/提交域端点**（⑲–㉓，见 [§3.7](#37-课程--作业--提交域task-17-新增)）。
> 端点真源：`plugins/dsh-plugin-learnbuddy/src/routes/api.js`（版本 `cf0220f` + task-17 增量）。
> 所有响应示例均来自**实测**；task-16 的 18 个端点实测于公网服务，task-17 新增的 5 个端点实测于本仓 `test/missing-endpoints.test.js` 的真实运行（本地 in-memory SQLite + 种子数据，与生产同一套路由代码）。

| 项目 | 值 |
| --- | --- |
| 服务地址 | `http://129.204.52.57:3088` |
| 业务路由前缀 | `/api/learnbuddy` |
| 前端静态入口 | `http://129.204.52.57:3088/learnbuddy/` |
| 实测时间 | 2026-09-11 18:04–18:08 (UTC)；task-17 5 个端点：2026-09-12 本地实测 |
| 实测方式 | `curl.exe` 直连公网地址（task-16）；`node --test` 真实 HTTP 链路（task-17） |
| 代码版本 | `cf0220f` (branch `feat/api-docs`) + task-17 `feat/missing-endpoints` |

> 🆕 **task-17 增量（2026-09-12）**：补齐 5 个 P0 端点 —— `GET /courses`、`GET /assignments`、
> `GET /submissions`、`GET /submissions/:id`、`POST /submissions`。
> 它们修复了两个阻塞项：① 前端拿不到课程/作业/提交列表，评阅主线无法从 UI 走通；
> ② 🔴 「未发布报告的 `grades` / `summary` 对学生置空」这条安全红线此前**无端点可达**（`store.getSubmissions()` 已实现但无路由调用），现已通过 ㉑/㉒ 真正生效。
> **本域 5 个端点 `userId` 一律必填（缺失 400）**，不会重蹈 `GET /materials` 无参返回全库（含 `private`）的越权覆辙。
> 无 schema 变更 —— 服务器部署只需重启（无需数据迁移）。

---

## ⚠️ 联调前必读（3 条结论）

**1. 当前服务未强制鉴权。** `POST /auth/login` 会返回 `token`，但**没有任何其他端点读取或校验它**。带伪造的 `Authorization: Bearer bogus-token-xyz` 与不带该头，返回完全一致（已实测）。因此前端**不要**把 token 当成访问前提。

**2. 登录接口对数据库内用户不校验密码。** 只要用户名存在，**任意密码**都返回 200 + 有效 token（已实测：`student.lin` 配错误密码仍登录成功）。只有兜底测试账号 `user` / `admin` 才会校验密码。

**3. 真实大模型当前未生效，两个 AI 端点正在「静默降级」。** 实测 `POST /grader/submit` 返回的是 `grader.js` 里**硬编码的兜底常量**，`POST /qa/ask` 返回的是**兜底话术**——不是模型产出。详见[第 7 节](#7-实测记录与代码不符之处)。**前端务必按第 7 节做兜底识别，否则会把假数据当真实 AI 结果展示。**

---

## 目录

- [1. 快速开始](#1-快速开始)
- [2. 通用约定](#2-通用约定)
  - [2.1 CORS](#21-cors)
  - [2.2 认证语义](#22-认证语义)
  - [2.3 错误格式与状态码](#23-错误格式与状态码)
- [3. 端点详解](#3-端点详解)
  - [3.1 认证域](#31-认证域)
  - [3.2 课件与资料域](#32-课件与资料域)
  - [3.3 文件预览与下载域](#33-文件预览与下载域)
  - [3.4 伴学答疑域](#34-伴学答疑域)
  - [3.5 评阅域（AutoGrader）](#35-评阅域autograder)
  - [3.6 学情分析域](#36-学情分析域)
  - [3.7 课程 / 作业 / 提交域（task-17 新增）](#37-课程--作业--提交域task-17-新增)
- [4. 权限与业务规则（评分点）](#4-权限与业务规则评分点)
- [5. 评阅状态机](#5-评阅状态机)
- [6. 前端接入建议](#6-前端接入建议)
- [7. 实测记录与代码不符之处](#7-实测记录与代码不符之处)

---

## 1. 快速开始

### 1.1 最小连通性验证

```bash
# 1) 拉课件列表（无需登录、无需任何 Header）
curl.exe -s "http://129.204.52.57:3088/api/learnbuddy/materials"

# 2) 登录拿测试账号
curl.exe -s -X POST "http://129.204.52.57:3088/api/learnbuddy/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"user\",\"password\":\"123\"}"
```

### 1.2 可复制 curl 合集

```bash
BASE=http://129.204.52.57:3088/api/learnbuddy
JSON="Content-Type: application/json"

# ── 认证 ──────────────────────────────────────────────
curl.exe -s -X POST "$BASE/auth/login" -H "$JSON" \
  -d '{"username":"user","password":"123"}'

curl.exe -s -X POST "$BASE/auth/login" -H "$JSON" \
  -d '{"username":"teacher.chen","password":"123"}'

curl.exe -s -X POST "$BASE/auth/login" -H "$JSON" \
  -d '{"username":"student.lin","password":"123"}'

# ── 课件与资料 ────────────────────────────────────────
curl.exe -s "$BASE/materials"                              # 全部（含私有，见 §4.3）
curl.exe -s "$BASE/materials?userId=s-yi"                  # 按学生视角过滤（推荐）
curl.exe -s "$BASE/materials?courseId=network"             # 按课程过滤（不过滤私有）
curl.exe -s "$BASE/materials/mat-tcp/context"              # 课件多模态上下文快照
curl.exe -s "$BASE/materials/mat-net-teach/context?userId=s-yi"   # 私有课件 → 404

# ── 文件预览与下载 ────────────────────────────────────
curl.exe -s -I "$BASE/files/<blobId>/view"
curl.exe -s -I "$BASE/files/<blobId>/download"

# ── 课程 / 作业 / 提交（task-17 新增，⚠️ userId 必填）──────
curl.exe -s "$BASE/courses?userId=s-yi"                            # 学生：已选课程
curl.exe -s "$BASE/courses?userId=t-chen"                          # 教师：所授课程
curl.exe -s "$BASE/assignments?userId=s-yi&courseId=network"       # 作业列表（学生仅见已发布）
curl.exe -s "$BASE/submissions?userId=s-xu&assignmentId=lab-os"    # 提交列表（学生：成绩置空）
curl.exe -s "$BASE/submissions?userId=t-chen&assignmentId=lab-os"  # 提交列表（教师：完整成绩）
curl.exe -s "$BASE/submissions/sub-xu-os?userId=t-chen"            # 单份提交详情
curl.exe -s -X POST "$BASE/submissions" -H "$JSON" \
  -d '{"studentId":"s-yi","assignmentId":"lab-tcp","fileName":"报告.pdf","encoding":"base64","content":"JVBERi0xLjQKJUVPRgo="}'

# ── 伴学答疑 ──────────────────────────────────────────
curl.exe -s -X POST "$BASE/qa/cards/search" -H "$JSON" \
  -d '{"courseId":"network","query":"三次握手"}'
curl.exe -s -X POST "$BASE/qa/ask" -H "$JSON" \
  -d '{"question":"为什么SYN报文会消耗一个序列号？","courseId":"network","userId":"s-yi"}'
curl.exe -s -X POST "$BASE/dsh/session-context" -H "$JSON" \
  -d '{"materialId":"mat-tcp"}'
curl.exe -s -X POST "$BASE/dsh/quote" -H "$JSON" \
  -d '{"materialId":"mat-tcp","page":2}'

# ── 评阅（⚠️ 会改数据库状态，联调时慎用）────────────────
curl.exe -s -X POST "$BASE/grader/grade-submission" -H "$JSON" \
  -d '{"submissionId":"sub-zhou-net"}'
curl.exe -s -X POST "$BASE/grader/batch" -H "$JSON" \
  -d '{"assignmentId":"lab-tcp","concurrency":2}'

# ── 学情（只读，skipLLM=1 免模型调用）──────────────────
curl.exe -s "$BASE/analytics/assignment/lab-tcp?skipLLM=1"
curl.exe -s "$BASE/analytics/course/network?skipLLM=1"
```

### 1.3 可用测试账号

| 用户名 | 密码 | 角色 | userId | 说明 |
| --- | --- | --- | --- | --- |
| `user` | `123` | `teacher` | `user-demo` | 兜底测试账号，**唯一会校验密码的账号** |
| `admin` | 任意 | `teacher` | `user-demo` | 兜底分支，任意密码均可 |
| `teacher.chen` | `123` | `teacher` | `t-chen` | 陈知行，执教 `network` / `os` / `cs101` |
| `teacher.lin` | `123` | `teacher` | `t-lin` | 执教 `database` |
| `student.lin` | `123` | `student` | `s-yi` | 林一，选修 `network` / `os` / `cs101` |
| `student.zhou` | `123` | `student` | `s-zhou` | 周可 |
| `student.xu` | `123` | `student` | `s-xu` | 许然 |

> ⚠️ 除 `user` / `admin` 外，密码**不参与校验**（见 [§2.2](#22-认证语义)）。

### 1.4 演示数据 ID 速查

前端做联调时可直接用这些 ID。

| 类型 | ID | 说明 |
| --- | --- | --- |
| 课程 | `network` / `os` / `database` / `cs101` | 计算机网络 / 操作系统 / 数据库原理 / 计算机科学导论 |
| 作业 | `lab-tcp`（network）/ `lab-os`（os）/ `lab-db`（database） | 均已 `published: true` |
| 提交 | `sub-zhou-net` | `submitted`（可评阅） |
| 提交 | `sub-xu-net` | `submitted`（可评阅） |
| 提交 | `sub-xu-os` | `review`（待教师发布） |
| 提交 | `sub-yi-os` | `published`（已发布，不可重复评阅） |
| 提交 | `sub-zhou-db` | `published`（database 课，教师为 `t-lin`） |
| 课件（公开） | `mat-tcp` | 第三章 · TCP 可靠传输（首选上下文样例） |
| 课件（私有） | `mat-net-teach` | owner `t-chen`，`visibility: private` |

---

## 2. 通用约定

### 2.1 CORS

CORS 已**全量放开**（`Access-Control-Allow-Origin: *`），前端本地 `Vite` / `Webpack` / 直接页面访问均可直接调用，**无需代理**。

实测 `OPTIONS` 预检响应：

```http
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-File-Name
```

实测 JSON 端点响应头：

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-File-Name
```

说明：
- 预检仅对 `pathname.startsWith("/api/learnbuddy")` 生效（`api.js:253`）。
- 静态前端 `/learnbuddy/*` 同样带 `Access-Control-Allow-Origin: *`。
- → **`Origin` 无论取何值都会被放行**（无来源白名单）。

### 2.2 认证语义

**必须如实理解当前实现，不要假设存在 Bearer 鉴权。**

| 问题 | 实测结论 |
| --- | --- |
| `POST /auth/login` 返回什么？ | `{ ok, token, user }`，`token` 形如 `token-<userId>-<timestamp>` 或兜底串 `mock-token-learnbuddy-user-123` |
| 其它接口校验 token 吗？ | **不校验**。全仓无任何路由读取 `Authorization` 头（`api.js` 仅用到 `content-type`、`x-file-name`；`server.js` 的反代凭据注入另有开关，与本业务 API 无关） |
| 带伪造 token 会怎样？ | 与不带**完全一致**（实测 `GET /materials?courseId=network`、`POST /qa/cards/search` 均返回 200 同一响应） |
| 不带 token 会怎样？ | 正常返回，不返回 401 |

> 🔎 **已知安全缺口**：登录对数据库用户**不校验密码**（`api.js:270-277`）——先按用户名查库，命中即签发 token，`password` 字段被完全忽略。实测 `{"username":"student.lin","password":"totally-wrong"}` → HTTP 200 + 有效 token。**上生产前必须修复。**

### 2.3 错误格式与状态码

成功：`{"ok": true, ...}`；失败：`{"ok": false, "error": "<中文原因>"}`。

| 状态码 | 触发条件 |
| --- | --- |
| `200` | 成功。⚠️ 注意 `POST /qa/ask` **异常时也返回 200**（降级答案），必须看 `fallback` 字段 |
| `204` | CORS 预检成功 |
| `400` | 缺少必填参数、参数类型错误、文件格式/大小不合法、状态机不允许、评分项缺项 |
| `401` | **仅** `POST /auth/login` 用户名+密码都不匹配兜底账号时 |
| `403` | 角色/课程权限不足：`review-publish`（非教师、非执教教师）、**`GET /assignments` / `GET /submissions` / `GET /submissions/:id` / `POST /submissions`（跨课程、非学生提交、未发布作业提交、看他人提交）** |
| `404` | 资源不存在，或存在但当前用户无权访问（课件上下文）；**新增：用户/课程/作业/提交记录不存在** |
| `500` | 文件读流异常（`files/:id/view|download`） |
| `502` | 网关层：DSH 上游未启动（非业务端点） |

⚠️ **未匹配的 `/api/learnbuddy/*` 路径不会返回 JSON**：会穿透到反向代理，由 DSH 上游回**纯文本** `404 not found`（实测 `GET /api/learnbuddy/unknown`）。方法不匹配同理（实测 `GET /auth/login`、`GET /qa/ask` → `404 not found` 纯文本）。

---

## 3. 端点详解

### 3.1 认证域

#### ① `POST /api/learnbuddy/auth/login`

**用途**：单入口登录，返回用户身份与 token。

**请求 Body**（`application/json`）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `username` | string | 是 | 用户名。存在于 SQLite `users` 表即视为成功 |
| `password` | string | 否 | **仅对兜底账号 `user` 生效**；数据库用户忽略此字段 |

**实测请求/响应（成功，兜底账号）**

```bash
curl.exe -s -X POST "http://129.204.52.57:3088/api/learnbuddy/auth/login" \
  -H "Content-Type: application/json" -d '{"username":"user","password":"123"}'
```

```json
{
  "ok": true,
  "token": "mock-token-learnbuddy-user-123",
  "user": {
    "id": "user-demo",
    "username": "user",
    "name": "学习者/助教测试账户",
    "role": "teacher"
  }
}
```

> ⚠️ 注意 `role` 实测为 **`"teacher"`**，而仓内 `README.md:363` 与 `docs/FRONTEND_DEVELOPMENT_GUIDE.md` 写作 `"user"`——**以本文为准**。

**实测（数据库用户，忽略密码）**

```bash
curl.exe -s -X POST ".../auth/login" -H "Content-Type: application/json" \
  -d '{"username":"student.lin","password":"totally-wrong"}'
```

```json
{
  "ok": true,
  "token": "token-s-yi-1789149859961",
  "user": { "id": "s-yi", "username": "student.lin", "name": "林一", "role": "student", "initials": "林" }
}
```

**实测（失败）**

```json
{
  "ok": false,
  "error": "用户名或密码错误，可使用默认测试凭据 user / 123 或教师账户 teacher.chen"
}
```

| 状态码 | 场景 |
| --- | --- |
| `200` | 用户名命中数据库，或 `user`+`123`，或 `admin`（任意密码） |
| `401` | 用户名不在库且非兜底账号 |

---

### 3.2 课件与资料域

#### ② `GET /api/learnbuddy/materials`

**用途**：查询课件列表（课件元数据 + 已抽取知识点）。

**Query 参数**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `userId` | string | 否 | 传入后**按用户权限过滤**（本课程公开资料 + 本人私有资料 + 本人已选课程） |
| `courseId` | string | 否 | 按课程过滤 |

**三种调用语义（均可同时传，`userId` 优先）**

| 调用 | 行为 |
| --- | --- |
| `?userId=xxx` | 走权限过滤；顺带限定该用户已选/所授课程 |
| `?userId=xxx&courseId=yyy` | 权限过滤 + 课程过滤（**推荐**） |
| 仅 `?courseId=yyy` | 只按课程字段过滤，**不做可见性过滤 → 会返回 `private` 资料** |
| 都不传 | 返回全库全部资料，**含 `private`** |
| `?userId=不存在的ID` | 返回 `{"ok":true,"materials":[]}`（**不报错**） |

**实测响应**（真实数据，节选 1 条 + 已省略项）

```json
{
  "ok": true,
  "materials": [
    {
      "id": "mat-tcp",
      "courseId": "network",
      "ownerId": "t-chen",
      "title": "第三章 · TCP 可靠传输",
      "kind": "PDF",
      "visibility": "course",
      "status": "ready",
      "size": "2.4 MB",
      "pages": 3,
      "date": "2026-09-10",
      "knowledge": [
        {
          "id": "handshake-kp-0",
          "title": "从一次握手开始，理解可靠传输",
          "summary": "TCP 三次握手的目的，是让通信双方确认彼此的发送与接收能力，并同步初始序列号。",
          "page": 1
        }
      ],
      "cards": [
        {
          "id": "qa-syn",
          "question": "为什么 SYN 报文会消耗一个序列号？",
          "keywords": "SYN,消耗,序列号",
          "answer": "SYN 是需要被可靠确认的控制信息，因此占用一个序列号。对端收到 seq=x 的 SYN 后，用 ack=x+1 表示已经收到它。纯 ACK 不额外消耗序列号。",
          "confirmed": true
        }
      ]
    }
  ]
}
```

**响应字段说明**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `materials[].id` | string | 课件 ID |
| `materials[].courseId` | string | 所属课程 |
| `materials[].ownerId` | string | 上传者 userId |
| `materials[].title` | string | 课件标题（= 上传文件名） |
| `materials[].kind` | string | `PDF` / `PPTX` / `DOCX` / `PNG` … |
| `materials[].visibility` | string | `course`（课程公开）或 `private`（仅本人） |
| `materials[].status` | string | `ready`（解析成功）或 `pending`（解析失败/未完成） |
| `materials[].size` | string | 人类可读大小，如 `"2.4 MB"` |
| `materials[].pages` | number | 页数 |
| `materials[].date` | string | `YYYY-MM-DD` |
| `materials[].blobId` | string | **文件名**，用于拼 `files/:id/view|download`；上传生成的课件才有 |
| `materials[].knowledge` | array | 知识点列表（`status: pending` 时为空数组） |
| `materials[].cards` | array | 教师答疑卡 |

**实测数据盘点**（快照时间 2026-09-11 18:08 UTC，共 10 条）

> ⚠️ 服务与其它联调者**共用同一数据库**，条数会随并发上传变化；下表为实测时刻的快照，ID 稳定、条数可能增长。

| materialId | visibility | status | 标题 |
| --- | --- | --- | --- |
| `mat-tcp` | `course` | `ready` | 第三章 · TCP 可靠传输 |
| `mat-wire` | `course` | `ready` | Wireshark 抓包实验指导 |
| `mat-os` | `course` | `ready` | 第五章 · 进程同步与互斥 |
| `mat-db` | `course` | `ready` | 第六章 · 索引与查询优化（owner `t-lin`） |
| `mat-net-teach` | **`private`** | `ready` | 传输层课堂讲解提纲 |
| `mat-1789147718790-pqmi` | `course` | `ready` | UDP校验和实验指导书.pdf |
| `mat-1789062084015-n8zk` | `course` | `ready` | 真实网络实验报告原件.pdf |
| `mat-1789147732770-t1lw` | `course` | **`pending`** | 损坏的文件.pdf |
| `mat-1789147743962-dyc6` | `course` | **`pending`** | 第二个损坏文件.pdf |
| `mat-1789150155329-b4c6` | `course` | **`pending`** | 验证用损坏文件.pdf |

> 三条 `pending` 是 task-14「解析失败不得静默伪装」的实测证据：原件**已落盘可预览**，但 `knowledge` 为空数组、状态记为 `pending`，未伪造知识点。

**可见性实测对照**

| 请求 | 返回私有资料 `mat-net-teach`？ |
| --- | --- |
| `/materials?userId=s-yi`（学生） | ❌ 否（正确隔离） |
| `/materials?userId=t-chen`（owner） | ✅ 是（正确） |
| `/materials`（无参） | ⚠️ **是（泄漏）** |
| `/materials?courseId=network` | ⚠️ **是（泄漏）** |

| 状态码 | 场景 |
| --- | --- |
| `200` | 总是 200；无匹配数据时 `materials: []` |

---

#### ③ `GET /api/learnbuddy/materials/:id/context`

**用途**：获取课件的**多模态结构化上下文快照**（逐页正文 + 图表清单 + 知识点），是给 AI/助手注入背景的核心数据源。

**Path 参数**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `:id` | string | 是 | 课件 ID（`materialId`），需 URL 编码 |

**Query 参数**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `userId` | string | 否 | 传入后校验可见性；**不传则不做权限校验** |

**实测响应**（`GET /materials/mat-tcp/context`，节选）

```json
{
  "ok": true,
  "context": {
    "materialId": "mat-tcp",
    "id": "mat-tcp",
    "title": "第三章 · TCP 可靠传输",
    "courseId": "network",
    "courseName": "计算机网络",
    "courseCode": "CS 203",
    "kind": "PDF",
    "size": "2.4 MB",
    "pages": 3,
    "visibility": "course",
    "status": "ready",
    "date": "2026-09-10",
    "sampleKey": "handshake",
    "sections": [
      {
        "page": 1,
        "chapter": "第1节：TCP 协议连接概览与报文封装结构",
        "content": "TCP（传输控制协议）是面向连接的、可靠的传输层通信协议。TCP 报文段由 20 字节固定头部与数据字段组成。……",
        "diagrams": [
          {
            "id": "fig-tcp-1",
            "title": "TCP 报文首部格式与关键控制标志位展开",
            "caption": "Figure 1-1: TCP Header 结构与 Flags 控制位定义",
            "type": "diagram",
            "description": "展示 TCP 头部 20 字节固定结构，重点高亮 32 位 Sequence Number、32 位 Acknowledgment Number 与 SYN/ACK/RST 控制位。",
            "page": 1
          }
        ]
      }
    ]
  }
}
```

**实测响应顶层字段**（`context` 对象的完整键集）

`materialId`、`id`、`title`、`courseId`、`courseName`、`courseCode`、`kind`、`size`、`pages`、`visibility`、`status`、`date`、`sampleKey`、`sections`、`pageContents`、`diagrams`、`figures`、`knowledgePoints`、`cardsCount`、`confirmedCardsCount`、`confirmedCards`

其中 `sections[]` 的键为 `page`、`chapter`、`content`、`diagrams`；`diagrams[]` 的键为 `id`、`title`、`caption`、`type`、`description`、`page`。

**错误响应**

| 状态码 | 场景 | 实测响应 |
| --- | --- | --- |
| `404` | 课件不存在，**或**存在但无权限 | `{"ok":false,"error":"未找到指定课件或当前用户无权访问"}` |

> 🔒 **权限隔离实测**：`GET /materials/mat-net-teach/context?userId=s-yi` → `404`（私有课件对学生）；`?userId=t-chen`（owner）→ `200`。**注意「无权」与「不存在」返回同一响应**，前端无法区分——这是刻意设计（不泄漏资源存在性）。

---

#### ④ `POST /api/learnbuddy/materials/upload`

**用途**：上传课件原件，落盘 + 立即抽取知识点 + 入库。

> ⚠️ **成功路径未实测**（会产生数据库记录且无删除端点，为避免污染演示数据已跳过）。以下请求/响应字段依据 `api.js:347-455` 代码推导。

**三种请求形态，按 `Content-Type` 自动分流：**

**形态 A：`multipart/form-data`（推荐）**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file`（任意带 `filename` 的字段） | file | 是 | 仅取**最后一个**带 `filename` 的 part |
| `courseId` | string | 否 | 默认 `network` |
| `ownerId` | string | 否 | 默认 `t-chen` |
| `visibility` | string | 否 | 默认 `course` |

**形态 B：`application/json`**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `fileName` | string | 否 | 默认 `新建实验指导书.pdf`；也可用 `title` |
| `courseId` / `ownerId` / `visibility` | string | 否 | 同上 |
| `content` / `fileData` / `buffer` | string | 否 | 文件内容；`encoding: "base64"` 或值为 `data:` 开头时按 base64 解码 |
| `encoding` | string | 否 | 传 `"base64"` 启用 base64 解码 |

> 若三者都不传内容，会**写入一个占位 PDF**（`%PDF-1.4 ... %%EOF`）——**仍会创建课件记录**。

**形态 C：二进制直传**

| 位置 | 字段 | 说明 |
| --- | --- | --- |
| Header | `X-File-Name` | 文件名（URL 编码，服务端 `decodeURIComponent`） |
| Query | `filename` | 备用文件名，默认 `uploaded.pdf` |

**校验规则**

| 规则 | 值 | 违反时 |
| --- | --- | --- |
| 扩展名白名单 | `.pdf` `.ppt` `.pptx` `.docx` `.png` `.jpg` `.jpeg` | `400` |
| 单文件大小上限 | 20 MB | `400` |

**实测错误响应（未落盘，安全）**

```bash
curl.exe -s -X POST ".../materials/upload" -H "Content-Type: application/json" \
  -d '{"fileName":"malware.exe"}'
```

```json
{
  "ok": false,
  "error": "不支持的文件格式: \".exe\"。仅支持白名单格式: .pdf, .ppt, .pptx, .docx, .png, .jpg, .jpeg"
}
```

```json
{
  "ok": false,
  "error": "不支持的文件格式: \"无后缀\"。仅支持白名单格式: .pdf, .ppt, .pptx, .docx, .png, .jpg, .jpeg"
}
```

**成功响应形状**（⚠️ 未实测，据代码推导）

```json
{
  "ok": true,
  "material": { "id": "mat-<ts>-<rand>", "courseId": "network", "ownerId": "t-chen",
                "title": "xxx.pdf", "kind": "PDF", "visibility": "course",
                "status": "ready", "size": "584 B", "pages": 1, "date": "2026-09-11",
                "blobId": "<hash>.pdf", "knowledge": [], "cards": [] },
  "parseStatus": "parsed",
  "parseError": null,
  "parseErrorCode": null,
  "file": {
    "id": "<hash>.pdf", "name": "xxx.pdf", "size": 584, "sizeFormatted": "584 B",
    "hash": "<sha256>",
    "viewUrl": "/api/learnbuddy/files/<hash>.pdf/view",
    "downloadUrl": "/api/learnbuddy/files/<hash>.pdf/download"
  }
}
```

**解析失败契约**（task-14）

原件**已落盘可预览**，但 `material.status` 记为 `"pending"`、`knowledge` 为 `[]`，**绝不伪装 `ready`**。失败通过三个字段如实透出：

| 字段 | 说明 |
| --- | --- |
| `parseStatus` | `"parsed"` 或 `"failed"` |
| `parseError` | 人类可读错误，如 `文档解析失败 [malformed]：…` |
| `parseErrorCode` | `malformed` / `encrypted` / `unsupported` / … |

实测旁证：演示库中「损坏的文件.pdf」「第二个损坏文件.pdf」两条均为 `status: pending` + `knowledge: []`。

| 状态码 | 场景 |
| --- | --- |
| `200` | 上传成功（解析可能 failed，但仍是 200） |
| `400` | 缺 multipart boundary、未包含文件字段、格式不在白名单、超过 20MB、未捕获异常 |

---

### 3.3 文件预览与下载域

#### ⑤ `GET /api/learnbuddy/files/:id/view`

**用途**：内联预览原始文件（浏览器 PDF 阅读器 / 图片直显）。

**Path 参数**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `:id` | string | 是 | 存储 `fileId`，即课件里的 `blobId`（形如 `<sha256>.pdf`） |

**实测请求**

```bash
curl.exe -s -I "http://129.204.52.57:3088/api/learnbuddy/files/1b21cc42…c68.pdf/view"
```

```http
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Disposition: inline; filename="UDP%E6%A0%A1%E9%AA%8C%E5%92%8C%E5%AE%9E%E9%AA%8C%E6%8C%87%E5%AF%BC%E4%B9%A6.pdf"
Content-Length: 584
Access-Control-Allow-Origin: *
Cache-Control: public, max-age=86400
```

响应体为**文件原始二进制**（实测首字节 `%PDF-1.4`），非 JSON。

> `Content-Disposition` 的 `filename` 是 **URL 编码**的；前端若需显示原始中文名，用 `decodeURIComponent()` 解码，或直接取课件对象的 `title`。

| 状态码 | 场景 | 响应体 |
| --- | --- | --- |
| `200` | 成功 | 文件二进制 |
| `404` | 文件不存在 | `{"ok":false,"error":"文件不存在或已被删除"}` |
| `500` | 读流异常 | `{"ok":false,"error":"..."}` |

---

#### ⑥ `GET /api/learnbuddy/files/:id/download`

**用途**：以附件形式下载原始文件。

**Path 参数**：同 ⑤。

**Query 参数**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 否 | 下载文件名兜底值（仅当元数据缺失时生效） |

**实测响应头**

```http
HTTP/1.1 200 OK
Content-Type: application/octet-stream
Content-Disposition: attachment; filename="UDP%E6%A0%A1%E9%AA%8C%E5%92%8C%E5%AE%9E%E9%AA%8C%E6%8C%87%E5%AF%BC%E4%B9%A6.pdf"; filename*=UTF-8''UDP%E6%A0%A1%E9%AA%8C%E5%92%8C%E5%AE%9E%E9%AA%8C%E6%8C%87%E5%AF%BC%E4%B9%A6.pdf
Content-Length: 584
Access-Control-Allow-Origin: *
Cache-Control: no-cache
```

| 状态码 | 场景 |
| --- | --- |
| `200` | 成功 |
| `404` | `{"ok":false,"error":"文件不存在或已被删除"}`（已实测） |
| `500` | `{"ok":false,"error":"..."}` |

---

### 3.4 伴学答疑域

#### ⑦ `POST /api/learnbuddy/qa/cards/search`

**用途**：按相关度检索教师答疑卡（伴学答疑的「权威答案」来源）。

**请求 Body**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `courseId` | string \| null | 否 | 限定课程 |
| `query` | string | 否 | 检索词，默认 `""` |
| `threshold` | number | 否 | 相关度阈值 |
| `limit` | number | 否 | 返回条数上限 |
| `userId` | string \| null | 否 | 用户视角过滤 |

**实测响应 A — 命中答疑卡**

```bash
curl.exe -s -X POST ".../qa/cards/search" -H "Content-Type: application/json" \
  -d '{"courseId":"network","query":"为什么 SYN 报文会消耗一个序列号？"}'
```

```json
{
  "ok": true,
  "courseId": "network",
  "query": "为什么 SYN 报文会消耗一个序列号？",
  "count": 1,
  "cards": [
    {
      "id": "qa-syn",
      "question": "为什么 SYN 报文会消耗一个序列号？",
      "title": "为什么 SYN 报文会消耗一个序列号？",
      "keywords": "SYN,消耗,序列号",
      "answer": "SYN 是需要被可靠确认的控制信息，因此占用一个序列号。对端收到 seq=x 的 SYN 后，用 ack=x+1 表示已经收到它。纯 ACK 不额外消耗序列号。",
      "confirmed": true,
      "materialId": "mat-tcp",
      "materialTitle": "第三章 · TCP 可靠传输",
      "courseId": "network",
      "score": 100,
      "matchedKeywordCount": 3
    }
  ]
}
```

**实测响应 B — 无命中**

`{"courseId":"network","query":"三次握手"}` → `count: 0`（该串不在答疑卡关键词内）

```json
{ "ok": true, "courseId": "network", "query": "三次握手", "count": 0, "cards": [] }
```

**实测响应 C — 空参数**

```json
{ "ok": true, "courseId": null, "query": "", "count": 0, "cards": [] }
```

**响应字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `count` | number | 命中条数 |
| `cards[].id` | string | 答疑卡 ID |
| `cards[].question` / `title` | string | 卡片标题（两者同值） |
| `cards[].keywords` | string | 触发关键词，**逗号分隔的单个字符串**（非数组） |
| `cards[].answer` | string | 权威答案 |
| `cards[].score` | number | 相关度得分（满分命中为 `100`） |
| `cards[].matchedKeywordCount` | number | 命中关键词个数 |
| `cards[].materialId` / `materialTitle` / `courseId` | string | 归属课件与课程 |
| `cards[].confirmed` | boolean | 是否已由教师确认 |

| 状态码 | 场景 |
| --- | --- |
| `200` | 总是 200（含无命中） |

> 💡 **检索是「关键词命中」而非语义匹配**：提问「三次握手」（虽然是该课件的核心概念）返回 0 条，而提问「SYN 序列号」返回 1 条——因为预置卡的关键词是 `SYN,消耗,序列号`。
> **前端建议**：用用户的原始提问直接调本接口，命中则展示为「教师权威答案」；未命中再调 `POST /qa/ask`。
> 注意 `qa/ask` 内部还有一层内置卡匹配（`mockData.qaCards`，关键词如「三次握手」「SYN」「ACK」），因此 `cards/search` 返回 0 不代表 `qa/ask` 也会返回 0。

---

#### ⑧ `POST /api/learnbuddy/qa/ask`

**用途**：伴学答疑主入口。三级策略：教师答疑卡 → 内置卡 → 大模型。

**请求 Body**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `question` | string | 是（建议） | 学生提问，默认 `""` |
| `courseId` | string \| null | 否 | 限定课程，用于答疑卡检索 |
| `materialId` | string \| null | 否 | 注入该课件的多模态上下文 |
| `userId` | string \| null | 否 | 用户视角 |

**实测响应 A — 命中教师卡（`source: "teacher_card"`）**

```bash
curl.exe -s -X POST ".../qa/ask" -H "Content-Type: application/json" \
  -d '{"question":"为什么SYN报文会消耗一个序列号？","courseId":"network","userId":"s-yi"}'
```

```json
{
  "ok": true,
  "source": "teacher_card",
  "cardId": "card-002",
  "title": "TCP 三次握手标准时序与报文特征",
  "answer": "1. 客户端发送 SYN (seq=x)；\n2. 服务端回复 SYN+ACK (seq=y, ack=x+1)；\n3. 客户端回复 ACK (seq=x+1, ack=y+1)。请重点比对抓包中的 Flags 标志位与序号变化。"
}
```

**实测响应 B — 未命中卡，走模型链路（`source: "agent_llm"`）**

```json
{
  "ok": true,
  "source": "agent_llm",
  "answer": "【LearnBuddy 伴学助手】针对问题「什么是滑动窗口？」，建议先对照抓包过滤条件（如 tcp.port == 80），确认客户端握手包序号 seq 是否连续递增。",
  "fallback": true
}
```

> 🚨 **这不是模型产出**。本次全部实测（「UDP 校验和怎么计算？」「为什么需要四次挥手？」「什么是滑动窗口？」「请解释拥塞控制算法。」）**均在 0.5–0.8s 内返回该兜底话术**并带 `fallback: true`。耗时远低于任何真实模型往返，说明服务端模型调用**立即失败**走了 `catch` 分支。详见[第 7 节](#7-实测记录与代码不符之处)。

**响应字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `source` | string | `"teacher_card"`（命中教师卡）或 `"agent_llm"`（走模型链路） |
| `cardId` / `title` | string | 仅 `teacher_card` 时存在 |
| `answer` | string | 答案文本，**永不为空**（有兜底） |
| `contextInjected` | boolean | 仅 `agent_llm` 的**正常路径**存在（是否注入了课件/答疑卡上下文） |
| `fallback` | boolean | **`true` 表示这是兜底答案，不是模型产出** |
| `truncated` | boolean | 仅当模型输出被 `max_tokens` 截断时出现 |

> 🔧 **前端兜底识别建议**：`source === "agent_llm"` 且（`fallback === true`，或响应中**缺少 `contextInjected` 字段**）即判定为降级答案。**不要把它渲染成「AI 智能回答」。**

| 状态码 | 场景 |
| --- | --- |
| `200` | **恒为 200**。模型异常也会降级返回 200，必须靠 `fallback` 字段判别 |

---

#### ⑨ `POST /api/learnbuddy/dsh/session-context`

**用途**：生成「课件伴学助手」的会话 System Prompt 与元数据快照，用于把课件上下文注入 DSH 助手。

**请求 Body**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `materialId` | string | **是** | 课件 ID；缺失返回 400 |
| `userId` | string \| null | 否 | 传入后校验可见性 |
| `maxLength` | number | 否 | Prompt 最大长度，默认内部常量 |

**实测响应**（节选，`prompt` 截断）

```json
{
  "ok": true,
  "materialId": "mat-tcp",
  "id": "mat-tcp",
  "title": "第三章 · TCP 可靠传输",
  "courseId": "network",
  "courseName": "计算机网络",
  "courseCode": "CS 203",
  "pages": 3,
  "prompt": "【LearnBuddy 课件伴学助手 System Prompt】\n你是一位高校计算机与软件实验课程的高级智能伴学助教（LearnBuddy Companion Agent）。……\n【课件背景信息】\n- 课程名称: 计算机网络 (CS 203)\n- 课件名称: 第三章 · TCP 可靠传输\n- 课件规格: 共 3 页 | 类型: PDF | 状态: ready\n……",
  "promptLength": 2318,
  "diagrams": [ { "id": "fig-tcp-1", "title": "TCP 报文首部格式与关键控制标志位展开", "caption": "Figure 1-1: TCP Header 结构与 Flags 控制位定义", "page": 1 } ],
  "figures": [ "…与 diagrams 同源，共 3 项…" ],
  "knowledgePoints": [
    {
      "id": "handshake-kp-0",
      "name": "从一次握手开始，理解可靠传输",
      "title": "从一次握手开始，理解可靠传输",
      "summary": "TCP 三次握手的目的，是让通信双方确认彼此的发送与接收能力，并同步初始序列号。",
      "page": 1,
      "difficulty": "核心"
    }
  ],
  "cardsCount": 1,
  "confirmedCardsCount": 1,
  "truncated": false
}
```

实测顶层键：`ok`、`materialId`、`id`、`title`、`courseId`、`courseName`、`courseCode`、`pages`、`prompt`、`promptLength`、`diagrams`、`figures`、`knowledgePoints`、`cardsCount`、`confirmedCardsCount`、`truncated`。

实测取值（`materialId: "mat-tcp"`）：`promptLength` = 2318、`diagrams` 3 项、`figures` 3 项、`knowledgePoints` 3 项、`cardsCount` = 1、`confirmedCardsCount` = 1、`truncated` = false。

**错误响应（均已实测）**

| 状态码 | 场景 | 响应 |
| --- | --- | --- |
| `400` | 缺 `materialId` | `{"ok":false,"error":"缺少必要参数: materialId"}` |
| `404` | 课件不存在/无权 | `{"ok":false,"error":"未找到指定课件或当前用户无权访问"}` |

---

#### ⑩ `POST /api/learnbuddy/dsh/quote`

**用途**：把课件图表/页面转成 Markdown 引用块（证据引用），供助手回答时引用出处。

**请求 Body**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `materialId` | string | 否 | 用于自动查找图表 |
| `page` | number | 否 | 页码，自动匹配该页图表 |
| `figureId` | string | 否 | 图表 ID（优先级高于 `page`） |
| `customNote` | string | 否 | 附加批注 |
| `quoteItem` | object | 否 | **直接传入引用对象则跳过自动查找** |

**实测响应 A — 命中图表**

```json
{
  "ok": true,
  "quoteText": "> [引用第 2 页图表: Figure 2-1: 客户端与服务端三次握手时序流及 seq/ack 演进图]\n> 图表说明: 时序图呈现 SYN(seq=x) -> SYN+ACK(seq=y, ack=x+1) -> ACK(seq=x+1, ack=y+1) 交互过程，标注连接状态由 LISTEN -> SYN_SENT -> SYN_RCVD -> ESTABLISHED 的迁移。",
  "quoteItem": {
    "page": 2,
    "figureId": "fig-tcp-2",
    "caption": "Figure 2-1: 客户端与服务端三次握手时序流及 seq/ack 演进图",
    "description": "时序图呈现 SYN(seq=x) -> SYN+ACK(seq=y, ack=x+1) -> ACK(seq=x+1, ack=y+1) 交互过程，标注连接状态由 LISTEN -> SYN_SENT -> SYN_RCVD -> ESTABLISHED 的迁移。",
    "customNote": ""
  }
}
```

**实测响应 B — 空 Body 兜底（不报错）**

```json
{
  "ok": true,
  "quoteText": "> [引用第 1 页图表: 课件图表]",
  "quoteItem": { "page": 1, "figureId": "", "caption": "课件图表", "description": "", "customNote": "" }
}
```

| 状态码 | 场景 |
| --- | --- |
| `200` | 总是 200（无匹配也构造兜底引用） |

---

#### ⑪ `POST /api/learnbuddy/dsh/message`

**用途**：DSH 助手 Bridge 消息校验与应答（握手/上下文/引用三类）。

**请求 Body**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | string | 是 | `learnbuddy:init` / `learnbuddy:context` / `learnbuddy:quote`，其它值走通用 ack |
| `requestId` | string | **是** | 请求标识；缺失/为空 → 返回 `learnbuddy:error` |
| `contextKey` | string | 否 | 上下文键（如 `materialId`） |
| `text` | string | 否 | `learnbuddy:context` 时用于统计长度 |
| `quoteItem` | object | 否 | `learnbuddy:quote` 时的引用对象 |

**实测响应 A — 合法握手**

```bash
curl.exe -s -X POST ".../dsh/message" -H "Content-Type: application/json" \
  -d '{"type":"learnbuddy:init","requestId":"req-1","contextKey":"mat-tcp"}'
```

```json
{
  "ok": true,
  "response": {
    "type": "learnbuddy:ready",
    "requestId": "req-1",
    "contextKey": "mat-tcp",
    "status": "ready",
    "timestamp": 1789149931757
  }
}
```

**实测响应 B — 缺 `requestId`（校验失败）**

```json
{
  "ok": false,
  "response": {
    "type": "learnbuddy:error",
    "requestId": "",
    "contextKey": "",
    "message": "缺少有效的请求标识符 (requestId)",
    "timestamp": 1789149922143
  }
}
```

**`response.type` 取值表**

| 入参 `type` | 出参 `response.type` | 附加字段 |
| --- | --- | --- |
| `learnbuddy:init` | `learnbuddy:ready` | `status: "ready"` |
| `learnbuddy:context` | `learnbuddy:received` | `receivedLength` |
| `learnbuddy:quote` | `learnbuddy:quoted` | `quoteText` |
| 其它 / 校验失败 | `learnbuddy:ack` / `learnbuddy:error` | `messageType` / `message` |

| HTTP 状态码 | 说明 |
| --- | --- |
| `200` | **HTTP 层恒为 200**；业务成败看响应体 `ok`（`response.type !== "learnbuddy:error"`）与 `response.type` |

---

### 3.5 评阅域（AutoGrader）

> 🚨 **本域 4 个写端点会真实修改数据库状态**（`submitted → grading → review → published`）。
> 本次实测**仅验证了参数校验与权限错误路径**（这些路径在状态写入**之前**抛错，不产生副作用），
> **未触发任何真实状态变更**——已通过 `GET /analytics/assignment/lab-os?skipLLM=1` 在干扰前后比对确认
> （`publishedCount: 1`、`reviewedCount: 2` 恒定不变）。

#### ⑫ `POST /api/learnbuddy/grader/submit`

**用途**：对**传入的报告正文**做一次即时评分（`grader.js` 内置 4 项 Rubric），**不落库、不改状态**，是评阅域的「试算」接口。

**请求 Body**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `reportTitle` | string | 否 | 报告标题，默认 `计算机网络实验报告.pdf` |
| `reportContent` | string | 否 | 报告正文；不传则用内置默认摘要 |

**实测响应**

```json
{
  "ok": true,
  "reportTitle": "TCP实验报告_测试.pdf",
  "totalScore": 92,
  "maxScore": 100,
  "summaryReview": "报告格式规范，三次握手标志位清晰准确；但在过滤语法说明环节稍显简略，建议补充常用显示过滤器说明。",
  "rubricChecks": [
    { "item": "实验拓扑与网络环境描述", "score": 10, "max": 10, "status": "pass", "comment": "拓扑清晰完整" },
    { "item": "Wireshark 抓包截图与过滤语法", "score": 12, "max": 20, "status": "warning", "comment": "缺少部分过滤条件说明" },
    { "item": "三次握手报文序号与时序图分析", "score": 40, "max": 40, "status": "pass", "comment": "seq/ack 变化逻辑阐述极佳" },
    { "item": "网络异常/连接重置案例诊断", "score": 30, "max": 30, "status": "pass", "comment": "结合 RST 包进行了合理解释" }
  ]
}
```

**内置 Rubric**（满分 100）

| item | max |
| --- | --- |
| 实验拓扑与网络环境描述 | 10 |
| Wireshark 抓包截图与过滤语法 | 20 |
| 三次握手报文序号与时序图分析 | 40 |
| 网络异常/连接重置案例诊断 | 30 |

> 🚨 **实测返回的是硬编码兜底常量**，不是模型产出。判别方法见[第 7 节](#7-实测记录与代码不符之处)。

| 状态码 | 场景 |
| --- | --- |
| `200` | 总是 200（异常也降级返回 200） |

---

#### ⑬ `POST /api/learnbuddy/grader/grade-submission`

**用途**：按**状态机**对单份已提交报告发起智能评阅（作业 Rubric 逐项判分）。

**请求 Body**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `submissionId` | string | **是** | 提交 ID；缺失返回 400 |
| `options` | object | 否 | 透传给评阅流水线，支持 `forceFail`（强制失败，测试用）、`strictLLM`（模型异常时不禁用规则降级） |

**状态前置条件**：必须是 `submitted` 或 `failed`。

**成功响应形状**（⚠️ **未实测**，据 `autograder-pipeline.js:353-362` 推导）

```json
{
  "ok": true,
  "submissionId": "sub-zhou-net",
  "status": "review",
  "totalScore": 88,
  "maxScore": 100,
  "grades": [
    { "rubricId": "network-r0", "score": 17, "page": 1, "comment": "…", "evidence": "…" }
  ],
  "summary": "…",
  "submission": { "id": "sub-zhou-net", "status": "review", "grades": [], "history": [] }
}
```

**实测错误响应**（全部未产生副作用）

| 请求 | 状态码 | 响应 |
| --- | --- | --- |
| `{}` | `400` | `{"ok":false,"error":"缺少必要参数: submissionId"}` |
| `{"submissionId":"no-such-sub"}` | `400` | `{"ok":false,"error":"提交记录不存在: no-such-sub"}` |
| `{"submissionId":"sub-yi-os"}`（published） | `400` | `{"ok":false,"error":"当前报告状态为「published」，仅允许对「submitted」或「failed」状态的报告启动评阅"}` |
| `{"submissionId":"sub-xu-os"}`（review） | `400` | `{"ok":false,"error":"当前报告状态为「review」，仅允许对「submitted」或「failed」状态的报告启动评阅"}` |

> ✅ **「已发布不可重复评阅」已实测确认**：`sub-yi-os`（published）→ `400` 明确错误。
> ⚠️ 注意错误文案里状态值是**中文书名号包裹的原值**（`「published」`），前端如需映射提示请用「包含状态词」而非严格相等匹配。

**评阅失败时**：状态先置 `grading`，异常后置 `failed` 并记录 `failure` 文本，可通过 ⑮ `retry` 重试。

---

#### ⑭ `POST /api/learnbuddy/grader/batch`

**用途**：对某作业下**全部 `submitted` / `failed`** 报告做受控并发评阅。

**请求 Body**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `assignmentId` | string | **是** | 作业 ID；缺失返回 400 |
| `concurrency` | number | 否 | 并发度，默认 `2`（内部 `Math.max(1, …)`） |
| `options` | object | 否 | 透传评阅选项 |

**实测响应（无待评报告时，安全）**

```bash
curl.exe -s -X POST ".../grader/batch" -H "Content-Type: application/json" \
  -d '{"assignmentId":"lab-os"}'
```

```json
{ "ok": true, "assignmentId": "lab-os", "total": 0, "processed": 0, "succeeded": 0, "failed": 0, "results": [] }
```

> 实测 `lab-os` 的两份报告分别是 `review` 与 `published`，均不在目标集合内 → `total: 0`，**无副作用**。

**不存在的作业 ID 也返回 200**（实测 `{"assignmentId":"no-such-assignment"}` → `total: 0`），因为该接口从不为 `assignmentId` 做存在性校验。**前端切勿用此接口判断作业是否存在。**

**有实际评阅时的 `results[]` 形状**（据代码推导）

```json
{ "id": "sub-zhou-net", "studentId": "s-zhou", "success": true,  "status": "review", "totalScore": 88, "maxScore": 100 }
{ "id": "sub-xu-net",   "studentId": "s-xu",   "success": false, "status": "failed", "error": "…" }
```

| 状态码 | 场景 |
| --- | --- |
| `200` | 正常（含 `total: 0`、作业不存在） |
| `400` | 缺 `assignmentId`：`{"ok":false,"error":"缺少必要参数: assignmentId"}` |

---

#### ⑮ `POST /api/learnbuddy/grader/retry`

**用途**：对 `failed` 报告重新发起评阅。

**请求 Body**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `submissionId` | string | **是** | 提交 ID |
| `options` | object | 否 | 透传评阅选项 |

**状态前置条件**：必须是 `failed`（本接口内部校验后会转调 `grade-submission`）。

**实测错误响应**

| 请求 | 状态码 | 响应 |
| --- | --- | --- |
| `{"submissionId":"no-such-sub"}` | `400` | `{"ok":false,"error":"提交记录不存在: no-such-sub"}` |
| `{"submissionId":"sub-yi-os"}` | `400` | `{"ok":false,"error":"仅允许对「failed」状态的报告发起重试，当前状态为「published」"}` |

**成功响应**：与 ⑬ 同结构（⚠️ 未实测）。

| 状态码 | 场景 |
| --- | --- |
| `200` | 重试成功 |
| `400` | 缺参数 / 记录不存在 / 状态非 `failed` |

---

#### ⑯ `POST /api/learnbuddy/grader/review-publish`

**用途**：教师人工复核改分并**正式发布成绩**（状态 → `published`，同时写入 ReviewVersion 快照）。

**请求 Body**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `submissionId` | string | **是** | 提交 ID |
| `teacherId` | string | **是** | 教师 userId；也可用 `userId` 或 `reviewerId` 传入 |
| `grades` | array | **是** | 核定小项得分列表，**必须覆盖作业 Rubric 的每一项** |
| `summary` | string | 否 | 综合评语；不传则沿用原有 `summary` |
| `strictRange` | boolean | 否 | `true` 时小项越界**直接拒绝**；默认 `false`（夹取到 `[0, max]` 并留痕） |

**`grades[]` 字段**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `rubricId` | string | 否* | 优先按 `rubricId` 匹配（也支持 `id`、`title`/`item` 文本、数组下标兜底） |
| `score` | number | **是** | 得分，不可为空 |
| `page` | number | 否 | 证据页码，默认按序号推算 |
| `comment` | string | 否 | 该项评语 |
| `evidence` | string | 否 | 证据引用 |

**业务红线**

- 只有该作业所属课程的**执教教师**可发布 → 否则 `403`
- 总分由后端**遍历小项严格累加**得出，**忽略请求里的任何总分字段**
- `grades` 缺项 → `400`（提示具体缺失项）
- 状态为 `grading` 时禁止发布 → `400`
- `ReviewVersion` 快照与 `published` 翻转在**同一 SQLite 事务**内原子完成

**实测错误响应**（全部未产生副作用）

| 请求 | 状态码 | 响应 |
| --- | --- | --- |
| `{}` | `400` | `{"ok":false,"error":"缺少必要参数: submissionId"}` |
| 缺 `teacherId` | `400` | `{"ok":false,"error":"缺少必要参数: teacherId"}` |
| `grades` 非数组 | `400` | `{"ok":false,"error":"grades 必须为数组格式"}` |
| `submissionId` 不存在 | `404` | `{"ok":false,"error":"提交记录不存在: no-such-sub"}` |
| `teacherId: "s-yi"`（学生） | `403` | `{"ok":false,"error":"权限不足：用户「s-yi」非教师角色，禁止复核成绩"}` |
| `teacherId: "t-chen"` 复核 `database` 课的报告 | `403` | `{"ok":false,"error":"权限不足：教师「t-chen」不是课程「database」的执教教师"}` |
| `grades: []`（缺评分项） | `400` | `{"ok":false,"error":"缺少评分项「实验环境与实现说明」(os-r0) 的核定给分"}` |

**成功响应形状**（⚠️ **未实测**，据 `feedback-analytics.js:301-316` 推导）

```json
{
  "ok": true,
  "submissionId": "sub-xu-os",
  "status": "published",
  "previousStatus": "review",
  "totalScore": 84,
  "maxScore": 100,
  "grades": [
    { "rubricId": "os-r0", "title": "实验环境与实现说明", "max": 20, "score": 19,
      "page": 1, "comment": "…", "evidence": "…" }
  ],
  "summary": "…",
  "reviewVersion": 2,
  "clamped": false,
  "clampedItems": [],
  "history": [ { "version": 2, "confirmedAt": "…", "teacherId": "t-chen", "grades": [], "totalScore": 84, "maxScore": 100, "summary": "…" } ],
  "snapshot": { "version": 2, "confirmedAt": "…", "teacherId": "t-chen", "reviewerId": "t-chen", "grades": [], "totalScore": 84, "maxScore": 100, "summary": "…", "clamped": false, "clampedItems": [] },
  "submission": { "id": "sub-xu-os", "status": "published", "grades": [], "summary": "…", "history": [] }
}
```

| 状态码 | 场景 |
| --- | --- |
| `200` | 发布成功 |
| `400` | 缺参数 / `grades` 非数组 / 缺评分项 / 分数非法 / 状态为 `grading` |
| `403` | 非教师角色，或非该课程执教教师 |
| `404` | 提交记录不存在（错误文案含「不存在」） |

---

### 3.6 学情分析域

> 两个接口均为**只读**。建议联调时带 `skipLLM=1` 跳过模型调用（当前模型链路已确认为降级状态，见第 7 节）。

#### ⑰ `GET /api/learnbuddy/analytics/assignment/:id`

**用途**：作业维度的全班学情（均分、分数段分布、各 Rubric 采分点得分率、薄弱项、教学建议）。

**Path / Query 参数**

| 字段 | 位置 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `:id` | path | string | 是 | 作业 ID，如 `lab-tcp` |
| `skipLLM` | query | string | 否 | `1` 或 `true` 时跳过模型，走规则化教学建议 |

**实测响应**（`GET /analytics/assignment/lab-tcp?skipLLM=1`，`rubricAnalytics` 节选）

```json
{
  "ok": true,
  "assignmentId": "lab-tcp",
  "assignmentTitle": "实验一 · TCP 三次握手分析",
  "courseId": "network",
  "totalStudents": 3,
  "totalSubmissions": 2,
  "publishedCount": 0,
  "reviewedCount": 0,
  "gradingCount": 0,
  "failedCount": 0,
  "submissionRate": 0.67,
  "reviewCompletionRate": 0,
  "highestScore": 0,
  "lowestScore": 0,
  "averageScore": 0,
  "averageScoreRate": 0,
  "maxScore": 100,
  "scoreDistribution": [
    { "band": "0-59", "count": 0 },
    { "band": "60-69", "count": 0 },
    { "band": "70-79", "count": 0 },
    { "band": "80-89", "count": 0 },
    { "band": "90-100", "count": 0 }
  ],
  "rubricAnalytics": [
    { "rubricId": "network-r0", "title": "实验环境与抓包过程", "criterion": "清楚说明环境、操作步骤与关键参数，过程可复现。",
      "max": 20, "studentCount": 0, "avgScore": 0, "avgLostPoints": 0, "scoreRate": 0, "lossRate": 0 }
  ],
  "weakestItems": [],
  "teachingSuggestions": [
    { "topic": "全班表现优异",
      "suggestion": "全班实验报告各采分项得分率表现良好，建议下周可按计划推进后续进阶实验或安排创新拓展项目。",
      "actionPlan": "课前简要肯定本次实验规范性，直接进入下周新课主题。" }
  ]
}
```

**关键字段语义**

| 字段 | 说明 |
| --- | --- |
| `totalStudents` | `max(选课人数, 去重提交人数, 1)` |
| `totalSubmissions` | 该作业全部提交数（含所有状态） |
| `publishedCount` | **已发布**数——**均分/最高分/最低分/分数段只统计已发布报告** |
| `reviewedCount` | `review` + `published` 之和 |
| `submissionRate` | 已提交人数 / 选课人数，上限 1 |
| `reviewCompletionRate` | 已发布 / 已提交 |
| `averageScoreRate` | `averageScore / maxScore`，保留 2 位 |
| `weakestItems` | 薄弱采分点（按失分排序） |
| `teachingSuggestions` | `skipLLM=1` 时为规则化建议 |

> 💡 **`publishedCount: 0` 时所有分数字段必然为 0**——不是接口坏了，而是**尚无已发布成绩**。实测 `lab-tcp` 正是此情况（2 份报告均停留在 `submitted`）。

| 状态码 | 场景 | 实测响应 |
| --- | --- | --- |
| `200` | 成功 | — |
| `404` | 作业不存在 | `{"ok":false,"error":"作业不存在: nope"}` |

---

#### ⑱ `GET /api/learnbuddy/analytics/course/:id`

**用途**：课程大盘学情 + 跨作业教学建议（按作业逐项汇总）。

**Path / Query 参数**

| 字段 | 位置 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `:id` | path | string | 是 | 课程 ID，如 `network` |
| `skipLLM` | query | string | 否 | `1` 或 `true` 跳过模型 |

**实测响应**（顶层字段 + 节选）

```json
{
  "ok": true,
  "courseId": "network",
  "courseTitle": "计算机网络",
  "courseCode": "CS 203",
  "teacherId": "t-chen",
  "totalStudents": 3,
  "totalAssignments": 1,
  "publishedAssignmentsCount": 1,
  "totalSubmissionsCount": 2,
  "totalPublishedSubmissionsCount": 0,
  "overallAverageScore": 0,
  "overallSubmissionRate": 0.67,
  "overallReviewCompletionRate": 0,
  "assignmentSummaries": [
    { "assignmentId": "lab-tcp", "title": "实验一 · TCP 三次握手分析", "averageScore": 0, "maxScore": 100,
      "averageScoreRate": 0, "highestScore": 0, "lowestScore": 0, "submissionRate": 0.67,
      "reviewCompletionRate": 0, "totalSubmissions": 2, "publishedCount": 0, "weakestItem": null }
  ],
  "weakestItems": [],
  "teachingAdvice": [
    { "assignmentId": "lab-tcp", "assignmentTitle": "实验一 · TCP 三次握手分析",
      "suggestions": [ { "topic": "全班表现优异", "suggestion": "…", "actionPlan": "…" } ] }
  ],
  "assignmentAnalytics": [ { "ok": true, "assignmentId": "lab-tcp", "…": "与端点 ⑰ 同结构" } ]
}
```

> ⚠️ **响应体较大**：`assignmentAnalytics[]` 内嵌了每个作业的**完整**学情对象（与端点 ⑰ 同结构）。
> 若只需大盘数字，请忽略该字段以减小传输与渲染开销。

**`overallAverageScore` 计算口径**：仅对 `publishedCount > 0` 的作业取各自均分再平均（保留 1 位小数）。

| 状态码 | 场景 | 实测响应 |
| --- | --- | --- |
| `200` | 成功 | — |
| `404` | 课程不存在 | `{"ok":false,"error":"课程不存在: nope"}` |

---

### 3.7 课程 / 作业 / 提交域（task-17 新增）

> 🆕 本节 5 个端点为 **task-17 补齐**，修复「前端拿不到课程/作业/提交列表 → 评阅主线无法从 UI 走通」
> 与「未发布成绩对学生置空的安全红线在 API 层不可达」两个阻塞项。
>
> **通用规则（本域 5 个端点一致，无例外）**
>
> | 规则 | 行为 |
> | --- | --- |
> | `userId` / `studentId` **必填** | 缺失 → `400 {"ok":false,"error":"缺少必要参数: userId"}`。**绝不会**像 `GET /materials` 那样无身份即返回全量数据 |
> | 用户不存在 | `404 {"ok":false,"error":"用户不存在: <id>"}` |
> | 无课程访问权（跨课程） | `403 {"ok":false,"error":"权限不足：…"}` |
> | 资源不存在 | `404 {"ok":false,"error":"课程/作业/提交记录不存在: <id>"}` |
> | 数据入口 | 全部经 `DatabaseStore` 权限层产出，端点自身不做任何绕过权限的字段拼装 |

#### ⑲ `GET /api/learnbuddy/courses` — 课程列表

**用途**：拉取当前用户可访问的课程（学生 = 已选课程；教师 = 所授课程）。前端可用它替代硬编码的课程下拉框。

**Query 参数**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `userId` | string | **是** | 用户 ID（`users.id`，如 `s-yi` / `t-chen`）。缺失 → `400` |

**实测响应（学生 `s-yi`，HTTP 200）**

```json
{
  "ok": true,
  "userId": "s-yi",
  "role": "student",
  "count": 3,
  "courses": [
    { "id": "cs101", "teacherId": "t-chen", "title": "计算机科学导论", "code": "CS 101", "color": "blue", "description": "计算机系统与算法基础初探。" },
    { "id": "network", "teacherId": "t-chen", "title": "计算机网络", "code": "CS 203", "color": "green", "description": "从一次握手，理解万物互联。" },
    { "id": "os", "teacherId": "t-chen", "title": "操作系统", "code": "CS 301", "color": "orange", "description": "探索计算机如何管理每一份资源。" }
  ]
}
```

**响应字段说明**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `role` | string | 请求者的角色（`student` / `teacher`），前端可直接据此切换 UI |
| `count` | number | 课程条数 |
| `courses[].id` | string | 课程 ID（后续 `courseId` 参数用它） |
| `courses[].teacherId` | string | 执教教师 userId |
| `courses[].title` / `code` / `color` / `description` | string | 课程展示信息 |
| 排序 | — | 固定按 `code` 升序（`CS 101` → `CS 203` → `CS 301`） |

**实测（失败）**

```json
// GET /courses            （缺 userId）→ HTTP 400
{ "ok": false, "error": "缺少必要参数: userId" }

// GET /courses?userId=s-nobody → HTTP 404
{ "ok": false, "error": "用户不存在: s-nobody" }
```

| 状态码 | 场景 |
| --- | --- |
| `200` | 成功（用户无任何课程时为 `count: 0` + `courses: []`，仍返回 200） |
| `400` | 缺 `userId` |
| `404` | `userId` 在 `users` 表中不存在 |

---

#### ⑳ `GET /api/learnbuddy/assignments` — 作业列表

**用途**：拉取作业列表。学生**只能看到已发布（`published: true`）**的作业；教师能看到本课程全部作业（含未发布草稿）。

**Query 参数**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `userId` | string | **是** | 缺失 → `400` |
| `courseId` | string | 否 | 传入则限定该课程；**会先校验课程存在与访问权**，跨课程 → `403`（不是静默返回空数组）。不传则返回该用户全部可访问课程的作业 |

**实测响应（学生 `s-yi` + `courseId=network`，HTTP 200）**

```json
{
  "ok": true,
  "userId": "s-yi",
  "courseId": "network",
  "count": 1,
  "assignments": [
    {
      "id": "lab-tcp",
      "courseId": "network",
      "title": "实验一 · TCP 三次握手分析",
      "due": "2026-09-18",
      "description": "使用 Wireshark 捕获一次完整的 TCP 连接建立过程，分析 SYN、ACK 与序列号变化，结合截图给出解释，并讨论一种连接异常。",
      "materialIds": ["mat-tcp", "mat-wire"],
      "rubric": [
        { "id": "network-r0", "title": "实验环境与抓包过程", "max": 20, "criterion": "清楚说明环境、操作步骤与关键参数，过程可复现。" },
        { "id": "network-r1", "title": "三次握手字段分析", "max": 30, "criterion": "结合本次实验的原理与关键字段，逐项解释观察结果。" },
        { "id": "network-r2", "title": "抓包截图与证据", "max": 30, "criterion": "提供清晰、对应当前结论的原始截图或输出，并标注必要字段。" },
        { "id": "network-r3", "title": "异常分析与实验总结", "max": 20, "criterion": "讨论异常或边界情况，给出有依据的结论与改进方向。" }
      ],
      "confirmed": true,
      "published": true
    }
  ]
}
```

**响应字段说明**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `assignments[].id` | string | 作业 ID（提交/评阅/学情接口都用它） |
| `assignments[].courseId` | string | 所属课程 |
| `assignments[].due` | string | 截止日期（`YYYY-MM-DD`，可能为空串） |
| `assignments[].materialIds` | string[] | 关联课件 ID，供前端跳转课件 |
| `assignments[].rubric` | object[] | 评分标准 `{id,title,max,criterion}`，**教师复核与前端分数明细都用它对齐** |
| `assignments[].confirmed` | boolean | 评分标准是否已确认（`false` 时 `review-publish` 会 400） |
| `assignments[].published` | boolean | 是否已发布。**学生的列表里只会出现 `true`** |

**实测（失败）**

```json
// GET /assignments?userId=s-yi&courseId=database   （s-yi 未选修 database）→ HTTP 403
{ "ok": false, "error": "权限不足：用户「s-yi」无权访问课程「database」的作业" }

// GET /assignments?userId=s-yi&courseId=nope       → HTTP 404
{ "ok": false, "error": "课程不存在: nope" }

// GET /assignments?courseId=network                （缺 userId）→ HTTP 400
{ "ok": false, "error": "缺少必要参数: userId" }
```

| 状态码 | 场景 |
| --- | --- |
| `200` | 成功（无匹配作业时 `count: 0`） |
| `400` | 缺 `userId` |
| `403` | 传了 `courseId` 但当前用户无该课程访问权 |
| `404` | 用户不存在 / 传入的 `courseId` 不存在 |

---

#### ㉑ `GET /api/learnbuddy/submissions` — 提交列表 ★ 安全红线生效点

**用途**：拉取某次作业的提交列表。**教师看全班（完整评分与评语）；学生只看自己的，且非 `published` 状态的报告 `grades` / `summary` 被强制置空。**

> 🔴 **本节是本任务最重要的验收点。** 服务端经由 `store.getSubmissions(userId, assignmentId)` 产出数据，
> 「未发布成绩不泄漏给学生」这条赛题红线**首次在 HTTP 层真正生效**。

**Query 参数**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `userId` | string | **是** | 缺失 → `400` |
| `assignmentId` | string | **是** | 缺失 → `400`；不存在 → `404` |

**实测响应 A（学生 `s-xu` 查 `lab-os`：自己的报告处于 `review`，成绩被置空，HTTP 200）**

```json
{
  "ok": true,
  "userId": "s-xu",
  "role": "student",
  "assignmentId": "lab-os",
  "courseId": "os",
  "count": 1,
  "submissions": [
    {
      "id": "sub-xu-os",
      "assignmentId": "lab-os",
      "studentId": "s-xu",
      "fileName": "进程同步实验报告_许然.docx",
      "submittedAt": "2026-09-10 08:45",
      "status": "review",
      "sampleKey": "os",
      "grades": [],
      "summary": "",
      "history": []
    }
  ]
}
```

> ⚠️ 注意：库里这条记录**实际带着 4 项评分与一段评语**（评阅已完成、教师尚未发布），
> 但学生侧响应中 `grades` 为 `[]`、`summary` 为 `""`，且**响应里根本没有 `failure` 键**（未下发给学生）。
> `count: 1` 也证明学生只看到自己的提交。

**实测响应 B（教师 `t-chen` 查**同一份** `sub-xu-os`：完整评分，HTTP 200）**

```json
{
  "ok": true,
  "userId": "t-chen",
  "role": "teacher",
  "assignmentId": "lab-os",
  "courseId": "os",
  "count": 2,
  "submissions": [
    {
      "id": "sub-xu-os",
      "assignmentId": "lab-os",
      "studentId": "s-xu",
      "fileName": "进程同步实验报告_许然.docx",
      "submittedAt": "2026-09-10 08:45",
      "status": "review",
      "sampleKey": "os",
      "grades": [
        { "rubricId": "os-r0", "score": 19, "page": 1, "comment": "环境与实现步骤清晰。", "evidence": "使用有界缓冲区与信号量实现生产者、消费者线程。" },
        { "rubricId": "os-r1", "score": 24, "page": 2, "comment": "互斥锁保护临界区描述清楚，信号量增减顺序可再推导。", "evidence": "运行日志展示缓冲区容量在 0 至 5 之间变化。" },
        { "rubricId": "os-r2", "score": 25, "page": 2, "comment": "测试输出截图完整。", "evidence": "运行日志展示缓冲区容量在 0 至 5 之间变化。" },
        { "rubricId": "os-r3", "score": 16, "page": 3, "comment": "边界条件讨论有待深化。", "evidence": "对空缓冲区的连续消费测试说明不充分。" }
      ],
      "summary": "核心过程已完成，边界测试与证据标注尚需完善。",
      "history": [],
      "failure": null
    },
    { "id": "sub-yi-os", "studentId": "s-yi", "status": "published", "grades": ["… 4 项，学生侧同样可见"], "summary": "能够清楚说明同步与互斥的区别。…" }
  ]
}
```

**师生可见性对照表（同一份 `sub-xu-os`，同一时刻）**

| 字段 | 学生 `s-xu` 视角 | 教师 `t-chen` 视角 |
| --- | --- | --- |
| `grades` | `[]` 🔴 | 4 项完整评分 ✅ |
| `summary` | `""` 🔴 | 完整评语 ✅ |
| `failure` | 键不存在 🔴 | `null`（失败时带原因）✅ |
| 可见提交条数 | 仅自己的（`count: 1`） | 全班（`count: 2`） |
| 元信息（`status` / `fileName` / `submittedAt`） | 可见（用于展示「评阅中」状态） | 可见 |

**各状态下的学生可见性**（与 [§5 状态机](#5-评阅状态机)一致）

| `status` | 学生 `grades` / `summary` |
| --- | --- |
| `submitted` | 置空 |
| `grading` | 置空 |
| `review` | 置空 |
| `failed` | 置空 |
| `published` | **完整可见** |

**响应字段说明**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `role` | string | 请求者角色 |
| `assignmentId` / `courseId` | string | 回显，便于前端串联 |
| `count` | number | 本视角下的可见条数 |
| `submissions[].id` | string | 提交 ID（`submissions/:id`、`grader/*` 都用它） |
| `submissions[].studentId` | string | 提交者 userId |
| `submissions[].status` | string | `submitted` / `grading` / `review` / `published` / `failed` |
| `submissions[].grades` | object[] | `{rubricId,score,page,comment,evidence}`；非 `published` 时对学生为 `[]` |
| `submissions[].summary` | string | 总评；非 `published` 时对学生为 `""` |
| `submissions[].history` | object[] | 历次发布快照（教师视角有意义；学生置空报告为空数组） |
| `submissions[].blobId` | string \| 缺省 | 报告原件 ID（有物理文件时才会出现） |

**实测（失败）**

```json
// 缺 userId          → HTTP 400
{ "ok": false, "error": "缺少必要参数: userId" }
// 缺 assignmentId    → HTTP 400
{ "ok": false, "error": "缺少必要参数: assignmentId" }
// assignmentId 不存在 → HTTP 404
{ "ok": false, "error": "作业不存在: lab-nope" }
// 跨课程（t-chen 查 database 课的 lab-db）→ HTTP 403
{ "ok": false, "error": "权限不足：用户「t-chen」无权访问课程「database」的提交记录" }
```

| 状态码 | 场景 |
| --- | --- |
| `200` | 成功（自己无提交时 `count: 0`） |
| `400` | 缺 `userId` 或 `assignmentId` |
| `403` | 用户对该作业所属课程无访问权 |
| `404` | 用户不存在 / 作业不存在 |

---

#### ㉒ `GET /api/learnbuddy/submissions/:id` — 单份提交详情

**用途**：拉取单份提交详情（与 ㉑ 同一套置空规则）。前端展示「我的报告 / 某学生报告」详情页用它。

**Path / Query 参数**

| 字段 | 位置 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | path | string | **是** | 提交 ID，如 `sub-xu-os` |
| `userId` | query | string | **是** | 缺失 → `400` |

**实测响应 A（学生 `s-xu` 查自己的 `review` 报告，HTTP 200）**

```json
{
  "ok": true,
  "submission": {
    "id": "sub-xu-os",
    "assignmentId": "lab-os",
    "studentId": "s-xu",
    "fileName": "进程同步实验报告_许然.docx",
    "submittedAt": "2026-09-10 08:45",
    "status": "review",
    "sampleKey": "os",
    "grades": [],
    "summary": "",
    "history": []
  }
}
```

**实测响应 B（教师 `t-chen` 查同一份，HTTP 200）**

```json
{
  "ok": true,
  "submission": {
    "id": "sub-xu-os",
    "studentId": "s-xu",
    "status": "review",
    "grades": [ { "rubricId": "os-r0", "score": 19, "page": 1, "comment": "环境与实现步骤清晰。", "evidence": "…" } ],
    "summary": "核心过程已完成，边界测试与证据标注尚需完善。",
    "failure": null
  }
}
```

> 上面 B 为节选（完整 `grades` 共 4 项，字段与 ㉑ 一致）。

**实测（失败）**

```json
// GET /submissions/sub-xu-os?userId=s-zhou  （学生看他人提交）→ HTTP 403
{ "ok": false, "error": "权限不足：用户「s-zhou」无权访问提交记录「sub-xu-os」" }

// GET /submissions/sub-nope?userId=t-chen   → HTTP 404
{ "ok": false, "error": "提交记录不存在: sub-nope" }

// GET /submissions/sub-xu-os                （缺 userId）→ HTTP 400
{ "ok": false, "error": "缺少必要参数: userId" }
```

| 状态码 | 场景 |
| --- | --- |
| `200` | 有权限（学生看自己的已发布报告 / 教师看本课程任意报告） |
| `400` | 缺 `userId` |
| `403` | 记录存在但无权访问（学生看他人、教师看非本人执教课程） |
| `404` | 用户不存在 / 提交记录不存在 |

---

#### ㉓ `POST /api/learnbuddy/submissions` — 创建提交（学生交报告）

**用途**：学生提交实验报告，写入 `submissions` 表，初始 `status: "submitted"`，可立即被
`POST /grader/grade-submission`（单份）或 `POST /grader/batch`（全班）评阅。

**请求体（两种形态任选，推荐 JSON）**

**a) `application/json`**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `assignmentId` | string | **是** | 目标作业 ID |
| `studentId` | string | **是** | 提交者 userId（学生）。兼容别名 `userId` |
| `fileName` | string | **是** | 报告文件名，**扩展名决定存储校验**（白名单：`.pdf .ppt .pptx .docx .png .jpg .jpeg`） |
| `content` | string | **是** | 报告文件内容：base64 字符串或 `data:application/pdf;base64,...`。兼容别名 `fileData` / `buffer` |
| `encoding` | string | 否 | 传 `"base64"` 表示按 base64 解码；`content` 以 `data:` 开头时自动按 base64 处理，无需该字段 |

**b) `multipart/form-data`**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `assignmentId` | text | **是** | 同上 |
| `studentId` | text | **是** | 同上 |
| 文件字段（如 `file`） | file | **是** | 报告二进制，文件名即 `fileName` |

**请求示例（JSON，base64）**

```bash
curl.exe -s -X POST "$BASE/submissions" -H "Content-Type: application/json" \
  -d '{"studentId":"s-yi","assignmentId":"lab-tcp","fileName":"TCP实验报告_林一.pdf","encoding":"base64","content":"JVBERi0xLjQK...JUVPRgo="}'
```

**实测响应（成功，HTTP 200）**

```json
{
  "ok": true,
  "submission": {
    "id": "sub-1789177259360-xrly",
    "assignmentId": "lab-tcp",
    "studentId": "s-yi",
    "fileName": "TCP实验报告_林一.pdf",
    "submittedAt": "2026-09-12T01:40:59.360Z",
    "status": "submitted",
    "blobId": "6b110e101cddca23772cb3edfff1c713afc50a89f285eae27c6b3f5a47ed9129.pdf",
    "grades": [],
    "summary": "",
    "history": []
  },
  "file": {
    "id": "6b110e101cddca23772cb3edfff1c713afc50a89f285eae27c6b3f5a47ed9129.pdf",
    "name": "TCP实验报告_林一.pdf",
    "size": 41,
    "sizeFormatted": "41 B",
    "hash": "6b110e101cddca23772cb3edfff1c713afc50a89f285eae27c6b3f5a47ed9129",
    "viewUrl": "/api/learnbuddy/files/6b110e101cddca23772cb3edfff1c713afc50a89f285eae27c6b3f5a47ed9129.pdf/view",
    "downloadUrl": "/api/learnbuddy/files/6b110e101cddca23772cb3edfff1c713afc50a89f285eae27c6b3f5a47ed9129.pdf/download"
  }
}
```

**响应字段说明**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `submission.id` | string | 新提交 ID，交给 `POST /grader/grade-submission` 评阅 |
| `submission.status` | string | 固定初始值 `"submitted"` |
| `submission.blobId` | string | 落盘文件 ID = `SHA-256 + 扩展名`（64 位十六进制）。**报告正文不落库，数据库只存这个引用** |
| `submission.grades` / `summary` | `[]` / `""` | 新建时为初始值（且按红线规则，未发布状态对学生恒为置空） |
| `file.viewUrl` / `file.downloadUrl` | string | 可直接给前端做预览/下载（走 ⑤/⑥ 两个端点） |
| `file.size` / `sizeFormatted` | number / string | 字节数与可读大小 |

**实测（失败）**

```json
// 缺 studentId   → HTTP 400
{ "ok": false, "error": "缺少必要参数: studentId" }
// 缺 assignmentId → HTTP 400
{ "ok": false, "error": "缺少必要参数: assignmentId" }
// 缺 fileName     → HTTP 400
{ "ok": false, "error": "缺少必要参数: fileName" }
// 缺 content      → HTTP 400
{ "ok": false, "error": "缺少必要参数: content（报告文件内容，base64 或 data URL；multipart 时为文件字段）" }
// 非学生角色提交 → HTTP 403
{ "ok": false, "error": "权限不足：用户「t-chen」非学生角色，禁止提交报告" }
// 跨课程提交     → HTTP 403
{ "ok": false, "error": "权限不足：学生「s-yi」未选修课程「database」，禁止提交报告" }
// 作业未发布     → HTTP 403
{ "ok": false, "error": "权限不足：作业「lab-tcp-draft」尚未发布，学生不可提交报告" }
// 非白名单扩展名 → HTTP 400
{ "ok": false, "error": "不支持的文件格式: \".exe\"。仅支持白名单格式: .pdf, .ppt, .pptx, .docx, .png, .jpg, .jpeg" }
```

| 状态码 | 场景 |
| --- | --- |
| `200` | 提交成功 |
| `400` | 缺 `studentId`/`assignmentId`/`fileName`/`content`；扩展名不在白名单；文件超过 20MB |
| `403` | 非学生角色；未选修该课程；作业尚未发布 |
| `404` | 用户不存在；作业不存在 |

**安全与存储约束（重要）**

1. **只允许学生提交**：`studentId` 必须是 `role === "student"` 的用户，否则 `403`。
2. **只能提交到自己已选修的、且已发布的作业**，否则 `403`（跨课程 / 草稿作业都拦下）。
3. **报告文件一律经 `StorageService` 物理落盘**，数据库只保存 `blobId`（SHA-256 文件名）。
   *大 base64 绝不写入 `submissions` 表* —— 已由测试断言：数据库行内既不含 base64，也不含报告正文，
   且单行记录远小于上传载荷（`test/missing-endpoints.test.js`）。
4. **同一文件内容重复提交会哈希去重**（物理盘只存一份），但每次提交仍生成独立的 `submission.id` 记录。
5. 不要给本端点传入真实大模型密钥之类的东西 —— 它只做落盘与入库，**不触发任何模型调用**。

**推荐前端调用链**

```
GET /courses?userId=<uid>                       → 课程下拉框
        ↓
GET /assignments?userId=<uid>&courseId=<cid>    → 作业列表（含 rubric，用于展示评分标准）
        ↓
POST /submissions  {studentId, assignmentId, fileName, content}   → 交报告（status=submitted）
        ↓
POST /grader/grade-submission {submissionId}    → 教师侧触发评阅（submitted → review）
        ↓
GET /submissions?userId=<studentId>&assignmentId=<aid>  → 学生看自己的（未发布 → 成绩置空）
GET /submissions?userId=<teacherId>&assignmentId=<aid>  → 教师看全班（完整成绩）
```

---

## 4. 权限与业务规则（评分点）

> 这些规则是赛题评分点，**前端必须据此设计 UI**（隐藏/置空/提示），不能只依赖后端拦截。

### 4.1 未发布提交，学生侧成绩与评语被置空

学生查询非 `published` 状态的提交时，后端**强制置空**以下字段（`store.js:543-551`、`store.js:593-604`）：

| 字段 | 非 `published` 时 |
| --- | --- |
| `grades` | 强制 `[]` |
| `summary` | 强制 `""` |
| `failure` | 置为 `undefined`（不下发失败原因） |

教师查询**不受此限制**（教师始终能看到全班完整评分与评语）。

> ✅ **task-17 更新（已闭合）**：该权限层由 `store.getSubmission()` / `store.getSubmissions()` 实现，
> 此前 **HTTP API 没有任何端点调用它们**（红线在 API 面不可达）。
> 现由 **㉑ `GET /submissions?assignmentId=&userId=`** 与 **㉒ `GET /submissions/:id?userId=`** 接通，
> 红线**在 HTTP 层真正生效**，并有端到端测试证明：
> 学生查 `review` 态报告 → `grades: []` / `summary: ""`（且无 `failure` 键）；
> 教师查**同一份** → 4 项完整 `grades` + 完整 `summary`（见 [§3.7](#37-课程--作业--提交域task-17-新增)）。

### 4.2 教师只能复核自己所授课程的报告

`POST /grader/review-publish` 的鉴权顺序：

1. 用户必须存在 → 否则 `404`
2. 角色必须是 `teacher` → 否则 `403`
3. 必须是该作业所属课程的执教教师（`courses.teacher_id === teacherId`，或 `hasCourse` 通过）→ 否则 `403`
4. 状态不得为 `grading` → 否则 `400`
5. 评分项必须齐全且合法 → 否则 `400`

**实测 403 响应**

```json
{ "ok": false, "error": "权限不足：用户「s-yi」非教师角色，禁止复核成绩" }
```

```json
{ "ok": false, "error": "权限不足：教师「t-chen」不是课程「database」的执教教师" }
```

课程执教教师对照：`network`/`os`/`cs101` → `t-chen`；`database` → `t-lin`。

### 4.3 资料可见性

| 场景 | 规则 |
| --- | --- |
| `visibility: "course"` | 本课程内可见 |
| `visibility: "private"` | **仅 `ownerId` 本人可见** |
| 学生 | 只能看**本课程公开资料 + 自己的私有资料** |

**实测对照表**

| 请求 | 是否可见 `mat-net-teach`（private, owner `t-chen`） |
| --- | --- |
| `GET /materials?userId=s-yi` | ❌ 不可见（正确隔离） |
| `GET /materials?userId=t-chen` | ✅ 可见（owner 本人） |
| `GET /materials/:id/context?userId=s-yi` | `404`（正确隔离） |
| `GET /materials/:id/context?userId=t-chen` | `200` |
| `GET /materials`（无 `userId`） | ⚠️ **可见（越权泄漏）** |
| `GET /materials?courseId=network`（无 `userId`） | ⚠️ **可见（越权泄漏）** |

> 🔎 **结论**：可见性过滤**仅在传入 `userId` 时生效**。前端**务必始终带 `userId`** 调课件列表，否则会拿到教师的私有资料。
> 🔎 **已知缺陷**：无 `userId` 时泄漏 `private` 资料，建议后端补齐（本轮只做文档，不改代码）。

### 4.4 404 与 403 的语义区分

| 接口 | 无权访问时 | 资源不存在时 |
| --- | --- | --- |
| `GET /materials/:id/context` | `404`（同文案，**故意不区分**） | `404` |
| `POST /dsh/session-context` | `404`（同上） | `404` |
| `POST /grader/review-publish` | **`403`**（明确区分） | `404` |
| `GET /analytics/*` | 无鉴权（见下） | `404` |

> ⚠️ **学情接口无任何鉴权**：`GET /analytics/*` 不接收 `userId`、不做角色校验（实测无需任何身份参数即可拿到全班学情）。前端不要把它当成"教师专属"接口来设计权限，但**上线前应补齐服务端鉴权**。

---

## 5. 评阅状态机

```
                    ┌──────────────────────────────────────────┐
                    │                                          │
  submitted ──⑬/⑭──> grading ──成功──> review ──⑯──> published │
      ▲                 │                                      │
      │                 └──失败──> failed ──⑮ retry──┐          │
      │                             ▲                │          │
      │                             └────────────────┘          │
      └─────────────────（不可回到 submitted）───────────────────┘
```

**状态定义与可见性**

| 状态 | 含义 | 学生可见成绩？ | 教师可见成绩？ |
| --- | --- | --- | --- |
| `submitted` | 已提交待评阅 | ❌ 置空 | ✅ |
| `grading` | 评阅进行中（**中间态**） | ❌ 置空 | ✅ |
| `review` | 评阅完成，待教师复核 | ❌ 置空 | ✅ |
| `published` | 已发布，成绩正式生效 | ✅ **可见** | ✅ |
| `failed` | 评阅失败，可重试 | ❌ 置空 | ✅ |

**各接口在各状态下的可用性**

| 接口 | `submitted` | `grading` | `review` | `published` | `failed` |
| --- | --- | --- | --- | --- | --- |
| `POST /grader/grade-submission` | ✅ 可用 | ❌ 400 | ❌ 400 | ❌ 400 | ✅ 可用 |
| `POST /grader/batch` | ✅ 被选中 | ❌ 跳过 | ❌ 跳过 | ❌ 跳过 | ✅ 被选中 |
| `POST /grader/retry` | ❌ 400 | ❌ 400 | ❌ 400 | ❌ 400 | ✅ 可用 |
| `POST /grader/review-publish` | ✅ 可用 | ❌ 400（禁止强制发布） | ✅ 可用 | ✅ 再次发布（追加新版本快照） | ✅ 可用 |

**关键约束（均有实测证据）**

- ✅ **已 `published` 不可重复评阅**：`grade-submission` 对 `sub-yi-os`（published）→ `400`
  `当前报告状态为「published」，仅允许对「submitted」或「failed」状态的报告启动评阅`
- ✅ **`review` 也不可重评**：对 `sub-xu-os`（review）→ `400`（同文案，状态为 `「review」`）
- ✅ **`retry` 只认 `failed`**：对 `sub-yi-os` → `400`
  `仅允许对「failed」状态的报告发起重试，当前状态为「published」`
- ✅ **`grading` 状态禁止教师强制发布**：`400`
  `报告当前正在后台评阅中，请等待评阅结束后再进行人工复核与发布`
- ✅ `batch` 只挑 `submitted` / `failed`，其余状态一律跳过（实测 `lab-os` → `total: 0`）
- ✅ **发布是「只前进」的**：`published` 可再次发布（`reviewVersion` 递增并追加 `history` 快照），但**无法退回** `review` / `submitted`

**发布时的版本快照**：每次 `review-publish` 都把一个 `ReviewVersion` 对象追加进 `history[]`，字段含 `version`（= 原长度+1）、`confirmedAt`、`teacherId`、`grades`、`totalScore`、`maxScore`、`summary`、`clamped`。前端可用 `history.length` 展示"复核轮次"。

---

## 6. 前端接入建议

### 6.1 现状：前端用的是浏览器内置演示数据

当前 React Demo **完全没有调用后端**，所有数据来自浏览器内置演示数据（`localStorage` / `IndexedDB`）或组件内硬编码常量。由此产生的关键问题：

| 现象 | 后果 |
| --- | --- |
| 课件列表、知识点是前端常量 | 与后端真实解析结果（含 `pending` 失败元件）不一致 |
| **评阅分数是假的** | UI 上的分数、评语、Rubric 明细**没有任何后端来源**，属前端自造 |
| 学情图表是前端算的 | 与 `analytics` 接口的全班口径（尤其"只统计 published"）不一致 |
| 答疑是本地规则 | 无法命中教师答疑卡，也无法注入课件上下文 |

> 🚨 **优先级最高的改造点**：把**评阅分数**与**学情**切到真实接口。这两处的「假数据」在演示中最容易被评委追问。

### 6.2 应改为调用的接口清单

| # | 前端功能 | 应调用 | 现状 | 替换优先级 |
| --- | --- | --- | --- | --- |
| 1 | 登录 | `POST /auth/login` | 前端假登录 | 🔴 高 |
| 2 | 课件列表 | `GET /materials?userId=<uid>` | 前端常量 | 🔴 高 |
| 3 | 课件详情/知识点 | `GET /materials/:id/context` | 前端常量 | 🟠 中 |
| 4 | 文件预览/下载 | `GET /files/:id/view`、`/files/:id/download` | 无 | 🟠 中 |
| 5 | 伴学答疑 | `POST /qa/ask`（+ `/qa/cards/search`） | 前端本地规则 | 🔴 高 |
| 6 | 助手上下文注入 | `POST /dsh/session-context`、`/dsh/quote` | 无 | 🟡 低 |
| 7 | 报告评分（试算） | `POST /grader/submit` | 前端假分 | 🔴 高 |
| 8 | 报告评阅 | `POST /grader/grade-submission`、`/grader/batch` | 前端假分 | 🔴 高 |
| 9 | 失败重试 | `POST /grader/retry` | 无 | 🟡 低 |
| 10 | 教师复核发布 | `POST /grader/review-publish` | 前端假分 | 🔴 高 |
| 11 | 作业学情 | `GET /analytics/assignment/:id?skipLLM=1` | 前端假图表 | 🔴 高 |
| 12 | 课程大盘 | `GET /analytics/course/:id?skipLLM=1` | 前端假图表 | 🟠 中 |
| 13 | 课件上传 | `POST /materials/upload` | 无 | 🟡 低 |
| 14 | **课程下拉框** | **`GET /courses?userId=<uid>`**（task-17 新增） | 前端硬编码 | 🔴 高 |
| 15 | **作业列表** | **`GET /assignments?userId=<uid>&courseId=<cid>`**（task-17 新增） | 前端硬编码 | 🔴 高 |
| 16 | **提交报告** | **`POST /submissions`**（task-17 新增） | 无 | 🔴 高 |
| 17 | **提交/成绩明细** | **`GET /submissions?assignmentId=&userId=`**、**`GET /submissions/:id?userId=`**（task-17 新增） | 无（最大阻塞项，已解除） | 🔴 高 |

### 6.3 推荐调用顺序

```
① 登录          POST /auth/login                      → 拿 user.id / user.role，存入前端状态
                              ↓
② 课程列表       GET  /courses?userId=<uid>            → 课程下拉框（学生=已选 / 教师=所授）
                              ↓
③ 作业列表       GET  /assignments?userId=<uid>&courseId=<cid> → 作业 + rubric（学生仅见已发布）
                              ↓
④ 课件与上下文   GET  /materials?userId=<uid>          → 课件列表
                GET  /materials/:id/context?userId=<uid> → 选中课件的逐页内容与图表
                              ↓
⑤ 伴学答疑       POST /qa/ask                          → 命中卡=教师权威答案；否则 agent_llm
                POST /dsh/session-context              → 需要把课件注入助手时
                              ↓
⑥ 提交报告       POST /submissions                     → 落盘 + 入库（status=submitted）
                              ↓
⑦ 评阅           POST /grader/grade-submission         → submitted → review
                POST /grader/batch?assignmentId=...    → 全班批量
                POST /grader/retry                     → 仅 failed 可重试
                              ↓
⑧ 查看提交       GET  /submissions?assignmentId=&userId=<uid>  → 学生：未发布成绩置空；教师：完整
                GET  /submissions/:id?userId=<uid>     → 单份详情
                              ↓
⑨ 教师复核发布   POST /grader/review-publish           → review → published（需教师身份）
                              ↓
⑩ 学情           GET  /analytics/assignment/:id?skipLLM=1
                GET  /analytics/course/:id?skipLLM=1   → 大盘
```

### 6.4 最小 `fetch` 示例（登录 + 拉课件）

```js
const BASE = "http://129.204.52.57:3088/api/learnbuddy";

/** 登录：返回 { ok, token, user }。注意：token 目前不被后端校验，仅作前端状态使用。 */
async function login(username, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || `登录失败 (HTTP ${res.status})`);
  return data; // { ok, token, user: { id, username, name, role } }
}

/** 课件列表：务必带 userId，否则会拿到教师私有资料（见 §4.3）。 */
async function fetchMaterials(userId, courseId) {
  const qs = new URLSearchParams({ userId });
  if (courseId) qs.set("courseId", courseId);
  const res = await fetch(`${BASE}/materials?${qs}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  return data.materials;
}

// ── 串联使用 ───────────────────────────────────────────
(async () => {
  const { user } = await login("student.lin", "123");       // user.id === "s-yi"
  const materials = await fetchMaterials(user.id, "network");
  console.log(`共 ${materials.length} 个课件`);

  const first = materials[0];
  // status: "pending" 表示后端解析失败——知识点为空是正常契约，不是 bug
  if (first.status === "pending") {
    console.warn(`课件《${first.title}》解析失败，无知识点可用`);
  }
  // blobId 是文件名，用于预览/下载
  if (first.blobId) {
    const viewUrl = `${BASE}/files/${encodeURIComponent(first.blobId)}/view`;
    const dlUrl   = `${BASE}/files/${encodeURIComponent(first.blobId)}/download`;
    console.log({ viewUrl, dlUrl });
  }
})();
```

### 6.5 必须注意的 6 个坑

1. **🚫 不要假设存在 token 鉴权。** 后端当前不校验 token；带上也无副作用，但**不能**用它做前端路由守卫的唯一依据（可直接读 `user.role`）。

2. **⚠️ 课件列表必须带 `userId`。** 否则 `private` 资料会混进列表（实测泄漏，见 §4.3）。
   *（task-17 新增的 `GET /courses` / `GET /assignments` / `GET /submissions` / `GET /submissions/:id` / `POST /submissions` 已把 `userId` 设为**必填**，缺失直接 `400`，不存在同类泄漏面。）*

3. **⚠️ `status: "pending"` 是正常契约。** 表示解析失败，`knowledge` 必为空数组。UI 应显示「解析失败/待重试」，**不要**当成加载中，也不要显示知识点。

4. **⚠️ AI 结果是降级数据，别当真。** `POST /qa/ask` 检查 `fallback === true`；`POST /grader/submit` 若 `summaryReview` 等于第 7.1 节给出的兜底串，即为假结果。演示时建议明确标注"当前为降级模式"，反而更显诚实。

5. **✅ 「提交报告」与「查询提交列表」端点已补齐（task-17，2026-09-12）。** *（原文记录：此前无端点暴露 `createSubmission` / `getSubmissions` / `getSubmission`，前端拿不到"某个学生的成绩与评语"，是当时最大的联调阻塞项。）*
   - 现在可以：`POST /submissions` 交报告 → `GET /submissions?assignmentId=&userId=` 拉列表 → `GET /submissions/:id?userId=` 拉详情。
   - ⚠️ **记得带 `userId`**（本域必填，缺失 `400`），并且**学生视角下未发布报告的成绩/评语恒为置空**，UI 要显示「评阅中/待发布」而不是空白。
   - 详见 [§3.7](#37-课程--作业--提交域task-17-新增)。

6. **⚠️ 学情分数字段全为 0 时先看 `publishedCount`。** 只有 `published` 报告才计入均分/分布（见 §3.6）。`publishedCount: 0` → 所有分数必然为 0。

---

## 7. 实测记录与代码不符之处

### 7.1 🚨 最重要：「真实 DeepSeek 模型」当前未生效

任务背景称"已接真实 DeepSeek 模型（文本/读图/评阅都实测通过）"。**本次实测结论与此不符**：两个 AI 端点均在**静默降级**，返回硬编码假数据。

**证据 1 — `POST /grader/submit` 返回的是源码里的兜底常量**

实测响应 `summaryReview` 为：
> `"报告格式规范，三次握手标志位清晰准确；但在过滤语法说明环节稍显简略，建议补充常用显示过滤器说明。"`

该字符串与 `src/services/grader.js:111` 的 `catch` 分支常量**逐字一致**。
（对比：`llm.js:590` 的 Mock 分支常量是 `"报告实验数据完备，TCP 三次握手过程时序分析准确，…"` —— **不是**这条。
两者 `totalScore` / `rubricChecks` 数值碰巧相同，**只有 `summaryReview` 能区分**，请以此判别。）

→ 说明 `chatCompletion()` **抛出了异常**（而非走 `!isConfigured()` 的 Mock 分支，否则会返回 Mock 那条文案）。
→ 即：`LLM_API_KEY` **已配置**（`isConfigured()` 为真），但**真实 HTTP 请求失败**。

**证据 2 — `POST /qa/ask` 未命中答疑卡时 100% 走 `catch` 兜底，且响应体缺 `contextInjected`**

实测 4 个提问（`UDP 校验和怎么计算？` / `为什么需要四次挥手？` / `什么是滑动窗口？` / `请解释拥塞控制算法。`）**全部**返回：

```json
{ "ok": true, "source": "agent_llm", "answer": "【LearnBuddy 伴学助手】针对问题「…」，建议先对照抓包过滤条件（如 tcp.port == 80），确认客户端握手包序号 seq 是否连续递增。", "fallback": true }
```

该响应**缺少 `contextInjected` 字段**。正常降级路径会带 `contextInjected`（`api.js:744`），只有**最外层 `catch`**（`api.js:756-763`）产出的对象没有它 → 确证模型调用抛异常。

**证据 3 — 耗时 0.5–0.8s**

实测 4 次 `qa/ask` 模型链路耗时均 < 1s，远低于任何真实模型往返（`llm.js` 超时阈值为 `LLM_TIMEOUT_MS`，默认 45000ms）。→ **不是超时**，是**立即失败**（连接/DNS/TLS 失败，或 HTTP 状态非 2xx 被 `_post` 的 `fail()` 拒绝）。

**影响面**

| 端点 | 影响 |
| --- | --- |
| `POST /qa/ask` | 非答疑卡提问全部返回无信息量的兜底话术 |
| `POST /grader/submit` | 返回固定 92 分，与报告质量**完全无关** |
| `POST /grader/grade-submission` / `batch` | 预期同样走规则降级（`_generateRuleBasedEvaluation`），产出 `max - [0,2,3,1,2]` 的固定分 |
| `POST /materials/upload` | 知识点抽取预期降级或失败（实测库中确有 `pending` 课件） |
| `GET /analytics/*?skipLLM=1` | 不受影响（已跳过模型） |

**建议排查动作（不在本任务范围内，仅记录）**

```powershell
# 在服务器上执行，直连供应商做 7 项实盘断言（脚本会脱敏打印，绝不落盘密钥）
cd plugins/dsh-plugin-learnbuddy
node scripts/verify-live-llm.mjs
```

需核查的环境变量（**仅列变量名，本文不含任何密钥**）：
`LLM_API_KEY`、`LLM_PROVIDER`、`LLM_BASE_URL`、`LLM_MODEL_TEXT`、`LLM_MODEL_VISION`、`LLM_TIMEOUT_MS`、`DEEPSEEK_API_KEY`。

> ⚠️ **本轮未修改任何代码**（任务要求只产出文档）。以上仅作为交付说明上报。

### 7.2 实测与代码/既有文档的具体差异

| # | 项 | 既有文档/预期 | **实测结果** | 处置 |
| --- | --- | --- | --- | --- |
| 1 | AI 端点真实性 | 背景称"接真实 DeepSeek，实测通过" | **实际静默降级，返回硬编码假数据** | 本文 §7.1 如实记录 |
| 2 | 登录响应 `role` | `README.md:363`、`FRONTEND_DEVELOPMENT_GUIDE.md` 写 `"role": "user"` | **实测 `"role": "teacher"`** | 本文以实测为准 |
| 3 | 登录密码校验 | 文档暗示需密码 | **数据库用户忽略密码**，任意密码均 200 | 本文 §2.2 记录为安全缺口 |
| 4 | 课件列表响应 | `README.md:373-383` 示例为 `uploadedAt`/`keyPointsCount`/`status:"parsed"` | **实际字段为 `date`/`knowledge`/`status:"ready"\|"pending"`**；无 `uploadedAt`/`keyPointsCount` | 本文 §3.2 以实测为准 |
| 5 | `Authorization` 头 | 响应头宣告 `Access-Control-Allow-Headers: …Authorization…` | **后端从不读取该头**，无任何鉴权 | 本文 §2.2 明确"未强制鉴权" |
| 6 | `POST /qa/cards/search` | — | **检索正常工作**（相关提问 `score: 100`, `count: 1`）；仅「三次握手」等**非关键词**查询返回 0 | 本文 §3.4 说明检索为关键词匹配 |
| 7 | 未匹配路由 | 预期 JSON 404 | **纯文本** `404 not found`（穿透到 DSH 反向代理） | 本文 §2.3 说明 |
| 8 | `GET /materials` 可见性 | 应隔离 `private` 资料 | **无 `userId` 时泄漏 `private` 资料** | 本文 §4.3 记录为缺陷 |
| 9 | 提交/成绩查询端点 | 任务描述"学生查询时成绩被置空" | **task-16 实测时该权限逻辑无 HTTP 端点可达**（`getSubmissions` 未被任何路由调用） | ✅ **task-17 已补齐 ㉑/㉒，红线在 API 层生效**（见 §3.7） |
| 10 | 学情接口鉴权 | 应限教师 | **无任何鉴权**，无需身份参数 | 本文 §4.4 记录 |

### 7.3 实测过的端点清单

**✅ 成功路径已实测（14 个）**

| 端点 | 实测覆盖 |
| --- | --- |
| `POST /auth/login` | 兜底账号 200 / 错误密码 401 / DB 用户错误密码 200 / 无密码 200 |
| `GET /materials` | 无参、`userId`、`courseId`、组合、不存在 userId（5 种）+ 可见性对照 |
| `GET /materials/:id/context` | 200（公开）/ 404（私有越权）/ 404（不存在） |
| `GET /files/:id/view` | 200（真实 PDF，校验响应头 + 二进制）/ 404 |
| `GET /files/:id/download` | 200（校验 `Content-Disposition`）/ 404 |
| `POST /qa/cards/search` | 命中 200（`score:100`）/ 无命中 200 / 空参 200 |
| `POST /dsh/session-context` | 200（`promptLength`=2318）/ 400 / 404 |
| `POST /dsh/quote` | 200（按 `page` 命中图表）/ 200（空参兜底） |
| `POST /dsh/message` | 200（`learnbuddy:ready`）/ 200（`learnbuddy:error`） |
| `POST /qa/ask` | 200（`teacher_card`）/ 200（`agent_llm` 降级） |
| `POST /grader/submit` | 200（降级结果） |
| `POST /grader/batch` | 200（`total:0`）/ 200（不存在作业）/ 400 |
| `GET /analytics/assignment/:id` | 200 / 404 |
| `GET /analytics/course/:id` | 200 / 404 |

**🟡 仅错误/边界路径已实测，成功写路径未实测（4 个）**

| 端点 | 已实测 | 未实测原因 |
| --- | --- | --- |
| `POST /materials/upload` | `400`（`.exe` 白名单、无后缀） | 成功上传会**新增课件记录且无删除端点**，为保护演示数据跳过；改以代码分析 + `pending` 实件旁证 |
| `POST /grader/grade-submission` | `400`×4（缺参/不存在/published/review） | 成功评阅会**把 `submitted` 改为 `review`**，不可逆；按任务要求优先只读 |
| `POST /grader/retry` | `400`×2（不存在/非 failed） | 无 `failed` 状态报告可供安全重试 |
| `POST /grader/review-publish` | `400`×3 / `403`×2 / `404`×1 | 成功发布会**翻转状态为 `published` 并写快照**，不可逆 |

**🔒 未实测但已确认无副作用（`POST /grader/batch` 的真实评阅分支）**：`lab-tcp` 下有 2 份 `submitted` 报告（`sub-zhou-net`、`sub-xu-net`），调用会真实评阅并改状态，**刻意未调用**。当前演示数据保持原样：两份 TCP 报告仍为 `submitted`。

**当前演示数据状态快照**（本次全部实测干扰**前后一致**，可作基线）

```json
// GET /analytics/assignment/lab-tcp?skipLLM=1  →  totalSubmissions: 2, publishedCount: 0, reviewedCount: 0
// GET /analytics/assignment/lab-os?skipLLM=1   →  totalSubmissions: 2, publishedCount: 1, reviewedCount: 2
// GET /materials                               →  10 条（实测时段内有其它联调者并发上传 1 条，与本任务无关）
```

> ✅ **副作用审计**：本任务对 4 个写端点共发起 16 次调用，**全部落在参数校验/权限校验的提前返回路径**（均在状态写入之前抛错）。
> 经 `lab-tcp` / `lab-os` 的 `publishedCount`、`reviewedCount` 与 `/materials` 条数在**干扰前后逐项比对**，确认**未产生任何状态变更**。
> 唯一变动（`mat-1789150155329-b4c6` 新增）来自**其它并发联调者**，非本任务所为。

**🆕 task-17 新增 5 个端点的验证记录（5 个，全部真实 HTTP 链路）**

| 端点 | 覆盖路径 |
| --- | --- |
| `GET /courses` | 200（学生/教师/另一教师 3 种身份）+ 400（缺 `userId`）+ 404（用户不存在） |
| `GET /assignments` | 200（学生 1 条 / 教师含草稿 2 条）+ 403（跨课程）+ 404（课程不存在）+ 400（缺 `userId`） |
| `GET /submissions` | 200（学生置空 / 教师完整 / published 学生可见 / submitted 置空）+ 400×2 + 403×2 + 404 |
| `GET /submissions/:id` | 200（教师完整 / 学生置空 / 学生看自己 published）+ 403×2 + 404 + 400 |
| `POST /submissions` | 200（JSON base64 成功落盘 + multipart 成功落盘）+ 400×6（缺参/白名单）+ 403×3 + 404×2 |

> 验证方式：`cd plugins/dsh-plugin-learnbuddy && node --test test/missing-endpoints.test.js`
> —— 11 个用例全部通过，使用**真实** `DatabaseStore`（in-memory SQLite + 种子数据）、**真实** `StorageService`（临时目录物理落盘）、**真实** HTTP Server，无 mock。
> 全量回归：`npm test` → 198 个用例（基线 187 + 新增 11），**新增用例 0 失败**；
> 基线中 14 个失败均为本机缺少 `@firecrawl/anydoc` 原生依赖（`engineUnavailable`）所致，与本次改动无关（改动前后失败集合逐条一致）。
> 关键反证断言：上传约 240KB 报告后，直查 `submissions` 表原始行，**既不含 base64 也不含报告正文**（`rawDump.length < 2000` 字节）。

### 7.4 已知端点缺口

> ✅ **task-17（2026-09-12）已补齐本表前 4 项中的 5 个端点**（课程/作业/提交列表与创建提交），
> 保留删除线仅作历史记录；其余条目仍为待办。

| 缺口 | 影响 | 状态 |
| --- | --- | --- |
| ~~无 `GET /submissions?assignmentId=&userId=`~~ | ~~前端无法拉取提交列表 / 学生成绩明细~~ | ✅ **已补齐（㉑）** |
| ~~无 `GET /submissions/:id?userId=`~~ | ~~无法查看单份提交详情~~ | ✅ **已补齐（㉒）** |
| ~~无 `POST /submissions`（提交报告）~~ | ~~前端无法发起新提交，评阅链路无法从 UI 走通~~ | ✅ **已补齐（㉓）** |
| ~~无课程列表端点（`getUserCourses` 无路由）~~ | ~~前端无法动态拉课程下拉框，只能硬编码~~ | ✅ **已补齐（⑲）** |
| ~~无作业列表端点（`getAssignments` 无路由）~~ | ~~前端无法拉作业列表，只能硬编码~~ | ✅ **已补齐（⑳）** |
| 无 `DELETE /materials/:id` | 上传后无法删除，联调易留垃圾数据 | ⏳ 待办 |
| 无 `DELETE /submissions/:id` | 新提交无法撤回，联调同样会留测试数据 | ⏳ 待办 |
| `GET /materials` 无 `userId` 时泄漏 `private` 资料 | 越权泄漏（§4.3） | ⏳ 待办（**新端点已不再有此模式**） |
| 登录不校验密码 | 安全缺口，上生产前必修 | ⏳ 待办 |
| `GET /analytics/*` 无鉴权 | 任何人可拉全班学情（§4.4） | ⏳ 待办 |

---

## 附录：网关层行为（非业务端点，供部署/排查参考）

| 路径 | 行为 |
| --- | --- |
| `/learnbuddy/*` | 托管前端静态产物，SPA fallback；带 `Access-Control-Allow-Origin: *`（实测 `/learnbuddy/` → `200 text/html`，619 字节） |
| `/api/learnbuddy/*` | 由本插件业务路由处理；未匹配 → 穿透到反向代理 → 纯文本 `404 not found` |
| 其它路径 | 透明反向代理到 DSH Web（`127.0.0.1:3080`），支持 HTTP 与 WebSocket upgrade |
| DSH 未启动时 | 网关回 `502` `{"ok":false,"error":"DSH 服务暂未启动或正在重启中"}` |

> 与前端业务无直接关系，故不计入本文「23 个端点」。

---

*本文由 task-16-api-docs 产出，task-17-missing-endpoints 增量更新（新增 §3.7 共 5 个端点，计数 18 → 23）。*
*task-16 标注「实测」的响应均为 2026-09-11 对 `http://129.204.52.57:3088` 的真实调用结果；task-17 新增端点的响应为 2026-09-12 对本仓真实 HTTP 路由的调用结果。*
*文档不含任何真实密钥。*
