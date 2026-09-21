/**
 * 报告真实解析的回归测试
 *
 * ## 为什么要有这个文件
 *
 * 2026-09-21 合并 `main` 时发现：`parseReportDocument()` 里调用了
 * **不存在的** `storage.getFile(...)`（StorageService 的真实接口只有
 * `saveFile` / `getFilePath` / `deleteFile` / `getFileMetadata`），
 * 每次都抛 TypeError 并被 `catch {}` 静默吞掉 ⇒ 恒返回 null ⇒
 * 「真实解析报告」**从来没有真正发生过**，一直落在元数据兜底（假内容）上。
 *
 * 这个 bug 能长期藏住，是因为**没有任何测试真的把一份文件放进存储、再走一遍解析**：
 * 语法检查、模块加载、既有测试全都是绿的。
 *
 * 所以这里补上真实路径的测试：**真的落盘一份文件，真的解析它，断言拿到真实正文。**
 * 以后任何人再改动这条链，都会在这里被拦住。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { StorageService } from "../src/services/storage.js";
import { parseReportDocument } from "../src/services/autograder-pipeline.js";
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
      "StorageService 没有 getFile —— 若将来加了请同步改 parseReportDocument 的注释与调用方式"
    );
    assert.equal(typeof storage.getFilePath, "function", "真实接口是 getFilePath");
    assert.equal(typeof storage.getFileMetadata, "function", "真实接口是 getFileMetadata");
    assert.equal(typeof storage.saveFile, "function", "真实接口是 saveFile");
  } finally {
    cleanup();
  }
});

test("报告解析 - 真实落盘的文件必须能被解析出正文（这条曾经是坏的）", async () => {
  const { storage, cleanup } = makeStorage();
  try {
    // 真的写入一份 PDF 字节（不是 mock），再按提交的路径去解析
    const pdf = buildMinimalPdf(["LearnBuddy Report Parse Probe", "UDP checksum lab", "result matches"]);
    const saved = await storage.saveFile(pdf, "probe-report.pdf");
    const blobId = saved.blobId || saved.fileId;
    assert.ok(blobId, "落盘后应当拿到 blobId");

    const parsed = await parseReportDocument({ blobId, fileName: "probe-report.pdf" }, storage);

    assert.ok(
      parsed,
      "必须解析出结果 —— 返回 null 意味着解析链又断了（历史上就是调用了不存在的 storage.getFile）"
    );
    assert.ok(typeof parsed.content === "string" && parsed.content.length > 0, "必须拿到正文");
    assert.ok(
      /LearnBuddy|UDP|checksum|Report/i.test(parsed.content),
      `正文应当包含原件里的文字，实际拿到：${JSON.stringify(parsed.content.slice(0, 80))}`
    );
    assert.ok(Number.isFinite(parsed.pages) && parsed.pages >= 1, "应当给出页数");
  } finally {
    cleanup();
  }
});

test("报告解析 - 没有原件时返回 null（不编造正文）", async () => {
  const { storage, cleanup } = makeStorage();
  try {
    assert.equal(await parseReportDocument({ blobId: null }, storage), null, "无 blobId 时不得编造");
    assert.equal(await parseReportDocument({ blobId: "nope.pdf" }, storage), null, "原件不存在时不得编造");
    assert.equal(await parseReportDocument(null, storage), null);
  } finally {
    cleanup();
  }
});

test("报告解析 - 损坏的文件要报错并返回 null，而不是给出一份看起来正常的正文", async () => {
  const { storage, cleanup } = makeStorage();
  try {
    const saved = await storage.saveFile(Buffer.from("这不是一个合法的 PDF"), "broken.pdf");
    const blobId = saved.blobId || saved.fileId;

    const parsed = await parseReportDocument({ blobId, fileName: "broken.pdf" }, storage);
    assert.equal(parsed, null, "解析失败必须显式返回 null 交由调用方降级，不得伪造内容");
  } finally {
    cleanup();
  }
});
