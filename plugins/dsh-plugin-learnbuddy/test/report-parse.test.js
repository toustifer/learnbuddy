/**
 * 报告真实解析的回归测试
 *
 * ## 为什么要有这个文件
 *
 * 2026-09-21 发现：报告解析这条链**从来没真正成功过** —— 它调用了不存在的
 * `storage.getFile(...)`，每次都抛错并被 `catch {}` 静默吞掉，于是评分一直落在
 * 「元数据兜底」上（拿文件名和体积编一段正文，再配上写死的图注）。
 *
 * 这个 bug 能长期藏住，是因为**没有任何测试真的把一份文件放进存储、再走一遍解析**：
 * 语法检查、模块加载、既有测试全都是绿的。
 *
 * 2026-09-22 与柳穿鱼的分支合并后，接口由他重写为 **async 的 `extractReportContent`**，
 * 并引入了几条更硬的契约（本文件按新契约断言）：
 *   - `source` 如实标记来源：`document` = 真实解析，`fixture` = 内置演示样例
 *   - 解析失败**显式返回失败对象**（`status: "failed"`、`content: ""`），**绝不编造正文**
 *   - 页数由标题结构估算时用 `pagesEstimated` 显式标记，不冒充真实页码
 *
 * 所以这里断言的是：**真的落盘一份文件 → 真的解析 → 拿到真实正文**，
 * 以及**不可解析时必须显式失败、不得伪造**。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { StorageService } from "../src/services/storage.js";
import { extractReportContent } from "../src/services/autograder-pipeline.js";
import { buildMinimalPdf } from "../scripts/lib/doc-fixtures.mjs";

function makeStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learnbuddy-reportparse-"));
  return {
    storage: new StorageService({ uploadDir: dir }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

test("报告解析 - storage 的真实接口里没有 getFile（防止再写回不存在的方法）", () => {
  const { storage, cleanup } = makeStorage();
  try {
    assert.equal(
      typeof storage.getFile,
      "undefined",
      "StorageService 没有 getFile —— 解析层必须用 getFilePath / getFileMetadata（已做兼容，但别再依赖 getFile）"
    );
    assert.equal(typeof storage.getFilePath, "function", "真实接口是 getFilePath");
    assert.equal(typeof storage.getFileMetadata, "function", "真实接口是 getFileMetadata");
    assert.equal(typeof storage.saveFile, "function", "真实接口是 saveFile");
  } finally {
    cleanup();
  }
});

test("报告解析 - 真实落盘的文件必须能解析出正文（这条曾经是坏的）", async () => {
  const { storage, cleanup } = makeStorage();
  try {
    // 真的写入一份 PDF 字节（不是 mock），再按提交的路径去解析
    const pdf = buildMinimalPdf(["LearnBuddy Report Parse Probe", "UDP checksum lab", "result matches"]);
    const saved = await storage.saveFile(pdf, "probe-report.pdf");
    const blobId = saved.blobId || saved.fileId;
    assert.ok(blobId, "落盘后应当拿到 blobId");

    const report = await extractReportContent({ blobId, fileName: "probe-report.pdf" }, storage);

    assert.ok(report, "必须返回解析结果");
    assert.notEqual(report.status, "failed", `解析失败：${report.error || "未给出原因"}`);
    assert.equal(report.source, "document", "真实解析的来源必须标为 document");
    assert.ok(typeof report.content === "string" && report.content.length > 0, "必须拿到正文");
    assert.ok(
      /LearnBuddy|UDP|checksum|Report/i.test(report.content),
      `正文应当包含原件里的文字，实际拿到：${JSON.stringify(String(report.content).slice(0, 80))}`
    );
  } finally {
    cleanup();
  }
});

test("报告解析 - 没有原件时显式失败，绝不编造正文", async () => {
  const { storage, cleanup } = makeStorage();
  try {
    assert.equal(await extractReportContent(null, storage), null, "没有提交记录时返回 null");

    const noBlob = await extractReportContent({ fileName: "x.pdf" }, storage);
    assert.equal(noBlob.status, "failed", "缺 blobId 必须显式失败");
    assert.equal(noBlob.content, "", "失败时正文必须为空 —— 不得用元数据编一段正文顶替");
    assert.equal(noBlob.pages, 0, "失败时不应给出页数");
    assert.ok(noBlob.error, "必须给出可读的失败原因");
  } finally {
    cleanup();
  }
});

test("报告解析 - 原件不存在时同样显式失败，不伪造", async () => {
  const { storage, cleanup } = makeStorage();
  try {
    const report = await extractReportContent({ blobId: "nope.pdf", fileName: "nope.pdf" }, storage);
    assert.equal(report.status, "failed", "原件读不到必须显式失败");
    assert.equal(report.content, "", "失败时不得编造正文");
  } finally {
    cleanup();
  }
});

test("报告解析 - 损坏的文件不得给出一份「看起来正常」的正文", async () => {
  const { storage, cleanup } = makeStorage();
  try {
    const saved = await storage.saveFile(Buffer.from("这不是一个合法的 PDF"), "broken.pdf");
    const blobId = saved.blobId || saved.fileId;

    const report = await extractReportContent({ blobId, fileName: "broken.pdf" }, storage);
    assert.equal(report.status, "failed", "损坏文件必须显式失败");
    assert.equal(report.content, "", "失败时必须留空，不得伪造内容");
  } finally {
    cleanup();
  }
});

test("报告解析 - 来源必须如实标记，fixture 不得混作真实解析", async () => {
  const { storage, cleanup } = makeStorage();
  try {
    // 带 sampleKey 的提交走内置样例 —— 允许，但**必须标记为 fixture**
    // （SAMPLE_STUDENT_REPORTS 的键是 network / os / database；handshake 是课件的键，不是提交的）
    const fixture = await extractReportContent({ sampleKey: "network", fileName: "样例.pdf" }, storage);
    assert.ok(fixture, "样例解析应当返回结果");
    assert.equal(
      fixture.source,
      "fixture",
      "内置样例必须标记为 fixture（按 04 §5 不得混入正式评分与统计）"
    );
  } finally {
    cleanup();
  }
});
