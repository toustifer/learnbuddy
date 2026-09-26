# LearnBuddy 界面截图清单

> 采集日期：2026-09-26
> 共 **21** 张（**线上 19 张** + **本机预览 2 张**），合计约 **5.6 MB**。
>
> - 线上：线上演示环境 http://129.204.52.57:3088/learnbuddy/
> - 本机预览：用户在本机环境提供的补充截图，右下角带「本机预览」角标。
>   **两个环境不是同一份部署**，对照看时请注意来源列。

**想直接找页面**：打开 [`index.html`](./index.html)（带搜索框，输入页面名 / 路由 / 文件名 / 课程名即可过滤）。

线上那批的采集方式：Playwright 驱动 Chrome 153，视口 1440×900、deviceScaleFactor 2，全页截图；
登录态由服务端令牌注入（教师 `teacher.lin`、学生 `student.xu`，演示口令 `123`）。

## 清单

| 页面 | 路由 | 角色 | 来源 | 文件 | 体积 | 备注 |
| :--- | :--- | :--- | :--- | :--- | ---: | :--- |
| 登录页 | `#home` | 公共（未登录） | 线上 3088 | [`00-login.png`](./00-login.png) | 213 KB | — |
| 教学空间（教师首页） | `#home` | 教师（teacher.lin） | 线上 3088 | [`10-teacher-home.png`](./10-teacher-home.png) | 197 KB | — |
| 课程库 | `#courses` | 教师（teacher.lin） | 线上 3088 | [`11-teacher-courses.png`](./11-teacher-courses.png) | 246 KB | — |
| 课程工作区 | `#course/database` | 教师（teacher.lin） | 线上 3088 | [`12-teacher-course.png`](./12-teacher-course.png) | 165 KB | — |
| 课件工作区 | `#material/mat-db` | 教师（teacher.lin） | 线上 3088 | [`13-teacher-material.png`](./13-teacher-material.png) | 307 KB | 教师视角的同一份课件（对照上面的学生视角）。 |
| 作业列表 | `#assignments/database` | 教师（teacher.lin） | 线上 3088 | [`14-teacher-assignments.png`](./14-teacher-assignments.png) | 189 KB | — |
| 作业详情 / 布置 | `#assignment/lab-db` | 教师（teacher.lin） | 线上 3088 | [`15-teacher-assignment.png`](./15-teacher-assignment.png) | 210 KB | — |
| 评阅台（全班） | `#grading/lab-db` | 教师（teacher.lin） | 线上 3088 | [`16-teacher-grading.png`](./16-teacher-grading.png) | 188 KB | — |
| 在线评阅（聚焦单份） | `#grading/lab-db/sub-xu-db` | 教师（teacher.lin） | 线上 3088 | [`17-teacher-review.png`](./17-teacher-review.png) | 380 KB | 左栏是学生原件（DOCX，转 PDF 预览），右栏是评分复核 + 评分证据。 |
| 报告工作区 | `#report/sub-xu-db` | 教师（teacher.lin） | 线上 3088 | [`18-teacher-report.png`](./18-teacher-report.png) | 453 KB | — |
| 学情分析 | `#insights/database` | 教师（teacher.lin） | 线上 3088 | [`19-teacher-insights.png`](./19-teacher-insights.png) | 240 KB | 学情分析只有教师能看，与学生视角那张对照。 |
| 学习空间（学生首页） | `#home` | 学生（student.xu） | 线上 3088 | [`20-student-home.png`](./20-student-home.png) | 234 KB | — |
| 课程库（学生所见 4 门课） | `#courses` | 学生（student.xu） | 线上 3088 | [`21-student-courses.png`](./21-student-courses.png) | 647 KB | — |
| 课程工作区 | `#course/database` | 学生（student.xu） | 线上 3088 | [`22-student-course.png`](./22-student-course.png) | 180 KB | — |
| 课件阅读 + 学习助手 | `#material/mat-db` | 学生（student.xu） | 线上 3088 | [`23-student-material.png`](./23-student-material.png) | 320 KB | 左侧课件阅读正常（正文来自服务器）；右侧「学习助手」面板本次采集时**未连上**，面板自己给出了原因与重连入口。 |
| 我的作业 | `#assignments/database` | 学生（student.xu） | 线上 3088 | [`24-student-assignments.png`](./24-student-assignments.png) | 185 KB | — |
| 作业提交页 | `#assignment/lab-db` | 学生（student.xu） | 线上 3088 | [`25-student-assignment.png`](./25-student-assignment.png) | 282 KB | — |
| 我的报告 | `#report/sub-xu-db` | 学生（student.xu） | 线上 3088 | [`26-student-report.png`](./26-student-report.png) | 467 KB | — |
| 我的学情（学生视角） | `#insights/database` | 学生（student.xu） | 线上 3088 | [`27-student-insights.png`](./27-student-insights.png) | 108 KB | 学生打开学情分析会看到「教学反馈仅对教师开放」——这是**角色权限拦截**，不是页面故障。 |
| 课件阅读 + 学习助手（助手可用） | `#material/mat-tcp` | 学生（林一） | 本机预览（用户提供） | [`30-student-material-assistant.png`](./30-student-material-assistant.png) | 281 KB | 专门补的对照图：**本机预览下学习助手是连通可用的**（有引导语、引用当前资料、模型选择、提问框），右下角标注「本机预览」、底部标注「正文来自服务器」。与线上那张 23-student-material 的「未连上」形成对照。 |
| 课件工作区 · 备课助手 + 备课笔记 / 答疑卡 | `#material/mat-os` | 教师（陈知行 · teacher.chen） | 本机预览（用户提供） | [`31-teacher-material-prep-assistant.png`](./31-teacher-material-prep-assistant.png) | 272 KB | 教师视角比学生多两个页签：**备课笔记 / 答疑卡**；右侧面板此时叫 **备课助手**（学生侧叫学习助手）。这是线上那批截图里没有的形态 —— 同一页面对教师与学生呈现不同工具集。 |

## 复现

```bash
# 0) 依赖：Node 18+ 与 playwright-core（Chrome 直接复用 agent-browser 已装的那个）
#    npm install playwright-core --proxy http://127.0.0.1:7890 --https-proxy http://127.0.0.1:7890

# 1) 预热（可选但强烈建议）：线上链路对本机很慢，先把构建产物灌进持久化 profile 的缓存
node warmup.cjs 25

# 2) 采集：教师 10 页 + 学生 8 页 + 登录页，共 19 张
node capture-pw.cjs

# 3) 重新生成索引（index.html / README.md / IMA-导入说明.md）
node build-index.cjs
```

采集脚本里几个**必须保留**的等待，删了就会截到半成品：
等到 `#root` 有子节点（入口模块执行完）、等到页内不再出现「读取中」、
以及命中「暂时无法读取 / 被登出退回登录页」时**重载重试**（慢链路会把响应体截断，
而任意一次 `auth/me` 失败都会让前端清掉令牌 —— 所以每页导航前都要重新注入令牌）。

## 注意

- 截图取自**线上演示环境**，反映的是该环境当前部署的版本；本地未合并的改动不会出现在这里。
- 环境变量里带代理时，若浏览器启动失败，参考仓库记忆里记录的 `--no-sandbox` 与 CDP 连接坑。
