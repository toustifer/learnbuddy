# LearnBuddy DSH 界面 v0.1

2026-09-10。黄山要求先简单做一版 DSH UI，后续再整体调整。本目录属于前端工作范围；独立于嘉俊维护的业务插件后端。

## 已落地

- 实际运行并验证官方 `@deepseek-ai/dsh@0.1.5-rc.1`，使用本项目隔离的本地目录。
- 通过 `dsh.client` 加载浏览器插件；使用 `ctx.theme.overrideTokens` 设置浅色与深色配色，替换品牌标识与名称。
- 原生空会话欢迎行改为「一起把问题想明白」，去掉原有「探索未至之境 / 预览版」展示；输入提示改成「关于这份材料，你想问什么？」。
- **材料工作台和报告反馈页直接内嵌原生 DSH 对话**，学生操作不再打开独立页面。工作台托管于 `/learnbuddy/`，对话 iframe 使用 `/?learnbuddy=embedded`；根路径完整 DSH 保留为维护与调试入口。
- 嵌入模式收起 DSH 外部导航与工作区选择，保留原生编辑器、会话内容、附件、模型选择与发送/停止操作。手机沿用上下阅读布局，窄栏调整对话的标题、资料卡与输入框。
- 点击课件中的图引用或「引用本篇材料 / 课程资料」，内容直接送入本页助手的引用卡。引用卡通过 DSH 的 `inputActions.setDraft` 追加到已有草稿，不自动发送。
- 本地预览按 `用户 ID:材料或报告 ID` 保存 DSH Session 对应关系；重新打开恢复原会话。正式用户、课程与 Session 的服务端授权仍待后台接入。
- iframe 与工作台双向检查来源窗口、精确 origin、请求 ID、上下文标识；接收端限制长度与返回路径。等 DSH 确认后才显示就绪，连接失败提供原位重试，面板卸载会清理重试定时器。

## 本地启动

需要 Node.js **22.19+ 或 24+**。DSH 比当前网页开发要求更高；无需升级系统全局 Node，可在本次命令中使用相应版本。

在 `web/` 下运行：

```sh
npm ci
npm run build
npm run setup:dsh
npm run dev:dsh
```

第一次使用或重启后，用命令输出的 DSH 鉴权链接登录一次，再打开 [材料工作台与内嵌助手](http://127.0.0.1:3089/learnbuddy/#material/mat-tcp)。不要把鉴权参数写进代码、文档或分享链接。

同一服务中的工作台：[LearnBuddy](http://127.0.0.1:3089/learnbuddy/)。也保留原有 `npm run dev` 的 `5178` 入口。两个端口的浏览器存储独立，切换入口不会迁移原演示数据。

`dev:dsh` 自动构建 UI 插件，只绑定 `127.0.0.1:3089`。依赖、DSH home、预览学习目录都在被忽略的 `.dsh-preview/` 内；不会使用 `~/.dsh`、团队服务器或现有 DSH 配置。预览不配置 API Key，也不调用模型。

打开材料页时，内嵌助手通过 DSH 自身的 Workspace 与 Session API 关联预览目录，恢复该账号与材料对应的 Session，首次打开时新建。只在本地预览环境提供自动关联；生产环境未接入课程工作区时会明确报错。预览隐藏首次模型配置弹窗。根路径维护入口仍保留模型设置。

## 团队集成

1. 嘉俊先核对服务器 DSH 版本。这版只验过 `0.1.5-rc.1`，不承诺旧版本插槽兼容。
2. 在 `web/` 运行 `npm run build` 与 `npm run build:dsh`。
3. 在实际 DSH profile 的 patch 中添加本插件的 `host.js`，例如以下路径改成部署机器的真实路径：

```yaml
- insert:
    - id: learnbuddy-ui
      name: /部署目录/plugins/dsh-plugin-learnbuddy/web/dsh-ui/host.js
```

4. 启动 DSH 后核对 `/learnbuddy/`、iframe 路由与身份认证、学习欢迎文案及本页资料引用。正式环境应由后端提供课程到 Workspace/Session 的授权映射，替换本地预览的会话关联。不能仅因 HTTP 页面返回成功就认定 Agent 与课程数据已接通。
5. 服务器源与版本确认后，再统一原有 `3088` 网关的路由和鉴权。本地验证与服务器同步分别记录，最新进展见[部署记录](../../../../docs/DEPLOYMENT-2026-09-10.md)。

产物路径：`web/dist/` 与 `web/dsh-ui/dist/client.js`。`build.mjs` 包装 CJS 为 DSH 公开的浏览器模块注册格式；React 从 DSH 宿主提供，不把网页的 React 19 副本打入 DSH。

## 本轮验收与限制

网页构建、UI 插件构建和 20 项自动测试通过；新增连接测试覆盖来源窗口、origin、请求 ID、账号/资料标识、运行时拒绝、超时与卸载清理。实际浏览器验证：本页加载原生会话、图片说明引用、保留已有草稿、知识速览来回切换、收起/重开助手、不同课件切换与草稿恢复、报告页「聊聊反馈」内嵌、原 `5178` 开发入口、390px 手机布局。手机初始化保持原文阅读位置，主动点图引用才滚到助手。未见本轮页面警告或报错。

- 当前 DSH 侧没有配置真实模型，未发送模型问题。工作台整理、生成、评阅仍采用模拟；教师答疑卡自动检索尚未接入 DSH。
- 交接当前支持文字与图片说明。原始图片、PDF、Office 文件没有传入 DSH；界面与交接内容明确区分，后续应对接正式上传与解析接口。
- 原工作台模拟聊天记录未删除，也不传入 DSH。新会话与草稿由 DSH 管理；引用卡在当前 iframe 内存中，重新打开会根据当前材料重新准备引用。
- Session 对应关系仅用于本机演示的会话连续性，**不是服务端权限隔离**。DSH 的开发者会话与工具权限尚未映射课程师生身份，不能作为正式学生共享入口发布。
- 嵌入外壳样式依赖该版本的公开 `data-slot` 标记和其周围结构。品牌 Slot 提供自定义欢迎标题；原生标题组不再展示。该版本无输入提示文案 Slot，因此在本插件中仅适配原生编辑器的展示属性与空白提示，未修改 DSH 安装包、编辑器内容或语言偏好。升级 DSH 时须复核这些接缝。
- 原生「添加工作区」在当前自动化环境无法打开 macOS 文件夹选择器；本地预览通过受限目录关联，无需改变机器权限。

## 依据

- [DSH Client Modules](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/client-modules.md)
- [DSH Slots](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/slots.md)
- [DSH Theme](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-theme/README.md)
- [DSH WebServer](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/webserver/README.md)

以本地安装的 `0.1.5-rc.1` 包内代码和类型进行联调；上述主分支文档可能继续变化。
