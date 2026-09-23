/**
 * Populate only the isolated web/.dsh-preview teaching database with repeatable
 * AutoGrader test data. The generated PDFs are real files parsed by the same
 * document pipeline as uploads; no text is fabricated in the review UI.
 *
 * Run after `npm run dev:services` has created the local database:
 *   node scripts/prepare-local-autograder-demo.mjs
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseStore } from "../src/db/store.js";
import { StorageService } from "../src/services/storage.js";
import { extractReportContent } from "../src/services/autograder-pipeline.js";
import { buildPdf } from "./lib/doc-fixtures.mjs";

const dataDir = fileURLToPath(new URL("../web/.dsh-preview/teaching-data/", import.meta.url));
const dbPath = path.join(dataDir, "learnbuddy.sqlite");
if (!existsSync(dbPath)) {
  throw new Error("本地教学数据库不存在。请先启动 web/dev-services.mjs。");
}

const store = new DatabaseStore({ path: dbPath, seed: false });
const storage = new StorageService({ uploadDir: path.join(dataDir, "uploads") });

async function saveParsedPdf(fileName, lines) {
  const saved = await storage.saveFile(buildPdf([lines]), fileName, { role: "local-autograder-test" });
  const report = await extractReportContent({ fileName, blobId: saved.fileId }, storage);
  if (report?.source !== "document" || !report.structuredPages?.length || report.originalPages !== 1) {
    throw new Error(`${fileName} 没有通过真实 PDF 解析：${report?.error || report?.status || "未知错误"}`);
  }
  const parsedContent = {
    title: report.title,
    pages: report.pages,
    originalPages: report.originalPages,
    pagesEstimated: report.pagesEstimated === true,
    source: "document",
    hasImages: report.hasImages === true,
    images: report.images || [],
    imageWarnings: report.imageWarnings || [],
    warnings: report.warnings || [],
    completeness: report.status === "partial" ? "partial" : "complete",
    structuredPages: report.structuredPages
  };
  return { blobId: saved.fileId, parsedContent };
}

try {
  if (!store.getSubmission("sub-yi-net-local")) {
    const fileName = "本地测试 · TCP握手报告_林一.pdf";
    const document = await saveParsedPdf(fileName, [
      "TCP HANDSHAKE LAB REPORT - LIN YI",
      "Environment: Windows 11, Wireshark 4.2, local client and test server.",
      "The client IP is 192.168.1.105 and the server IP is 192.168.1.80.",
      "Capture filter: tcp port 8080. The full connection was recorded.",
      "Step 1: Client sends SYN with Seq=1000 and no ACK flag.",
      "Step 2: Server replies SYN-ACK with Seq=5000 and Ack=1001.",
      "Step 3: Client sends ACK with Seq=1001 and Ack=5001.",
      "The ACK value confirms receipt of the preceding sequence number.",
      "Packet 12 shows SYN, packet 13 shows SYN-ACK, packet 14 shows ACK.",
      "The packet list was filtered by the same four-tuple throughout.",
      "A screenshot marks the three Flags fields and both sequence columns.",
      "A second capture intentionally sends RST after the handshake.",
      "The RST ends the connection before application data is exchanged.",
      "Conclusion: all three steps match the expected TCP state transition.",
      "Limitation: one local network was tested; delay was not measured."
    ]);
    store.createSubmission({
      id: "sub-yi-net-local",
      assignmentId: "lab-tcp",
      studentId: "s-yi",
      fileName,
      submittedAt: "2026-09-23 10:00",
      status: "submitted",
      ...document,
      grades: [],
      summary: "",
      history: []
    });
    // createSubmission handles the upload metadata; parsedContent is persisted
    // through the same update path used by the real grading pipeline.
    store.updateSubmission("sub-yi-net-local", { parsedContent: document.parsedContent });
    console.log("已新增林一的本地测试 PDF，等待真实 AutoGrader 评阅。");
  } else {
    const existing = store.getSubmission("sub-yi-net-local");
    if (!existing.parsedContent && existing.blobId) {
      const report = await extractReportContent(existing, storage);
      if (report?.source !== "document" || !report.structuredPages?.length) throw new Error("林一的测试 PDF 重新解析失败。");
      store.updateSubmission(existing.id, { parsedContent: {
        title: report.title, pages: report.pages, originalPages: report.originalPages ?? null,
        pagesEstimated: report.pagesEstimated === true, source: "document",
        hasImages: report.hasImages === true, images: report.images || [],
        imageWarnings: report.imageWarnings || [], warnings: report.warnings || [],
        completeness: report.status === "partial" ? "partial" : "complete",
        structuredPages: report.structuredPages
      } });
      console.log("已补齐林一报告的持久化解析内容。");
    } else {
      console.log("林一的本地测试提交已存在，保留当前评阅数据。");
    }
  }

  const zhou = store.getSubmission("sub-zhou-net");
  if (zhou && !zhou.blobId && !zhou.grades.length) {
    const fileName = "本地测试 · TCP握手报告_周可.pdf";
    const document = await saveParsedPdf(fileName, [
      "TCP HANDSHAKE LAB REPORT - ZHOU KE",
      "Environment: Linux client, Wireshark 4.2, campus test server.",
      "Capture filter: tcp port 8080.",
      "Client sends SYN with Seq=2000.",
      "Server sends SYN-ACK with Seq=7000 and Ack=2001.",
      "Client sends ACK with Seq=2001 and Ack=7001.",
      "The capture lists the three packets in chronological order.",
      "Only the packet list is attached; field-level labels are missing.",
      "No abnormal connection case was recorded in this trial.",
      "Conclusion: the normal connection was established successfully."
    ]);
    store.updateSubmission(zhou.id, { fileName, sampleKey: null, ...document });
    console.log("已补周可的本地测试 PDF；保留其待评阅状态。");
  } else {
    console.log("周可的提交已有原件或评分，未覆盖。");
  }

  if (!store.getSubmission("sub-yi-os-local")) {
    const fileName = "本地测试 · 生产者消费者报告_林一.pdf";
    const document = await saveParsedPdf(fileName, [
      "PRODUCER CONSUMER LAB REPORT - LIN YI",
      "Environment: Ubuntu 22.04, Python 3.11, four producer threads and two consumer threads.",
      "The bounded buffer capacity is five entries; each item is a numbered integer.",
      "I used empty=5, full=0 and a mutex lock to protect buffer updates.",
      "Producer: wait(empty), acquire(mutex), append item, release(mutex), signal(full).",
      "Consumer: wait(full), acquire(mutex), pop item, release(mutex), signal(empty).",
      "The mutex prevents concurrent writes; the semaphores prevent overflow and underflow.",
      "Run command: python3 producer_consumer.py --capacity 5 --producers 4 --consumers 2.",
      "Console log: P1 put 001 size=1; P2 put 002 size=2; C1 got 001 size=1.",
      "Console log: P3 put 003 size=2; C2 got 002 size=1; C1 got 003 size=0.",
      "A 100-item run consumed all 100 items with no duplicate item IDs.",
      "Boundary test: consumer waited when buffer size was zero, then resumed after producer signaled full.",
      "Boundary test: producer waited when buffer size was five, then resumed after consumer signaled empty.",
      "The report includes console text but no screenshot of the terminal or source listing.",
      "Conclusion: the semaphore order avoided buffer overflow and underflow in these runs."
    ]);
    store.createSubmission({
      id: "sub-yi-os-local", assignmentId: "lab-os", studentId: "s-yi",
      fileName, submittedAt: "2026-09-24 10:00", status: "submitted",
      ...document, grades: [], summary: "", history: []
    });
    store.updateSubmission("sub-yi-os-local", { parsedContent: document.parsedContent });
    console.log("已新增操作系统本地测试 PDF，等待真实 AutoGrader 评阅。");
  } else {
    console.log("操作系统本地测试提交已存在，保留当前评阅数据。");
  }

  if (!store.getAssignment("local-rubric-draft")) {
    store.createAssignment({
      id: "local-rubric-draft",
      courseId: "network",
      title: "本地测试 · 可编辑评分标准",
      due: "2026-10-01T23:59",
      description: "用于测试作业名称、截止时间、任务要求、资料关联及评分项的新增、修改、删除和保存。",
      materialIds: ["mat-tcp"],
      rubric: [
        { id: "local-r0", title: "实验过程", criterion: "说明实验环境和操作步骤。", max: 50 },
        { id: "local-r1", title: "分析与结论", criterion: "用抓包结果支持结论。", max: 50 }
      ],
      confirmed: false,
      published: false
    });
    console.log("已新增无提交的草稿，可测试评分项增删与保存。");
  } else {
    console.log("可编辑草稿已存在，保留当前修改。");
  }
} finally {
  store.close();
}
