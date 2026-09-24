# 线上重复资料记录清理报告

- **执行角色**：worker-database
- **执行时间**：2026-09-25 03:40 ~ 03:43 (UTC)
- **目标服务器**：`jiajun@129.204.52.57`
- **数据库路径**：`/home/jiajun/learnbuddy/plugins/dsh-plugin-learnbuddy/data/learnbuddy.db`
- **执行原则**：用户确认口径「删除多余记录，保留每组最早的一条」，显式 rowid 删除，禁止波及种子资料与关联表。

---

## 一、现状核对与口径修正

在执行前对线上数据库进行了完整探查：
1. **总记录数**：27 条。
2. **重复记录分析**：
   - **分组 1**：`blob_id = 16cc455c5b67c2cef6dd1486e1b77f6d5d278fea7dd1233e6ffecc26449a00e0.png`（标题：`实验台截图-字段参考.png`）
     - 出现 5 次，rowids：`141, 142, 143, 144, 145`
     - 规则：保留最早的 `rowid: 141`，待删 `142, 143, 144, 145`（4 条）
   - **分组 2**：`blob_id = 569ac2644c2e9afe586be2e9b0e92eee8e940007533c5d287578b7193169bb40.png`（标题：`实验台截图-字段与图形.png`）
     - 出现 8 次，rowids：`146, 147, 148, 149, 150, 151, 152, 153`
     - 规则：保留最早的 `rowid: 146`，待删 `147, 148, 149, 150, 151, 152, 153`（7 条）
3. **数量修正说明**：
   - 任务指示中的“13条”为两组重复记录总数（5 + 8 = 13），扣除各组保留的 1 条最早记录后，**实际待删记录数为 4 + 7 = 11 条**。
   - 删除后预期总条数：27 - 11 = **16 条**。
   - 种子资料（`blob_id IS NULL`）共 5 条（`mat-tcp`, `mat-wire`, `mat-net-teach`, `mat-os`, `mat-db`，当前 rowid 为 168~172），均受严格保护。
4. **引用完整性检查**：
   - 深度扫描 `assignments`、`submissions`、`sessions`、`review_drafts` 等业务表，确认这 11 条待删除记录在其他表中**无任何引用或外键依赖**。

---

## 二、第 1 步：强制备份（原始输出）

### 执行命令
```bash
ssh jiajun@129.204.52.57
cd /home/jiajun/learnbuddy/plugins/dsh-plugin-learnbuddy/data
BAK="learnbuddy.db.bak-cleanup-$(date +%Y%m%d-%H%M%S)"
cp learnbuddy.db "$BAK"
ls -la "$BAK"
sha256sum learnbuddy.db "$BAK"
```

### 原始输出
```
-rw-r--r-- 1 jiajun jiajun 249856 Sep 25 03:40 learnbuddy.db.bak-cleanup-20260925-034016
e4290cdf6591c170011fc73bb080584ed79a3ea52d47e960ba87a974beb465d5  learnbuddy.db
e4290cdf6591c170011fc73bb080584ed79a3ea52d47e960ba87a974beb465d5  learnbuddy.db.bak-cleanup-20260925-034016
```
- **备份文件路径**：`/home/jiajun/learnbuddy/plugins/dsh-plugin-learnbuddy/data/learnbuddy.db.bak-cleanup-20260925-034016`
- **文件校验和 (SHA-256)**：`e4290cdf6591c170011fc73bb080584ed79a3ea52d47e960ba87a974beb465d5`

---

## 三、第 2 步：干跑清单（DRY RUN）

### 执行输出
```
=== DRY RUN: DUPLICATE MATERIALS AUDIT ===

Found 2 duplicate groups:

--------------------------------------------------------------------------------
Group Blob ID: 16cc455c5b67c2cef6dd1486e1b77f6d5d278fea7dd1233e6ffecc26449a00e0.png (Count: 5)
  [KEEP (Earliest)]  rowid: 141   id: mat-1790146007266-hyoo    course: network    owner: t-chen   title: 实验台截图-字段参考.png
  [DELETE]           rowid: 142   id: mat-1790146231075-prnx    course: network    owner: t-chen   title: 实验台截图-字段参考.png
  [DELETE]           rowid: 143   id: mat-1790146541699-me3o    course: network    owner: t-chen   title: 实验台截图-字段参考.png
  [DELETE]           rowid: 144   id: mat-1790146784335-9skp    course: network    owner: t-chen   title: 实验台截图-字段参考.png
  [DELETE]           rowid: 145   id: mat-1790147170175-pivw    course: network    owner: t-chen   title: 实验台截图-字段参考.png
--------------------------------------------------------------------------------
Group Blob ID: 569ac2644c2e9afe586be2e9b0e92eee8e940007533c5d287578b7193169bb40.png (Count: 8)
  [KEEP (Earliest)]  rowid: 146   id: mat-1790148307456-x8iz    course: network    owner: t-chen   title: 实验台截图-字段与图形.png
  [DELETE]           rowid: 147   id: mat-1790149057809-qly7    course: network    owner: t-chen   title: 实验台截图-字段与图形.png
  [DELETE]           rowid: 148   id: mat-1790149592881-jxae    course: network    owner: t-chen   title: 实验台截图-字段与图形.png
  [DELETE]           rowid: 149   id: mat-1790150050741-g6j7    course: network    owner: t-chen   title: 实验台截图-字段与图形.png
  [DELETE]           rowid: 150   id: mat-1790150498356-eadg    course: network    owner: t-chen   title: 实验台截图-字段与图形.png
  [DELETE]           rowid: 151   id: mat-1790151383643-wtv7    course: network    owner: t-chen   title: 实验台截图-字段与图形.png
  [DELETE]           rowid: 152   id: mat-1790152028594-vl0r    course: network    owner: t-chen   title: 实验台截图-字段与图形.png
  [DELETE]           rowid: 153   id: mat-1790152564196-c1r1    course: network    owner: t-chen   title: 实验台截图-字段与图形.png

--------------------------------------------------------------------------------
=== DRY RUN SUMMARY ===
当前 materials 总记录数: 27
待删除 rowids (11 条): 142, 143, 144, 145, 147, 148, 149, 150, 151, 152, 153
保留 rowids (2 条): 141, 146
预计删除条数: 11
预计删除后总记录数: 16
种子资料 (blob_id IS NULL) 保持数量: 5
```

---

## 四、第 3 步：执行删除

使用显式 rowid 列表并在显式事务（BEGIN TRANSACTION / COMMIT）中执行：

### 执行代码与 SQL
```javascript
const toDelete = [142, 143, 144, 145, 147, 148, 149, 150, 151, 152, 153];
db.exec('BEGIN TRANSACTION;');
const stmt = db.prepare(`DELETE FROM materials WHERE rowid IN (${toDelete.join(',')})`);
const result = stmt.run();
db.exec('COMMIT;');
```

### 实际执行输出
```
=== PRE-DELETE CONFIRMATION ===
┌─────────┬───────┬──────────────────────────┬─────────────────────────────┬────────────────────────────────────────────────────────────────────────┐
│ (index) │ rowid │ id                       │ title                       │ blob_id                                                                │
├─────────┼───────┼──────────────────────────┼─────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ 0       │ 142   │ 'mat-1790146231075-prnx' │ '实验台截图-字段参考.png'   │ '16cc455c5b67c2cef6dd1486e1b77f6d5d278fea7dd1233e6ffecc26449a00e0.png' │
│ 1       │ 143   │ 'mat-1790146541699-me3o' │ '实验台截图-字段参考.png'   │ '16cc455c5b67c2cef6dd1486e1b77f6d5d278fea7dd1233e6ffecc26449a00e0.png' │
│ 2       │ 144   │ 'mat-1790146784335-9skp' │ '实验台截图-字段参考.png'   │ '16cc455c5b67c2cef6dd1486e1b77f6d5d278fea7dd1233e6ffecc26449a00e0.png' │
│ 3       │ 145   │ 'mat-1790147170175-pivw' │ '实验台截图-字段参考.png'   │ '16cc455c5b67c2cef6dd1486e1b77f6d5d278fea7dd1233e6ffecc26449a00e0.png' │
│ 4       │ 147   │ 'mat-1790149057809-qly7' │ '实验台截图-字段与图形.png' │ '569ac2644c2e9afe586be2e9b0e92eee8e940007533c5d287578b7193169bb40.png' │
│ 5       │ 148   │ 'mat-1790149592881-jxae' │ '实验台截图-字段与图形.png' │ '569ac2644c2e9afe586be2e9b0e92eee8e940007533c5d287578b7193169bb40.png' │
│ 6       │ 149   │ 'mat-1790150050741-g6j7' │ '实验台截图-字段与图形.png' │ '569ac2644c2e9afe586be2e9b0e92eee8e940007533c5d287578b7193169bb40.png' │
│ 7       │ 150   │ 'mat-1790150498356-eadg' │ '实验台截图-字段与图形.png' │ '569ac2644c2e9afe586be2e9b0e92eee8e940007533c5d287578b7193169bb40.png' │
│ 8       │ 151   │ 'mat-1790151383643-wtv7' │ '实验台截图-字段与图形.png' │ '569ac2644c2e9afe586be2e9b0e92eee8e940007533c5d287578b7193169bb40.png' │
│ 9       │ 152   │ 'mat-1790152028594-vl0r' │ '实验台截图-字段与图形.png' │ '569ac2644c2e9afe586be2e9b0e92eee8e940007533c5d287578b7193169bb40.png' │
│ 10      │ 153   │ 'mat-1790152564196-c1r1' │ '实验台截图-字段与图形.png' │ '569ac2644c2e9afe586be2e9b0e92eee8e940007533c5d287578b7193169bb40.png' │
└─────────┴───────┴──────────────────────────┴─────────────────────────────┴────────────────────────────────────────────────────────────────────────┘

=== EXECUTING DELETE IN TRANSACTION ===
Changes count: 11
Transaction COMMITTED successfully.
```

---

## 五、第 4 步：验证

### 1. SQL 级别验证

#### 查询 1：按 blob_id 分组查重
```sql
SELECT blob_id, COUNT(*) c FROM materials WHERE blob_id IS NOT NULL GROUP BY blob_id HAVING c > 1;
```
**输出**：
```
=== VERIFICATION 1: DUPLICATES CHECK ===
Duplicate groups count: 0
[]
```
（结果为 0 行，不再存在任何重复资料）

#### 查询 2：当前总数
```sql
SELECT COUNT(*) FROM materials;
```
**输出**：
```
=== VERIFICATION 2: TOTAL COUNT ===
Total count: 16
```
（总数从 27 精确变为 16，成功清理 11 条）

#### 查询 3：种子资料完整性（blob_id IS NULL）
```sql
SELECT rowid, id, title FROM materials WHERE blob_id IS NULL;
```
**输出**：
```
=== VERIFICATION 3: SEED MATERIALS (blob_id IS NULL) ===
Seed materials count: 5
┌─────────┬───────┬─────────────────┬───────────────────────────┐
│ (index) │ rowid │ id              │ title                     │
├─────────┼───────┼─────────────────┼───────────────────────────┤
│ 0       │ 168   │ 'mat-tcp'       │ '第三章 · TCP 可靠传输'   │
│ 1       │ 169   │ 'mat-wire'      │ 'Wireshark 抓包实验指导'  │
│ 2       │ 170   │ 'mat-net-teach' │ '传输层课堂讲解提纲'      │
│ 3       │ 171   │ 'mat-os'        │ '第五章 · 进程同步与互斥' │
│ 4       │ 172   │ 'mat-db'        │ '第六章 · 索引与查询优化' │
└─────────┴───────┴─────────────────┴───────────────────────────┘
```
（5 条种子资料全部原样保留）

#### 查询 4：保留目标记录验证
```sql
SELECT rowid, id, title, blob_id, course_id, owner_id FROM materials WHERE rowid IN (141, 146);
```
**输出**：
```
=== VERIFICATION 4: KEPT TARGET MATERIALS (141, 146) ===
┌─────────┬───────┬──────────────────────────┬─────────────────────────────┬────────────────────────────────────────────────────────────────────────┬───────────┬──────────┐
│ (index) │ rowid │ id                       │ title                       │ blob_id                                                                │ course_id │ owner_id │
├─────────┼───────┼──────────────────────────┼─────────────────────────────┼────────────────────────────────────────────────────────────────────────┼───────────┼──────────┤
│ 0       │ 141   │ 'mat-1790146007266-hyoo' │ '实验台截图-字段参考.png'   │ '16cc455c5b67c2cef6dd1486e1b77f6d5d278fea7dd1233e6ffecc26449a00e0.png' │ 'network' │ 't-chen' │
│ 1       │ 146   │ 'mat-1790148307456-x8iz' │ '实验台截图-字段与图形.png' │ '569ac2644c2e9afe586be2e9b0e92eee8e940007533c5d287578b7193169bb40.png' │ 'network' │ 't-chen' │
└─────────┴───────┴──────────────────────────┴─────────────────────────────┴────────────────────────────────────────────────────────────────────────┴───────────┴──────────┘
```

#### 全库剩余 16 条完整清单
```
┌─────────┬───────┬──────────────────────────┬─────────────────────────────────────────────────┬────────────────────────────────────────────────────────────────────────┬────────────┬──────────┐
│ (index) │ rowid │ id                       │ title                                           │ blob_id                                                                │ course_id  │ owner_id │
├─────────┼───────┼──────────────────────────┼─────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┼────────────┼──────────┤
│ 0       │ 6     │ 'mat-1789062084015-n8zk' │ '真实网络实验报告原件.pdf'                      │ 'de438aa2577dc1a8a315554fe84c22ffe1f2d22993911a4f074a9dada28a5971.pdf' │ 'network'  │ 't-chen' │
│ 1       │ 57    │ 'mat-1789147718790-pqmi' │ 'UDP校验和实验指导书.pdf'                       │ '1b21cc42bc6c32bb7028b308bb07f5a0cdb0796c68ef380e390bd7cd8b7cdc68.pdf' │ 'network'  │ 't-chen' │
│ 2       │ 58    │ 'mat-1789147732770-t1lw' │ '损坏的文件.pdf'                                │ 'd51a01522907b34c4fe0e56350c948095c90b0f06ba8a14d2c3e939a931daf52.pdf' │ 'network'  │ 't-chen' │
│ 3       │ 59    │ 'mat-1789147743962-dyc6' │ '第二个损坏文件.pdf'                            │ '908c913b7911973ce6f561ea57fa04f6cd7c422310ff387e30f86c1491596748.pdf' │ 'network'  │ 't-chen' │
│ 4       │ 65    │ 'mat-1789150155329-b4c6' │ '验证用损坏文件.pdf'                            │ '861c43516675e71bd924653800dd71125454af81773d7d4b0865e74d184cc947.pdf' │ 'network'  │ 't-chen' │
│ 5       │ 141   │ 'mat-1790146007266-hyoo' │ '实验台截图-字段参考.png'                       │ '16cc455c5b67c2cef6dd1486e1b77f6d5d278fea7dd1233e6ffecc26449a00e0.png' │ 'network'  │ 't-chen' │
│ 6       │ 146   │ 'mat-1790148307456-x8iz' │ '实验台截图-字段与图形.png'                     │ '569ac2644c2e9afe586be2e9b0e92eee8e940007533c5d287578b7193169bb40.png' │ 'network'  │ 't-chen' │
│ 7       │ 154   │ 'mat-1790179382866-pyck' │ 'v2-3a4acba7c1f30945233c629574d32f5f_1440w.jpg' │ 'd292bb1bb33773ff00c351b1d7ac238086eada7220e667f1c6c7804889076b56.jpg' │ 'os'       │ 't-chen' │
│ 8       │ 155   │ 'mat-1790179447098-blng' │ 'v2-d6df5dc841129b62b55f881b4477d4d5_1440w.jpg' │ '8df741b3cbe893526342c4135b2aa49e54345788d51f9332d92506afa561f879.jpg' │ 'os'       │ 't-chen' │
│ 9       │ 161   │ 'mat-1790181117805-if66' │ 'v2-d6df5dc841129b62b55f881b4477d4d5_1440w.png' │ '6b7fa434f92a8b80aab02d9bf1a12e49ffcae424e4013a1c4f68b67e3d2bbcd0.png' │ 'os'       │ 's-yi'   │
│ 10      │ 162   │ 'mat-1790187607101-1xj5' │ 'probe-progress.png'                            │ '386816e2465df548a61fa448bf050511421effe2b3cc4769775511fcd9a34030.png' │ 'os'       │ 's-yi'   │
│ 11      │ 168   │ 'mat-tcp'                │ '第三章 · TCP 可靠传输'                         │ null                                                                   │ 'network'  │ 't-chen' │
│ 12      │ 169   │ 'mat-wire'               │ 'Wireshark 抓包实验指导'                        │ null                                                                   │ 'network'  │ 't-chen' │
│ 13      │ 170   │ 'mat-net-teach'          │ '传输层课堂讲解提纲'                            │ null                                                                   │ 'network'  │ 't-chen' │
│ 14      │ 171   │ 'mat-os'                 │ '第五章 · 进程同步与互斥'                       │ null                                                                   │ 'os'       │ 't-chen' │
│ 15      │ 172   │ 'mat-db'                 │ '第六章 · 索引与查询优化'                       │ null                                                                   │ 'database' │ 't-lin'  │
└─────────┴───────┴──────────────────────────┴─────────────────────────────────────────────────┴────────────────────────────────────────────────────────────────────────┴────────────┴──────────┘
```

---

### 2. 网关接口层验证（`/api/learnbuddy/materials?userId=t-chen`）

使用教师账号（`teacher.chen`）登录获取 Bearer 访问令牌，调用网关接口：
```bash
POST /api/learnbuddy/auth/login -> 获取 token
GET /api/learnbuddy/materials?userId=t-chen (Authorization: Bearer <token>)
```

**接口返回原始输出**：
```
=== STEP 4.2: FULL API VERIFICATION ===
HTTP Status: 200
ok: true
Total materials returned by API for t-chen: 13

┌─────────┬───────┬──────────────────────────┬─────────────────────────────────────────────────┬───────────┬───────────────────────┐
│ (index) │ index │ id                       │ title                                           │ courseId  │ blobId                │
├─────────┼───────┼──────────────────────────┼─────────────────────────────────────────────────┼───────────┼───────────────────────┤
│ 0       │ 1     │ 'mat-1790146007266-hyoo' │ '实验台截图-字段参考.png'                       │ 'network' │ '16cc455c5b67c2ce...' │
│ 1       │ 2     │ 'mat-1790148307456-x8iz' │ '实验台截图-字段与图形.png'                     │ 'network' │ '569ac2644c2e9afe...' │
│ 2       │ 3     │ 'mat-1790179382866-pyck' │ 'v2-3a4acba7c1f30945233c629574d32f5f_1440w.jpg' │ 'os'      │ 'd292bb1bb33773ff...' │
│ 3       │ 4     │ 'mat-1790179447098-blng' │ 'v2-d6df5dc841129b62b55f881b4477d4d5_1440w.jpg' │ 'os'      │ '8df741b3cbe89352...' │
│ 4       │ 5     │ 'mat-1789147718790-pqmi' │ 'UDP校验和实验指导书.pdf'                       │ 'network' │ '1b21cc42bc6c32bb...' │
│ 5       │ 6     │ 'mat-1789147732770-t1lw' │ '损坏的文件.pdf'                                │ 'network' │ 'd51a01522907b34c...' │
│ 6       │ 7     │ 'mat-1789147743962-dyc6' │ '第二个损坏文件.pdf'                            │ 'network' │ '908c913b7911973c...' │
│ 7       │ 8     │ 'mat-1789150155329-b4c6' │ '验证用损坏文件.pdf'                            │ 'network' │ '861c43516675e71b...' │
│ 8       │ 9     │ 'mat-1789062084015-n8zk' │ '真实网络实验报告原件.pdf'                      │ 'network' │ 'de438aa2577dc1a8...' │
│ 9       │ 10    │ 'mat-tcp'                │ '第三章 · TCP 可靠传输'                         │ 'network' │ '(null)'              │
│ 10      │ 11    │ 'mat-wire'               │ 'Wireshark 抓包实验指导'                        │ 'network' │ '(null)'              │
│ 11      │ 12    │ 'mat-net-teach'          │ '传输层课堂讲解提纲'                            │ 'network' │ '(null)'              │
│ 12      │ 13    │ 'mat-os'                 │ '第五章 · 进程同步与互斥'                       │ 'os'      │ '(null)'              │
└─────────┴───────┴──────────────────────────┴─────────────────────────────────────────────────┴───────────┴───────────────────────┘

Duplicate check result:
PASS: ZERO duplicate blobIds returned by API!
```

---

## 六、第 5 步：回滚说明

若线上业务发生异常或需恢复清理前的快照，请执行以下命令：

```bash
# 1. 登录线上服务器
ssh jiajun@129.204.52.57

# 2. 恢复数据库文件
cd /home/jiajun/learnbuddy/plugins/dsh-plugin-learnbuddy/data
cp learnbuddy.db.bak-cleanup-20260925-034016 learnbuddy.db

# 3. 校验恢复后哈希
sha256sum learnbuddy.db
# 期望输出：e4290cdf6591c170011fc73bb080584ed79a3ea52d47e960ba87a974beb465d5  learnbuddy.db

# 4. 重启网关服务
export PATH="/home/jiajun/.local/bin:$PATH"
pm2 restart learnbuddy-gateway
```
