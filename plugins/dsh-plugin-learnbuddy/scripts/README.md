# 验证脚本（人工执行，不参与 `npm test`）

这些脚本**不是**自动化测试（`npm test` 只跑 `test/*.test.js`，task-09 后共 92 个用例）。
它们需要本机真实 DSH 在跑，用于上线前/交付时的端到端取证。

## `verify-live-dsh.mjs`

```powershell
cd plugins/dsh-plugin-learnbuddy
node scripts/verify-live-dsh.mjs
```

做的事：起两个**隔离端口**的真实网关实例（关闭注入 / 开启注入）代理到
真实 `127.0.0.1:3080`，用真实 `ws` 客户端与真实 HTTP 验证 12 条标准。
**所有浏览器场景都显式携带 `Host`/`Origin`/`Sec-Fetch-*`**（默认模拟公网
`129.204.52.57:3088`，可用 `PUBLIC_AUTHORITY` 覆盖），复刻真实浏览器行为：

| # | 场景 | 期望 |
| --- | --- | --- |
| 0 | 直连 DSH（不经网关）+ 公网 `Origin` | 403（`isTrustedApiRequest` 同源校验，根因） |
| 1 | 直连 DSH + `Origin` 与 Host 同源 | 非 403（401） |
| 2 | 直连 DSH 不带 `Origin` | 非 403（401） |
| 3 | 开关关闭 `GET /?learnbuddy=embedded` | 401（与现状一致） |
| 4 | 开关开启 `GET /?learnbuddy=embedded` + 公网 `Origin` | 200 + HTML |
| 5 | 开关开启 `GET /` + 公网 `Origin` | 200 |
| 6 | 开关关闭 `/api/remote.mux` WebSocket | 401 |
| 7 | 开关开启 `/api/remote.mux` WebSocket（不带 `Origin`） | 101 |
| 8 | 开关开启 `/api/remote.mux` WebSocket + 公网 `Origin` + `Sec-Fetch-Site` | 101（task-09 修复目标） |
| 9 | 开关开启 `/api/nonexistent` + 公网 `Origin` | 非 403（真实 DSH 回 404） |
| 10 | 开关关闭 `/api/remote.mux` + 公网 `Origin` | 403（未放宽成「都放行」） |
| 11 | 开关开启 `/api/learnbuddy/materials` + 公网 `Origin` | 200 `{ok:true}`（业务路由零回归） |

前置条件：

1. DSH 已在 `127.0.0.1:3080` 运行；
2. `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/`）含
   `records.client-connection/browser-session.payload.secret`；
3. 能加载到 `ws` 包：默认从 `C:/Users/15775/.npm-global/node_modules/@deepseek-ai/dsh/` 借，
   可用环境变量 `DSH_PACKAGE_ROOT` 覆盖（本插件刻意保持零依赖，不引入 `ws`）。

该脚本**不改动**线上 3088 端口的进程，只在自己起的临时端口上验证。
