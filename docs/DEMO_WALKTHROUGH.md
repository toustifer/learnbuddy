# 演示走查报告

> 走查时间：2026-09-25
> 走查方式：**真实浏览器操作线上环境**，师生两条线，不预设重点
> 环境：`http://129.204.52.57:3088/learnbuddy/`

---

## 一、结论

**走查未发现致命问题。所有演示主线功能均正常，且数据真实。**

| 环节 | 判定 |
|---|---|
| 教师线：首页「需要关注」 | ✅ 数据真实 |
| 教师线：作业管理 | ✅ 数据真实 |
| 教师线：**AI 辅助评阅** | ✅ 真的调用模型，含逐项证据与缺失点 |
| 教师线：学情分析 | ✅ 数据真实，统计口径有脚注 |
| 学生线：**提取正文** | ✅ 真实原文逐字正确 |
| 学生线：**学习助手** | ✅ **完全可用，能提问能回答，会主动声明不确定性** |
| 首页数字展示方式 | 🟡 数据正确但易误读（见 §4） |

---

## 二、⚠️ 走查过程中的一次重大误判（必须记录）

### 2.1 我的错误判定

走查中我用如下方式检测助手：

```js
const a = document.querySelector(".assistant-column");
a.querySelectorAll("input,textarea").length   // → 0
```

连续采样 87 秒均为 0，控制台无报错，我据此写下：

> 🔴 **致命问题：学生无法向学习助手提问**
> 「助手停在『就绪』态，从未进入可交互态」

### 2.2 实际真相

**助手完全正常。** 我的检测方法有两处根本性错误：

| # | 我的错误 | 真相 |
|---|---|---|
| 1 | 只查 `input, textarea` | DSH 用的是 **`contenteditable` DIV**（`<div class="uV2eYG_input" contenteditable="true">`），`querySelectorAll("input,textarea")` 抓不到 |
| 2 | 只查外层 DOM | **助手渲染在 iframe 内**（`src="http://129.204.52.57:3088/?learnbuddy=embedded"`），外层查询永远为 0 |

**正确检测方式**：

```js
const f = document.querySelector(".assistant-column iframe");
const d = f.contentDocument;              // 同源，可穿透
d.querySelector("[contenteditable=true]") // → 真正的输入框
```

### 2.3 实测：助手真的能工作

在 iframe 内的 `contenteditable` 中输入真实问题并发送：

```
问：这份材料讲的是什么？

答（18:03，3 次工具调用，248 tok/s，缓存命中 89%）：
「工作区里只有一份实质材料：实验台字段与图形-学习笔记.md」
 核心内容分三层：
   1. 字段拆解 — XB-7741 STEP-9 LOT-4471 是三段复合编号（设备/步骤/批次）
      关键规则：分隔符是空格不是连字符，不能按 - 机械切分
   2. 图形符号 — 黑色实心三角形是状态指示符
      典型错误是把它当纯装饰忽略
   3. 录入规范 — 易混字符 B/8、S/5、O/0、I/1
 两点需要提醒：
   · 原始截图不在工作区（笔记自己声明图片本体缺失），这一我也无法补验
   · 三角形语义被刻意悬置，材料只给候选集合，没有定论
   · 「这类描述是对截图内容的转述，不是我能独立核实的事实」
```

**助手功能齐全**（DOM 实测）：新建会话、搜索会话、工作区选择、语音输入、
模型选择（`DeepSeek-V41-Flash`）、附件、指令、发送按钮。

**且具备诚实性**：主动声明「我也无法补验」「不是我能独立核实的事实」。

### 2.4 教训

**「我没检测到」不等于「不存在」。** 我的检测方法选错了层（外层 DOM vs iframe 内
`contenteditable`），却得出了肯定性的否定结论 —— 这正是本次走查要防范的错误类型，
由我自己犯下。

后续走查任何 iframe 承载的功能，必须先确认承载层再下结论。

---

## 三、✅ 走查通过的环节（含证据）

### 3.1 AI 辅助评阅 —— 真的调用模型

```
点「AI 辅助评阅」→ 约 15 秒 → 返回 74 / 100 分
评分证据（4 项）：实验环境与抓包过程 | 需裁决 | 已覆盖 | 缺失点
「缺失点：未说明如何触发握手过程（如浏览器访问、curl 或 telnet）」
「内置演示样例 · 不作为正式评分依据」   ← 诚实标记
```

报告内容具体到可核对（端口 80、Wireshark 4.2、序列号 3841092810、MSS 1460、
RST+ACK 异常场景），且明确标注不作正式评分依据。

### 3.2 提取正文 —— 真实原文

```
提取正文 | PAGE 1 | 第 1 / 1 页
UDP Checksum Verification Lab: capture DNS query port 53
正文来自服务器
```

逐字吻合文件内真实内容（task-28 修复成果在线上演示路径生效）。

### 3.3 学情分析 —— 口径诚实

```
均分仅统计已发布成绩，保留各作业原始分值；不同总分的作业不适合直接横向比较。
```

### 3.4 助手引用材料

助手 iframe 内可见：

```
引用 · UDP校验和实验指导书.pdf
```

说明「引用当前资料」把**真实的课件**带入了对话上下文。

---

## 四、🟡 唯一建议改进项：首页数字展示方式

### 现象

| 来源 | 数字 |
|---|---|
| 首页 | 「2 份提交待处理」「1 份提交待处理」 |
| 作业页 | 「1 份待复核」「4 份已提交」 |
| 数据库 | `submitted: 2` + `review: 1` |

三个数字看似打架。**实际首页是对的** —— 它显示的是**每项作业各自的数量**：

```js
// Workspace.tsx:55, 75
const needingReview = submissions.filter((s) =>
  (s.status === "review" || s.status === "submitted") &&
  latestSubmission(submissions, s.assignmentId, s.studentId)?.id === s.id);

// 渲染：`${needingReview.filter(s => s.assignmentId === a.id).length} 份提交待处理`
```

```
实验一 TCP：2 份（sub-xu-net + sub-zhou-net，均 submitted）
实验二 OS： 1 份（sub-xu-os，review）
```

**与数据库完全吻合 → 数据无误。** 但走查者（我）与潜在评委**都可能误读**为总数。

**建议**：加「共 3 份」汇总，或把文案改为「本作业 2 份待处理」以明确归属。

---

## 五、复现命令

```bash
# 正确检测助手（必须穿透 iframe + 找 contenteditable）
const f = document.querySelector(".assistant-column iframe");
const d = f.contentDocument;
d.querySelector("[contenteditable=true]")   // → 输入框
d.querySelectorAll("button").length          // → 功能按钮齐全

# 数据库真实提交状态
node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('/home/jiajun/learnbuddy/plugins/dsh-plugin-learnbuddy/data/learnbuddy.db');
console.log(d.prepare('SELECT status,COUNT(*) c FROM submissions GROUP BY status').all());
"
```
