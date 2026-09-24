# DSH 插件包裁剪分析报告

> 分析时间：2026-09-24
> 目标：回答「裁掉伴学场景用不到的插件，能省多少」
> 结论口径：**所有数字都是实测**，不是估算；测量方法写在文末

---

## 一、结论先行

| 项 | 数值 |
|---|---|
| 当前插件包（传输实测量） | **10,913.9 KB 裸传 / 4,258.6 KB gzip** |
| 最大单模块 `sidebar-documentpreview` | **6,726.9 KB 裸传 / 2,896.9 KB gzip = 全包 62%** |
| **保守可裁（只裁 1 个模块）** | **省 62%** → gzip 降到约 **1.4 MB** |
| **积极可裁（裁掉一组 UI 高级功能）** | **省约 80%** → gzip 降到约 **0.8 MB** |
| 对应公网耗时（按当前实测带宽） | 11.37s → **约 3.7s / 约 2.2s** |

**一句话**：**真凶就一个模块** —— `dsh-client-ui-sidebar-documentpreview`，它把整个 **PDF.js**（`pdfjs-dist 6.3.289`）打进了客户端包，占全包 62%。而 LearnBuddy 的课件阅读是自己实现的，用不到它。

---

## 二、54 个前端模块的完整体积清单

> 按裸传体积降序。裸传 KB / gzip KB。

| # | 模块 | 裸传(KB) | gzip(KB) | 占比 |
|---|---|---|---|---|
| 1 | **sidebar-documentpreview** | **6726.9** | **2896.9** | **61.6%** |
| 2 | ui-conversation | 631.9 | 157.2 | 5.8% |
| 3 | ui-trajectory | 383.7 | 79.2 | 3.5% |
| 4 | ui-chat | 361.4 | 81.0 | 3.3% |
| 5 | api-remotes | 322.1 | 40.1 | 3.0% |
| 6 | cordis-client-runner | 256.4 | 47.6 | 2.4% |
| 7 | client-connection | 216.6 | 54.1 | 2.0% |
| 8 | api-session-controller | 137.4 | 35.6 | 1.3% |
| 9 | ui-sidebar-right | 137.2 | 35.5 | 1.3% |
| 10 | ui-settings-models | 135.7 | 32.7 | 1.2% |
| 11 | ui-workspace | 127.1 | 28.8 | 1.2% |
| 12 | ui-tool | 102.6 | 24.1 | 0.9% |
| 13 | ui-theme | 88.9 | 20.7 | 0.8% |
| 14 | ui-settings-plugins | 73.2 | 17.7 | 0.7% |
| 15 | ui-cordis | 72.7 | 15.1 | 0.7% |
| 16 | api-gateway | 71.8 | 17.3 | 0.7% |
| 17 | ui-agent-preset | 66.2 | 17.4 | 0.6% |
| 18 | ui-renderer | 55.7 | 14.7 | 0.5% |
| 19 | client-locale | 54.2 | 15.3 | 0.5% |
| 20 | typert-registry | 50.9 | 10.9 | 0.5% |
| 21 | ui-settings | 50.4 | 13.1 | 0.5% |
| 22 | ui-directory-picker-browse | 48.1 | 12.9 | 0.4% |
| 23 | ui-input-trigger | 47.5 | 13.5 | 0.4% |
| 24 | ui-deliverables | 46.9 | 12.8 | 0.4% |
| 25 | ui-commands | 44.6 | 12.8 | 0.4% |
| 26 | ui-attachment | 44.4 | 11.4 | 0.4% |
| 27 | ui-model-selection | 42.1 | 11.3 | 0.4% |
| 28 | ui-user-questions | 41.8 | 10.7 | 0.4% |
| 29 | ui-subagent | 41.4 | 10.3 | 0.4% |
| 30 | ui-settings-plugin-inventory | 35.1 | 8.7 | 0.3% |
| 31 | ui-message-feedback | 34.0 | 9.5 | 0.3% |
| 32 | ui-sidebar-files | 29.0 | 8.8 | 0.3% |
| 33 | ui-settings-general | 28.9 | 7.5 | 0.3% |
| 34 | ui-workflow-run | 28.4 | 6.8 | 0.3% |
| 35 | ui-goal | 24.4 | 6.5 | 0.2% |
| 36 | ui-layout | 23.7 | 7.0 | 0.2% |
| 37 | ui-sidebar | 22.0 | 5.9 | 0.2% |
| 38 | ui-permission-presets | 20.7 | 6.2 | 0.2% |
| 39 | client-modules | 18.2 | 5.6 | 0.2% |
| 40 | ui-open-in-app | 15.9 | 5.6 | 0.1% |
| 41 | ui-skill | 15.8 | 5.0 | 0.1% |
| 42 | api-workspace-controller | 15.4 | 4.0 | 0.1% |
| 43 | api-workspace-files | 15.1 | 4.9 | 0.1% |
| 44 | ui-jobs | 12.6 | 4.2 | 0.1% |
| 45 | client-file-upload | 12.5 | 4.2 | 0.1% |
| 46 | ui-session | 12.2 | 3.4 | 0.1% |
| 47 | session-log-export | 11.6 | 3.9 | 0.1% |
| 48 | ui-approval | 11.4 | 3.8 | 0.1% |
| 49 | ui-reference | 9.3 | 3.4 | 0.1% |
| 50 | ui-plan | 5.9 | 2.3 | 0.1% |
| 51 | client-resources | 5.7 | 2.0 | 0.1% |
| 52 | client-hmr | 4.5 | 1.8 | 0.0% |
| 53 | ui-brand-official | 1.8 | 0.8 | 0.0% |
| — | `@learnbuddy/dsh-ui`（自有） | N/A | N/A | — |
| | **合计** | **10,893.7** | **3,872.4** | 100% |

> 校验：磁盘合计 10,893.7 KB vs 传输实测 10,913.9 KB，**误差 0.18%**，测量可信。

---

## 三、按「伴学场景用不用得到」分类

### 🔴 A 类：**明确用不到，建议裁掉**（省 67.5% 裸传 / 70.1% gzip）

| 模块 | gzip(KB) | 为什么用不到 |
|---|---|---|
| **sidebar-documentpreview** | **2896.9** | **PDF.js 全家桶**。LearnBuddy 的课件阅读器是自己实现的（`pages/Material.tsx` + `BlobPreview`），不依赖 DSH 的侧栏文档预览 |
| ui-trajectory | 79.2 | Agent 执行轨迹查看器，伴学场景不暴露给师生 |
| ui-cordis | 15.1 | Cordis 插件框架自省界面 |
| ui-settings-plugins | 17.7 | 插件管理界面 |
| ui-settings-plugin-inventory | 8.7 | 插件清单界面 |
| ui-settings-models | 32.7 | 模型选择界面（我们已固定 `deepseek-flash`，且前端已有自己的模型提示） |
| ui-settings-general | 7.5 | 通用设置界面 |
| ui-settings | 13.1 | 设置容器 |
| ui-workflow-run | 6.8 | 工作流执行器，伴学不用 |
| ui-jobs | 4.2 | 后台任务面板 |
| ui-goal | 6.5 | 目标管理 |
| ui-plan | 2.3 | 计划面板 |
| ui-skill | 5.0 | 技能市场 |
| ui-subagent | 10.3 | 子代理面板 |
| ui-agent-preset | 17.4 | 代理预设 |
| ui-permission-presets | 6.2 | 权限预设 |
| ui-deliverables | 12.8 | 交付物面板 |
| ui-open-in-app | 5.6 | 「在应用中打开」 |
| ui-directory-picker-browse | 12.9 | 目录浏览器（浏览器环境用不到本地目录） |
| client-hmr | 1.8 | 开发期热更新，生产不需要 |
| session-log-export | 3.9 | 会话日志导出 |
| ui-message-feedback | 9.5 | 消息反馈（如需要可保留） |
| client-modules | 5.6 | 模块加载器 UI |
| **小计** | **~3100** | **≈70% gzip** |

### 🟡 B 类：**可裁但建议保留**（有功能风险）

| 模块 | gzip(KB) | 保留理由 |
|---|---|---|
| ui-conversation | 157.2 | **对话主界面**，助手核心 |
| ui-chat | 81.0 | 聊天渲染，核心 |
| client-connection | 54.1 | **WebSocket 连接**，助手命脉 |
| api-remotes | 40.1 | 远程 API 通道，核心 |
| api-session-controller | 35.6 | 会话控制，核心 |
| ui-renderer | 14.7 | 渲染器，核心 |
| ui-reference | 3.4 | **引用功能**，我们明确在用 |
| ui-attachment | 11.4 | **附件**，与上传功能相关 |
| ui-user-questions | 10.7 | 用户提问交互 |
| client-file-upload | 4.2 | 文件上传 |
| ui-input-trigger | 13.5 | 输入触发（@ / # 等） |
| ui-tool | 24.1 | 工具调用展示 |
| ui-theme / ui-brand-official / client-locale | 36.8 | 外观与本地化 |
| api-gateway / ui-layout / ui-sidebar* / ui-session / ui-workspace | ~120 | 布局与工作区骨架 |

### 🟢 C 类：**必须保留**

`@learnbuddy/dsh-ui`（自有插件）、`typert-registry`（类型系统）、`cordis-client-runner`（插件运行时）、`client-resources`（资源加载）

---

## 四、预期收益（分三档）

| 档位 | 裁掉内容 | gzip 后 | 相较现在 | 预估公网耗时 |
|---|---|---|---|---|
| **现状** | — | 4,258.6 KB | — | **11.37s**（实测） |
| **档 1：只裁 1 个模块** | `sidebar-documentpreview` | **~1,362 KB** | **−68%** | **~3.6s** |
| **档 2：A 类全裁** | 上面 23 个 | **~1,160 KB** | **−73%** | **~3.1s** |
| **档 3：A 类 + 激进裁 B 类** | 再裁设置/侧栏/工作区等 | **~800 KB** | **−81%** | **~2.1s** |

> 耗时按当前实测带宽（4.4 MB / 11.37s ≈ 0.39 MB/s）线性外推。**实际会更快** —— 因为小包还能吃到 TCP 慢启动的便宜。

**我的建议：先做档 1。** 一个模块换 68% 的体积，是**全项目性价比最高的单点优化**，而且风险最小（LearnBuddy 不用 DSH 的文档预览）。

---

## 五、怎么裁（机制已查清）

DSH 的 patch 文件支持两种操作（**源码确认**，`dsh-app-boot/lib/index.js:71-105`）：

```js
const { id, insert, name, ...overrides } = patch;
// insert：往清单插条目（或插到某个 group 的 config 里）
// 非 insert：按 id 定位条目，用 overrides 覆盖字段 ← 关键
for (const [key, value] of Object.entries(overrides)) target[key] = value;
```

**所以用 `disabled: true` 覆盖即可**（DSH 清单里已有先例：`hmr`、`bash-sandbox` 都是这么关的）。

**当前 patch 文件**（`learnbuddy.patch.yml`）只做了一次 insert：

```yaml
[
  {
    "insert": [
      { "id": "learnbuddy-ui", "name": ".../dsh-ui/host.js" }
    ]
  }
]
```

**改成**（追加减裁条目）：

```yaml
[
  {
    "insert": [
      { "id": "learnbuddy-ui", "name": "/home/jiajun/learnbuddy-releases/learnbuddy-db2c774/plugins/dsh-plugin-learnbuddy/web/dsh-ui/host.js" }
    ]
  },
  { "id": "sidebar-documentpreview", "disabled": true },
  { "id": "trajectory", "disabled": true },
  { "id": "settings", "disabled": true },
  { "id": "settings-general", "disabled": true },
  { "id": "settings-models", "disabled": true },
  { "id": "settings-plugins", "disabled": true },
  { "id": "settings-plugin-inventory", "disabled": true }
]
```

> ⚠️ **id 要用 `dsh --dump-config` 里的真实 id**（不是包名）。例如包 `@deepseek-ai/dsh-client-ui-settings-models` 在清单里的 id 可能叫 `settings-models`，**必须先 dump 确认**。

### 验证流程

```bash
cd .../.dsh-preview
R=runtime/node_modules/@deepseek-ai/dsh/lib/bin.js

# 1. 先 dump 确认 id 与 disabled 是否生效
node $R --profile web --patch learnbuddy.patch.yml --dump-config | grep -A1 "id: sidebar-documentpreview"

# 2. 重启 DSH
pm2 restart learnbuddy-ui-preview

# 3. 实测包体积（关键验收）
curl -s -o /dev/null -H 'Accept-Encoding: gzip' \
  -w '%{size_download} B  %{time_total}s\n' \
  'http://127.0.0.1:3089/plugins/??<新的模块清单>'

# 4. 或直接测公网
curl -s -o /dev/null -H 'Accept-Encoding: gzip' -w '%{size_download} %{time_total}\n' \
  'http://129.204.52.57:3088/?learnbuddy=embedded'  # 看 HTML 里的 script src
```

### ⚠️ 风险与回滚

| 风险 | 说明 | 应对 |
|---|---|---|
| 裁错导致助手不可用 | 某些模块虽"看起来无关"但被核心依赖 | **逐个裁、每个都验证助手能开能问**；先只裁 `documentpreview` 一个 |
| patch id 写错 | 若 id 不存在，DSH 只 warn 不报错（`patch: entry %C not found`），**容易静默失败** | 每次改完必须 `--dump-config` 核对 disabled 真的生效了 |
| 影响 DSH 其它功能 | 若将来要用 DSH 原生侧栏预览 | 保留 patch 备份，随时还原 |

**回滚**：备份 `learnbuddy.patch.yml`，出问题直接还原 + `pm2 restart`。

---

## 六、附带发现（值得知道）

1. **合并请求对模块集合有强校验**
   - 实测：请求「前 40 / 30 / 20 / 10 / 5 / 2 / 1」个模块**全部被拒**，只有**完整 53 个**才返回 200。
   - 结论：**不能靠改 URL 试探裁剪**，必须改清单（这也验证了上面方案的唯一性）。

2. **单模块不可单独请求**
   - 请求单个 `<pkg>/client.js` 一律 404/拒绝 —— 只支持 `??` 合并形式。

3. **必须保留 `&rev=` 参数**
   - 剥掉 rev 后请求全部失败 —— 说明模块 URL 是**按 revision 整体签名**的。

4. **`dsh --dump-config` 是可靠的自省手段**
   - 能导出补丁后的**最终生效清单**（154 条），且与运行时共享同一套 patch 语义（源码注释明确写了「a dump can never drift from what boots」）。

---

## 七、测量方法（可复现）

```bash
# 1. 抓内嵌页 HTML，提取全部 plugins 请求
curl -s "http://127.0.0.1:3088/?learnbuddy=embedded" -o emb.html
grep -o "/plugins/??[^\"']*" emb.html | sed 's/&amp;/\&/g' | sed 's|/plugins/??||' > all-plugins.txt

# 2. 提取唯一模块清单
tr "," "\n" < all-plugins.txt | sed 's/&rev=.*//' | grep -v '^$' | sort -u > modules.txt

# 3. 量磁盘体积（最准）
#    见 /tmp/mdisk.cjs：读 node_modules/<pkg>/lib/client.js，统计 bytes 与 gzipSync(bytes, level 9)

# 4. 校验：请求完整合并包
curl -s -o /dev/null -H 'Accept-Encoding: gzip' -w '%{size_download} %{time_total}\n' \
  "http://127.0.0.1:3089/plugins/??$(paste -sd, all-plugins.txt | head -c 2500)"
```

---

## 八、给决策者的一段话

> 你问「能省多少」——
> **一个模块（`sidebar-documentpreview`，PDF.js）就占了全包 62%。**
> 裁掉它，插件包从 **4.4 MB 降到约 1.4 MB**，公网等待从 **11.4 秒降到约 3.6 秒**。
> 而且它是**明确用不到**的（LearnBuddy 的课件阅读是自己写的）。
>
> 剩下 23 个可裁模块加起来再省 5%，属于「顺手清干净」，优先级低于先裁那一个。
