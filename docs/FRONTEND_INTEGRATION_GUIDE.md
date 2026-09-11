# LearnBuddy 前端对接指南

> **写给**：黄山（前端 UI 与数据对接）
> **版本**：2026-09-11
> **配套参考**：[`docs/API.md`](./API.md) —— 18 个端点的完整字段表、真实响应 JSON、错误码。本文是「怎么做」，那篇是「字段是什么」。

---

## 0. 你的任务边界（先说清楚，避免你背不必要的包袱）

你**只需要做两件事**：

1. **UI 与交互** —— 页面、样式、状态流转、动画、响应式
2. **对接数据** —— 把数据源从「浏览器内置演示数据」换成「调后端 HTTP 接口」

**不用你管**：后端逻辑、大模型调用、服务器部署、数据库、DSH 插件。这些**已经全部上线在跑**，你只要调接口就行。

---

## 1. 为什么现在必须换数据源

| 功能 | 现在（前端演示数据） | 换完之后 |
|---|---|---|
| 课件列表 | 前端写死的常量 | 后端真实解析的课件（含解析失败状态） |
| 知识点 | 前端写死 | 后端从真实 PDF/PPTX 里抽出来的 |
| **评阅分数** | ❌ **前端自己编的** | ✅ 后端真模型逐项评分（带页码证据） |
| 学情图表 | 前端自己算 | 后端按全班真实数据算 |
| 伴学答疑 | 本地规则匹配 | 先查教师答疑卡，未命中走模型 + 课件上下文 |

**最关键的是「评阅分数」**：现在 UI 上那个分数**没有任何后端来源**，是前端自造的。评委一旦追问「这个分怎么算的」，现在答不上来。换完之后你就是**真的在教学闭环上跑数据**。

---

## 2. ⚠️ 开工前必读：7 个坑（全部是实测出来的）

> 这一节是本文最重要的部分。**不看会踩**。

### 坑 1：后端**不校验 token**，别用它做路由守卫

`POST /auth/login` 会返回一个 `token`，但**没有任何接口会校验它**。带伪造 token 和不带，返回完全一样。

👉 **做法**：登录成功后把 `user` 存进前端状态，**用 `user.role` 做 UI 分支**（显示教师端 / 学生端）。不要把 token 当成访问前提，也不要写「未登录跳转」的拦截器去等一个后端 401（它不会返回 401）。

### 坑 2：登录接口**不校验密码**（数据库用户）

只要用户名存在，**任意密码**都能登录成功。

👉 **做法**：正常传 `password` 就行，但**别在前端写「密码错误」的乐观假设**——它不会错。这是后端待修的安全缺口，不是你要处理的。

### 坑 3：🚨 课件列表**必须带 `userId`**，否则会泄漏教师的私有资料

实测：`GET /materials`（不带 `userId`）会返回 `visibility: "private"` 的资料。

| 调用 | 是否正确过滤私有资料 |
|---|---|
| `/materials?userId=s-yi` | ✅ 正确隔离 |
| `/materials?userId=s-yi&courseId=network` | ✅ 正确隔离（**推荐这样调**） |
| `/materials?courseId=network` | ❌ **泄漏** |
| `/materials` | ❌ **泄漏** |

👉 **做法**：**所有**拉课件列表的地方都带上 `userId`。封装成一个函数，别让每个页面自己拼 URL。

### 坑 4：🚨 AI 当前处于**降级模式**，必须识别 `fallback`

DeepSeek 账户余额不足，所以现在：
- `POST /qa/ask` 未命中答疑卡时，返回的是**兜底话术**，且带 `"fallback": true`
- `POST /grader/submit` 返回的是**写死的 92 分**（与报告质量完全无关）

👉 **做法**：
- 答疑：检查 `data.fallback === true` → UI 上标注「当前为降级模式」或提示重试
- 评分：检查 `summaryReview` 是否等于兜底串（见 [`docs/API.md`](./API.md) §7.1）

> 💡 **演示小技巧**：如实标注「当前为降级模式」反而更显诚实，而且说明**系统有容错设计**——这其实是加分项（评委喜欢看系统怎么处理故障）。

### 坑 5：🚨 **缺 4 个端点**，这决定了你的改造顺序

后端目前**没有**这些接口：

| 缺失 | 影响 |
|---|---|
| `GET /submissions` | 前端**拉不到**提交列表、拿不到学生成绩明细 |
| `POST /submissions` | 前端**无法**发起新提交 |
| `GET /courses` | 前端拉不到课程下拉框 |
| `GET /assignments` | 前端拉不到作业列表 |

👉 **做法**：见下方 **§6 绕过方案**。**不要**自己造明细数据冒充后端结果。

### 坑 6：`status: "pending"` 是**正常契约**，不是「加载中」

课件解析失败时，后端返回 `status: "pending"` + `knowledge: []`（空数组）+ `parseStatus: "failed"` + `parseErrorCode`。

👉 **做法**：UI 上显示「**解析失败**：原因」，并提供「重新上传」引导。**不要**显示成加载动画，也不要假装有知识点。

可用的 `parseErrorCode`：
| code | 含义 | 给用户的提示 |
|---|---|---|
| `malformed` | 文件损坏 | 文件已损坏，请重新导出后再上传 |
| `encrypted` | 加密/需密码 | 该文件有密码保护，请先解除加密 |
| `unsupported` | 格式不支持 | 暂不支持该格式 |
| `needsOcr` | 扫描件/纯图片页 | 该文件是扫描件，需要 OCR（暂不支持） |
| `resourceLimit` | 超出安全上限 | 文件过于复杂，请拆分后再上传 |
| `io` | 读取失败 | 文件读取失败，请重试 |
| `engineUnavailable` | 后端解析引擎缺失 | 服务端配置问题，请联系管理员 |

### 坑 7：评阅类接口会**真实改数据库状态**，联调时别乱点

`POST /grader/grade-submission`、`/grader/batch`、`/grader/retry`、`/grader/review-publish` **会修改服务器上的真实数据**，而且**没有回滚接口**。

👉 **做法**：联调时用一个固定的演示提交 ID，别循环点。评阅状态机见 [`docs/API.md`](./API.md) §5。

---

## 3. 环境信息（照抄就能用）

### 3.1 服务地址

```
API Base:   http://129.204.52.57:3088/api/learnbuddy
前端入口:   http://129.204.52.57:3088/learnbuddy/
```

- **CORS 已全量放开**（`Access-Control-Allow-Origin: *`），本地 Vite 直接调，**不需要配代理**。
- 想看完整界面效果：`http://129.204.52.57:3088/learnbuddy/`

### 3.2 测试账号

| 用户名 | 密码 | 角色 | userId | 说明 |
|---|---|---|---|---|
| `user` | `123` | teacher | `user-demo` | 兜底账号（**唯一校验密码的**） |
| `teacher.chen` | `123` | teacher | `t-chen` | 陈知行，执教 `network`/`os`/`cs101` |
| `teacher.lin` | `123` | teacher | `t-lin` | 林悦，执教 `database` |
| `student.lin` | `123` | student | `s-yi` | 林一，选修 `network`/`os`/`cs101` |
| `student.zhou` | `123` | student | `s-zhou` | 周可 |
| `student.xu` | `123` | student | `s-xu` | 许然 |

> ⚠️ 除 `user`/`admin` 外，密码**不参与校验**（见坑 2）。

### 3.3 演示数据 ID 速查

| 类型 | ID | 说明 |
|---|---|---|
| 课程 | `network` / `os` / `database` / `cs101` | 计网 / 操作系统 / 数据库 / 计科导论 |
| 作业 | `lab-tcp`(network) / `lab-os`(os) / `lab-db`(database) | 均已发布 |
| 提交 | `sub-zhou-net` | `submitted`（**可评阅，联调用它**） |
| 提交 | `sub-xu-net` | `submitted`（可评阅） |
| 提交 | `sub-xu-os` | `review`（待教师发布） |
| 提交 | `sub-yi-os` | `published`（**已发布，不可重复评阅**） |
| 课件 | `mat-tcp` | 第三章 · TCP 可靠传输（**首选上下文样例**） |
| 课件 | `mat-net-teach` | 教师私有（测试权限隔离用） |

---

## 4. 改造地图：动哪些文件

基于你现有的前端结构（`plugins/dsh-plugin-learnbuddy/web/`）：

| 文件 | 现在的作用 | 要改成什么 |
|---|---|---|
| `src/context.tsx` | 全局状态容器，从 localStorage 读写 | **改成从后端拉取**；保留内存状态，写操作调后端接口 |
| `src/storage.ts` | IndexedDB 存文件 blob | 上传走后端 `POST /materials/upload`；预览用 `GET /files/:id/view` |
| `src/seed.ts` | 演示数据常量 | 只作为「后端不可用时的兜底」，或直接删除 |
| `src/pages/App` 各页面 | 读 `useStore()` 的本地数据 | 读改成从后端来的数据 |
| `src/dsh.ts` / `DshAssistant.tsx` | 助手 iframe 桥接 | **不用动**（已经能工作） |

**建议新增一个统一 API 客户端**（见 §7.1），所有页面都通过它调接口 —— 这样 URL 拼接、错误处理、`userId` 只写一次（坑 3 就靠这个规避）。

---

## 5. 推荐分批实施（每批都能演示）

> 不要一次全改完。**每批做完都应该是可演示的状态**。

### 🥇 第一批 P0：让它「活」起来（建议 1~2 天）

| # | 功能 | 接口 |
|---|---|---|
| 1 | 登录 | `POST /auth/login` |
| 2 | 资料库列表 | `GET /materials?userId=&courseId=` |
| 3 | 课件详情（原文 + 知识点） | `GET /materials/:id/context?userId=` |
| 4 | 伴学答疑 | `POST /qa/ask`（注意 `fallback`） |
| 5 | 答疑卡检索（可选） | `POST /qa/cards/search` |

**✅ 验收标准**：登录后能看到**后端真实课件列表**；点进课件能看到真实知识点；提问能得到后端响应（并正确识别降级）。

### 🥈 第二批 P1：真评分（建议 2~3 天）

| # | 功能 | 接口 |
|---|---|---|
| 6 | 单份评阅 | `POST /grader/grade-submission` `{submissionId}` |
| 7 | 全班批量评阅 | `POST /grader/batch` `{assignmentId, concurrency}` |
| 8 | 失败重试 | `POST /grader/retry` `{submissionId}` |
| 9 | 教师复核发布 | `POST /grader/review-publish` |

**✅ 验收标准**：点击「评阅」能看到**后端返回的逐项评分**（每项带 `score` / `max` / `comment` / **`page` 页码证据** / `evidence` 原文引用）。

> 💡 这是你**最能出彩**的地方 —— `evidence` 字段是报告里的**原文引用**，把它渲染成「评分依据卡」，视觉冲击力很强。

### 🥉 第三批 P2：学情大盘（建议 1~2 天）

| # | 功能 | 接口 |
|---|---|---|
| 10 | 作业学情 + 薄弱项 | `GET /analytics/assignment/:id?skipLLM=1` |
| 11 | 课程大盘 | `GET /analytics/course/:id?skipLLM=1` |

**✅ 验收标准**：图表数字来自后端（不是前端算的）。

> ⚠️ 注意：**均分/最高分/分数段只统计 `published` 状态**的报告。`publishedCount: 0` 时所有分数必然为 0 —— 先看这个字段，别以为是 bug。

---

## 6. 缺端点的绕过方案（重要，决定你的排期）

后端**没有**提交列表/创建提交/课程列表/作业列表端点。三个选择：

### 方案 A（推荐，你立刻能开工）

**「本地负责编排，后端负责算分」**：

- 课程、作业、提交列表这些**结构数据**暂时继续用你本地的（或固定 2~3 个演示条目）
- 但**提交 ID 用后端的真实 ID**（`sub-zhou-net` / `sub-xu-net`）
- **评分结果 100% 从后端拿**（`grader/grade-submission`）
- 学情从后端拿（`analytics/assignment/lab-tcp`）

这样你**今天就能开始**，而且最关键的「真评分」是真的。

### 方案 B（如果我这边补端点）

我去派任务补上 `GET /submissions`、`POST /submissions`、`GET /courses`、`GET /assignments`（估计 1~2 天），你等一下再动 P1。

### 方案 C（不推荐）

用 `/analytics/*` 的聚合数字凑展示 —— 只有总数没有明细，撑不起"逐项评分"这个卖点。

> 📌 **我的建议**：先用 **方案 A** 把 P0 做完（1~2 天），同时告诉我你需要哪些端点，我并行去补。你做完 P0 我大概率也补完了。

---

## 7. 代码模板（可直接抄）

### 7.1 统一 API 客户端（新建 `src/api.ts`）

```ts
export const API_BASE = "http://129.204.52.57:3088/api/learnbuddy";

export type ApiUser = {
  id: string;
  username: string;
  name: string;
  role: "teacher" | "student";
  initials?: string;
};

/** 统一请求：把错误统一成 Error，避免每个页面各写一遍 try/catch */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    // 未匹配的路由会穿透到反代，返回纯文本 404（见 API.md §2.3）
    throw new Error(`接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 80)}`);
  }
  if (!data.ok) throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
  return data as T;
}

// ─── 认证 ───────────────────────────────────────────────
export async function login(username: string, password: string) {
  return request<{ ok: true; token: string; user: ApiUser }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

// ─── 课件 ───────────────────────────────────────────────
export type Material = {
  id: string;
  courseId: string;
  ownerId: string;
  title: string;
  kind: string;
  visibility: "course" | "private";
  status: "ready" | "pending";
  size: string;
  pages: number;
  date: string;
  blobId?: string;
  knowledge: Array<{ id: string; title: string; summary: string; page: number }>;
  cards: Array<{ id: string; question: string; answer: string; keywords?: string; confirmed?: boolean }>;
  // 解析失败时才有：
  parseStatus: "parsed" | "pending" | "failed";
  parseErrorCode?: string;
  parseError?: string;
};

/** ⚠️ 必须带 userId，否则会拿到教师私有资料（坑 3） */
export async function listMaterials(userId: string, courseId?: string) {
  const qs = new URLSearchParams({ userId });
  if (courseId) qs.set("courseId", courseId);
  const data = await request<{ ok: true; materials: Material[] }>(`/materials?${qs}`);
  return data.materials;
}

export async function getMaterialContext(materialId: string, userId: string) {
  const data = await request<{ ok: true; context: any }>(
    `/materials/${encodeURIComponent(materialId)}/context?userId=${encodeURIComponent(userId)}`,
  );
  return data.context;
}

// ─── 伴学答疑 ───────────────────────────────────────────
export type AskResult = {
  ok: true;
  source: "teacher_card" | "agent_llm";
  answer: string;
  cardId?: string;
  title?: string;
  contextInjected?: boolean;
  /** ⚠️ 为 true 表示后端降级（不是模型产出）—— 见坑 4 */
  fallback?: boolean;
};

export async function ask(question: string, opts: { courseId?: string; userId?: string; materialId?: string } = {}) {
  return request<AskResult>("/qa/ask", {
    method: "POST",
    body: JSON.stringify({ question, ...opts }),
  });
}

export async function searchCards(courseId: string, query: string) {
  return request<{ ok: true; cards: any[] }>("/qa/cards/search", {
    method: "POST",
    body: JSON.stringify({ courseId, query }),
  });
}

// ─── 评阅 ───────────────────────────────────────────────
export type RubricGrade = {
  rubricId: string;
  score: number;
  page?: number;
  comment?: string;
  /** 报告原文引用 —— 渲染成「评分依据」很有说服力 */
  evidence?: string;
};

export type GradeResult = {
  ok: true;
  submissionId: string;
  status: "review" | "failed";
  totalScore: number;
  maxScore: number;
  grades: RubricGrade[];
  summary: string;
};

export async function gradeSubmission(submissionId: string) {
  return request<GradeResult>("/grader/grade-submission", {
    method: "POST",
    body: JSON.stringify({ submissionId }),
  });
}

export async function gradeBatch(assignmentId: string, concurrency = 2) {
  return request<{ ok: true; total: number; processed: number; succeeded: number; failed: number; results: any[] }>(
    "/grader/batch",
    { method: "POST", body: JSON.stringify({ assignmentId, concurrency }) },
  );
}

export async function publishReview(input: {
  submissionId: string;
  teacherId: string;
  grades: Array<{ rubricId: string; score: number; page?: number; comment?: string }>;
  summary?: string;
}) {
  return request<{ ok: true; status: "published"; totalScore: number; maxScore: number; reviewVersion: number }>(
    "/grader/review-publish",
    { method: "POST", body: JSON.stringify(input) },
  );
}

// ─── 学情 ───────────────────────────────────────────────
export async function assignmentAnalytics(assignmentId: string) {
  return request<{ ok: true; [k: string]: any }>(
    `/analytics/assignment/${encodeURIComponent(assignmentId)}?skipLLM=1`,
  );
}

export async function courseAnalytics(courseId: string) {
  return request<{ ok: true; [k: string]: any }>(
    `/analytics/course/${encodeURIComponent(courseId)}?skipLLM=1`,
  );
}

// ─── 文件预览 / 下载 ────────────────────────────────────
export const fileViewUrl = (blobId: string) => `${API_BASE}/files/${encodeURIComponent(blobId)}/view`;
export const fileDownloadUrl = (blobId: string) => `${API_BASE}/files/${encodeURIComponent(blobId)}/download`;
```

### 7.2 一个页面怎么接（以「资料库」为例）

```tsx
// 改造前：读本地 seed / localStorage
// const materials = useStore().materials;

// 改造后：从后端拉
function Library() {
  const { user } = useSession();              // 登录后存下来的 { id, role, name }
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    listMaterials(user.id, "network")          // ⚠️ 一定带 user.id
      .then(setMaterials)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [user]);

  if (loading) return <Spinner />;
  if (error) return <Retry onRetry={/* … */}>{error}</Retry>;

  return materials.map((m) => (
    <MaterialRow key={m.id}>
      <Title>{m.title}</Title>
      <Size>{m.size}</Size>

      {/* 坑 6：解析失败是正常契约，要如实展示原因 */}
      {m.parseStatus === "failed" ? (
        <Alert kind="warning">
          解析失败：{parseErrorText(m.parseErrorCode)}
          <button>重新上传</button>
        </Alert>
      ) : (
        <KnowledgeList items={m.knowledge} />
      )}

      {/* 预览走后端直链，不用再自己存 blob */}
      {m.blobId && (
        <a href={fileViewUrl(m.blobId)} target="_blank" rel="noreferrer">查看原件</a>
      )}
    </MaterialRow>
  ));
}

function parseErrorText(code?: string) {
  return {
    malformed: "文件已损坏，请重新导出后再上传",
    encrypted: "该文件有密码保护，请先解除加密",
    unsupported: "暂不支持该格式",
    needsOcr: "该文件是扫描件，需要 OCR（暂不支持）",
    resourceLimit: "文件过于复杂，请拆分后再上传",
    io: "文件读取失败，请重试",
    engineUnavailable: "服务端解析引擎缺失，请联系管理员",
  }[code ?? ""] ?? "未知原因";
}
```

### 7.3 答疑面板怎么处理降级（坑 4 代码化）

```tsx
async function handleAsk(question: string) {
  const res = await ask(question, { courseId: "network", userId: user.id, materialId: "mat-tcp" });

  pushMessage({
    role: "assistant",
    text: res.answer,
    // 命中教师卡 → 标「教师权威解答」（这是赛题亮点，要显眼）
    badge: res.source === "teacher_card" ? "教师权威解答" : null,
    // 降级 → 如实标注，不要假装是真的
    degraded: res.fallback === true,
  });
}

// 渲染时：
{msg.degraded && (
  <Hint>当前为降级模式（模型暂不可用），回答仅供参考</Hint>
)}
```

---

## 8. 各页面具体接法一览

| 页面 | 现在用什么 | 改成调 |
|---|---|---|
| 登录 | 假登录 | `POST /auth/login` |
| 资料库 | `seed.ts` 常量 | `GET /materials?userId=&courseId=` |
| 材料工作台 | 常量知识点 + 本地 blob | `GET /materials/:id/context` + `GET /files/:id/view` |
| 材料页助手 | iframe（**已可用，不用动**） | 需要注入上下文时加 `POST /dsh/session-context` |
| 伴学答疑 | 本地规则 | `POST /qa/ask`（+ `/qa/cards/search`） |
| 作业与报告 | 本地假提交 | ⚠️ 缺端点 → 用固定 ID + 后端评分结果（方案 A） |
| 评阅管理 | 前端假分 | `POST /grader/batch`、`/grader/grade-submission` |
| 报告详情 | 前端假 Rubric | 用 `grades[]`（含 `page` / `evidence`） |
| 教师复核发布 | 前端假发布 | `POST /grader/review-publish` |
| 教学反馈 | 前端自算 | `GET /analytics/assignment/:id`、`/analytics/course/:id` |

---

## 9. 自测验收清单

联调完成后，逐条自查：

- [ ] 用 `student.lin` / `teacher.chen` 登录，界面按 `user.role` 正确切换
- [ ] 课件列表来自后端（改一条后端数据，刷新页面能看到变化）
- [ ] **所有**拉课件的地方都带了 `userId`（用 `teacher.chen` 登录，不该看到无关的私有资料）
- [ ] 解析失败的课件显示**具体原因**，不是「加载中」
- [ ] 点「查看原件」能在新标签打开真实文件
- [ ] 提问时：命中教师卡显示「教师权威解答」；未命中显示模型回答
- [ ] 降级时（`fallback: true`）UI 有明确标注，不冒充真结果
- [ ] 点「评阅」拿到的是**后端返回的逐项评分**（且有页码 / 原文引用）
- [ ] 学情页数字来自后端（`publishedCount: 0` 时显示「暂无已发布报告」，不是显示 0 分）
- [ ] 断网 / 后端挂掉时，页面有可读的错误提示 + 重试按钮（不是白屏）

---

## 10. 遇到问题怎么办

| 现象 | 可能原因 | 怎么办 |
|---|---|---|
| 请求报 CORS | 极少见（CORS 已全开） | 检查 URL 是否写错（注意 `/api/learnbuddy` 前缀） |
| 返回纯文本 `404 not found` | 路由未匹配，穿透到反代了 | 核对路径拼写（见 API.md §2.3） |
| 拿到的资料里有别人的私有文件 | 忘了带 `userId` | 见坑 3 |
| 评分老是 92 分不变 | **后端在降级模式**（余额问题） | 见坑 4，这是**后端的事**，不是你的 bug |
| 提问回答很套路 | 同上（降级） | 同上 |
| 评阅报 400 | 状态机不允许 | 查 [`docs/API.md`](./API.md) §5 状态机表 |
| 找不到提交列表接口 | 端点确实缺失 | 见 §6，用方案 A |

**找谁**：
- 接口字段/行为不懂 → 先查 [`docs/API.md`](./API.md)（18 个端点全有实测响应）
- 接口不够用 / 需要新端点 → **告诉我**（我这边派任务补）
- 后端 bug / 数据不对 → **告诉我**，你不用改后端

---

## 附：3 分钟演示脚本建议（供你设计 UI 时参考）

评委想看的是「**AI 真的在教学闭环里工作**」，建议按这个顺序演：

1. **教师端**：上传一份实验指导书 → 展示**后端真实解析出的知识点**（带页码）
2. **学生端**：打开课件 → 提一个有代表性的问题 → **命中教师预设答疑卡**（显示「教师权威解答」）
3. 学生端：提一个超纲问题 → 走模型 + **课件上下文**（显示「根据第 X 页…」）
4. **评阅**：点一份报告的「自动评阅」→ 展示**逐项评分卡**，每项带**页码 + 报告原文引用**
5. **教师复核**：改一个分数 → 点「发布」→ 状态变 `published`
6. **学情**：切到反馈页 → 展示**薄弱采分点排名** + **下周备课建议**

> 这个脚本里，第 4 步的「**评分依据带报告原文引用**」和**第 6 步**是最容易让评委记住的。

---

*本文由 Leader 维护。接口字段的权威来源是 [`docs/API.md`](./API.md)；本文若与它冲突，以 API.md 为准。*
