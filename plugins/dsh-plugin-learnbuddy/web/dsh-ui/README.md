# LearnBuddy DSH 界面 v0.1

2026-09-10。黄山要求先简单做一版 DSH UI，后续再整体调整。本目录属于前端工作范围；独立于嘉俊维护的业务插件后端。

## 已落地

- 实际运行并验证官方 `@deepseek-ai/dsh@0.1.5-rc.1`，使用本项目隔离的本地目录。
- 通过 `dsh.client` 加载浏览器插件；使用 `ctx.theme.overrideTokens` 设置浅色与深色配色，替换品牌标识与名称。
- 原生空会话欢迎行改为「一起把问题想明白」，去掉原有「探索未至之境 / 预览版」展示；输入提示改成「关于这份材料，你想问什么？」。
- **材料工作台和报告反馈页直接内嵌原生 DSH 对话**，学生操作不再打开独立页面。工作台托管于 `/learnbuddy/`，对话 iframe 使用 `/?learnbuddy=embedded`；根路径完整 DSH 保留为维护与调试入口。
- 嵌入模式收起 DSH 外部导航与工作区选择，保留原生编辑器、会话内容、附件、模型选择与发送/停止操作。手机沿用上下阅读布局，窄栏调整对话的标题、资料卡与输入框。
- 点击课件中的图引用或「引用本篇材料 / 课程资料」，内容直接送入本页助手的引用卡。引用卡通过 DSH 的 `inputActions.setDraft` 追加到已有草稿，不自动发送。
- 本地预览按 `用户 ID:材料或报告 ID` 保存 DSH Session 对应关系；重新打开恢复原会话。可使用的主机名由宿主注入的允许列表决定：默认仅 `127.0.0.1` 与 `localhost`，公网入口需显式配置（见「公网允许列表」）。正式用户、课程与 Session 的服务端授权仍待后台接入。
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

打开材料页时，内嵌助手通过 DSH 自身的 Workspace 与 Session API 关联预览目录，恢复该账号与材料对应的 Session，首次打开时新建。默认只在 `127.0.0.1` 与 `localhost` 提供这套自动关联；公网主机名要先按下节配置允许列表。生产环境未接入课程工作区时会明确报错。预览隐藏首次模型配置弹窗。根路径维护入口仍保留模型设置。

## 公网允许列表（`LEARNBUDDY_ALLOWED_HOSTS`）

要让公网域名或 IP 使用同一套内嵌助手，由**提供该页面的 DSH 进程**给出允许列表：

```sh
# 例：预览实例（PM2 进程 learnbuddy-ui-preview）改用公网入口
export PATH=/home/jiajun/.local/bin:$PATH
LEARNBUDDY_ALLOWED_HOSTS='learn1learn.stifer.xyz,129.204.52.57' \
  pm2 restart learnbuddy-ui-preview --update-env
```

`host.js` 读取该变量、去空白、忽略空项、统一小写，再把结果作为 `allowedHosts` 注入 `globalThis.__LEARNBUDDY_UI__`；`client.cjs` 的 `isHostAllowed()` 只比较 `location.hostname`，与协议、端口无关。

- **安全默认不变**：未设置、为空，或整串都不是合法主机名时，`allowedHosts` 为空，页面回落到与改动前完全一致的默认——仅放行 `127.0.0.1` 与 `localhost`。写错只会挡住页面，不会放开。
- 配置项只做**追加**：配上公网主机名后本机预览仍可用。
- 只接受裸主机名。`https://…`、`host:3088`、`*`、`*.stifer.xyz`、含空格或斜杠的值一律丢弃；不支持通配符，也不做端口白名单。
- 三处判定共用同一个 `isHostAllowed()`：发送来源白名单 `allowedOrigins()`、嵌入会话关联（`initialize`）、侧边栏「进入学习对话」的预览工作区分支。`previewWorkspace` 与允许列表必须同时成立才会绑定宿主注入的工作区，公网主机名不会绕过白名单。
- 注入时机不变：只设置 `LEARNBUDDY_PREVIEW_WORKSPACE` 时仍注入 `__LEARNBUDDY_UI__`；两者都没设置时完全不注入。

### 安全影响（必须同时接受）

开启公网主机名后，**所有公网访客共用同一个宿主注入的预览工作区与会话**：同一份工作区、同一批会话记录，也共用 DSH 开发者会话的工具权限。这正是原先只放行本机的原因，交接文档写明「不能删除限制后让学生共用开发者工作区」。当前放宽只适用于演示/预览验收，**不是学生正式入口**；DSH 自身的登录门禁仍然独立存在（未认证访客会被 DSH 拦截，而不是被本白名单放行）。收紧方向：后端按已认证用户下发专用 Workspace/Session；网关层加 IP 白名单或 Basic Auth；只把 `LEARNBUDDY_ALLOWED_HOSTS` 设在受控实例上。

## 团队集成

1. 嘉俊先核对服务器 DSH 版本。这版只验过 `0.1.5-rc.1`，不承诺旧版本插槽兼容。
2. 在 `web/` 运行 `npm run build` 与 `npm run build:dsh`。
3. 在实际 DSH profile 的 patch 中添加本插件的 `host.js`，例如以下路径改成部署机器的真实路径：

```yaml
- insert:
    - id: learnbuddy-ui
      name: /部署目录/plugins/dsh-plugin-learnbuddy/web/dsh-ui/host.js
```

4. 用 `LEARNBUDDY_ALLOWED_HOSTS` 声明公网主机名并重启该 DSH 进程（见上一节）；未声明时按默认只放行本机。
5. 启动 DSH 后核对 `/learnbuddy/`、iframe 路由与身份认证、学习欢迎文案及本页资料引用。正式环境应由后端提供课程到 Workspace/Session 的授权映射，替换本地预览的会话关联。不能仅因 HTTP 页面返回成功就认定 Agent 与课程数据已接通。
6. 服务器源与版本确认后，再统一原有 `3088` 网关的路由和鉴权。本地验证与服务器同步分别记录，最新进展见[部署记录](../../../../docs/DEPLOYMENT-2026-09-10.md)。

产物路径：`web/dist/` 与 `web/dsh-ui/dist/client.js`。`build.mjs` 包装 CJS 为 DSH 公开的浏览器模块注册格式；React 从 DSH 宿主提供，不把网页的 React 19 副本打入 DSH。

## 本轮验收与限制

网页构建、UI 插件构建、网页侧 20 项 vitest 与插件侧 26 项 `node:test` 全部通过；新增允许列表用例覆盖安全默认（未配置时公网主机名被拒）、已配置公网主机名放行、未列入的主机名仍被拒、大小写/空白/空项/非法项归一、判定与端口协议无关、宿主注入行、以及 `dist/client.js` 与源码一致。原有连接测试继续覆盖来源窗口、origin、请求 ID、账号/资料标识、运行时拒绝、超时与卸载清理。实际浏览器验证：本页加载原生会话、图片说明引用、保留已有草稿、知识速览来回切换、收起/重开助手、不同课件切换与草稿恢复、报告页「聊聊反馈」内嵌、原 `5178` 开发入口、390px 手机布局。手机初始化保持原文阅读位置，主动点图引用才滚到助手。未见本轮页面警告或报错。

- 当前 DSH 侧没有配置真实模型，未发送模型问题。工作台整理、生成、评阅仍采用模拟；教师答疑卡自动检索尚未接入 DSH。
- 交接当前支持文字与图片说明。原始图片、PDF、Office 文件没有传入 DSH；界面与交接内容明确区分，后续应对接正式上传与解析接口。
- 原工作台模拟聊天记录未删除，也不传入 DSH。新会话与草稿由 DSH 管理；引用卡在当前 iframe 内存中，重新打开会根据当前材料重新准备引用。
- Session 对应关系仅用于本机演示的会话连续性，**不是服务端权限隔离**。DSH 的开发者会话与工具权限尚未映射课程师生身份，不能作为正式学生共享入口发布。把公网主机名加入允许列表后，这批访客共用同一个预览工作区与会话（见「公网允许列表 · 安全影响」）。
- 嵌入外壳样式依赖该版本的公开 `data-slot` 标记和其周围结构。品牌 Slot 提供自定义欢迎标题；原生标题组不再展示。该版本无输入提示文案 Slot，因此在本插件中仅适配原生编辑器的展示属性与空白提示，未修改 DSH 安装包、编辑器内容或语言偏好。升级 DSH 时须复核这些接缝。
- 原生「添加工作区」在当前自动化环境无法打开 macOS 文件夹选择器；本地预览通过受限目录关联，无需改变机器权限。

## 依据

- [DSH Client Modules](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/client-modules.md)
- [DSH Slots](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/slots.md)
- [DSH Theme](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-theme/README.md)
- [DSH WebServer](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/webserver/README.md)

以本地安装的 `0.1.5-rc.1` 包内代码和类型进行联调；上述主分支文档可能继续变化。
