# LearnBuddy Web

默认连接现有 LearnBuddy API；保留显式选择的本地交互演示模式。当前实现与验证边界见 [最新 UI 与导航记录](../../../docs/UI_HIERARCHY_AND_ASSISTANT-2026-09-12.md) 及 [师生数据接入记录](../../../docs/FRONTEND_REDESIGN-2026-09-12.md)。

## 本地启动

```sh
npm ci
npm run dev
```

访问 `http://127.0.0.1:5178/learnbuddy/`。本机预览使用 Node.js 24，当前 `.env.local` 将业务 API 连接到本机 3091、DSH 连接到本机 3089；分别运行 `npm run dev:services`、`npm run dev:dsh` 和 `npm run dev`，详见 [服务配置](../../../docs/LLM_AND_VOICE_SETUP.md)。未加载这份本机配置时，开发配置默认代理到团队服务；不要把两者的数据混淆。

默认 API 路径为同源 `/api/learnbuddy`，可用 `VITE_API_BASE` 指定其他测试后端。正式部署时应保持前端、API 和 DSH 同源；不要在 HTTPS 页面里硬编码 HTTP API。

需要离线交互演示时，访问 `http://127.0.0.1:5178/learnbuddy/?mode=demo`，或通过 `VITE_DATA_MODE=demo` 构建。演示模式使用本地样例及浏览器存储，不是后端结果；不会在网络失败时自动切入。

```sh
npm test
npm run build
npm run build:dsh
```

网页产物为 `dist/`，基础路径 `/learnbuddy/`。本轮没有部署到线上。修改 Context 类型等基础模块后，若开发热更新出现上下文错误，完整刷新页面；生产产物不使用热更新。

## 本地 AutoGrader 测试数据

启动 `npm run dev:services` 后，在 `web` 目录运行 `npm run demo:autograder`。脚本只操作 `.dsh-preview/teaching-data`：生成计算机网络与操作系统作业的测试 PDF，用现有解析链路保存正文，保持新提交为“待评阅”，不预填分数。教师在评阅页点击“AI 辅助评阅”后，服务端以 `strictLLM` 模式运行真实 AutoGrader；模型不可用时明确报错，不把规则或固定分数当作真实评阅。旧的内置教学样例仍可作为兜底展示，页面会标明来源。脚本还创建一份没有学生提交的草稿，用来测试评分项的新增、删除和保存。重复运行会保留已有评阅与教师修改。

访问 `/learnbuddy/#grading/lab-tcp` 或 `/learnbuddy/#grading/lab-os` 查看测试报告，或访问 `/learnbuddy/#assignment/local-rubric-draft` 测试可编辑评分标准。测试材料并非学生真正上传的原件，阅读器默认显示 PDF 的真实解析文本，生成的 PDF 可单独打开。

教师修改单项分数时，总分立即重算；报告批注写入本地服务端，切换评分证据或刷新页面后仍可读取。最终成绩与反馈仍由教师确认发布。

## 使用边界

- `student.lin`、`teacher.chen` 等演示账号密码为 `123`，身份以登录接口响应为准；当前服务端鉴权仍需完善。
- 课件列表、原文、答疑与教学统计来自后端。解析失败、回答降级、未发布成绩分别呈现。
- 作业、提交、成绩与教师名单来自工作台接口；新报告接收与提交门禁仍待接入。
- 评阅与发布会真实写入服务端数据。只对明确选择的记录操作；前次表单写入验收使用本机独立样例库；本轮为 UI 与导航验证。
- 备课与实验安排草稿暂未发布。语音只进入草稿，需人工核对与发送；浏览器兼容、HTTPS、麦克风及实际听写仍需演示设备验证。
- 统一助手使用原生 DSH 会话，材料与教师已确认答疑卡可附入草稿，不自动发送；不再提供第二个课件答疑入口。

## 文件入口

- `src/api.ts`：统一请求、身份参数、错误与降级处理。
- `src/context.tsx`：账号、资料刷新、会话内评阅结果与异步任务。
- `src/navigation.ts`、`src/pages/Workspace.tsx`：页面层级、个人工作台、课程总览与课程页。
- `src/pages/Library.tsx`、`Material.tsx`：课程资料、个人参考、上传、正文与教师准备。
- `src/pages/Academic.tsx`、`AssignmentForm.tsx`、`Online.tsx`：作业与成绩、作业表单、评阅与教学反馈。
- `src/pages/Assignments.tsx`：显式演示模式中的原有完整交互。
- `src/components/DshAssistant.tsx`、`VoiceInput.tsx`、`dsh-ui/client.cjs`：统一助手、原生引用与可编辑听写。
- `src/product.css`：本轮组件、课程层级和响应式视觉规则。
