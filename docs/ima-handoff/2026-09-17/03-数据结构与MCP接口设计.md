# LearnBuddy 数据结构与 MCP 接口设计

版本 1.0｜2026 年 9 月 17 日｜功能 C01 至 C06、G01 至 G03 及全部业务数据。

平台应把同一份业务数据提供给网页、内置 DSH Agent 和外部 MCP 客户端。IMA 存放开发知识；课程、文件、报告、成绩与会话映射存放在平台后端。以下是基于现有 SQLite 和文件存储的增量实施建议，尚未作为数据库迁移或 MCP 服务落地。

## 1 总体结构

网页和 DSH 插件调用业务服务；MCP 适配器也调用同一业务服务。业务服务负责身份、角色、课程关系、字段可见性和状态校验，再访问 SQLite、原件和解析产物。不要让 MCP 直接开放 SQL、文件系统路径或任意服务器命令。

建议 Demo 沿用 SQLite 和服务器文件存储，避免先迁移数据库平台。允许把嵌套评分表、知识点和解析清单保存为带 schemaVersion 的结构化 JSON；“Agent 友好”要求可按权限查询、字段明确、来源可追溯，并不要求把所有字段立刻拆成独立数据表。

## 2 现有数据与增量变化

现有 schema 包含 users、courses、enrollments、materials、assignments、submissions。materials 内保存 knowledge、cards、teaching，assignments 内保存 material_ids 和 rubric，submissions 内保存 grades、summary、history。文件使用 StorageService 保存，不能把 Markdown 或 IMA 当作这些记录的主数据库。

| 实体 | 保留与新增的核心字段 | 本轮用途 |
| --- | --- | --- |
| User | id、role；新增可信认证主体映射 | 由登录会话得到身份，禁止请求自报角色 |
| Course 与 Enrollment | courseId、teacherId、studentId | 单教师课程和学生多课程关系保持不变 |
| Material | id、courseId、ownerId、visibility；currentVersionId | 区分课程共享和私人材料，指向当前版本 |
| DocumentVersion | id、parentType、parentId、blobId、revision、hash、mime、sizeBytes、createdBy、createdAt | 课件和报告共用版本与原件结构 |
| ParseArtifact | versionId、schemaVersion、status、blocks、assets、warnings、engine、engineVersion | 保存真实解析结果与未读范围；大产物存文件，数据库存受控引用 |
| KnowledgePoint | id、versionId、title、explanation、evidenceRefs、generationSource | 标明来自哪一版本及哪些块 |
| AnswerCard | id、courseId、materialVersionId、question、answer、conditions、keywords、status、revision、confirmedBy、confirmedAt | 只把已发布教师卡交给学生 |
| Assignment | id、courseId、description、materialVersionIds、requiredTasks、rubric、revision、published | 分开记录必交要求和评分项 |
| SubmissionAttempt | id、assignmentId、studentId、attemptNo、documentVersionId、assignmentRevision、createdAt | 每次提交单独保留，补交不覆盖原件 |
| SubmissionCheck | attemptId、status、checks、missingItems、errorCode、checkedAt | 检查归属和完整性，不生成分数 |
| GradingRun | id、attemptId、rubricSnapshot、items、total、status、source、modelRunId、reviewState | AI 建议与人工复核分别记录 |
| AgentSession | actorId、mode、courseId、contextId、dshSessionId、workspaceRef、lastUsedAt | 按用户与任务恢复会话 |
| AuditEvent | id、actorId、action、objectRef、beforeRevision、afterRevision、createdAt、requestId | 追溯发布、改分、确认、补交和权限变更 |

上述实体是领域契约，不要求一一对应新表。建议先新增 document_versions、processing_jobs、agent_sessions、audit_events；其余嵌套记录用现有表的版本化 JSON 增量承接。提交尝试与评分运行若并发修改或查询复杂，再拆为独立表。迁移方案须有旧数据样本回读测试。

## 3 统一字段和不变量

所有业务标识使用不含私人内容的稳定 ID，禁止以文件名作为唯一键。时间保存 UTC ISO 8601，界面按用户时区显示。记录包含 schemaVersion，发生内容更新时 revision 递增；以 expectedRevision 检查并发修改，冲突返回可理解的错误，不覆盖他人刚完成的编辑。

原件内容不变，更新产生新版本。SHA-256 可用于字节去重，但相同 blobId 不意味着两个用户互相拥有访问权。文件下载必须从材料或报告的归属关系校验权限，不能只凭 hash 直接读取。

提交绑定当时的作业版本；评分绑定当时的评分表快照和报告版本。改分追加历史，重新评分创建新 run，不覆盖原始模型建议或原教师记录。列表默认展示每位学生当前有效的提交尝试，历史仍可追溯。

资料正文和图像不写入操作日志或审计事件。日志只保留必要 ID、状态和错误码，密钥、登录凭据、原始会话令牌不进入 IMA、Git 或浏览器日志。

## 4 证据结构

EvidenceRefV1 的示例仅说明字段，不代表已有数据。

```json
{
  "id": "ev_0001",
  "documentVersionId": "dv_001",
  "blockId": "block_014",
  "kind": "image",
  "locator": {"page": 2, "figure": "图 1"},
  "quote": "图中 SYN 标志位",
  "assetId": "asset_003"
}
```

PDF 和 PPTX 使用页或幻灯片序号；DOCX 使用标题路径、段落和表格位置，渲染后可增加版本绑定页码；表格使用工作表和范围。bbox 如使用，须说明相对于哪个页面图像、坐标单位及渲染尺寸。不存在页码时留空，不用估计页码填充。

模型返回 evidenceRef 必须属于该次已授权且已读取的输入集合。资源读取失败、过期或版本失效时返回可恢复错误，不替换成另一份材料的证据。

## 5 权限和字段投影

| 数据 | 学生 | 任课教师 | 全局 Agent 与 MCP |
| --- | --- | --- | --- |
| 课程共享资料与已发布卡片 | 已参加课程可读 | 可管理任教课程 | 继承调用者范围 |
| 私人学习或备课文件 | 仅本人 | 仅文件本人，不因教师身份读学生私件 | 仅本人授权内容 |
| 作业与必交要求 | 仅已发布且本人可访问 | 可创建和维护 | 首版只读 |
| 提交与检查结果 | 仅本人 | 任教课程可读 | 按角色投影 |
| AI 建议分与详细评语 | 教师确认前不返回 | 可读并可复核 | 同样不向学生泄露未确认字段 |
| 已确认成绩与依据 | 本人可读 | 任教课程可读 | 保持同一规则 |
| 私人对话 | 本人 | 不读取学生私人聊天 | 不通过教师概览或通用搜索泄露 |

黄山已确认 D2：教师确认后学生可查看自己的分数、详细评语与依据。D3：确认不阻塞评分、统计和教学建议。应在服务层生成 StudentSubmissionView 与 TeacherSubmissionView；学生投影在确认前移除 total、items 中的分数、详细评语和包含这些信息的 history，不能只在前端隐藏。

教师统计区分“AI 建议口径”和“已复核口径”，都附样本范围与时间。教师未复核的分数可以支撑其内部备课建议，但不写入学生可见的正式结果。

## 6 异步任务

processing_jobs 统一支持 parse、knowledge_extract、card_generate、submission_check、grade、teaching_feedback。字段包含 jobId、type、subjectRef、requestedBy、inputRevision、idempotencyKey、status、progress、attemptCount、errorCode、createdAt、updatedAt。

状态为 queued、running、succeeded、failed、cancelled。服务重启后把遗留 running 任务标为可恢复，按幂等键检查是否已有结果；不能重复确认成绩或创建重复提交。建议 Demo 从单机持久化队列和受控并发开始，不增加分布式队列依赖。

短查询同步返回；耗时处理返回 jobId，由网页和工具轮询统一结果。并发度、文件大小、处理超时和保留期集中配置。保留期由团队结合演示数据与后续运营确定，不在这次文档里擅自承诺永久保存。

## 7 MCP 最小只读工具集

下列名称为拟新增工具，当前仓库未发现对应 MCP 服务实现。输入不允许任意 actorId；身份由客户端认证凭据映射得到。courseId、materialId 等只表示查询对象，仍需授权检查。

| 工具名 | 主要参数 | 返回内容与权限 |
| --- | --- | --- |
| lb_get_me | 无 | 当前身份、角色、可用功能 |
| lb_list_courses | cursor、limit | 当前用户获准课程及简要状态 |
| lb_list_materials | courseId、cursor、limit | 可访问材料、版本和解析状态 |
| lb_search_course_content | courseId、query、limit | 正文片段、卡片与证据引用；权限过滤先于检索 |
| lb_read_evidence | evidenceIds | 经授权的文本、表格或图像；报告敏感范围仍受角色限制 |
| lb_list_assignments | courseId、status、cursor | 可见作业、截止日期、本人进度或教师汇总 |
| lb_get_submission | submissionId | 按学生或教师字段投影后的结果 |
| lb_get_learning_overview | courseIds | 学生本人的任务和已确认反馈摘要 |
| lb_get_teaching_overview | courseIds | 教师任教课程统计、样本数与复核口径 |
| lb_get_job | jobId | 本人发起或角色允许查看的任务进度 |

建议列表默认 20、最大 100 条，正文检索返回少量片段再按证据读取，具体容量由测试调整。响应同时给出结构化数据和简短可读说明；输出 schema 约束形状，工具错误使用 isError 并附项目错误码。对应协议依据见本节末官方来源。

项目通用返回内容建议包含 schemaVersion、data、evidenceRefs、warnings、asOf、nextCursor。错误码包括 UNAUTHENTICATED、FORBIDDEN、NOT_FOUND、REVISION_CONFLICT、PARSE_FAILED、MODEL_UNAVAILABLE、NOT_REVIEWED。工具实现按协议正确区分业务错误与协议错误，不能用成功结果里的空数组掩盖拒绝访问。

MCP 的 inputSchema、outputSchema、structuredContent 和 isError 采用官方工具契约：[MCP Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。这些字段不意味着 LearnBuddy 已实现这些工具。

## 8 连接与认证

远端部署建议优先采用 Streamable HTTP；是否使用长连接、任务扩展或其它协议版本，以 LearnBuddy/WorkBuddy 客户端实际支持情况决定。首次先验证初始化、列工具和调用一个查询，再扩展工具集。协议参考：[MCP Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。

HTTP MCP 接入按照客户端支持情况实现官方授权流程，校验凭据的主体、有效期、权限范围和目标服务。不能把学生传入的 userId 或 DSH 开发者凭据当成外部用户认证；不要将客户端令牌原样转发给其它下游服务。参考：[MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)。具体客户端支持需要嘉俊实测后写入连接指南。

若某客户端暂不能完成预期认证，先用隔离测试账号验证连接，记录能力缺口；不得以开放匿名公网读数据替代认证。演示模式也要拒绝跨课程、跨用户文件与报告访问。

## 9 迁移与兼容步骤

1. 记录待接手代码版本、旧表结构、数据量、现有文件引用及服务器未提交改动，制作可恢复备份。
2. 在副本上增加版本、任务和会话结构；旧材料按已有 blobId 建首个版本，不能重新生成原件内容。
3. 将旧评分和样例标为 legacy 或 fixture；未核验的旧结果不能自动升级为真实模型或教师确认结果。
4. 新服务读取新结构，兼容层对旧 UI 提供原字段；逐条覆盖上传、上下文、提交、复核和统计，不让两套路由分别写不同状态。
5. 比对迁移前后用户、课程、文件数与关键引用；完成权限测试和实际查询后再切换。代码回退不得用旧备份覆盖之后新产生的报告。

## 10 验收与来源

同一账号在网页、DSH 和 MCP 得到相同的可见课程、文件和成绩；越权时三条路径都拒绝；学生确认前拿不到分数，确认后可读本人结果；停用卡片不再命中；补交历史和旧版本证据可追溯；文件 hash 相同不能绕过授权。

数据架构方向来自会议 00:15:35 至 00:16:16、00:19:18 至 00:22:38、00:33:19 至 00:34:11；现有 schema 与数据服务核对基线为主分支 1ac6a10。黄山本次 D2、D3、D4 决策已纳入。官方 MCP 文档仅用于协议约束，领域数据和工具清单属于本项目实施建议。
