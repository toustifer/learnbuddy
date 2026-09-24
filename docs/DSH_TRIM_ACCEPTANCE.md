# DSH 插件裁剪 —— 端到端验收报告

> 验收时间：2026-09-24
> 地址：http://129.204.52.57:3088/learnbuddy/
> 工具：OpenCLI Browser Bridge（真实浏览器）+ curl 传输层实测
> 被测版本：`index-CrnhHSim.js`（含上轮 auth 修复），插件清单已裁剪

---

## 一、结论：全部通过 ✅

| # | 验收项 | 结果 |
|---|---|---|
| 1 | 插件包体积下降 | ✅ 裸传 **11,175,855 → 4,287,433 B（−61.6%）** |
| 2 | 插件包 gzip 下降 | ✅ **4,360,850 → 1,170,737 B（−73.1%）** |
| 3 | 公网传输耗时 | ✅ **11.37s → 2.50s（−78%）** |
| 4 | **助手就绪耗时（全新会话）** | ✅ **11-20s → 2.9s** |
| 5 | 只裁掉目标模块 | ✅ 53 → 52 个，**仅少 `sidebar-documentpreview`** |
| 6 | 助手功能零回归 | ✅ 提问 → 拿到真实回答 |
| 7 | 上下文注入正常 | ✅ 「引用 · 第三章 · TCP 可靠传输」 |
| 8 | 模型路由正常 | ✅ 遥测 `DeepSeek-V41-Flash` |

---

## 二、真实浏览器实测（不是服务端估算）

### 2.1 网络层（OpenCLI `network --all` 抓取）

```
插件包 URL 中已确认不含 sidebar-documentpreview   ✅
插件包解码后体积: 4,269,715 B   （服务端实测 4,287,433 B，一致）
内嵌页 HTML:      27,765 B      （裁剪前 28,333 B）
模块数:           52 个         （裁剪前 53）
```

### 2.2 传输层（curl，公网侧）

| | 裁剪前 | 裁剪后 | 降幅 |
|---|---|---|---|
| 连接建立 | 0.011s | 0.012s | — |
| 首字节 | 0.028s | 0.037s | — |
| **总耗时** | **11.369s** | **2.502s** | **−78%** |
| 传输体积(gzip) | 4,360,850 B | 1,170,737 B | −73% |

> 服务端首字节仅 37ms，**耗时几乎全在传输** —— 证实瓶颈是"4.4 MB ÷ 公网带宽"，减包是唯一有效解。

### 2.3 用户体验层（全新浏览器会话，无缓存）

```
点开课件 → 助手可交互 = 2.9 秒
（裁剪前同口径 11-20 秒）
```

### 2.4 助手功能验证（充值后）

```
提问: 请用一句话解释 TCP 三次握手中 SYN 和 ACK 的作用。
回答: SYN 用于发起连接并同步双方的初始序列号（客户端请求建立连接、
      服务器回应确认并同步自己的序列号），ACK 用于确认已收到对方的 SYN，
      从而让双方都确认彼此的收发能力正常、连接可靠建立。
遥测: DeepSeek-V41-Flash · 2 轮 2 步 · 161 tok/s · 8.5K tok · 缓存命中 97%
标记: 「已思考」
上下文: 「引用 · 第三章 · TCP 可靠传输」
```

---

## 三、精确性验证：只裁了该裁的

```
diff 裁剪前后模块清单:
  仅裁剪前有: @deepseek-ai/dsh-client-ui-sidebar-documentpreview/client.js
```

**其余 52 个模块一个不少** —— 助手界面元素（输入框、引用卡片、`标准模式`、`workspace`、模型选择器）全部正常。

---

## 四、过程中出现的问题（如实记录）

### 🔴 我造成过一次服务中断

**现象**：服务崩溃重启 143 次。

**原因**：我把本地 git 版 `preview.mjs` 直接覆盖到 release 目录，而 release 的
`src/services/llm.js` 是旧版（不含 `resolveLLMConfig`），导致
`TypeError: resolveLLMConfig is not a function` 崩溃循环。

**修复**：重写为「绝对路径指向 git 部署目录 + try/catch 兜底」的版本。

**教训**：覆盖服务器上未知但可用的文件前**必须先备份**——这次是先覆盖才发现它与预期不同。

### 🟡 一个关键机制（避免后人踩坑）

`preview.mjs` **每次启动都重写** `.dsh-preview/learnbuddy.patch.yml`。
所以裁剪配置**不能手改 patch 文件**（重启即失效），必须写在 `preview.mjs` 里。

### 🟡 一个被实测排除的方案

"按需加载/改 URL 试裁"走不通：

```
请求 前 40/30/20/10/5/2/1 个模块  → 全部非 200
请求 全部 53 个模块              → 200 ✅
```

**模块集合被整体签名**，少一个整包即拒绝。只能改清单。

### 🟡 环境问题（非本次改动引入）

- **DeepSeek 余额曾耗尽**（`Insufficient Balance`），已充值恢复
- 助手会话里**遗留了一条充值前的失败记录**（`02:27 Insufficient Balance`），是历史数据，不影响新请求

---

## 五、是否继续做「档 2」

档 1 已拿到 −78%，档 2（再裁 A 类 22 个模块）预计**再多省约 4%**。

**建议不做** —— 收益远小于风险（每裁一个都要验证助手不挂，且部分模块被核心依赖）。

---

## 六、复现命令

```bash
# 1. 测插件包体积（服务端本机）
cd /tmp
curl -s "http://127.0.0.1:3088/?learnbuddy=embedded" -o emb.html
grep -o "/plugins/??[^\"']*" emb.html | sed 's/&amp;/\&/g' | awk -F"@deepseek-ai" 'NF-1>=50' > big.txt
u=$(head -1 big.txt)
curl -s -o /dev/null -H 'Accept-Encoding: gzip' -w '%{size_download} B  %{time_total}s\n' "http://127.0.0.1:3089${u}"

# 2. 测公网耗时
curl -s -o /dev/null -H 'Accept-Encoding: gzip' \
  -w '连接 %{time_connect}s 首字节 %{time_starttransfer}s 总计 %{time_total}s\n' \
  "http://129.204.52.57:3088${u}"

# 3. 确认裁剪生效
curl -s "http://129.204.52.57:3088/?learnbuddy=embedded" | grep -c "sidebar-documentpreview"
# 期望 0

# 4. 回滚（如需）
#    编辑 .../web/dsh-ui/preview.mjs，从 DISABLED_PLUGINS 数组移除对应 id
#    然后 pm2 restart learnbuddy-ui-preview
```

---

## 七、产物

| 文件 | 说明 |
|---|---|
| `docs/DSH_PLUGIN_TRIMMING_ANALYSIS.md` | 54 个模块逐一列出的完整分析 |
| `web/dsh-ui/preview.mjs` | 裁剪配置（含机制说明注释） |
| 提交 | `f19e1e6`（已 rebase 到团队最新 `a1303e6` 之上） |
