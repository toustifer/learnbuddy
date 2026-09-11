# 验证脚本（人工执行，不参与 `npm test`）

这些脚本**不是**自动化测试（`npm test` 只跑 `test/*.test.js`，共 86 个用例）。
它们需要本机真实 DSH 在跑，用于上线前/交付时的端到端取证。

## `verify-live-dsh.mjs`

```powershell
cd plugins/dsh-plugin-learnbuddy
node scripts/verify-live-dsh.mjs
```

做的事：起两个**隔离端口**的真实网关实例（关闭注入 / 开启注入）代理到
真实 `127.0.0.1:3080`，用真实 `ws` 客户端与真实 HTTP 验证 6 条验收标准：

| # | 场景 | 期望 |
| --- | --- | --- |
| 1 | 开关关闭 `GET /?learnbuddy=embedded` | 401（与现状一致） |
| 2 | 开关开启 `GET /?learnbuddy=embedded` | 200 + HTML |
| 3 | 开关开启 `GET /` | 200 |
| 4 | 开关关闭 `/api/remote.mux` WebSocket | 401 |
| 5 | 开关开启 `/api/remote.mux` WebSocket | 101 且 `ws` 库接受握手 |
| 6 | 开关开启 `/api/learnbuddy/materials` | 200 `{ok:true}`（业务路由零回归） |

前置条件：

1. DSH 已在 `127.0.0.1:3080` 运行；
2. `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/`）含
   `records.client-connection/browser-session.payload.secret`；
3. 能加载到 `ws` 包：默认从 `C:/Users/15775/.npm-global/node_modules/@deepseek-ai/dsh/` 借，
   可用环境变量 `DSH_PACKAGE_ROOT` 覆盖（本插件刻意保持零依赖，不引入 `ws`）。

该脚本**不改动**线上 3088 端口的进程，只在自己起的临时端口上验证。
