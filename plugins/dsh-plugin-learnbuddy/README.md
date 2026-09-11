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

1. 进入插件目录安装本地引用：
   ```bash
   # 在 DSH profile 目录下添加本本地插件
   dsh plugin --profile web add "D:/obi/collected_program/经历/learnbuddy/plugins/dsh-plugin-learnbuddy"
   ```
   *或者在开发配置中直接引入 `plugins/dsh-plugin-learnbuddy`。*

2. 启动 DSH Web 实例：
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

### 验收命令（服务器上执行）

```powershell
# 内嵌助手入口：开启后应为 200（不再是 401）
curl.exe -s -o NUL -w "%{http_code}`n" "http://127.0.0.1:3088/?learnbuddy=embedded"
# WebSocket 握手：应为 101
curl.exe -i -s -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" "http://127.0.0.1:3088/api/remote.mux" | Select-String "HTTP/"
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
