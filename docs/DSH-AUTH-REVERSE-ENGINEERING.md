# DSH 浏览器会话鉴权：逆向工程结论

> 目的：搞清 `dsh web`（127.0.0.1:3080）的 token/cookie 鉴权机制，回答「网关能不能在不改 DSH 的前提下，
> 让公网访问 `/?learnbuddy=embedded` 不再返回 401」。
>
> 证据来源：本机已安装的 `@deepseek-ai/dsh@0.1.5-rc.1`
> （`C:\Users\15775\.npm-global\node_modules\@deepseek-ai\dsh`）。
> 下文所有 `文件:行号` 均指该安装包内 `node_modules/@deepseek-ai/<pkg>/lib/index.js`（若为单文件包则省略包名后的路径）。

## 0. 结论速查

| 问题 | 结论 |
| --- | --- |
| token 从哪来 | 进程启动时 `randomBytes(32)` 生成，进程内 WeakMap 记忆，**不落盘** |
| 是否每次启动随机 | 是。同一个进程（含插件热重载）内稳定，跨进程重启即变 |
| cookie 名怎么来 | `dsh-auth-` + base64url(sha256(**authority**))，authority = Host 头规范化结果 |
| cookie 载荷怎么校验 | HMAC-SHA256(`body`) == 签名，且 `payload.authority` 必须等于当前请求的 authority，时间窗有效 |
| 签名密钥哪来 | `$DSH_HOME/.credentials.yaml` 里 `records["client-connection/browser-session"].payload.secret`，**持久化** |
| 能否确定性提供 token | ❌ 没有 CLI flag / 环境变量 / 配置文件可以指定 launch token |
| 能否确定性拿到可用会话 | ✅ **可以**：读到上面的持久化 secret 后，网关可离线为 authority `127.0.0.1:3080` 自行签发合法 cookie |
| 刷新/续期接口 | 不存在。cookie 每次访问 `/` 时按需新签；密钥变化只能靠重新读凭据文档 |
| 网关可行方案 | 代理时保持 `Host: 127.0.0.1:3080`，并注入 `dsh-auth-<hash>=v1...` Cookie（task-08 已实现） |
| 带 `Origin` 为什么 403 | `/api` 与 WebSocket upgrade 还有一道 `isTrustedApiRequest` 栅栏：**带 Origin 时必须与 Host 同源**。只改 Host 不改 Origin 会 403（task-09 修复，见 §4.1） |

---

## 1. token 从哪里来、怎么签发

**文件**：`dsh-client-connection/lib/index.js`

```js
// L240-246
function processLaunchToken(owner) {
  const existing = PROCESS_LAUNCH_TOKENS.get(owner);
  if (existing !== void 0) return existing;
  const created = encodeBase64Url(randomBytes(SECRET_BYTES));   // SECRET_BYTES = 32 (L221)
  PROCESS_LAUNCH_TOKENS.set(owner, created);
  return created;
}
```

- `PROCESS_LAUNCH_TOKENS` 是模块级 `new WeakMap()`（L227），key 是 `ctx.root`（应用根 Context）。
- `BrowserAuth` 构造时取一次（L350：`this.launchToken = processLaunchToken(processOwner)`），
  `ProcessOwner` 由 `BrowserAuth.create(ctx.root, ctx.credentials, cookieMaxAgeDays)` 传入（L362-364，`apply` 里 L757）。
- **结论**：token 每次进程启动随机生成（32 字节 → base64url），只活在内存里，
  插件重载（同一 `ctx.root`）不会变，**进程重启必变**。

打印入口（证明它只用于拼 URL，不是可配置项）：

```js
// dsh-web-app/lib/index.js L370-377
authenticatedUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.pathname = "/"; url.search = ""; url.hash = "";
  url.searchParams.set(TOKEN_QUERY, this.launchToken);   // TOKEN_QUERY = "token" (L222)
  return url.href;
}
// dsh-web-app/lib/index.js L197-203
const webUrl = localWebUrl(connectionCtx);
const authenticatedUrl = connectionCtx.connection.authenticatedUrl(webUrl);
...
if (config.printUrl) console.log(`dsh web: ${authenticatedUrl}${...}`);
```

即启动日志里的 `dsh web: http://127.0.0.1:3080/?token=<TOKEN>` 是**唯一出口**，
而它的值来自内存随机数，没有任何注入通道。

## 2. token → cookie 的交换（303 + set-cookie）

**文件**：`dsh-client-connection/lib/index.js`

```js
// L386-425 authorizeIndex(req, res)
const url = new URL(req.url ?? "/", "http://dsh.invalid");
const tokens = url.searchParams.getAll(TOKEN_QUERY);           // "token" 参数（可重复）
if (tokens.length > 0) {
  const authority = requestAuthority(req.headers);             // L391
  if (req.method === "GET" && url.pathname === "/" && tokens.length === 1
      && authority !== void 0 && tokenMatches(tokens.join(""), this.launchToken)) {
    const issuedAt = Date.now();
    const expiresAt = issuedAt + this.maxAgeMilliseconds;       // maxAgeDays*86400000 (L351)
    const value = encodeCookie({ version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt }, this.secret);
    res.writeHead(303, {
      "cache-control": "no-store",
      "location": "/",
      "referrer-policy": "no-referrer",
      "set-cookie": sessionCookie(cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1e3))
    });
    res.end();
    return false;
  }
  ...
}
this.writeUnauthorized(req, res);   // L419 / L442-448：401 + no-store
```

要求很严格：`GET` + `pathname === "/"` + **恰好一个** `token` 参数 + `token` 常量时间相等（L275-279 `tokenMatches`）。

cookie 序列化（L292-294）：

```js
`${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`
```

**注意 `SameSite=Strict`**：这也是「公网域名直接吃 DSH 的 cookie」不可行的原因之一
（跨站场景下浏览器不会带上该 cookie）；网关侧注入绕开了这条限制。

## 3. cookie 名：由 authority 派生

```js
// L252-261
function requestAuthority(headers) {
  const host = header(headers, "host");
  if (host === void 0) return void 0;
  try { return new URL(`http://${host}`).host; } catch { return; }
}
// L280-282
function cookieName(authority) {
  return COOKIE_PREFIX + encodeBase64Url(createHash("sha256").update(authority).digest());
}
// L223 COOKIE_PREFIX = "dsh-auth-"
```

- authority 是 WHATWG `URL` 规范化后的 host（小写、去掉默认端口、IPv6 带括号）。
- 实测：authority `127.0.0.1:3080` → cookie 名
  `dsh-auth-` + base64url(sha256("127.0.0.1:3080"))，43 个字符。
- **cookie 名与 Host 强绑定**：换域名访问，cookie 名也变，所以网关必须让 DSH 看到
  与签发时一致的 Host —— 现有代理覆盖 `host: 127.0.0.1:<DSH_PORT>` 正好满足（server.js L93）。

## 4. cookie 载荷、签名与校验

```js
// L295-301
function signature(secret, body) { return createHmac("sha256", secret).update(body).digest(); }
function encodeCookie(payload, secret) {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `v1.${body}.${encodeBase64Url(signature(secret, body))}`;
}
// L302-320 decodeCookie：三段、版本 v1、签名常量时间比对、
//         payload 必须是 {version:1, authority:string, issuedAt:int, expiresAt:int}
// L431-441 isAuthenticated(request)
const authority = requestAuthority(request.headers);         // 必须能从 Host 推出
const rawCookie = header(request.headers, "cookie");
const value = cookieValue(rawCookie, cookieName(authority)); // 名字不对 → 直接 false
const payload = decodeCookie(value, this.secret);
if (payload === void 0 || payload.authority !== authority) return false;
const now = Date.now();
return payload.issuedAt <= now && payload.expiresAt > now
    && payload.expiresAt > payload.issuedAt
    && payload.expiresAt - payload.issuedAt <= this.maxAgeMilliseconds;   // 不能超签
```

也就是说 cookie 只是「authority + 时间窗」的 HMAC 签名信封，**不含 token、不含用户身份**。

`/api` 与 WebSocket 用同一套：

```js
// L552-556 HostConnectionService.requestRejection —— /api 的 401 来源
requestRejection(request) {
  if (!isTrustedApiRequest(request, this.trustedHosts)) return 403;
  return this.browserAuth.isAuthenticated(request) ? void 0 : 401;
}
// L201-215 isTrustedApiRequest：Host 必须是 loopback 或 trustedHosts 之一；
//   Sec-Fetch-Site 不能是 cross-site；带 Origin 时必须同源。
// dsh-api-gateway/lib/index.js L457-477：/api/remote.mux WebSocket
const rejection = webCtx.connection.requestRejection(req);
if (rejection !== void 0) { rejectRemoteStreamUpgrade(socket, rejection); return; }  // L373-388
mux.handleUpgrade(req, socket, head);
```

这两点决定了两件事：

1. **Host 必须覆盖成 loopback**（否则 403，连鉴权都到不了）——现有代理已满足。
2. **WebSocket 走同一个 401**，所以网关补 upgrade 转发时必须同样注入 Cookie。

> ⚠️ 上面 `isTrustedApiRequest` 里还有第三条规则（Origin 同源），task-08 漏掉了它，
> 导致「本地测试全绿但公网浏览器仍 403」。完整分析见 §4.1。

## 4.1 Origin 同源校验（task-09：公网浏览器 403 的根因）

`isTrustedApiRequest` 的完整判定（`dsh-client-connection/lib/index.js` L201-215，
**早于会话鉴权**，所以失败返回 403 而不是 401）：

```js
function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, "host");
  if (host === void 0) return false;
  const hostUrl = parseAuthority(host);                    // L144-150: new URL(`http://${host}`)
  if (hostUrl === void 0) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = header(request.headers, "origin");
  if (origin === void 0) return true;                       // 无 Origin = 非浏览器客户端，放行
  try {
    return new URL(origin).host === hostUrl.host;            // 带 Origin 必须与 Host 同源
  } catch {
    return false;                                           // 连 new URL 都解析不了（如 "null"）也拒绝
  }
}
// L117-121 isLoopbackHostname：localhost / [::1] / 127.0.0.0-8
// L552-556 HostConnectionService.requestRejection：!isTrustedApiRequest -> 403；可信但未鉴权 -> 401
// dsh-api-gateway L462-468：/api/remote.mux upgrade 走同一个 requestRejection
```

### 公网实测对照表（2026-09-11，`http://129.204.52.57:3088`，`LEARNBUDDY_DSH_SESSION_INJECT=1`）

WebSocket `/api/remote.mux` 握手：

| 请求头 | 修复前 | 修复后 |
| --- | --- | --- |
| 不带 `Origin` | **101** ✅ | 101 ✅ |
| `Origin: http://129.204.52.57:3088`（真实浏览器一定这样发） | **403** ❌ | **101** ✅ |
| `Origin: http://127.0.0.1:3080`（与 authority 同源） | **101** ✅ | 101 ✅ |
| `Origin: http://129.204.52.57:3088` + `Sec-Fetch-Site: same-origin` | **403** ❌ | **101** ✅ |
| `Sec-Fetch-Site: cross-site`（任意 Origin） | 403 ❌ | 403（**刻意保留**，见下） |

HTTP `/api/*` 路径：

| 请求头 | 修复前 | 修复后 |
| --- | --- | --- |
| 不带 `Origin` | 404（通过信任检查，仅无此路由） | 404 |
| `Origin: http://129.204.52.57:3088` | **403** ❌ | 404（通过） |
| `Origin: http://127.0.0.1:3080` | 404（通过） | 404 |

### 为什么必须同时改写 Host 与 Origin

同一条转发链上有三个必须自洽的量：

| 量 | 来源 | 约束 |
| --- | --- | --- |
| Host | 网关覆盖 | cookie 名 = `sha256(authority)`，authority 由 Host 推导 → **必须**是 `127.0.0.1:3080` |
| Origin | 浏览器原始发送 | 一旦存在就必须 `new URL(origin).host === Host` → **必须**一起改写成 `http://127.0.0.1:3080` |
| Cookie | 网关注入 | payload.authority 必须等于 Host 推导出的 authority |

少改任何一个都会失败，而且失败码不同：

- 只改 Host、不改 Origin → Origin 跨源 → **403**（CSRF 栅栏先拦，这是 task-08 的缺口）
- 只改 Origin、不改 Host（公网 authority 原样透传）→ Host 既不是 loopback 也不在 `trustedHosts` → **403**；
  即使配了 `trustedHosts`，cookie 名会按公网 authority 派生、与注入 cookie 不匹配 → **401**
- 两个都改但 cookie 的 authority 没跟着改 → **401**

> 另一条可行路线是把公网 authority 加进 DSH 的 `--trusted-host` 并让网关为该 authority 签 cookie，
> 但那要求改 DSH 启动参数、且放弃「Host 永远是 loopback」这一不变量；本任务按用户要求走
> 「Host + Origin 一起改写」的方案。

### 网关侧实现（`plugins/dsh-plugin-learnbuddy/server.js`）

```js
const originRewriteEnabled = () => injector !== undefined && injector.enabled === true;
function buildProxyHeaders(req, cookieHeader) {
  const headers = { ...req.headers };
  headers.host = dshAuthority;                       // 与 cookie authority 对齐
  ...
  if (originRewriteEnabled()) {
    const origin = headers.origin;
    if (typeof origin === "string" && origin !== "") headers.origin = `http://${dshAuthority}`;
  }
  return headers;
}
```

语义要点：

1. **HTTP 与 WebSocket upgrade 共用 `buildProxyHeaders`**，所以两条路径行为一致（upgrade 也用它）。
2. 请求**不带** `Origin` → 保持不带（DSH 据此把非浏览器客户端放行，凭空添加会改变语义）。
3. 请求带任意 `Origin` → 一律改写成 `http://127.0.0.1:<DSH_PORT>`，包括 `Origin: null`
   （sandboxed iframe 的 opaque origin：DSH 的 `new URL("null")` 会抛，同样 403）。
4. **关闭注入时一概不改写**（`originRewriteEnabled()` 为 false），行为与本能力不存在时完全一致。

### 刻意不改写的浏览器标记（与 csrf 边界的取舍）

| 标记 | 处理 | 理由 |
| --- | --- | --- |
| `Sec-Fetch-Site: cross-site` | **不改写**，仍 403 | 独立硬规则。真实部署下不会出现：DSH 文档自身就加载在网关源上，它发出的 fetch/WS 都是 `same-origin`；只有「第三方站点里跑的页面直接跨站打 /api」才是 cross-site，那正是要拒绝的场景 |
| `Sec-Fetch-Site: same-origin` / `Sec-Fetch-Mode` / `Sec-Fetch-Dest` | 原样透传 | DSH 只对 `cross-site` 敏感 |
| `Referer` | 无需处理 | DSH 全仓不读 `Referer`/`Referrer`（grep 无命中） |

> 安全提示：改写 Origin 等于替浏览器「正名」，会绕过 DSH 针对浏览器的 CSRF 栅栏。
> 但开启会话注入后，网关本来就会为任何转发请求注入合法会话 cookie，CSRF 面已经打开；
> 该能力默认关闭、开启时打印安全告警的定位不变。

## 5. 签名密钥是持久化凭据（关键发现）

```js
// dsh-client-connection/lib/index.js
const AUTH_RECORD_KEY = credentialKey("client-connection", "browser-session");   // L219
// L321-338
async function initializeSecret(credentials) {
  const generated = { version: STORED_SECRET_VERSION, secret: encodeBase64Url(randomBytes(SECRET_BYTES)) };
  const secret = storedSecret(await credentials.modifyRecord(AUTH_RECORD_KEY, (current) => {
    if (current !== void 0) { storedSecret(current); return Promise.resolve(void 0); }   // 已存在 → 不覆盖
    return Promise.resolve({ kind: "grant", payload: generated });                        // 首次才生成
  }));
  ...
}
// L362-364
static async create(processOwner, credentials, maxAgeDays) {
  return new BrowserAuth(processOwner, await initializeSecret(credentials), maxAgeDays);
}
```

密钥的落盘位置：

```js
// dsh-credentials-local/lib/index.js
const CREDENTIALS_FILENAME = ".credentials.yaml";                                  // L49
return { filename: resolve(config.path ?? join(resolveDshHome(config.dshHome), ".credentials.yaml")), ... };  // L56-62
// 记录解析：records 段 → "<scope>/<id>" → { kind, payload }                     // L203-210 / L233-263
// 写入：0600 原子替换 + 跨进程锁                                                 // L541-567
// dsh-home-paths/lib/index.js L73-76 resolveDshHome：configured > $DSH_HOME > ~/.dsh
```

本机实测文件 `C:\Users\15775\.dsh\.credentials.yaml`：

```yaml
version: 1
refs:
  DEEPSEEK_API_KEY: sk-...
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: ClDMl5y2QmBo9ZQ1P3TKSsr7cCIxuqDaADVbKx6Ep2M
```

**因此：只要网关能读到 `$DSH_HOME/.credentials.yaml`，就能离线签出任意时刻都合法的
`dsh-auth-127.0.0.1:3080` cookie，完全绕开一次性 launch token。**
这正是本次实现的方案（见 `src/services/dsh-session-injector.js`）。

## 6. 是否存在「可由启动方确定性提供」的 token

逐条排查：

| 通道 | 结论 | 证据 |
| --- | --- | --- |
| CLI flag | ❌ 无 `--token`；`dsh --profile web` 只认 `--host/--port/--no-open/--trusted-host` | `dsh-web-app/lib/startup.js` L21-28 |
| 环境变量 | ❌ 没有任何 env 参与 token 生成（`processLaunchToken` 只依赖 owner） | `dsh-client-connection` L240-246 |
| 配置文件 | ❌ settings.yaml 无该字段；token 是内存 WeakMap，不读写配置 | 同上 + `initializeSecret` 只写 secret 记录 |
| 启动参数 / profile patch | ❌ 只能调 `cookieMaxAgeDays` / `trustedHosts`，不能定 token | `Config` L737-742 |
| **凭据文档（secret）** | ✅ **可以确定性使用**，且是持久化的 | 见 §5 |

补充：`trustedHosts`（`--trusted-host`）只放宽 Host 白名单（`isTrustedApiRequest` L201-215），
**不放宽鉴权**；`0.0.0.0` 绑定被 CLI 硬拒（`startup.js` L40）。

## 7. 刷新 / 续期接口

**不存在**专门端点。相关事实：

1. cookie 是「按需新签」的：每次带 `?token=` 访问 `/` 都会 303 + 新 `set-cookie`（L395-407），
   但新 cookie 的 authority 仍是**当前请求的 Host**。
2. 只要 secret 不变（正常情况，`initializeSecret` 对已有记录不覆盖），旧 cookie 在
   `issuedAt..expiresAt` 窗口内一直有效；网关每次转发都会重签一个 `now..now+30d` 的 cookie，
   所以实际效果是**滚动续期**。
3. secret 变化只有两条路径：凭据文档被删除后重建（DSH 重启且记录缺失），或人为改写。
   此时旧 cookie 立刻失效 → 表现为 401。
4. 网关的应对：`DshSessionInjector.handleUnauthorized()` 重读凭据文档后重试一次
   （`maxRetries` 默认 1）。**没有** DSH 侧的「刷新接口」可调。

## 8. 时间窗与配置

- `cookieMaxAgeDays` 默认 30 天（`Config` L740 `z.natural().min(1).default(30)`）。
- 校验要求 `expiresAt - issuedAt <= maxAgeMilliseconds`（L440），所以**网关签的 cookie 寿命
  不能超过 DSH 的 `cookieMaxAgeDays`**；本实现默认 30 天，并提供 `maxAgeDays` 选项对齐。
- `writeUnauthorized` 返回 401 + `cache-control: no-store` + `text/plain`
  （文案 `dsh web authentication required; reopen the URL printed by dsh web.`），
  与本任务侦察到的线上现象一致。

## 9. 对网关的落地要求（本任务实现）

1. 代理到 DSH 时必须保留 `Host: 127.0.0.1:<DSH_PORT>`（与 cookie authority 对齐）——既有行为不变。
2. HTTP 请求注入 `Cookie: dsh-auth-<sha256(authority)>=v1.<b64url(payload)>.<b64url(hmac)>`；
   载荷 `{version:1, authority:"127.0.0.1:<port>", issuedAt:now, expiresAt:now+30d}`。
3. 收到 401 时重读 `$DSH_HOME/.credentials.yaml` 并重试一次（幂等，仅无 body 请求可重放）。
4. **WebSocket upgrade（`/api/remote.mux`）必须走同一套注入**，否则握手同样 401。
5. 开关默认关闭（`LEARNBUDDY_DSH_SESSION_INJECT=1` 才开），开启时打印安全告警。
6. 浏览器不会自己带这个 cookie（它是 `SameSite=Strict` 且 authority 是 loopback），
   所以定位是**网关注入**而不是「让浏览器登录」。
7. **（task-09）开启注入时还必须把 `Origin` 改写成同一个 authority**：`/api/*` 与 WebSocket
   upgrade 在鉴权之前先过 `isTrustedApiRequest`，带 Origin 时要求与 Host 同源，
   否则真实浏览器（Origin = 公网 authority）会拿到 403。HTTP 与 upgrade 两条路径都走
   `buildProxyHeaders`，只改这一处即可；不带 Origin 时不得凭空添加，关闭注入时不得改写。

## 10. 复核方法（可复现）

```powershell
# 1) 看 DSH 打印的鉴权入口与 cookie 形状
#    dsh web 启动日志: dsh web: http://127.0.0.1:3080/?token=<TOKEN>
curl.exe -i "http://127.0.0.1:3080/?token=<TOKEN>"      # 期望 303 + set-cookie: dsh-auth-<hash>=v1...
# 2) 解出 cookie 名，确认 hash 来自 authority
node -e "const c=require('crypto');console.log('dsh-auth-'+c.createHash('sha256').update('127.0.0.1:3080').digest('base64url'))"
# 3) 确认凭据文档里有持久化 secret
Get-Content "$env:USERPROFILE\.dsh\.credentials.yaml"
# 4) 用该 secret 自签 cookie 直接访问（本仓库实现）
node -e "import('./plugins/dsh-plugin-learnbuddy/src/services/dsh-session-injector.js').then(m=>{const i=new m.DshSessionInjector({enabled:true,authority:'127.0.0.1:3080'});console.log(i.headers({}));})"
```

### 10.1 已完成的线上验证（2026-09-11，本机 DSH 0.1.5-rc.1 真实运行）

用**真实 DSH（127.0.0.1:3080）+ 真实网关实例（隔离端口，未触碰线上 3088）**跑通：

| 场景 | 结果 |
| --- | --- |
| 开关关闭 `GET /?learnbuddy=embedded` | **401**（与现状一致） |
| 开关关闭 `/api/remote.mux` WebSocket | **401**（`ws` 库收到 HTTP 401） |
| 开关开启 `GET /?learnbuddy=embedded` | **200**，HTML 28158 字节 |
| 开关开启 `GET /` | **200** |
| 开关开启 `/api/remote.mux` WebSocket | **101 Switching Protocols**，标准 `ws` 客户端握手成功 |
| 开关开启 `/api/learnbuddy/materials` | **200**，`{ok:true}`（业务路由零回归） |
| 直接打 DSH、**不覆盖 Host**（`Host: example.com:3080`） | 401 → 证明 Host 必须与 cookie authority 对齐 |

复现：`node plugins/dsh-plugin-learnbuddy/_verify-live-e2e.mjs`（`_` 前缀文件不入库，仅为交付证据）。

### 10.2 task-09：带真实浏览器头的线上验证（2026-09-11，真实 DSH 0.1.5-rc.1）

同一套「真实 DSH + 隔离端口真实网关」脚本，但**显式携带浏览器头**
（`Host: 129.204.52.57:3088`、`Origin: http://129.204.52.57:3088`、`Sec-Fetch-Site`），
复现并验证 §4.1 的结论。入库复现：`node plugins/dsh-plugin-learnbuddy/scripts/verify-live-dsh.mjs`
（12/12 通过）。

| # | 场景 | 结果 |
| --- | --- | --- |
| 0 | 直连 DSH（不经网关）+ `Host: 127.0.0.1:3080` + 公网 `Origin` | **403**（根因复现） |
| 1 | 直连 DSH + `Origin: http://127.0.0.1:3080`（与 Host 同源） | 401（证明 403 由 Origin 不同源触发） |
| 2 | 直连 DSH 不带 `Origin` | 401（旧测试只覆盖了这条路径） |
| 3 | 开关关闭 `GET /?learnbuddy=embedded` | 401（与现状一致） |
| 4 | 开关开启 `GET /?learnbuddy=embedded` + 公网 `Origin` | 200，HTML 28158 字节 |
| 5 | 开关开启 `GET /` + 公网 `Origin` | 200 |
| 6 | 开关关闭 `/api/remote.mux`（不带 Origin） | 401 |
| 7 | 开关开启 `/api/remote.mux`（不带 Origin） | **101** |
| 8 | 开关开启 `/api/remote.mux` + 公网 `Origin` + `Sec-Fetch-Site: same-origin` | **101**（修复目标） |
| 9 | 开关开启 `/api/nonexistent` + 公网 `Origin` | **404**（通过信任+鉴权，不再是 403） |
| 10 | 开关关闭 `/api/remote.mux` + 公网 `Origin` | **403**（未放宽成「都放行」） |
| 11 | 开关开启 `/api/learnbuddy/materials` + 公网 `Origin` | 200 `{ok:true}`（业务路由零回归） |

单元层同样提高了保真度：`test/dsh-session-injector.test.js` 的假 DSH
**复刻了 `isTrustedApiRequest`**（Host loopback + `sec-fetch-site` + Origin 同源），
新增 6 个用例显式发送公网 `Origin`/`Sec-Fetch-*`。修复前这 3 个用例真实失败
（`HTTP /api` expected 200 → actual **403**；WebSocket expected 101 → actual **403**），
修复后全绿——即「只有不带 Origin 才通过」的旧测试不再能掩盖缺口。

## 11. 版本与失效风险

- 结论基于 `@deepseek-ai/dsh@0.1.5-rc.1`。若升级后 `dsh-client-connection` 改变
  cookie 名/载荷/密钥记录键（`client-connection/browser-session`），注入会失效——
  表现为 401 且日志出现「重读凭据后重试」但仍 401。
- 排查顺序：`dsh` 版本 → 该文件 §3/§4/§5 三处逻辑 → 凭据文档记录键。
- 本实现把不变量写成测试（`test/dsh-session-injector.test.js`）：假 DSH 复刻了
  §3/§4/§4.1 的校验算法（cookie 名与签名、`isTrustedApiRequest` 的 Host/Origin/`sec-fetch-site`），
  一旦上游算法变化，测试会跟着失败，提示需要重新逆向。
- 特别是**信任栅栏的输入必须是「浏览器真实会发的头」**：task-08 的测试全部不发送 `Origin`，
  于是一个真实的公网 403 被 86/86 全绿掩盖。新增用例一律显式携带 `Origin` 与 `Sec-Fetch-Site`。
