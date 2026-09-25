# 「提取正文」未打通 —— 根因诊断报告

> 诊断时间：2026-09-24
> 触发：用户报告「提取文件盒阅读提取正文这一部分还没有打通」
> 结论：**根因已定位到具体代码行，且链路是「断在持久化」而不是「断在解析」**

---

## 一、结论先行

**正文被真实解析出来了，但没有落库 —— 前端「提取正文」只能拿到合成兜底文本。**

```
真实解析引擎 (anydoc)  ✅ 已接好，能产出 markdown 正文
       ↓
parseAndExtract 返回   ✅ 返回 { content: <真实正文>, knowledgePoints: [...] }
       ↓
上传接口存库           ❌ 只存 knowledgePoints，content 被丢弃
       ↓
materials 表            ❌ 根本没有正文列
       ↓
前端「提取正文」tab      ❌ 读不到正文，服务端合成假文本兜底
```

---

## 二、现场证据

### 2.1 现象（线上实测）

课程 `network` 里有这样一份资料：

```
真实网络实验报告原件.pdf   PDF · 54 B · 12 页 · 已整理
```

**但它的真实内容是（54 字节）：**
```
%PDF-1.4 End-to-End Real Upload Test PDF Content
%%EOF
```

**而这个「空文件」在界面上显示出了 12 页正文：**

```
「...告原件.pdf 第 1 页原理解构图」
「展示第 1 页涉及的技术拓扑与配置参数。」
「Figure 1-1: 第 1 页实验要点与图文说明」
```

**这些文字在文件里根本不存在。**

### 2.2 根因代码 —— 合成兜底

`plugins/dsh-plugin-learnbuddy/src/services/material-context.js:242-274`

```js
if (material.sampleKey && SAMPLE_PAGE_TEMPLATES[material.sampleKey]) {
  sections = 内置高质量样例;                    // 只有内置样例走这条
} else {
  // 2. 通用兜底：根据页码和已抽取知识点动态合成结构化图文段落
  for (let p = 1; p <= pageCount; p++) {
    const contentText = pageKps.length > 0
      ? pageKps.map((k) => k.summary).join("；")     // 有条目就拼摘要
      : `${material.title} 第 ${p} 页重点阐述与实验操作内容。`;   // ← 没有就编

    const diagrams = [{
      title: pageKps.length > 0
        ? `${pageKps[0].name} 示意图`
        : `${material.title} 第 ${p} 页原理解构图`,     // ← 「原理解构图」出处
      caption: `Figure ${p}-1: 第 ${p} 页实验要点与图文说明`,  // ← 出处
      description: pageKps.length > 0
        ? `展示第 ${p} 页核心考点「${pageKps[0].name}」的原理架构与关键交互。`
        : `展示第 ${p} 页涉及的技术拓扑与配置参数。`,      // ← 出处
    }];
  }
}
```

**这段逻辑完全不读文件内容** —— 只依赖两个数：`material.pages`（页数）+ `material.knowledge`（知识点）。
该文件 `pages=12`、`knowledge` 有 1 条 → 于是合成出 12 页假正文。

### 2.3 断点 —— 数据库没有正文列

```
materials 表实际列：
  id, course_id, owner_id, title, kind, visibility, status, size,
  pages, date, sample_key, blob_id, knowledge, cards, teaching,
  parse_error_code, parse_error
                                    ↑ 有 knowledge
                                    ✗ 没有 content / markdown / sections
```

### 2.4 上游其实是对的

`src/services/material-parser.js:279-327` 的 `parseAndExtract` **确实产出了真实正文**：

```js
const parsed = await this.parseDocument(filePath, originalName);
const textContent = parsed.markdown;          // ← 真实 markdown 正文
const knowledgePoints = await this.extractKnowledgePoints(textContent, ...);

return {
  ...
  content: textContent,                        // ← 正文在这里
  knowledgePoints,                             // ← 知识点在这里
  ...
};
```

而且文件头注释明确写了纪律：

```js
// material-parser.js:16
// ⚠️ task-14 起：文档解析走真实引擎 `@firecrawl/anydoc`（Rust napi-rs 原生绑定）
// material-parser.js:23
//   1. 正文必须来自真实解析（`toMarkdownBytes`），不允许任何硬编码示例文字；
```

**所以问题是：上传接口只把 `knowledgePoints` 存了，把 `content` 丢了。**

---

## 三、影响面

| 功能 | 受影响 | 说明 |
|---|---|---|
| 「提取正文」tab | ❌ **完全不可用** | 显示合成假文本，不是文件真实内容 |
| 知识点 tab | ⚠️ 部分 | 知识点是从真实正文抽取的（可信），但点击时只能定位到合成页码 |
| 助手引用原文 | ⚠️ **上下文造假** | 注入给模型的是合成段落 + 知识点摘要，不是文件真实正文 |
| 原件预览 | ✅ 正常 | 走 `<iframe src=blob>`，直接渲染真实文件 |
| 内置教学样例 | ✅ 正常 | 走 `sampleKey` → `SAMPLE_PAGE_TEMPLATES` 精心编写的高质量内容 |

> ⚠️ **最值得警惕的一条**：助手「引用原文」注入的是**合成文本**。这意味着模型可能基于不存在的内容回答问题 —— 演示时若被追问「这段原文在哪一页」，会答不上来。

---

## 四、修复方向（三条，从最小到完整）

### 方案 A：只把正文存下来，前端优先用它（推荐）

1. `materials` 表加一列 `content`（真实 markdown 正文）
2. 上传接口把 `parsed.content` 存进去
3. `material-context.js` 改为：**有 `content` 就按真实正文切页，没有再走兜底**
4. 兜底路径**必须显式标记**（如 `synthetic: true`），前端据此显示「此资料正文未提取，以下为摘要提示」而不是伪装成正文

**优点**：直击根因、改动可控
**缺点**：需要给已有 14 条历史数据补跑解析（或标记为"无正文"）

### 方案 B：不落库，读取时实时解析

每次打开课件时实时调 anydoc 解析 blob。

**优点**：不用改表结构
**缺点**：每次打开都要跑 Rust 解析（慢），且 anydoc 在浏览器进程里；**不推荐**

### 方案 C：只修「标记」，不修内容

保留合成兜底，但前端明确标注「以下为 AI 摘要，非原文」。

**优点**：改动最小、能立刻消除"欺骗性"
**缺点**：**没有真正打通**，用户问的就是「提取正文不通」

---

## 五、建议

**做方案 A，并按以下顺序：**

1. 先加 `synthetic` 标记 + 前端如实显示（**立刻消除欺骗性，风险最低**）
2. 再加 `content` 列 + 上传时落库（**真正打通**）
3. 前端「提取正文」优先渲染真实正文，按 markdown 标题切页
4. 历史数据：补跑解析，或明确标记为"无正文"（不伪造）

**验收标准必须是**：上传一份**真实的多页 PDF**，界面显示的正文与 PDF 里的文字**逐字可对照**。

---

## 六、复现命令

```bash
# 1. 看那份 54 字节的"12 页 PDF"的真实内容
cat /home/jiajun/learnbuddy/plugins/dsh-plugin-learnbuddy/uploads/de438aa2577dc1a8a315554fe84c22ffe1f2d22993911a4f074a9dada28a5971.pdf
# 输出：%PDF-1.4 End-to-End Real Upload Test PDF Content

# 2. 看数据库里存了什么（注意没有 content 列）
node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('/home/jiajun/learnbuddy/plugins/dsh-plugin-learnbuddy/data/learnbuddy.db');
console.log(d.prepare('PRAGMA table_info(materials)').all().map(c=>c.name).join(', '));
"

# 3. 看合成兜底代码
sed -n '242,274p' /home/jiajun/learnbuddy/plugins/dsh-plugin-learnbuddy/src/services/material-context.js
```
