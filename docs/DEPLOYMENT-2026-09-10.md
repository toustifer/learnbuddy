# 前端同步与服务器部署记录

2026-09-10。分支 `codex/learnbuddy-frontend-demo`，[交接 PR #1](https://github.com/toustifer/learnbuddy/pull/1)。产品与代码交接见[给嘉俊的文档](FRONTEND_HANDOFF-2026-09-10.md)。

## 当前状态

- 网页和 DSH 插件已构建，20 项测试通过；源码、锁定依赖与交接说明已推送 GitHub，保留主分支由团队合并。
- 目标为现有腾讯云轻量服务器 `129.204.52.57`，实例 `lhins-izbtu2nd`，主机 `VM-0-3-ubuntu`。
- 16:41 已上传并解包提交 `db2c77405f90bbf7ce8efc901a6b1b7ca4c553df`，校验发布包及 53 个文件全部一致。
- 独立版本目录：`/home/jiajun/learnbuddy-releases/learnbuddy-db2c774`，所有者 `jiajun`。DSH `0.1.5-rc.1` 已安装，PM2 进程 `learnbuddy-ui-preview` 已运行并保存，监听 `127.0.0.1:3089`。
- 17:02 最终检查通过：53 个文件一致，工作台 HTML/JS/CSS 返回 200，原生认证、UI 注入和 WebSocket 握手正常，修复后进程持续运行。浏览器完整流程仍以本地实测为依据，未通过远程浏览器重复验收。
- **服务器同步完成，当前是经 SSH 转发访问的团队预览；原公网 `3088` 没有切换到新版。** 原目录有未提交改动且 DSH 较旧，保留给嘉俊确认正式集成。真实模型、解析、评分和服务端师生权限仍待接入。

## 原服务现场情况

本轮通过已授权的腾讯云终端与服务器控制台实测：

| 项目 | 实测结果 |
| --- | --- |
| 服务器 Node | `/home/jiajun/.local/bin/node`，`v22.21.1` |
| 原 DSH | `0.1.2-rc.1`，低于本轮 UI 验证版本 |
| 原代码目录 | `/home/jiajun/learnbuddy` |
| 原 Git HEAD | `96edb4b583f3ab52054a583e0d03def07f9302ed`，分支 `main` |
| 原目录未提交内容 | `src/index.js`、`src/routes/api.js` 有修改，`server.js` 和 `src/services/` 未跟踪（均相对业务插件目录） |
| 原进程管理 | 嘉俊账号 PM2：`dsh-web` 与 `learnbuddy-gateway` 均 online |
| 原监听 | DSH `127.0.0.1:3080`；网关 `0.0.0.0:3088` |

原目录版本不等于当前 GitHub 主分支，且存在未提交改动；本次没有切换它的分支、覆盖后端或升级原 DSH。服务器从 origin 拉取本分支时出现 GitHub SSH 公钥权限拒绝，因此改用确定提交的发布包同步；后续仓库拉取权限需由嘉俊配置，未把本机 GitHub 凭据复制到服务器。

## 发布包

- 上传文件：`/home/ubuntu/learnbuddy-db2c774.tar.gz`，253,876 字节。
- SHA-256：`6f97aa5a23138918f2a678ea89820192da693969f7c3332f23eac9c0e4839307`。
- `RELEASE.json` 记录源码提交、DSH 版本和逐文件校验值。腾讯云执行记录 `inv-d8gdj5g381` / `invt-d8gdj5g382` 返回 ExitCode 0，确认包和 53 个文件全部通过。
- 发布包是指定提交的源码快照，不含 `.git`。后续代码变更先回 GitHub 分支，再生成新版本；不直接把服务器目录变成开发分支。
- 最终部署说明单独提交并同步到同一 `docs/` 路径。服务器保留原说明的 `.db2c774.bak` 与原始发布清单 `RELEASE.source-db2c774.json`；当前 `RELEASE.json` 另记录 `documentationCommit` 和更新后的文档校验值，源码提交仍为 `db2c774`。

## 服务器最终核验

2026-09-10 17:02:25–17:02:26，腾讯云命令返回 ExitCode 0：

| 检查 | 结果 |
| --- | --- |
| 发布源码及产物 | 53/53 个 SHA-256 一致 |
| `/learnbuddy/index.html` 与两项 JS/CSS 资源 | HTTP 200，响应字节与发布清单一致 |
| 原生 DSH 根路径 | 未认证 401；用本次启动鉴权入口认证后可读取页面，LearnBuddy 标题与预览工作区注入存在 |
| `/api/remote.mux` | 未认证握手 401；认证后 WebSocket 握手 101 |
| 非白名单文件 | `.env`、`RELEASE.json`、不存在的资源均返回 404 |
| 预览进程 | PID `347182`，online；修复后的连续检查没有新增重启 |
| 原服务 | `dsh-web` PID `55383`、`learnbuddy-gateway` PID `144189` 保持 online，PID 与部署前一致 |
| 监听地址 | 新预览仅 `127.0.0.1:3089`；原 `3080`、`3088` 保留 |

PM2 显示预览累计重启数为 9，来自修复前的不完整依赖；没有清零掩盖该过程。WebSocket 检查只验证认证和连接建立，没有发送模型请求，也不代表材料/报告业务已经接通。

## 发布与验证约定

发布包从本分支的确定提交生成，包含源码、`web/dist/`、`web/dsh-ui/dist/client.js`，附提交号与 SHA-256。排除 `node_modules`、`.dsh-preview`、DSH 鉴权信息、模型密钥、浏览器数据和真实文件。

在 `plugins/dsh-plugin-learnbuddy/web/` 构建：

```sh
npm ci
npm run build
npm run build:dsh
npm test
```

DSH 预览另运行 `npm run setup:dsh`，要求 Node.js 22.19+ 或 24+；只验证过 `@deepseek-ai/dsh@0.1.5-rc.1`，不直接升级已有服务。

本次首次安装被控制台 180 秒上限中断，重跑普通安装后虽报告成功，仍存在缺失依赖和无效 lock 条目，导致预览反复退出。已停止预览，将不完整的 `runtime` 保留为 `.dsh-preview/runtime.incomplete-20260910`，在新目录用已有下载缓存完整安装。以后安装被中断时，不能仅凭包版本号或首次 HTTP 200 判定成功；需确认完整启动、持续响应及进程不再重启。

部署到独立版本目录，保留旧版本、模型配置与数据。优先使用回环绑定的团队预览，不开放新的公网端口。挂入既有 DSH 时，先备份 profile/启动配置、核对版本，只添加 `dsh-ui/host.js`。浏览器需实际验证静态资源、鉴权、内嵌会话、引用与草稿。

有 SSH 权限的成员可转发本机 `3090` 到服务器预览 `3089`：

```sh
ssh -N -L 127.0.0.1:3090:127.0.0.1:3089 jiajun@129.204.52.57
```

保持转发命令运行。在服务器以 `jiajun` 身份查看本次预览的启动日志：

```sh
PATH=/home/jiajun/.local/bin:$PATH pm2 logs learnbuddy-ui-preview --lines 80 --nostream
```

用日志中的 DSH 原生鉴权入口登录；若地址显示 `127.0.0.1:3089`，仅将端口改成转发使用的 `3090`。鉴权信息只在本人浏览器使用，不粘贴进仓库、PR 或共享文档。完成认证后访问 `http://127.0.0.1:3090/learnbuddy/`。演示账号密码见前端交接文档；它与 DSH 原生认证是两层不同的入口。

## 回退与正式接入

本次 PM2 进程名为 `learnbuddy-ui-preview`。以 `jiajun` 身份操作：

```sh
export PATH=/home/jiajun/.local/bin:$PATH
pm2 status
pm2 restart learnbuddy-ui-preview
```

需要停用本轮预览时：

```sh
export PATH=/home/jiajun/.local/bin:$PATH
pm2 stop learnbuddy-ui-preview
pm2 save
```

这会保留版本目录与日志。日志为 `/home/jiajun/.pm2/logs/learnbuddy-ui-preview-out.log` 和 `learnbuddy-ui-preview-error.log`。添加进程前的 PM2 保存文件已备份到 `/home/jiajun/.pm2/dump.pm2.before-learnbuddy-ui-20260910`；仅供排查恢复，不直接覆盖团队后来保存的进程清单。若接入既有 DSH，恢复该次集成前备份的 profile/启动配置，再按原服务管理方式重启并核对旧入口。

回退不删除文件、数据库、Session 或模型配置。当前本地 Session 映射不是服务端师生权限；正式入口需后端授权及 HTTPS，并验证网关 WebSocket。当前按 localhost/SSH 转发验证，公网 HTTP IP 入口未验证。

本轮完成了服务器安装和上述运行检查；本地已完成 20 项测试、双构建与浏览器流程验证。尚未完成服务器浏览器端到端操作、公网入口切换及真实业务验收，不能据此宣称模型、解析、评分已接通。
