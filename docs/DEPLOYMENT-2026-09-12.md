# 新版工作台公网部署 · 2026-09-12

新版已发布到原入口：**http://129.204.52.57:3088/learnbuddy/**。此记录取代 9 月 10 日“只提供 SSH 转发预览、尚未切换公网”的部署状态。

## 发布内容与运行方式

- 主发布包：`6b5d48e2807d433dbb3a04a2d8796395adf06623`，服务器目录 `/home/jiajun/learnbuddy-releases/learnbuddy-ui-6b5d48e`。包含新版网页、课程工作台与作业管理配套接口、HTTP 标识生成兼容处理。
- 助手更新包：`c24d7777bcabe068535505061fe6548729516804`，目录 `/home/jiajun/learnbuddy-releases/learnbuddy-assistant-c24d777`。修复公网工作区关联；只允许服务器明确配置的站点来源，保留本机预览。
- 网关进程仍为 `learnbuddy-gateway`，公网仍为 `3088`。启动入口改为主发布目录中的 `deploy/serve-existing-gateway.mjs`，从原 `server.js` 导入现有网关、数据库和中间件，再补上新版课程接口。
- 原后端位于 `/home/jiajun/learnbuddy/plugins/dsh-plugin-learnbuddy`，其未提交改动和 `server.js` 原文保留。数据库仍为该目录下的 `data/learnbuddy.db`，上传目录仍由原后端使用。
- DSH 仍由 `learnbuddy-ui-preview` 在 `127.0.0.1:3089` 运行，保留原 DSH HOME、配置与会话。UI 的 `host.js`、`client.cjs`、`dist/client.js` 更新到原预览目录；`client.cjs` 使用包含听写与来源校验的可重建 JavaScript，兼容原服务器构建器。
- DSH 进程增加 `LEARNBUDDY_PUBLIC_ORIGIN=http://129.204.52.57:3088`。网关原有 DSH 凭据注入、Host/Origin 转发规则保持原样。
- 临时验收服务 `learnbuddy-release-check` 已撤下；正式三个进程已保存到 PM2 启动配置。

网页构建采用 `VITE_DATA_SOURCE=remote`、`VITE_DATA_MODE=live`、`VITE_API_BASE=/api/learnbuddy`，页面显示“在线”，读取服务器数据。发布包不包含本机 `.env.local`、密钥、模型、数据库或上传文件。

## 实测结果

| 检查 | 结果 |
| --- | --- |
| 主发布包 | 67 个文件逐项 SHA-256 一致 |
| 公网页面与资源 | HTML 和 7 个 JS/CSS 文件共 8 项，与发布产物一致；最终源码再次构建结果相同 |
| 助手插件 | 公网返回的模块包含完整 38,216 字节构建产物；DSH 另附 source-map 注释 |
| 课程汇总接口 | 学生：3 门课、2 项作业、1 份本人提交、无全班名单；教师：3 门课、2 项作业、4 份提交、8 条课程选课关系 |
| 学生数据边界 | 未发布成绩不出现在学生汇总返回中 |
| WebSocket | 携带公网 Origin 和同站点请求头，握手为 HTTP 101 |
| 浏览器 | 原地址登录、教师与学生首页、课程总览、课程资料、作业列表通过；助手显示“会话已连接”和“引用已就绪” |
| 资料引用 | 点击后进入可编辑草稿；清空后可重新引用。验收草稿已清空，未发送模型问题 |
| 资源异常 | 缺失 JS 返回 404；`.env`、`RELEASE.json` 路径仅返回 SPA 页面，不包含文件内容 |
| 数据保全 | 原 `server.js` 的 SHA-256 不变；部署前后数据库逻辑内容一致 |
| 自动检查 | 45 项前端测试、4 项部署适配和教学接口测试通过；网页与 DSH 构建通过 |

保存配置时：原 `dsh-web` PID `55383` 未变；网关 PID `1032354`、累计重启 14；DSH 预览 PID `1033685`、累计重启 13。重启计数包含之前运行历史，本轮切换后保持稳定，未清零。

## 尚未验证或接入

- 本轮验证页面、服务器数据读取、DSH 连接及引用，没有验证真实模型回答、评阅或教师发布，也没有修改教学记录。
- 原地址为 HTTP，浏览器不能在此来源录音；服务器听写状态实测 `ready: false`。完整公网语音输入还需要 HTTPS 和服务器听写服务。
- 现有演示账号、正式认证及新报告提交门禁的既有边界未因部署改变。
- 没有覆盖或合并嘉俊服务器工作目录，也没有替团队合并 GitHub 主分支。

## 回退

主发布目录中的 `server-backup/` 保留原 DSH 三个 UI 文件、数据库快照及原进程信息；网关原启动配置保存在 `gateway-before.config.json`。这些配置仅服务器账号可读，不在网页托管目录内。

需要回退时，以 `jiajun` 身份执行以下步骤；**本轮没有执行回退**：

```sh
export PATH=/home/jiajun/.local/bin:$PATH
release=/home/jiajun/learnbuddy-releases/learnbuddy-ui-6b5d48e
dsh_ui=/home/jiajun/learnbuddy-releases/learnbuddy-db2c774/plugins/dsh-plugin-learnbuddy/web/dsh-ui
pm2 startOrRestart "$release/gateway-before.config.json" --only learnbuddy-gateway --update-env
cp "$release/server-backup/dsh-host.js" "$dsh_ui/host.js"
cp "$release/server-backup/dsh-client.cjs" "$dsh_ui/client.cjs"
cp "$release/server-backup/dsh-dist-client.js" "$dsh_ui/dist/client.js"
LEARNBUDDY_PUBLIC_ORIGIN= pm2 restart learnbuddy-ui-preview --update-env
pm2 save
```

回退页面与进程配置即可；不要用数据库快照覆盖后来产生的教学数据。PM2 配置用法参照[官方文档](https://pm2.keymetrics.io/docs/usage/application-declaration/)。
