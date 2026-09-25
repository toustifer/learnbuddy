# Auto-Grader 行为契约

> **读者**：接手的开发同学，以及要接入本系统的 Agent / MCP 客户端。
> **目的**：把「哪些是真实数据、哪些是降级产物、每个字段从哪来」写清楚 ——
> 本模块历史上最大的坑不是功能缺失，而是**界面看着正常、底下全是造出来的**。
> **最后更新**：2026-09-26（复核修正：身份认证**已落地**、原件真实页数**已接入但依赖 LibreOffice**、
> 补 `materials.content` 落库与 `synthetic` 标记契约；§1.1–§1.4、§2.3、§3、§4 已逐条对源码核实）

---

## 1. 解析契约

### 1.1 `parseDocument` — 课件与报告共用同一套解析

```js
MaterialParserService.parseDocument(filePath, originalName)
```

| 字段 | 含义 | 纪律 |
| :--- | :--- | :--- |
| `status` | `parsed` / `partial` / `failed` | **三态**：有 `warnings` 即 `partial`，不谎报成功 |
| `warnings` | 降级原因（内嵌资产被跳过、正文过短…） | 如实上报，不允许静默吞掉 |
| `markdown` | 完整正文 | **失败时恒为空字符串** |
| `images` | 内嵌图片（含 buffer 与 mimeType） | 白名单外的格式不进这个数组 |
| `pages` | **结构页数**（我们按标题/段落切出来的结果） | 估算值，配套 `pagesEstimated: true`。⚠️ 它**不等于**原件页码，见 1.3 |
| `embedded` | 资产统计 `{ total, inlined, skipped }` | `skipped > 0` 会转成 `warnings` |

**失败语义**：`status: "failed"` + `errorCode`，`markdown` 恒为空 ——
代码中**不存在**「假内容伪装成功」的分支。

### 1.2 `extractReportContent` — 报告评阅侧

产出会**持久化到 `submissions.parsed_content`**（刷新页面不丢）：

| 字段 | 说明 |
| :--- | :--- |
| `status` | `parsed` / `partial` / `failed` |
| `source` | `document` = 真实解析；`fixture` = 内置演示样例，**不得计入正式评分与统计** |
| `content` | 真实正文（Markdown） |
| `pages` | **结构页数**（阅读器切出来的页数），估算值 |
| `pagesEstimated` | `true` = `pages` 是估的；`false` = `pages` 由真实结构得出 |
| `originalPages` | **原件真实页数**（PDF 直接数；Word / PPT 等经 LibreOffice 转 PDF 再数）。取不到为 `null` —— **不猜、不冒充** |
| `structuredPages` | 渲染用页面结构：有标题按标题分节；无标题按每页约 12 段估算分页 |
| `images` | **真实落盘**的图片引用 `{ index, fileId, mimeType, size, viewUrl }` |
| `imageWarnings` / `warnings` | 未能落盘 / 解析降级的原因，如实展示 |
| `completeness` | `complete` / `partial`（投影层由 `status` 推导） |
| `documentVersionId` | = `blobId`（内容哈希），用于回答「依据哪一版报告」 |

**顺序纪律**：解析成功后**先落库、再评分**。这样即便随后模型不可用导致评分失败，
教师依然能看到报告本身。

### 1.3 ⚠️ 两套页码不要混用

| 坐标 | 是什么 | 谁在用 |
| :--- | :--- | :--- |
| `pages` / `structuredPages[].page` | **我们切出来的结构页** | 阅读器翻页、`locator.page` 反查 |
| `originalPages` | **原件自己**的页数 | 界面上「原件共 N 页（真实页数）」 |

**实测两者不是同一个数**：演示报告 `sub-xu-db` 的结构页数是 **2 页**（`pagesEstimated: true`，
本地解析与线上已记录产物一致），而它的 `originalPages` 当前是 **`null`**。

`originalPages` 依赖宿主机能跑 LibreOffice（Word / PPT 先转 PDF 再数）——
**取不到是常态而非异常**，此时如实留空、界面回落成「页码为估算值」，
**不得**把结构页数当成原件页数展示。调用方必须能接受 `null`。

**教师口头说的「第 3 页」指原件**，而 `evidenceRef.locator.page` 走的是结构页 ——
并排展示时不要混成同一个数。

### 1.4 课件侧（材料）新增：真实正文落库

`materials` 表新增 `content` 列存真实 Markdown 正文（上传路径由
`materialParser.parseAndExtract()` 产出，解析失败恒为 `null`，
**绝不写合成文本冒充原文**）。`MaterialContextService` 的分页因此变成**三段**，
且**必须让下游能分辨**：

| 分支 | 触发条件 | 标记 |
| :--- | :--- | :--- |
| 1 内置样例 | 命中 `sampleKey` | 无（内置教学样例，不是伪装） |
| 2 **真实正文** | `material.content` 非空 | `synthetic: false`，按 Markdown 标题切页，**不伪造页码与假图表** |
| 3 合成兜底 | 既无样例也无正文 | **`synthetic: true`** |

注入学习助手的上下文同样带标记：文案区分「正文阐述」与「摘要提示 (非原文)」。
**调用方见到 `synthetic: true` 必须如实呈现，不得当作课件原文引用。**

---

## 2. 评分契约

### 2.1 总分由程序计算

**铁律**：总分一律由后端按 rubric 逐项累加，**绝不信任模型口算的 `totalScore`**；
每项分数强制 clamp 到 `[0, max]`。

### 2.2 单项字段来源

| 字段 | 来源 | 纪律 |
| :--- | :--- | :--- |
| `score` | 模型给出 → 后端 clamp | 以程序计算结果为准 |
| `judgment` | **模型输出优先** | `satisfied` / `partially_satisfied` / `not_satisfied` / `unable_to_judge`；**不得由分数反推** |
| `judgmentSource` | 后端标记 | `model` = 模型明确给出；`score_fallback` = 模型未给、由分数兜底 |
| `coveredPoints` / `missingPoints` | **模型输出优先** | 只采纳具体子要求；模型没给就**留空**，不得用「完全达成 XXX」套模板 |
| `attentionLevel` | 后端按**内容信号**判定 | `review_required`（依据不足，或缺失点 ≥ 2）/ `needs_attention` / `clear`；**与分数高低解耦** |
| `evidence` | 模型输出的原文摘录 | 找不到对应原文时为空串 |
| `evidenceRef` | 后端组装 | 见 2.3 |

### 2.3 证据引用 `evidenceRef`

全部由契约层 `src/contracts/evidence.js` 的 `createEvidenceRef` 产出（**全系统只留这一套结构**）：

```json
{
  "id": "ev_9f2c1a8b30de",
  "documentVersionId": "e38a62dd….docx",
  "blockId": null,
  "kind": "text",
  "locator": {
    "page": 1,
    "slide": null,
    "block": 4,
    "headingPath": null,
    "sheet": null,
    "range": null,
    "figure": null,
    "bbox": null
  },
  "quote": "在本地实例上创建测试库与示例表，写入约二十万行数据，分别在建索引前后执行同一组查询。",
  "assetId": null
}
```

- `kind` 取 `EVIDENCE_KINDS`：`text` / `figure` / `image` / `table` / `code` / `asset`
- `locator` 是**结构化对象**，**只放真实存在的定位信息，拿不到就是 `null`**
  （源码里明确没有 `page: input.page || 1` 这类兜底）
- `block` = 页内段序号，由摘录在 `structuredPages` 里**反查**得到（归一化后包含匹配，
  容忍排版差异）；**反查不到就留 `null`**，不硬凑段号
- `id` 是**确定性**生成的（同一定位 → 同一 id），保证跨请求能稳定比对「是不是同一条证据」
- 评分链产生端（`grading`）用的仍是紧凑字符串 `page=4&block=2`；
  契约层的 `parseLocator()` 是**唯一**转换点，未知键一律忽略 —— 宁可少定位，也不猜

**可核对性判据**：`isTraceable(ref)` = 有 `documentVersionId` **且**至少一种定位
（`page` / `slide` / `block` / `headingPath` / `sheet` / `figure` / `assetId` / `blockId`）。
**只有 `quote` 不算** —— 摘录可能被改写，页号才是可核对的锚点。
新增「结论类」输出时应断言它成立（这是给调用方与 CI 用的）。

### 2.4 ⚠️ Mock 兜底红线（务必遵守）

`llm.js` 在**未配置密钥**时会返回「Mock 兜底」，其中针对评分请求返回的是一套
**写死的计算机网络评分**（实验拓扑 / Wireshark / 三次握手 / RST）。

**该响应带 `mock: true` 标记，autograder 必须拒绝**：当前行为是抛出
`LLM_NOT_CONFIGURED` 并走失败流程。**绝不允许把 Mock 结果当成模型判断入库** ——
它读起来完全正常，却与本份报告毫无关系。

> **历史教训**：曾因未检查该标记，索引实验的报告拿到了
> 「TCP 三次握手过程时序分析准确」的评语；那条「72 分」实际是
> Mock 自报的 92 分被 rubric 上限 clamp 后的结果。

---

## 3. 接口清单

**统一鉴权闸口（前置）**：`/api/learnbuddy/**` 默认**拒绝**，显式放行 ——
除 `/auth/login`、`/auth/me`、`/auth/logout` 三个认证端点外，全部要求
`Authorization: Bearer <token>`，无令牌 → `401`。身份一律由令牌在服务端解析，
**不接受任何入参里的 `userId` / `role` 自报**。唯一例外是文件 `view` / `download` /
`preview` 三兄弟（`<img src>` 与 `<a href>` 无法附加请求头，放行 `?token=`，
校验的仍是同一枚服务端令牌）。

| 端点 | 方法 | 作用 | 角色 / 状态边界 |
| :--- | :--- | :--- | :--- |
| `/api/learnbuddy/grader/grade-submission` | POST | 单份报告评阅 | 仅 `submitted` / `failed` 可发起 |
| `/api/learnbuddy/grader/retry` | POST | 对 `failed` 报告重试 | 非 `failed` 状态拦截 |
| `/api/learnbuddy/grader/batch` | POST | 全班批量评阅 | 受控并发，跳过已发布 |
| `/api/learnbuddy/grader/review-publish` | POST | 教师确认并发布 | 发布后学生可见 |
| `/api/learnbuddy/grader/submit` | POST | 学生提交报告 | |
| `/api/learnbuddy/submissions/:id/review-draft` | GET / PUT | **教师评阅草稿**读写 | 仅 `teacher`，且限本课程；与已发布结果分开存 |
| `/api/learnbuddy/submissions` | GET | 列提交 | **教师**：本课程全班；**学生**：仅自己，且未发布时成绩**置空** |
| `/api/learnbuddy/materials` · `/materials/upload` | GET / POST | 课件列表与上传 | 学生仅见公开 + 自有私有资料；上传按 `(courseId, ownerId, blobId)` **幂等** |
| `/api/learnbuddy/files/:id/preview` | GET | 原件内嵌渲染（Word 等经 LibreOffice 转 PDF，按 blobId 缓存） | 走 `?token=` |
| `/api/learnbuddy/auth/login` | POST | 登录 | scrypt 校验密码；用户不存在与密码错误**返回同一种 401**，不泄露账号是否存在 |

**状态机**：`submitted → grading → review → published`；异常 → `failed`（记录 `failure` 原因）。

---

## 4. 已知边界与待办

| 项 | 现状 |
| :--- | :--- |
| PDF 内嵌图 | **抽不到**（PDF 走 Markdown 通道，无文档模型）；只有 docx / pptx / xlsx 能抽 |
| 真实页码 | ✅ **已接入**：原件的真实页数走 `originalPages`（PDF 直接数；Word / PPT 等经 LibreOffice 转 PDF 再数，按 blobId 缓存）。阅读器用的 `pages` 仍是估算并由 `pagesEstimated` 标记 —— 两者**不混用**，见 1.3。⚠️ 依赖宿主机具备 LibreOffice，取不到时如实为 `null`（演示报告当前即为 `null`），**不冒充** |
| 身份认证 | ✅ **已落地**（缺口的关闭见下） |
| 教师评阅草稿 | 已落库（`GET/PUT /submissions/:id/review-draft`），草稿与已发布结果分开存 |
| MCP 接入 | 待对齐 MCP 接口协议（会议议题） |

### 4.1 「身份认证」缺口已关闭（原先记的反面）

本文件 2026-09-21 版曾记：`/auth/login` 取到 `password` 却从不参与判断、用户表无密码字段，
「登录」只是选择身份。**该缺口已修复**，现状：

- 密码**只存哈希**：`users.password_hash`，`node:crypto` 的 scrypt，格式 `scrypt$<salt>$<hash>`
- 会话令牌**服务端随机生成并落库**（32 字节 hex，12 小时过期），不是可预测的字符串拼接；
  校验只认服务端记录 —— 调用方无法靠入参声明身份
- 密码错误与用户不存在返回**同一种 401**（防账号枚举）
- 演示口令 `DEMO_PASSWORD = "123"`，由种子数据哈希入库

> 仍须注意：这是**演示级**方案（固定口令 + 无找回/改密流程），
> 但对「访问控制是否真实存在」这个问题，答案已经从「不存在」变成「存在」。
