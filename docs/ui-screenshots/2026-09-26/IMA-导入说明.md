# 界面截图 → IMA 知识库 导入说明

> 目录：`docs/ui-screenshots/2026-09-26/`　共 19 张，约 5.1 MB。
> 目的：**别人想找「某个页面长什么样」时，能按页面名/角色/路由直接搜到。**

## 为什么需要这份说明

本机 IMA 连接器未连接，无法由助手直接写入知识库。
所以这里给出一份**可直接照做的导入清单**：图片文件已在仓库里，按下面的标题与标签导入即可。

## 导入建议

1. 目标知识库：**艾玛知识库 / LearnBuddy**（与 `docs/ima-handoff/` 下其他文档同库）
2. 逐张上传本目录下的 PNG（文件名保持原样，便于和仓库对应）
3. 每张图的**标题**与**标签**按下表填写 —— 标题里带上页面名与角色，标签里带上路由，这样「评阅」「学情」「#insights」都能搜到
4. 可选：把 `index.html` 与 `README.md` 一起上传，作为总览入口

## 标题与标签对照表

| 文件 | 建议标题 | 建议标签（含路由） | 所属分类 |
| :--- | :--- | :--- | :--- |
| 00-login.png | 【公共】登录页 | `#home` | LearnBuddy / 界面截图 / 公共页 |
| 10-teacher-home.png | 【教师】教学空间（教师首页） | `#home` | LearnBuddy / 界面截图 / 教师端 |
| 11-teacher-courses.png | 【教师】课程库 | `#courses` | LearnBuddy / 界面截图 / 教师端 |
| 12-teacher-course.png | 【教师】课程工作区 | `#course/database` | LearnBuddy / 界面截图 / 教师端 |
| 13-teacher-material.png | 【教师】课件工作区 | `#material/mat-db` | LearnBuddy / 界面截图 / 教师端 |
| 14-teacher-assignments.png | 【教师】作业列表 | `#assignments/database` | LearnBuddy / 界面截图 / 教师端 |
| 15-teacher-assignment.png | 【教师】作业详情 / 布置 | `#assignment/lab-db` | LearnBuddy / 界面截图 / 教师端 |
| 16-teacher-grading.png | 【教师】评阅台（全班） | `#grading/lab-db` | LearnBuddy / 界面截图 / 教师端 |
| 17-teacher-review.png | 【教师】在线评阅（聚焦单份） | `#grading/lab-db/sub-xu-db` | LearnBuddy / 界面截图 / 教师端 |
| 18-teacher-report.png | 【教师】报告工作区 | `#report/sub-xu-db` | LearnBuddy / 界面截图 / 教师端 |
| 19-teacher-insights.png | 【教师】学情分析 | `#insights/database` | LearnBuddy / 界面截图 / 教师端 |
| 20-student-home.png | 【学生】学习空间（学生首页） | `#home` | LearnBuddy / 界面截图 / 学生端 |
| 21-student-courses.png | 【学生】课程库（学生所见 4 门课） | `#courses` | LearnBuddy / 界面截图 / 学生端 |
| 22-student-course.png | 【学生】课程工作区 | `#course/database` | LearnBuddy / 界面截图 / 学生端 |
| 23-student-material.png | 【学生】课件阅读 + 学习助手 | `#material/mat-db` | LearnBuddy / 界面截图 / 学生端 |
| 24-student-assignments.png | 【学生】我的作业 | `#assignments/database` | LearnBuddy / 界面截图 / 学生端 |
| 25-student-assignment.png | 【学生】作业提交页 | `#assignment/lab-db` | LearnBuddy / 界面截图 / 学生端 |
| 26-student-report.png | 【学生】我的报告 | `#report/sub-xu-db` | LearnBuddy / 界面截图 / 学生端 |
| 27-student-insights.png | 【学生】我的学情（学生视角） | `#insights/database` | LearnBuddy / 界面截图 / 学生端 |

## 备注

- 截图采集自**线上演示环境** 线上演示环境 http://129.204.52.57:3088/learnbuddy/
- 采集脚本与索引生成脚本：`capture-pw.cjs` / `build-index.cjs`
