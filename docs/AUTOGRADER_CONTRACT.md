# Auto-Grader 行为契约

> **读者**：接手的开发同学，以及要接入本系统的 Agent / MCP 客户端。
> **目的**：把「哪些是真实数据、哪些是降级产物、每个字段从哪来」写清楚 ——
> 本模块历史上最大的坑不是功能缺失，而是**界面看着正常、底下全是造出来的**。
> **最后更新**：2026-09-21

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
| `pages` | 页数 | **估算值**，配套 `pagesEstimated: true` |
| `embedded` | 资产统计 `{ total, inlined, skipped }` | `skipped > 0` 会转成 `warnings` |

**失败语义**：`status: "failed"` + `errorCode`，`markdown` 恒为空 ——
代码中**不存在**「假内容伪装成功」的分支。

### 1.2 `extractReportContent` — 报告评阅侧

产出会**持久化到 `submissions.parsed_content`**（刷新页面不丢）：

| 字段 | 说明 |
| :--- | :--- |
| `status` | `parsed` / `partial` / `failed` |
| `source` | `document` = 真实解析；`fixture` = 内置演示样例，**不得计入正式评分与统计** |
| `structuredPages` | 渲染用页面结构：有标题按标题分节；无标题按每页约 12 段估算分页 |
| `images` | **真实落盘**的图片引用 `{ index, fileId, mimeType, size, viewUrl }` |
| `imageWarnings` / `warnings` | 未能落盘 / 解析降级的原因，如实展示 |
| `completeness` | `complete` / `partial` |
| `documentVersionId` | = `blobId`（内容哈希），用于回答「依据哪一版报告」 |

**顺序纪律**：解析成功后**先落库、再评分**。这样即便随后模型不可用导致评分失败，
教师依然能看到报告本身。

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

```json
{
  "documentVersionId": "e38a62dd….docx",
  "locator": "page=1&block=4",
  "kind": "paragraph",
  "quote": "在本地实例上创建测试库与示例表，写入约二十万行数据，分别在建索引前后执行同一组查询。",
  "assetId": null
}
```

- `locator` 是可解析的键值形式：`page=N`（仅到页）或 `page=N&block=M`（精确到段）
- `block` 由摘录在 `structuredPages` 中**反查**得到（归一化后匹配，容忍排版差异）
- **反查不到就退回页码级**，不硬凑 `block` 数字

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

| 端点 | 方法 | 作用 | 角色 / 状态边界 |
| :--- | :--- | :--- | :--- |
| `/api/learnbuddy/grader/grade-submission` | POST | 单份报告评阅 | 仅 `submitted` / `failed` 可发起 |
| `/api/learnbuddy/grader/retry` | POST | 对 `failed` 报告重试 | 非 `failed` 状态拦截 |
| `/api/learnbuddy/grader/batch` | POST | 全班批量评阅 | 受控并发，跳过已发布 |
| `/api/learnbuddy/grader/review-publish` | POST | 教师确认并发布 | 发布后学生可见 |
| `/api/learnbuddy/grader/submit` | POST | 学生提交报告 | |
| `/api/learnbuddy/submissions` | GET | 列提交 | **教师**：本课程全班；**学生**：仅自己，且未发布时成绩**置空** |
| `/api/learnbuddy/materials` · `/materials/upload` | GET / POST | 课件列表与上传 | 学生仅见公开 + 自有私有资料 |

**状态机**：`submitted → grading → review → published`；异常 → `failed`（记录 `failure` 原因）。

---

## 4. 已知边界与待办

| 项 | 现状 |
| :--- | :--- |
| PDF 内嵌图 | **抽不到**（PDF 走 Markdown 通道，无文档模型）；只有 docx / pptx / xlsx 能抽 |
| 真实页码 | 目前是估算（`pagesEstimated: true`），未接入真实页码 |
| 身份认证 | ⚠️ **已知缺口**：`/auth/login` 取到 `password` 却从不参与判断，用户表亦无密码字段 —— 本地「登录」只是选择身份、不是认证。比赛原型阶段按约定暂不处理，但**不得据此认为系统已具备访问控制** |
| MCP 接入 | 待对齐 MCP 接口协议（会议议题） |
