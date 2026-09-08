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
