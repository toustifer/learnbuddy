# LearnBuddy Web

默认连接现有 LearnBuddy API；保留显式选择的本地交互演示模式。当前实现与验证边界见 [2026年9月12日接入记录](../../../docs/FRONTEND_INTEGRATION-2026-09-12.md)。

## 本地启动

```sh
npm ci
npm run dev
```

访问 `http://127.0.0.1:5178/learnbuddy/`。本轮使用 Node.js 24；开发服务只监听本机，并将业务 API、DSH 页面及连接代理到 `http://129.204.52.57:3088`。不会改变远端部署或数据库配置。

默认 API 路径为同源 `/api/learnbuddy`，可用 `VITE_API_BASE` 指定其他测试后端。正式部署时应保持前端、API 和 DSH 同源；不要在 HTTPS 页面里硬编码 HTTP API。

需要离线交互演示时，访问 `http://127.0.0.1:5178/learnbuddy/?mode=demo`，或通过 `VITE_DATA_MODE=demo` 构建。演示模式使用本地样例及浏览器存储，不是后端结果；不会在网络失败时自动切入。

```sh
npm test
npm run build
npm run build:dsh
```

网页产物为 `dist/`，基础路径 `/learnbuddy/`。本轮没有部署到线上。修改 Context 类型等基础模块后，若开发热更新出现上下文错误，完整刷新页面；生产产物不使用热更新。

## 使用边界

- `student.lin`、`teacher.chen` 等演示账号密码为 `123`，身份以登录接口响应为准；当前服务端鉴权仍需完善。
- 课件列表、原文、答疑与教学统计来自后端。解析失败、回答降级、未发布成绩分别呈现。
- 作业目录与演示提交 ID 暂用团队约定条目，不能当作实时列表。新提交、门禁、学生成绩查询等等待接口开放。
- 评阅与发布会真实写入服务端数据。只对明确选择的记录操作；本轮浏览器写入测试使用本地模拟接口。
- 备课与实验安排草稿暂未发布。语音只进入草稿，需人工核对与发送；浏览器兼容、HTTPS、麦克风及实际听写仍需演示设备验证。
- DSH 使用原生会话，材料引用不自动发送。默认课件答疑可显示教师答疑卡及降级来源。

## 文件入口

- `src/api.ts`：统一请求、身份参数、错误与降级处理。
- `src/context.tsx`：账号、资料刷新、会话内评阅结果与异步任务。
- `src/pages/Library.tsx`、`Material.tsx`：资料库、上传、正文与教师准备。
- `src/pages/Online.tsx`：接口未齐时的在线作业、评阅与教学反馈。
- `src/pages/Assignments.tsx`：显式演示模式中的原有完整交互。
- `src/components/ApiAssistant.tsx`、`DshAssistant.tsx`、`VoiceInput.tsx`：答疑、DSH 引用和可编辑听写。
