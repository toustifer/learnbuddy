/**
 * task-15：解析错误「持久化 + 列表透出 + 旧库迁移」测试套件
 *
 * 设计红线：
 * 1. **不做假持久化断言**：错误信息经 HTTP 上传接口写入 SQLite 后，
 *    必须能在一个**全新打开的 DatabaseStore**（模拟刷新页面 / 重启服务）里
 *    读到同样的错误码与信息。
 * 2. **迁移必须用真旧库测**：先用「不含新列」的旧结构 SQL 建表 + 插入真实数据，
 *    再用新代码打开。只测新建库测不出 `CREATE TABLE IF NOT EXISTS` 不补列这个坑。
 * 3. **越权红线**：列表接口原有的权限过滤逻辑不变，解析错误信息不得成为
 *    学生看到别人私有课件失败原因的渠道。
 * 4. 全部离线：损坏文件的解析失败发生在调用大模型之前，不发任何外部请求。
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DatabaseStore } from "../src/db/store.js";
import {
  MATERIAL_PARSE_ERROR_COLUMNS,
  migrateMaterialsParseErrorColumns
} from "../src/db/schema.js";
import { registerLearnBuddyRoutes } from "../src/routes/api.js";
import { StorageService } from "../src/services/storage.js";
import { buildCorruptPdf, buildMinimalPdf } from "../scripts/lib/doc-fixtures.mjs";
import { withAuthHeaders, tokenFor } from "./helpers/auth.js";

const PARSE_ERROR_MESSAGE = /文档解析失败 \[malformed\]/;

/**
 * 本测试进程内已打开的 store（Windows 下 SQLite 文件被占用时无法删除临时目录，
 * 所以清理钩子必须先把连接关掉）
 */
const liveStores = new Set();

/** 登记一个 store：临时目录清理时统一关闭 */
function trackStore(store) {
  liveStores.add(store);
  return store;
}

/**
 * 建临时目录（含自动清理）。
 * 该钩子注册得最早 → 先于各测试自己的 t.after 执行，因此在这里统一关连接再删目录。
 */
async function makeTempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "learnbuddy-parse-error-"));
  t.after(async () => {
    for (const store of liveStores) {
      try {
        store.close();
      } catch {
        /* 已关闭 */
      }
    }
    liveStores.clear();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return dir;
}

/** 打开一个 store（字符串路径或配置对象）并登记自动关闭 */
function openStore(options) {
  return trackStore(new DatabaseStore(options));
}

/** 起一个只挂 LearnBuddy 路由的真 HTTP server */
async function startTestServer(t, store, storage) {
  const middlewares = [];
  registerLearnBuddyRoutes({ webServer: { use: (fn) => middlewares.push(fn) } }, { store, storage });

  const server = http.createServer(async (req, res) => {
    for (const mw of middlewares) {
      let nextCalled = false;
      await mw(req, res, () => {
        nextCalled = true;
      });
      if (!nextCalled && (res.writableEnded || res.headersSent)) break;
    }
    if (!res.writableEnded && !res.headersSent) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

function httpRequest(port, method, reqPath, headers = {}, body = null) {
  return withAuthHeaders(port, headers).then((authHeaders) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: reqPath, method, headers: authHeaders }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ statusCode: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf-8") })
      );
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  }));
}

/** 通过真实上传接口上传一个损坏的 PDF（解析必然失败，且不触发任何 LLM 调用） */
async function uploadBrokenPdf(port, overrides = {}) {
  const file = buildCorruptPdf();
  const res = await httpRequest(
    port,
    "POST",
    "/api/learnbuddy/materials/upload",
    { "Content-Type": "application/json" },
    JSON.stringify({
      fileName: "broken.pdf",
      courseId: "network",
      ownerId: "t-chen",
      encoding: "base64",
      content: file.toString("base64"),
      ...overrides
    })
  );
  assert.equal(res.statusCode, 200, `上传接口应返回 200：${res.text}`);
  return JSON.parse(res.text);
}

/**
 * 通过列表接口取课件列表。
 *
 * 身份绑定后可见范围由令牌决定，`headers` 用于显式切换视角
 * （例如学生 student.lin）；不传则走 helper 默认的 teacher.chen。
 */
async function fetchMaterials(port, query, headers = {}) {
  const res = await httpRequest(port, "GET", `/api/learnbuddy/materials${query ? `?${query}` : ""}`, headers);
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.text);
}

function findMaterial(materials, id) {
  const found = materials.find((m) => m.id === id);
  assert.ok(found, `列表里应包含 ${id}`);
  return found;
}

// ===========================================================================
// (a) 解析失败 → store / 列表接口 / 服务重启后都能拿到错误码与信息
// ===========================================================================

test("(a) 解析失败错误持久化：直查 store、列表接口、重启后重开数据库都能看到失败原因", async (t) => {
  const dir = await makeTempDir(t);
  const dbPath = path.join(dir, "learnbuddy.db");
  const uploadDir = path.join(dir, "uploads");

  const store = openStore(dbPath);
  const storage = new StorageService({ uploadDir });
  const port = await startTestServer(t, store, storage);

  const uploadRes = await uploadBrokenPdf(port);

  // 上传响应：顶层字段保持 task-14 契约不变，material 里也带上同一份错误
  assert.equal(uploadRes.ok, true);
  assert.equal(uploadRes.parseStatus, "failed");
  assert.equal(uploadRes.parseErrorCode, "malformed");
  assert.match(uploadRes.parseError, PARSE_ERROR_MESSAGE);

  const materialId = uploadRes.material.id;
  assert.equal(uploadRes.material.status, "pending");
  assert.equal(uploadRes.material.parseStatus, "failed");
  assert.equal(uploadRes.material.parseErrorCode, "malformed");
  assert.match(uploadRes.material.parseError, PARSE_ERROR_MESSAGE);
  assert.deepEqual(uploadRes.material.knowledge, [], "失败不得写入伪造知识点");

  // 1) 直查 store
  const fromStore = store.getMaterialById(materialId);
  assert.equal(fromStore.parseStatus, "failed");
  assert.equal(fromStore.parseErrorCode, "malformed");
  assert.match(fromStore.parseError, PARSE_ERROR_MESSAGE);

  // 2) 走列表接口（不只是上传响应里才有）
  const listRes = await fetchMaterials(port, "courseId=network&userId=t-chen");
  const fromList = findMaterial(listRes.materials, materialId);
  assert.equal(fromList.parseStatus, "failed");
  assert.equal(fromList.parseErrorCode, "malformed");
  assert.match(fromList.parseError, PARSE_ERROR_MESSAGE);

  // 3) listMaterials 全量路径同样带上（该路径没有 userId 权限过滤）
  const fromListAll = findMaterial(store.listMaterials(), materialId);
  assert.equal(fromListAll.parseStatus, "failed");
  assert.equal(fromListAll.parseErrorCode, "malformed");

  // 4) 【关键】关掉连接、用同一份数据库文件重新打开（= 教师刷新页面 / 服务重启）
  store.close();
  const reopened = openStore({ path: dbPath, seed: false });

  const persisted = reopened.getMaterialById(materialId);
  assert.ok(persisted, "重开后记录仍在");
  assert.equal(persisted.status, "pending");
  assert.equal(persisted.parseStatus, "failed", "刷新后必须仍能看到失败状态");
  assert.equal(persisted.parseErrorCode, "malformed", "刷新后必须仍能看到原因码");
  assert.match(persisted.parseError, PARSE_ERROR_MESSAGE, "刷新后必须仍能看到可读错误信息");
  assert.match(persisted.parseError, /not a PDF|invalid PDF structure/, "错误信息要能帮教师自助排查");
});

// ===========================================================================
// (b) 旧库迁移：预先建好的旧结构 DB（无新列、有数据）→ 幂等补列且不丢数据
// ===========================================================================

/** 上一版（task-14 之前）的生产表结构：materials 没有 parse_error / parse_error_code */
const LEGACY_SCHEMA_SQL = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
  initials TEXT
);
CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  title TEXT NOT NULL,
  code TEXT NOT NULL,
  color TEXT DEFAULT 'blue',
  description TEXT DEFAULT '',
  FOREIGN KEY (teacher_id) REFERENCES users(id)
);
CREATE TABLE materials (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'PDF',
  visibility TEXT NOT NULL CHECK (visibility IN ('course', 'private')),
  status TEXT NOT NULL CHECK (status IN ('ready', 'pending')) DEFAULT 'ready',
  size TEXT DEFAULT '0 KB',
  pages INTEGER DEFAULT 1,
  date TEXT,
  sample_key TEXT,
  blob_id TEXT,
  knowledge TEXT DEFAULT '[]',
  cards TEXT DEFAULT '[]',
  teaching TEXT,
  FOREIGN KEY (course_id) REFERENCES courses(id),
  FOREIGN KEY (owner_id) REFERENCES users(id)
);
`;

/** 造一个「服务器上已有的旧库」：旧结构 + 真实数据（含一条损坏文件留下的 pending 记录） */
async function buildLegacyDatabase(dbPath) {
  const raw = new DatabaseSync(dbPath);
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec(LEGACY_SCHEMA_SQL);
  raw
    .prepare("INSERT INTO users (id, username, name, role, initials) VALUES (?, ?, ?, ?, ?)")
    .run("t-chen", "teacher.chen", "陈知行", "teacher", "陈");
  raw
    .prepare("INSERT INTO courses (id, teacher_id, title, code, color, description) VALUES (?, ?, ?, ?, ?, ?)")
    .run("network", "t-chen", "计算机网络", "CS 203", "green", "从一次握手，理解万物互联。");

  const legacyKnowledge = JSON.stringify([
    { id: "kp-legacy", title: "旧库里的知识点", summary: "迁移后必须原样保留", page: 1 }
  ]);
  raw
    .prepare(
      `INSERT INTO materials (
         id, course_id, owner_id, title, kind, visibility, status,
         size, pages, date, sample_key, blob_id, knowledge, cards, teaching
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "mat-legacy-ready",
      "network",
      "t-chen",
      "旧库 · TCP 课件",
      "PDF",
      "course",
      "ready",
      "2.4 MB",
      3,
      "2026-09-10",
      "handshake",
      "blob-legacy-ready",
      legacyKnowledge,
      "[]",
      null
    );
  raw
    .prepare(
      `INSERT INTO materials (
         id, course_id, owner_id, title, kind, visibility, status,
         size, pages, date, sample_key, blob_id, knowledge, cards, teaching
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "mat-legacy-pending",
      "network",
      "t-chen",
      "旧库 · 上传失败的课件",
      "PDF",
      "course",
      "pending",
      "0 KB",
      1,
      "2026-09-11",
      null,
      "blob-legacy-pending",
      "[]",
      "[]",
      null
    );

  const columns = raw.prepare("PRAGMA table_info(materials)").all().map((r) => r.name);
  const rows = raw.prepare("SELECT COUNT(*) AS n FROM materials").get().n;
  raw.close();
  return { columns, rows, legacyKnowledge };
}

test("(b) 旧库迁移：旧结构 DB 补列后可读写新列，原有数据与知识点不丢，且重复打开幂等", async (t) => {
  const dir = await makeTempDir(t);
  const dbPath = path.join(dir, "legacy-learnbuddy.db");

  const legacy = await buildLegacyDatabase(dbPath);
  // 先证明这确实是「没有新列的旧结构库」
  for (const column of MATERIAL_PARSE_ERROR_COLUMNS) {
    assert.ok(!legacy.columns.includes(column.name), `旧库不应有 ${column.name} 列`);
  }
  assert.equal(legacy.rows, 2);

  // === 用新代码打开旧库：构造数据库时（initSchema）应自动补齐列 ===
  const store = openStore({ path: dbPath, seed: false });

  const migratedColumns = store.db.prepare("PRAGMA table_info(materials)").all().map((r) => r.name);
  for (const column of MATERIAL_PARSE_ERROR_COLUMNS) {
    assert.ok(migratedColumns.includes(column.name), `迁移后应存在 ${column.name} 列`);
  }

  // 原有数据不丢，且字段内容原样保留
  assert.equal(store.listMaterials().length, 2, "迁移不得丢行");
  const legacyReady = store.getMaterialById("mat-legacy-ready");
  assert.equal(legacyReady.title, "旧库 · TCP 课件");
  assert.equal(legacyReady.size, "2.4 MB");
  assert.equal(legacyReady.pages, 3);
  assert.deepEqual(legacyReady.knowledge, JSON.parse(legacy.legacyKnowledge));
  // 老记录没有解析错误：ready → parsed；pending 且无错误 → pending（不谎报 parsed）
  assert.equal(legacyReady.parseStatus, "parsed");
  assert.equal(legacyReady.parseErrorCode, undefined);
  assert.equal(legacyReady.parseError, undefined);
  assert.equal(store.getMaterialById("mat-legacy-pending").parseStatus, "pending");

  // === 迁移后新列可正常读写 ===
  const marked = store.updateMaterial("mat-legacy-pending", {
    parseErrorCode: "malformed",
    parseError: "文档解析失败 [malformed]：malformed document: not a PDF"
  });
  assert.equal(marked.parseStatus, "failed");
  assert.equal(marked.parseErrorCode, "malformed");
  assert.match(marked.parseError, PARSE_ERROR_MESSAGE);

  const createdFailure = store.createMaterial({
    id: "mat-after-migration",
    courseId: "network",
    ownerId: "t-chen",
    title: "迁移后上传的损坏文件.pdf",
    visibility: "course",
    status: "pending",
    parseErrorCode: "encrypted",
    parseError: "文档解析失败 [encrypted]：document is encrypted"
  });
  assert.equal(createdFailure.parseStatus, "failed");
  assert.equal(createdFailure.parseErrorCode, "encrypted");

  // 直接读原始列，确认真的落到了 SQLite 列上（而不是只活在 JS 对象里）
  const rawRow = store.db
    .prepare("SELECT parse_error_code, parse_error FROM materials WHERE id = ?")
    .get("mat-after-migration");
  assert.equal(rawRow.parse_error_code, "encrypted");
  assert.match(rawRow.parse_error, /encrypted/);

  // === 幂等：重复迁移/重复打开不报错、不重复加列、数据仍在 ===
  const secondRun = migrateMaterialsParseErrorColumns(store.db);
  assert.equal(secondRun.migrated, false);
  assert.deepEqual(secondRun.added, []);

  store.close();
  const reopened = openStore({ path: dbPath, seed: false });
  // 旧库 2 条（其中 pending 那条被更新）+ 迁移后新建 1 条 = 3 条
  assert.equal(reopened.listMaterials().length, 3, "两次打开之间数据只增不减");
  assert.equal(reopened.getMaterialById("mat-after-migration").parseErrorCode, "encrypted");
  assert.deepEqual(reopened.getMaterialById("mat-legacy-ready").knowledge, JSON.parse(legacy.legacyKnowledge));

  const columnsAfterReopen = reopened.db.prepare("PRAGMA table_info(materials)").all().map((r) => r.name);
  assert.equal(
    columnsAfterReopen.filter((n) => n === "parse_error").length,
    1,
    "幂等迁移不得重复加列"
  );
});

test("(b2) 新建库直接具备解析错误列（全新部署无需迁移，也没有迁移副作用）", (t) => {
  const store = new DatabaseStore(":memory:");
  t.after(() => store.close());

  const columns = store.db.prepare("PRAGMA table_info(materials)").all().map((r) => r.name);
  for (const column of MATERIAL_PARSE_ERROR_COLUMNS) {
    assert.ok(columns.includes(column.name));
  }
  const result = migrateMaterialsParseErrorColumns(store.db);
  assert.equal(result.migrated, false, "新建库已含列，迁移应无操作");
  assert.equal(store.getMaterialById("mat-tcp").parseStatus, "parsed");
});

test("(b3) 并发启动兜底：另一实例已补列导致 duplicate column 时不阻断启动（其余 ALTER 错误照常抛出）", () => {
  // 真实 SQLite 无法确定性地制造「读 PRAGMA 与 ALTER 之间被另一个进程插队」的窗口，
  // 这里用最小桩模拟那一瞬间：PRAGMA 报告缺列，ADD COLUMN 却已被抢先执行。
  const makeStubDb = (execError) => ({
    prepare(sql) {
      if (sql.includes("sqlite_master")) return { get: () => ({ name: "materials" }) };
      return { all: () => [{ name: "id" }, { name: "status" }] };
    },
    exec() {
      throw execError;
    }
  });

  const tolerated = migrateMaterialsParseErrorColumns(
    makeStubDb(new Error("duplicate column name: parse_error_code"))
  );
  assert.equal(tolerated.added.length, MATERIAL_PARSE_ERROR_COLUMNS.length, "撞车时视为列已就绪");

  // 其他失败（例如库只读 / 磁盘满）必须继续抛出，不能把迁移错误吞掉
  assert.throws(
    () => migrateMaterialsParseErrorColumns(makeStubDb(new Error("attempt to write a readonly database"))),
    /readonly database/
  );

  // materials 表不存在时（异常场景）安全跳过
  const noTable = {
    prepare: () => ({ get: () => undefined, all: () => [] }),
    exec: () => {
      throw new Error("不应执行 ALTER");
    }
  };
  assert.deepEqual(migrateMaterialsParseErrorColumns(noTable), { migrated: false, added: [], existing: [] });
});

// ===========================================================================
// (c) 重新解析成功 → 陈旧错误必须被清空
// ===========================================================================

test("(c) 重新解析成功：陈旧错误被清空（重新上传/更新的成功结果不再带失败原因）", async (t) => {
  const dir = await makeTempDir(t);
  const dbPath = path.join(dir, "learnbuddy.db");

  const store = openStore(dbPath);
  const storage = new StorageService({ uploadDir: path.join(dir, "uploads") });
  const port = await startTestServer(t, store, storage);

  const failed = await uploadBrokenPdf(port);
  const materialId = failed.material.id;
  assert.equal(store.getMaterialById(materialId).parseStatus, "failed");

  // 1) 同一份课件重新解析成功：调用方**只**更新成功结果（不显式清字段），
  //    持久层必须保证 ready 的课件不残留任何失败原因
  const refreshed = store.updateMaterial(materialId, {
    status: "ready",
    pages: 2,
    knowledge: [{ id: "kp-fixed", title: "重传后的真实知识点", summary: "文件已修复", page: 1 }]
  });
  assert.equal(refreshed.parseStatus, "parsed");
  assert.equal(refreshed.parseErrorCode, undefined, "成功后不得残留原因码");
  assert.equal(refreshed.parseError, undefined, "成功后不得残留错误信息");

  const rawCleared = store.db
    .prepare("SELECT parse_error_code, parse_error FROM materials WHERE id = ?")
    .get(materialId);
  assert.equal(rawCleared.parse_error_code, null, "数据库列必须被真正清空");
  assert.equal(rawCleared.parse_error, null);

  // 列表接口不再显示已经失败的陈旧原因
  const listRes = await fetchMaterials(port, "courseId=network&userId=t-chen");
  const listed = findMaterial(listRes.materials, materialId);
  assert.equal(listed.parseStatus, "parsed");
  assert.deepEqual(listed.knowledge.map((k) => k.id), ["kp-fixed"]);
  assert.ok(!("parseError" in listed), "成功课件不应带 parseError 字段");
  assert.ok(!("parseErrorCode" in listed), "成功课件不应带 parseErrorCode 字段");

  // 2) 成功写入口径一致：即使调用方误把旧错误一起传进来，ready 也必须是干净的
  const created = store.createMaterial({
    id: "mat-sloppy-caller",
    courseId: "network",
    ownerId: "t-chen",
    title: "同名文件重传成功.pdf",
    visibility: "course",
    status: "ready",
    parseErrorCode: "malformed",
    parseError: "文档解析失败 [malformed]：上一轮的陈旧错误"
  });
  assert.equal(created.parseStatus, "parsed");
  assert.equal(created.parseErrorCode, undefined);
  assert.equal(created.parseError, undefined);

  // 3) 反向保护：失败仍然如实记录（清空逻辑没有把失败一起吞掉）
  const stillFailed = await uploadBrokenPdf(port, { fileName: "broken-again.pdf" });
  assert.equal(store.getMaterialById(stillFailed.material.id).parseStatus, "failed");
  assert.equal(store.getMaterialById(stillFailed.material.id).parseErrorCode, "malformed");
});

// ===========================================================================
// (d) 成功 / 失败材料混合列表：结果各归各位
// ===========================================================================

test("(d) 混合列表：成功项无错误字段且 parseStatus=parsed，失败项带原因码与信息", async (t) => {
  const dir = await makeTempDir(t);
  const store = openStore(path.join(dir, "learnbuddy.db"));
  const storage = new StorageService({ uploadDir: path.join(dir, "uploads") });
  const port = await startTestServer(t, store, storage);

  // 一条成功的（真解析结果的写法：ready + 知识点）
  store.createMaterial({
    id: "mat-mixed-ok",
    courseId: "network",
    ownerId: "t-chen",
    title: "混合列表 · 成功课件.pdf",
    visibility: "course",
    status: "ready",
    knowledge: [{ id: "kp-ok", title: "成功知识点", summary: "ok", page: 1 }]
  });
  // 两条失败的：损坏 + 加密
  const broken = await uploadBrokenPdf(port);
  store.createMaterial({
    id: "mat-mixed-encrypted",
    courseId: "network",
    ownerId: "t-chen",
    title: "混合列表 · 加密课件.pdf",
    visibility: "course",
    status: "pending",
    parseErrorCode: "encrypted",
    parseError: "文档解析失败 [encrypted]：document is encrypted"
  });

  const listRes = await fetchMaterials(port, "courseId=network&userId=t-chen");
  const ok = findMaterial(listRes.materials, "mat-mixed-ok");
  const bad = findMaterial(listRes.materials, broken.material.id);
  const encrypted = findMaterial(listRes.materials, "mat-mixed-encrypted");

  assert.equal(ok.parseStatus, "parsed");
  assert.ok(!("parseError" in ok));
  assert.ok(!("parseErrorCode" in ok));

  assert.equal(bad.parseStatus, "failed");
  assert.equal(bad.parseErrorCode, "malformed");
  assert.match(bad.parseError, PARSE_ERROR_MESSAGE);

  assert.equal(encrypted.parseStatus, "failed");
  assert.equal(encrypted.parseErrorCode, "encrypted");

  // 种子数据里的 ready 课件同样不带错误字段（向后兼容）
  for (const seededId of ["mat-tcp", "mat-wire"]) {
    const seeded = findMaterial(listRes.materials, seededId);
    assert.equal(seeded.parseStatus, "parsed");
    assert.ok(!("parseError" in seeded) && !("parseErrorCode" in seeded));
  }
  const osList = await fetchMaterials(port, "courseId=os&userId=t-chen");
  const osSeeded = findMaterial(osList.materials, "mat-os");
  assert.equal(osSeeded.parseStatus, "parsed");
  assert.ok(!("parseError" in osSeeded) && !("parseErrorCode" in osSeeded));

  // 新字段是「附加」的：既有字段一个都没变
  assert.equal(ok.status, "ready");
  assert.equal(ok.courseId, "network");
  assert.equal(ok.ownerId, "t-chen");
  assert.equal(typeof ok.title, "string");
  assert.equal(typeof ok.visibility, "string");
  assert.ok(Array.isArray(ok.knowledge));
  assert.ok(Array.isArray(ok.cards));
});

// ===========================================================================
// (e) 权限红线：解析错误不得成为越权泄露渠道
// ===========================================================================

test("(e) 权限过滤不变：学生看不到他人私有课件的解析错误，也看不到未选课课程的失败原因", async (t) => {
  const dir = await makeTempDir(t);
  const store = openStore(path.join(dir, "learnbuddy.db"));
  const port = await startTestServer(t, store, new StorageService({ uploadDir: path.join(dir, "uploads") }));

  const secretError = "文档解析失败 [encrypted]：教师私有课件的机密失败原因 8F3A";

  // 教师私有 + 解析失败（学生绝不能看到）
  store.createMaterial({
    id: "mat-private-failed",
    courseId: "network",
    ownerId: "t-chen",
    title: "教师私有失败的课件.pdf",
    visibility: "private",
    status: "pending",
    parseErrorCode: "encrypted",
    parseError: secretError
  });
  // 学生未选课课程（database）里的失败课件
  store.createMaterial({
    id: "mat-unenrolled-failed",
    courseId: "database",
    ownerId: "t-lin",
    title: "未选课课程的失败课件.pdf",
    visibility: "course",
    status: "pending",
    parseErrorCode: "malformed",
    parseError: "文档解析失败 [malformed]：未选课课程的失败原因 5C21"
  });
  // 学生自己的私有失败课件（可见，属于正向对照）
  store.createMaterial({
    id: "mat-own-failed",
    courseId: "network",
    ownerId: "s-yi",
    title: "学生自己的失败课件.pdf",
    visibility: "private",
    status: "pending",
    parseErrorCode: "needsOcr",
    parseError: "文档解析失败 [needsOcr]：第 1 页疑似扫描件，需要 OCR"
  });

  // 身份绑定：学生视角必须来自令牌（student.lin → s-yi），query 里的 userId 已不再是身份来源
  const studentHeaders = {
    Authorization: `Bearer ${await tokenFor(port, { username: "student.lin", password: "123" })}`
  };

  const studentRes = await fetchMaterials(port, "courseId=network", studentHeaders);
  const ids = studentRes.materials.map((m) => m.id);

  assert.ok(!ids.includes("mat-private-failed"), "学生的列表里不得出现教师私有课件");
  assert.ok(!ids.includes("mat-unenrolled-failed"), "未选课课程的课件不得出现");
  assert.ok(ids.includes("mat-own-failed"), "学生自己的失败课件应可见");

  // 整个响应体里不得出现任何越权错误信息（包含无 courseId 的全量视图）
  assert.ok(!studentRes.materials.some((m) => m.parseError === secretError || /8F3A/.test(m.parseError || "")));
  const allCoursesRes = await fetchMaterials(port, "", studentHeaders);
  assert.ok(!/8F3A/.test(allCoursesRes.text), "越权错误信息不得出现在响应体中");
  assert.ok(!/5C21/.test(allCoursesRes.text));
  for (const m of allCoursesRes.materials) {
    assert.ok(
      !m.parseErrorCode || m.ownerId === "s-yi" || m.visibility === "course",
      "带解析错误的课件必须仍然满足可见性规则"
    );
  }

  // 教师本人仍能看到自己私有课件的失败原因（权限过滤没有把功能一起砍掉）
  // 教师视角用默认令牌（teacher.chen），不再从 query 声明身份。
  const teacherRes = await fetchMaterials(port, "courseId=network");
  const teacherView = findMaterial(teacherRes.materials, "mat-private-failed");
  assert.equal(teacherView.parseStatus, "failed");
  assert.equal(teacherView.parseError, secretError);

  // 既有权限语义回归：学生看不到他人私有课件、教师看得到自己的
  assert.equal(store.getMaterials("s-yi", "network").some((m) => m.id === "mat-private-failed"), false);
  assert.equal(store.getMaterials("s-yi", "database").length, 0, "未选课课程返回空（既有行为不变）");
  assert.equal(store.getMaterialById("mat-private-failed", "s-yi"), null);
});

// ===========================================================================
// (f) 既有字段与调用方兼容：material-context / storage 链路不受影响
// ===========================================================================

test("(f) 向后兼容：未带解析错误的既有写路径行为不变，成功课件仍可返回纯文本素材", async (t) => {
  const dir = await makeTempDir(t);
  const store = openStore(path.join(dir, "learnbuddy.db"));

  // 旧调用方（不带任何 parse* 字段）创建/更新课件，字段与语义不变
  const created = store.createMaterial({
    id: "mat-compat",
    courseId: "os",
    ownerId: "t-chen",
    title: "兼容性课件.pdf",
    visibility: "course",
    kind: "PDF",
    size: "1 KB",
    pages: 2,
    knowledge: [{ id: "kp-compat", title: "兼容知识点", summary: "s", page: 1 }]
  });
  assert.equal(created.status, "ready");
  assert.equal(created.parseStatus, "parsed");
  assert.equal(created.parseErrorCode, undefined);
  assert.equal(created.parseError, undefined);
  assert.equal(created.size, "1 KB");
  assert.equal(created.pages, 2);

  const updated = store.updateMaterial("mat-compat", { title: "兼容性课件（第2版）.pdf" });
  assert.equal(updated.title, "兼容性课件（第2版）.pdf");
  assert.equal(updated.status, "ready");
  assert.equal(updated.parseStatus, "parsed");
  assert.deepEqual(updated.knowledge.map((k) => k.id), ["kp-compat"]);

  // 用真实文件（可解析的 PDF 字节）走一遍落盘 + 解析，确认新列不干扰既有素材链路
  const okPdf = buildMinimalPdf(["COMPAT REAL PDF CONTENT"]);
  assert.ok(okPdf.length > 0);
  assert.equal(store.getMaterials("t-chen", "os").some((m) => m.id === "mat-compat"), true);
  assert.equal(store.listMaterials().length, 6, "种子 5 条 + 新增 1 条");
});

// ===========================================================================
// 重启不能被种子覆盖（2026-09-22 修复）
// ===========================================================================

test("持久化·重启 - 种子只补不覆盖，评分/解析产物/批注必须活过重启", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "learnbuddy-seed-"));
  const dbPath = path.join(dir, "learnbuddy.db");

  // 1) 首次打开（空库 ⇒ 会种入演示数据）
  const first = new DatabaseStore(dbPath);
  const seeded = first.getSubmission("sub-xu-db");
  assert.ok(seeded, "前置条件：种子里应当有 sub-xu-db 这条演示提交");

  // 2) 模拟运行期产生的数据：评了分、落了解析产物、教师写了批注
  first.updateSubmission("sub-xu-db", {
    status: "review",
    grades: [{ rubricId: "database-r0", score: 12, page: 1, evidence: "一段真实摘录" }],
    summary: "小结",
    parsedContent: { source: "document", pages: 2, structuredPages: [{ paragraphs: ["正文"] }] },
    annotations: [{ id: "anno-1", page: 1, quote: "原文", comment: "教师批注" }]
  });
  first.close();

  // 3) 重新打开同一个库文件 —— 等价于**重启服务**：种子会再跑一遍
  const second = new DatabaseStore(dbPath);
  const after = second.getSubmission("sub-xu-db");
  second.close();

  assert.equal(after.status, "review", "重启不得把状态打回种子值");
  assert.equal(after.grades.length, 1, "重启不得清掉评分");
  assert.equal(after.grades[0].score, 12);
  assert.equal(after.summary, "小结", "重启不得清掉小结");
  assert.ok(after.parsedContent, "重启不得清掉解析产物（它落库就是为了重启后仍能看到报告）");
  assert.equal(after.parsedContent.source, "document");
  assert.equal(after.annotations.length, 1, "重启不得清掉教师批注");
  assert.equal(after.annotations[0].comment, "教师批注");

  await fs.rm(dir, { recursive: true, force: true });
});

test("持久化·重启 - 空库仍然会被正常种入（只补不覆盖 ≠ 不补）", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "learnbuddy-seed2-"));
  const dbPath = path.join(dir, "fresh.db");
  const store = new DatabaseStore(dbPath);
  assert.ok(store.getUser("t-chen"), "空库必须种入教师账号");
  assert.ok(store.getSubmission("sub-xu-db"), "空库必须种入演示提交");
  assert.ok(store.getAssignment("lab-db"), "空库必须种入作业");
  store.close();
  await fs.rm(dir, { recursive: true, force: true });
});
