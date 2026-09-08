# LearnBuddy 前端开发与 DSH 皮肤挂载指南 (黄山专属)

> **写给黄山**：本指南旨在让你用**最熟悉的前端技术栈（React / Vite / Vue / Tailwind）**，以最低心智负担完成 LearnBuddy 的前端工作台开发，并完美挂载到 DeepSeek Harness (DSH) 成为原生一体化产品。

---

## 核心设计理念：方案 A（定制独立工作台 / 皮肤挂载）

很多同学误以为做 DSH 项目必须去硬啃 DSH 复杂的底层源码——**完全不需要！**

我们采用 **“方案 A：定制皮肤/独立工作台”**：
1. **你写你的**：你在本地爱怎么写前端就怎么写（React + Tailwind 极其推荐），按常规开发网页。
2. **免密测试与单入口**：按会议要求，提供极简的统一登录入口，内置测试账号凭据 `user / 123`，评委一键进入。
3. **接口现成**：嘉俊已经在 DSH 插件中为你准备好了全部 Mock 接口（CORS 已配置，见后文）。
4. **一键集成进 DSH**：最终打包出的静态文件，直接由 DSH 的 Web 服务原生承载，评委访问 `http://服务器IP:3080/learnbuddy` 即是你的完整作品！

---

## 一、目录结构约定

你的前端工程放置在项目仓库的如下位置：

```text
learnbuddy/
└── plugins/
    └── dsh-plugin-learnbuddy/
        ├── src/                  # 嘉俊维护的 DSH 后端逻辑与 Skills
        │   ├── index.js
        │   └── routes/api.js     # 后端 API 与 Mock 数据
        │
        └── web/                  # ★ 黄山的工作目录（前端工程）
            ├── package.json
            ├── vite.config.ts
            ├── src/              # 前端源码（组件、页面、状态）
            └── dist/             # 打包输出目录（自动由 DSH 静态托管）
```

---

## 二、前端页面结构建议（极速拿高分）

根据赛事需求与会议决议，建议前端 Demo 包含以下三大核心视窗：

```text
┌────────────────────────────────────────────────────────────────────────┐
│  LearnBuddy 教学智能体与 AutoGrader 工作台       [测试账号: user] [退出]│
├───────────────────────────────────┬────────────────────────────────────┤
│ 左侧：课件与实验材料               │ 右侧：核心功能切换卡片              │
│                                   ├────────────────────────────────────┤
│ 📁 计算机网络实验                 │ [ 💬 伴学答疑舱 ]  [ 📝 实验批阅台 ] │
│  ├─ 实验一：Wireshark与TCP分析.pdf │                                    │
│  └─ 实验二：静态路由配置.docx       │ 提问框：支持输入问题或上传截图      │
│                                   │ ---------------------------------- │
│ 知识点速览：                      │ 对话流：                           │
│  • TCP 三次握手 (SYN/ACK)         │ 👨‍🎓 学生: "抓包全是红色 RST 是为何?"│
│  • 常见状态标志位                 │ 🤖 AI(命中教师答疑卡):             │
│                                   │    "目标端口未开启监听，请排查..."  │
└───────────────────────────────────┴────────────────────────────────────┘
```

---

## 三、已有后端接口速查（直接调，已配好跨域）

本地开发时，直接通过 `fetch` 或 `axios` 调用嘉俊提供的接口（默认端口以 DSH 为准，例如 `http://localhost:3080`）：

### 1. 统一单入口登录
- **地址**：`POST /api/learnbuddy/auth/login`
- **入参**：
  ```json
  { "username": "user", "password": "123" }
  ```
- **出参**：
  ```json
  {
    "ok": true,
    "token": "mock-token-learnbuddy-user-123",
    "user": { "username": "user", "name": "测试学员/助教", "role": "user" }
  }
  ```

### 2. 课件材料列表
- **地址**：`GET /api/learnbuddy/materials`
- **出参**：
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
        "keyPointsCount": 4
      }
    ]
  }
  ```

### 3. 伴学答疑问答（含答疑卡机制）
- **地址**：`POST /api/learnbuddy/qa/ask`
- **入参**：
  ```json
  { "question": "抓包出现红色 TCP RST 是怎么回事？" }
  ```
- **出参**（自动区分是命中教师预设卡，还是模型生成）：
  ```json
  {
    "ok": true,
    "source": "teacher_card", // 或 "agent_llm"
    "title": "抓包中出现红色 TCP RST 的常见排查",
    "answer": "抓包中看到红色的 RST 通常表示目标端口未开启监听..."
  }
  ```

### 4. 实验报告自动批阅（AutoGrader）
- **地址**：`POST /api/learnbuddy/grader/submit`
- **入参**：
  ```json
  { "reportTitle": "计网实验一_张三.pdf" }
  ```
- **出参**（含总分与逐项细则）：
  ```json
  {
    "ok": true,
    "totalScore": 92,
    "summaryReview": "报告整体优秀，三次握手标志位清晰；仅过滤语法部分缺少说明。",
    "rubricChecks": [
      { "item": "实验拓扑与网络环境描述", "score": 10, "max": 10, "status": "pass" },
      { "item": "Wireshark 抓包截图与过滤语法", "score": 12, "max": 20, "status": "warning" },
      { "item": "三次握手报文序号与时序图分析", "score": 40, "max": 40, "status": "pass" }
    ]
  }
  ```

---

## 四、本地开发三步走

1. **进入前端工程目录**：
   ```bash
   cd plugins/dsh-plugin-learnbuddy/web
   npm install
   npm run dev
   ```
2. **写代码与效果预览**：在浏览器 `http://localhost:5173` 调试界面，直接调上述 Mock 接口，样式调到你最满意的比赛水准。
3. **打包交付**：
   ```bash
   npm run build
   ```
   产物会生成在 `plugins/dsh-plugin-learnbuddy/web/dist`。嘉俊启动服务器上的 DSH 后，系统便会自动识别并全权托管你的界面！
