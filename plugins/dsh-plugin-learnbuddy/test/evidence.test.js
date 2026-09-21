/**
 * 契约层「溯源契约」测试（EvidenceRefV1）
 *
 * 规范要求：
 *   - 凡"结论"必挂证据引用（知识点、答案卡、检查结果、建议分、评语一律如此）
 *   - 证据指向**文档版本 + 原文定位**
 *   - 解析失败时**不得**用"另一份材料的证据"或"看起来正常的内容"顶替
 *
 * 这里重点守住两条最容易被"做假"的地方：
 *   1. **不猜位置**：拿不到页码就留 null，绝不填一个估计值
 *   2. **不编版本**：没有原件版本时，宁可不产出引用，也不伪造一个让它看起来成立
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import {
  EVIDENCE_KINDS,
  deriveDocumentVersionId,
  buildLocator,
  createEvidenceRef,
  isTraceable,
  collectEvidenceRefs,
  evidenceRefsFromMaterialContext,
  evidenceRefFromGrade,
  withSubmissionEvidenceRefs,
  collectFromSubmissions
} from "../src/contracts/evidence.js";
import { DatabaseStore } from "../src/db/store.js";
import { StorageService } from "../src/services/storage.js";
import { registerLearnBuddyRoutes } from "../src/routes/api.js";
import { withAuthHeaders, tokenFor } from "./helpers/auth.js";

const BASE = "/api/learnbuddy";
const BLOB = "a".repeat(64);

function makeHttpRequest(port, method, httpPath, headers = {}, body = null) {
  return withAuthHeaders(port, headers).then((authHeaders) => new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: httpPath, method, headers: authHeaders },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(raw.toString("utf-8"));
          } catch {
            json = null;
          }
          resolve({ statusCode: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  }));
}

async function startTestServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "learnbuddy-evidence-"));
  const storage = new StorageService({ uploadDir: tmpDir });
  const store = new DatabaseStore(":memory:");
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
  const port = server.address().port;
  return {
    port,
    store,
    as: async (actor) => ({
      Authorization: `Bearer ${await tokenFor(port, {
        username: { "t-chen": "teacher.chen" }[actor] || actor,
        password: "123"
      })}`
    }),
    get: (p, headers) => makeHttpRequest(port, "GET", p, headers, null),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

// ===========================================================================
// 1. 文档版本：内容寻址，缺了就留空
// ===========================================================================

test("溯源·版本 - 用原件内容哈希做版本，天然不可变", () => {
  assert.equal(deriveDocumentVersionId({ blobId: BLOB }), BLOB);
  // 内容变了哈希就变 ⇒ 旧证据永远指向旧内容，不会因覆盖上传而指错
  assert.notEqual(deriveDocumentVersionId({ blobId: "b".repeat(64) }), BLOB);
});

test("溯源·版本 - 没有原件时返回 null，绝不编造版本号", () => {
  assert.equal(deriveDocumentVersionId({}), null, "无 blobId 时必须是 null");
  assert.equal(deriveDocumentVersionId({ blobId: "" }), null);
  assert.equal(deriveDocumentVersionId({ blobId: "   " }), null);
  assert.equal(deriveDocumentVersionId(null), null);
  assert.equal(deriveDocumentVersionId(undefined), null);
});

// ===========================================================================
// 2. 定位：拿不到就留空（核心规则）
// ===========================================================================

test("溯源·定位 - 拿不到页码时留 null，绝不填估计值", () => {
  const locator = buildLocator({});
  assert.equal(locator.page, null, "不认识页码就必须是 null —— 编一个比留空更糟");
  assert.equal(locator.slide, null);
  assert.notEqual(locator.page, 1, "尤其不能默认成第 1 页");
  assert.equal(locator.headingPath, null);
  assert.equal(locator.figure, null);
});

test("溯源·定位 - 非法/无意义的页码同样留空", () => {
  for (const bad of [0, -3, "abc", null, undefined, NaN, Infinity]) {
    assert.equal(buildLocator({ page: bad }).page, null, `page=${String(bad)} 应留空`);
  }
  assert.equal(buildLocator({ page: "2" }).page, 2, "可解析的数字串应当接受");
});

test("溯源·定位 - 按文档类型给出不同定位方式", () => {
  assert.equal(buildLocator({ page: 3 }).page, 3);
  assert.equal(buildLocator({ slide: 5 }).slide, 5);
  assert.deepEqual(buildLocator({ headingPath: ["第三章", "3.2 索引"] }).headingPath, [
    "第三章",
    "3.2 索引"
  ]);
  assert.equal(buildLocator({ sheet: "Sheet1", range: "A1:C12" }).range, "A1:C12");
  assert.equal(buildLocator({ figure: "图 1" }).figure, "图 1");
});

test("溯源·定位 - bbox 三要素不全时视为不可用", () => {
  // 规范要求 bbox 必须说明参照页、单位与渲染尺寸
  assert.equal(buildLocator({ bbox: { page: 2, x: 1, y: 2 } }).bbox, null, "缺单位与渲染尺寸 → 不可用");
  const ok = buildLocator({ bbox: { page: 2, unit: "px", renderSize: "1240x1754", x: 1, y: 2, width: 10, height: 20 } });
  assert.ok(ok.bbox && ok.bbox.unit === "px", "三要素齐全时才接受");
});

// ===========================================================================
// 3. 引用结构
// ===========================================================================

test("溯源·引用 - 六个规范字段齐备，缺的用 null 而不是省略", () => {
  const ref = createEvidenceRef({
    documentVersionId: BLOB,
    blockId: "block_014",
    kind: "figure",
    locator: { page: 2, figure: "图 1" },
    quote: "图中 SYN 标志位",
    assetId: "asset_003"
  });

  assert.deepEqual(Object.keys(ref).sort(), [
    "assetId",
    "blockId",
    "documentVersionId",
    "id",
    "kind",
    "locator",
    "quote"
  ]);
  assert.match(ref.id, /^ev_[0-9a-f]{12}$/);
  assert.equal(ref.kind, "figure");
  assert.equal(ref.locator.page, 2);
});

test("溯源·引用 - id 是确定性的：同样的定位得到同样的 id", () => {
  const input = { documentVersionId: BLOB, blockId: "b1", kind: "text", locator: { page: 1 }, quote: "内容" };
  assert.equal(createEvidenceRef(input).id, createEvidenceRef({ ...input }).id, "同一定位必须稳定");
  assert.notEqual(
    createEvidenceRef(input).id,
    createEvidenceRef({ ...input, locator: { page: 2 } }).id,
    "定位不同必须区分"
  );
});

test("溯源·引用 - 未知 kind 归为 text，不产生非法取值", () => {
  assert.equal(createEvidenceRef({ kind: "胡说" }).kind, "text");
  assert.equal(createEvidenceRef({}).kind, "text");
  assert.ok(EVIDENCE_KINDS.length >= 5);
});

test("溯源·可追溯 - 只有摘录没有定位不算可追溯", () => {
  const quoteOnly = createEvidenceRef({ documentVersionId: BLOB, quote: "一段摘录" });
  assert.equal(
    isTraceable(quoteOnly),
    false,
    "摘录可能被改写，只有页号之类的锚点才能核对 —— 光有 quote 不算能指回原文"
  );

  assert.equal(isTraceable(createEvidenceRef({ documentVersionId: BLOB, locator: { page: 1 } })), true);
  assert.equal(isTraceable(createEvidenceRef({ documentVersionId: BLOB, blockId: "b1" })), true);
  assert.equal(isTraceable(createEvidenceRef({ documentVersionId: BLOB, assetId: "a1" })), true);
  assert.equal(
    isTraceable(createEvidenceRef({ locator: { page: 1 } })),
    false,
    "没有文档版本就不能定位到某一版原文"
  );
});

test("溯源·收集 - 过滤不可追溯的，并按 id 去重", () => {
  const good = createEvidenceRef({ documentVersionId: BLOB, locator: { page: 1 }, quote: "A" });
  const dup = createEvidenceRef({ documentVersionId: BLOB, locator: { page: 1 }, quote: "A" });
  const untraceable = createEvidenceRef({ documentVersionId: BLOB, quote: "只有摘录" });
  const collected = collectEvidenceRefs([good, dup, untraceable]);
  assert.equal(collected.length, 1, "重复的只留一条，不可追溯的被剔除");
  assert.deepEqual(collectEvidenceRefs(null), []);
});

// ===========================================================================
// 4. 从业务对象生成引用
// ===========================================================================

test("溯源·课件 - 段落出 text 证据、图表出 figure 证据，页码如实", () => {
  const context = {
    sections: [
      {
        page: 1,
        chapter: "第1节",
        content: "TCP 报文段由 20 字节固定头部与数据字段组成。",
        diagrams: [{ id: "fig-tcp-1", title: "TCP 首部", caption: "Figure 1-1: TCP Header", page: 1 }]
      },
      { page: 2, chapter: "第2节", content: "三次握手确保双向收发能力。" }
    ]
  };
  const refs = evidenceRefsFromMaterialContext(context, BLOB);

  assert.equal(refs.length, 3, "2 个段落 + 1 张图");
  for (const ref of refs) assert.equal(ref.documentVersionId, BLOB);
  assert.equal(refs.filter((r) => r.kind === "figure").length, 1);
  assert.equal(refs.find((r) => r.kind === "figure").locator.page, 1);
  assert.ok(refs.some((r) => r.locator.page === 2));
  assert.ok(
    refs.some((r) => String(r.quote).includes("三次握手")),
    "摘录必须是原文片段，不是概括"
  );
});

test("溯源·课件 - 没有版本时不产出任何引用（宁缺勿假）", () => {
  const context = { sections: [{ page: 1, content: "有内容" }] };
  assert.deepEqual(
    evidenceRefsFromMaterialContext(context, null),
    [],
    "没有文档版本就指不回原文 —— 此时必须一条都不产出，而不是产出指不准的引用"
  );
});

test("溯源·课件 - 段落没有页码时不硬凑页码", () => {
  const refs = evidenceRefsFromMaterialContext({ sections: [{ chapter: "无页码段落", content: "内容" }] }, BLOB);
  assert.equal(refs.length, 0, "既无页码也无块 id → 不可追溯 → 不产出");
});

test("溯源·评分 - 建议分引用指向被评阅的**报告**版本", () => {
  const reportVersion = "c".repeat(64);
  const ref = evidenceRefFromGrade(
    { rubricId: "os-r0", page: 2, evidence: "运行日志展示缓冲区容量在 0 至 5 之间变化。" },
    reportVersion
  );
  assert.ok(ref);
  assert.equal(ref.documentVersionId, reportVersion, "证据取自学生报告，不是课件");
  assert.equal(ref.locator.page, 2);
  assert.match(ref.quote, /缓冲区容量/);
  assert.equal(isTraceable(ref), true);
});

test("溯源·评分 - 没有页码也没有摘录时不生成'看起来有证据'的引用", () => {
  assert.equal(evidenceRefFromGrade({ rubricId: "r0" }, BLOB), null);
  assert.equal(evidenceRefFromGrade(null, BLOB), null);
  assert.equal(
    evidenceRefFromGrade({ rubricId: "r0", page: 1 }, null),
    null,
    "没有报告版本 → 不生成引用"
  );
});

test("溯源·评分 - 批量补引用是幂等的，且不改动没有证据的项形状", () => {
  const submission = {
    id: "sub-1",
    blobId: BLOB,
    grades: [
      { rubricId: "r0", score: 18, page: 1, evidence: "有摘录有页码" },
      { rubricId: "r1", score: 20 }
    ]
  };
  const once = withSubmissionEvidenceRefs(submission);
  assert.equal(once.grades[0].evidenceRefs.length, 1);
  assert.equal(
    Object.hasOwn(once.grades[1], "evidenceRefs"),
    false,
    "没有证据的评分项不加空数组，避免噪声"
  );

  const twice = withSubmissionEvidenceRefs(once);
  assert.deepEqual(twice.grades[0].evidenceRefs, once.grades[0].evidenceRefs, "重复处理结果不变");
  assert.equal(collectFromSubmissions([once]).length, 1);
});

// ===========================================================================
// 5. 端到端
// ===========================================================================

test("溯源·端到端 - 有原件的课件返回可追溯引用；缺版本时留空并说明原因", async () => {
  const t = await startTestServer();
  try {
    const headers = await t.as("t-chen");

    // ① 种子课件没有原件（blobId 缺失）→ 不产出引用，但要说明原因
    const noBlob = await t.get(`${BASE}/materials/mat-tcp/context`, headers);
    assert.equal(noBlob.statusCode, 200);
    assert.deepEqual(noBlob.json.evidenceRefs, [], "没有原件版本时不产出引用");
    assert.equal(
      noBlob.json.warnings.some((w) => /没有可追溯的原件版本/.test(w)),
      true,
      "必须说明为什么引用是空的，不能静默留空"
    );

    // ② 给课件补上原件内容哈希后，引用应当出现且可追溯
    t.store.updateMaterial("mat-tcp", { blobId: `${"d".repeat(64)}.pdf` });
    const withBlob = await t.get(`${BASE}/materials/mat-tcp/context`, headers);
    assert.equal(withBlob.statusCode, 200);
    assert.ok(withBlob.json.evidenceRefs.length > 0, "有版本后应当产出引用");
    for (const ref of withBlob.json.evidenceRefs) {
      assert.equal(isTraceable(ref), true, "产出的引用必须真的能指回原文");
      assert.equal(ref.documentVersionId, `${"d".repeat(64)}.pdf`);
    }
    assert.deepEqual(withBlob.json.warnings, [], "有版本时不应再有该提示");
  } finally {
    await t.close();
  }
});

test("溯源·端到端 - 建议分带上指向报告的引用；无报告版本时不硬造", async () => {
  const t = await startTestServer();
  try {
    const headers = await t.as("t-chen");

    // 种子里 sub-xu-os 有 4 项评分，但提交没有 blobId
    const before = await t.get(`${BASE}/submissions/sub-xu-os`, headers);
    assert.equal(before.statusCode, 200);
    assert.equal(
      (before.json.submission.grades || []).every((g) => !g.evidenceRefs),
      true,
      "没有报告版本时不硬造引用"
    );

    // 补上报告原件后，评分应当带上可追溯的引用
    t.store.updateSubmission("sub-xu-os", { blobId: `${"e".repeat(64)}.pdf` });
    const after = await t.get(`${BASE}/submissions/sub-xu-os`, headers);
    const graded = (after.json.submission.grades || []).filter((g) => g.evidenceRefs);
    assert.ok(graded.length > 0, "有报告版本后评分项应带上引用");
    for (const grade of graded) {
      for (const ref of grade.evidenceRefs) {
        assert.equal(ref.documentVersionId, `${"e".repeat(64)}.pdf`, "引用指向被评阅的报告");
        assert.equal(isTraceable(ref), true);
      }
    }
    assert.ok(
      Array.isArray(after.json.evidenceRefs) && after.json.evidenceRefs.length > 0,
      "响应级 evidenceRefs 应汇总本次返回的所有引用"
    );
  } finally {
    await t.close();
  }
});
