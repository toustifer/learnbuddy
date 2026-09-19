# AutoGrader v0.2 需求与当前实现对齐

核对：2026-09-19，代码 `1ac6a10`。来源：用户提供的 `D:\download\AutoGrader_PRD_v0.2.docx`，原 Word 未改动。

结论：管理、评分状态、复核和统计有基础；v0.2 核心的真实报告证据链、定位高亮、覆盖缺失和教师关注体验尚未打通。“部分”表示有可复用实现但未满足全项验收；课件解析、模拟页面不计为真实报告评分完成。

## 1. F1–F13 对照

| 需求 | 优先级 | 当前实现 | 对齐交付条件 |
| --- | --- | --- | --- |
| F1 作业与 Rubric | P0 | 部分。AssignmentForm.tsx 与 teaching.js 支持编辑发布；保存 id/title/criterion/max。缺结构化提交要求、证据要求与档位 | 教师确认 4–6 项；提交要求可保存；档位和证据配置方式待定 |
| F2 报告上传解析 | P0 | 部分。POST /submissions 已接收文件并落盘；在线提交按钮仍禁用；extractReportContent 返回样例/固定描述 | 在线上传真实 PDF/DOCX，解析内容与页/图引用实际用于评分 |
| F3 处理过程可视化 | P0 | 未满足。只有请求处理中提示，没有解析结构和逐项匹配阶段 | 展示真实识别结构与阶段，不伪造代码/表格数量和进度 |
| F4 逐项建议 | P0 | 部分。Rubric 映射、模型调用、限分和总分累加已有；输入及降级证据含固定描述 | 使用真实报告，每项返回判断、建议分、理由；不得修改评分标准 |
| F5 证据定位高亮 | P0 | 未满足。Online.tsx 只有 page/evidence 文本和原件外链，无阅读器联动与坐标 | 点击证据定位真实页/元素并高亮，覆盖文本和典型截图 |
| F6 覆盖缺失 | P0 | 未实现结构化能力；评语文字不能代替覆盖记录 | 展示子要求的已找到/未覆盖；读取失败不判为缺失 |
| F7 教师关注 | P0 | 未实现。现有筛选是提交状态，不是评分项关注分类 | 单份关注计数和筛选，跨学生 Review Item 队列与关注原因 |
| F8 修改确认 | P0 | 部分，基础较完整。改分、评语、整体发布、服务端事务快照已有 | 新增逐项采纳/修改/待处理语义，区分建议与最终结果，明确单项确认与发布关系 |
| F9 批量评阅 | P1 | 部分。受控并发、汇总与入口已有，无实时阶段和关注计数 | 真实报告批量可运行，阶段与关注统计真实可核对 |
| F10 班级洞察 | P0/P1 | 部分。已发布成绩的 Rubric 均分/失分率、薄弱项已有；无结构化缺失/矛盾聚合 | P0 至少一项由正式结果计算的洞察，确认后刷新；不得把平均得分率当掌握人数比例 |
| F11 矛盾检测 | P1 | 未实现专项检测与双证据展示 | 至少一个可复跑样本，展示两处真实证据；不稳定则不阻塞 P0 |
| F12 学生反馈 | P1 | 基础已有。Academic.tsx 展示正式成绩，workspace/store 过滤未发布结果 | 接通新正式结果，验证内部建议/标签/历史不可见；过滤不等于正式鉴权完成 |
| F13 重试快照 | P2 | 部分。失败重试与教师发布 history 已有；不是完整 AI 评阅版本与回滚 | 保留基础，完整 Review/Submission 版本按 P2 设计 |

## 2. 必须纠正的能力表述

**课件解析不等于报告解析。** material-parser.js 已接 AnyDoc，但报告评阅未接入；课件路径仍跳过 PDF 图片提取、估算 PDF 页数，知识点模型失败可能回落 TCP 模板。复用时必须补报告适用输出与稳定来源定位。

**证据文字不等于可定位证据。** 当前 page/evidence 缺文件版本、元素 ID、区域坐标等完整引用契约。原件外链无法满足同屏点击、高亮及双证据对照。

**发布快照不等于独立 Review。** submissions 存 grades/summary/history；复核发布在事务中追加教师、时间、最终成绩与评语。这可以复用，但不代表 rubricVersion、每次 AI 原始建议、逐项教师决定已完整存在。

**严格模型模式不等于真实证据。** 在线单份、重试和批量带 strictLLM，模型失败抛错；但报告输入依然可能是固定描述。其他路径还有模拟/规则降级，应明确来源。

## 3. 状态对齐

| 维度 | 当前 | v0.2 目标 |
| --- | --- | --- |
| 提交/发布 | submitted/grading/review/published/failed 混用 | 保留提交与发布语义，不能把 completed 等同发布 |
| 执行 | 使用 submission.status | reviewStatus：pending/processing/completed/needs_review/failed |
| 内容 | 分数、评语和部分路径 status | judgment：satisfied/partially_satisfied/not_satisfied/professional_judgment |
| 关注 | 无独立分类 | 表现明确/值得关注/需进一步处理，规则待决 |

建议新增兼容字段再迁移，不直接改旧数据库枚举。PRD 尚未定义 completed 与 needs_review 的完整流转、待处理项是否阻止发布，不能自行当作已确定规则。

## 4. 设计前待定事项

| 决策 | 建议起点，尚未确认为需求 |
| --- | --- |
| 关注分类 | 模型形成判断，程序按缺失、冲突、待处理信号分类，教师可调整；不用置信度替代全部规则 |
| Rubric 档位及证据要求 | 先用 TCP 模板供教师确认，再扩展通用编辑器 |
| DOCX 页码 | 固定版式预览与原件映射；段落序号不能冒充真实页码 |
| 覆盖缺失 | 子要求绑定证据和检索范围；解析不足保留无法判断 |
| 班级指标 | 先用已发布 Rubric 得分率；显示缺失人数需正式缺失标签和明确分母 |
| 单项确认与发布 | 单项可保存草稿，整体发布；未处理项发布规则待定 |
| F7 与 F9 依赖 | P0 关注队列可读取已有多份真实结果，不必先做大型实时批量平台 |

## 5. 下一次验收

1. 教师确认 TCP Rubric，从在线页面上传真实 PDF/DOCX，原件与记录可恢复。
2. 展示真实解析结构与阶段；评分证据属于当前报告。
3. 点击评分项证据，阅读器跳转并高亮真实原文/截图；切换报告不会沿用上一份引用。
4. A 高质量报告显示明确项；B 缺少 Sequence Number 解释显示覆盖差异与关注原因，不仅判断关键词出现。
5. 教师改分和评语后发布；服务端求和，刷新后仍在；发布前学生不可见内部建议。
6. 已确认结果改变对应班级指标；统计范围、分母可核对。
7. 更换报告复跑；坏文件、无密钥、非法输出失败或待处理，不生成固定高分。
8. 可选 C 矛盾样本展示两处真实证据；20/30/40 份批量规模依据实际稳定性决定，不伪造 PRD 示意计数。

异常不做主展示，不等于取消失败回归；完整认证列 P2，不等于可以宣称现有权限已完备。

## 6. 实现证据入口

- [报告提取与评分](../plugins/dsh-plugin-learnbuddy/src/services/autograder-pipeline.js)
- [提交接收 API](../plugins/dsh-plugin-learnbuddy/src/routes/api.js)
- [Rubric 保存和工作台过滤](../plugins/dsh-plugin-learnbuddy/src/routes/teaching.js)
- [在线提交占位](../plugins/dsh-plugin-learnbuddy/web/src/pages/AssignmentForm.tsx)
- [在线评分、证据展示和统计](../plugins/dsh-plugin-learnbuddy/web/src/pages/Online.tsx)
- [学生正式反馈](../plugins/dsh-plugin-learnbuddy/web/src/pages/Academic.tsx)
- [发布事务及学情计算](../plugins/dsh-plugin-learnbuddy/src/services/feedback-analytics.js)
- [数据库结构](../plugins/dsh-plugin-learnbuddy/src/db/schema.js)
- [课件解析](../plugins/dsh-plugin-learnbuddy/src/services/material-parser.js)

本次读取了 Word 正文与表格并对照上述代码；没有线上写入、真实模型调用或重跑测试。历史测试仅代表对应工程检查，不替代本表业务验收。外部 Word 不在仓库中，跨机器交接请同时提供原 PRD。
