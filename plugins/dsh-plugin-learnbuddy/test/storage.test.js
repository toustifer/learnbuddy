/**
 * LearnBuddy 文件存储与静态原件预览托管 单元与集成测试
 * 
 * 验证重点：
 * 1. StorageService 物理落盘与多格式白名单校验 (.pdf, .ppt, .pptx, .docx, .png, .jpg, .jpeg)
 * 2. 文件大小限制 (单文件不超过 20MB) 校验
 * 3. SHA-256 哈希校验、去重机制与防路径穿越安全防护
 * 4. getFilePath(fileId)、saveFile(buffer/stream, originalName)、deleteFile(fileId) 接口规范
 * 5. GET /api/learnbuddy/files/:id/view 在线预览 PDF 与图片
 * 6. GET /api/learnbuddy/files/:id/download 附件下载
 * 7. POST /api/learnbuddy/materials/upload 真实物理存储与 DatabaseStore 持久化连通
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { Readable } from "node:stream";

import {
  StorageService,
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE,
  formatFileSize,
  getMimeType
} from "../src/services/storage.js";
import { DatabaseStore } from "../src/db/store.js";
import { registerLearnBuddyRoutes } from "../src/routes/api.js";

function createTempDir(prefix = "learnbuddy-test-storage-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("StorageService - 文件物理保存、哈希计算与白名单格式支持", async () => {
  const tmpDir = createTempDir();
  const storage = new StorageService({ uploadDir: tmpDir });

  try {
    // 测试白名单中的各种扩展名
    const validFiles = [
      { name: "test-lecture.pdf", content: Buffer.from("%PDF-1.4 sample pdf content") },
      { name: "slides.pptx", content: Buffer.from("PK pptx mock zip content") },
      { name: "legacy.ppt", content: Buffer.from("D0CF11E0 ppt binary content") },
      { name: "notes.docx", content: Buffer.from("PK docx mock zip content") },
      { name: "screenshot.png", content: Buffer.from("\x89PNG\r\n\x1a\n png content") },
      { name: "photo.jpg", content: Buffer.from("\xFF\xD8\xFF photo jpg") },
      { name: "avatar.jpeg", content: Buffer.from("\xFF\xD8\xFF avatar jpeg") }
    ];

    for (const f of validFiles) {
      const saved = await storage.saveFile(f.content, f.name);

      assert.ok(saved.fileId, "应该生成 fileId");
      assert.equal(saved.originalName, f.name);
      assert.equal(saved.size, f.content.length);
      assert.equal(saved.ext, path.extname(f.name).toLowerCase());

      // 计算预期哈希
      const expectedHash = crypto.createHash("sha256").update(f.content).digest("hex");
      assert.equal(saved.hash, expectedHash, "SHA-256 哈希计算准确");

      // 验证物理落盘存在
      assert.ok(fs.existsSync(saved.filePath), "物理文件应已落盘");
      const diskContent = fs.readFileSync(saved.filePath);
      assert.deepEqual(diskContent, f.content, "物理文件内容一致");

      // 验证 getFilePath 可定位
      const queriedPath = storage.getFilePath(saved.fileId);
      assert.equal(queriedPath, saved.filePath);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("StorageService - 扩展名白名单严格过滤与大写扩展名兼容", async () => {
  const tmpDir = createTempDir();
  const storage = new StorageService({ uploadDir: tmpDir });

  try {
    // 大写扩展名兼容
    const upperPdf = await storage.saveFile(Buffer.from("pdf-data"), "EXPERIMENT.PDF");
    assert.equal(upperPdf.ext, ".pdf");

    // 不在白名单的后缀应被拒绝
    const illegalFiles = ["script.sh", "evil.exe", "trojan.php", "hack.js", "style.css", "noext"];
    for (const illegalName of illegalFiles) {
      await assert.rejects(
        async () => {
          await storage.saveFile(Buffer.from("malicious content"), illegalName);
        },
        /不支持的文件格式/,
        `非白名单文件 "${illegalName}" 应被严格拦截`
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("StorageService - 单文件大小限制校验 (<=20MB 允许, >20MB 拦截)", async () => {
  const tmpDir = createTempDir();
  // 使用自定义小阈值测试大小限制机制
  const strictStorage = new StorageService({
    uploadDir: tmpDir,
    maxSize: 1024 // 1 KB 限制用于单元测试
  });

  try {
    const smallBuffer = Buffer.alloc(512, "a");
    const saved = await strictStorage.saveFile(smallBuffer, "small.pdf");
    assert.equal(saved.size, 512);

    const oversizedBuffer = Buffer.alloc(1025, "b");
    await assert.rejects(
      async () => {
        await strictStorage.saveFile(oversizedBuffer, "large.pdf");
      },
      /超过单文件限制/,
      "超过大小限制的文件应被拦截"
    );

    // 测试默认配置 20MB 常量
    assert.equal(MAX_FILE_SIZE, 20 * 1024 * 1024);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("StorageService - SHA-256 去重机制", async () => {
  const tmpDir = createTempDir();
  const storage = new StorageService({ uploadDir: tmpDir });

  try {
    const identicalContent = Buffer.from("Same file content uploaded twice");
    const save1 = await storage.saveFile(identicalContent, "report_v1.pdf");
    const save2 = await storage.saveFile(identicalContent, "report_v2.pdf");

    assert.equal(save1.hash, save2.hash, "哈希一致");
    assert.equal(save1.fileId, save2.fileId, "fileId 去重一致");
    assert.equal(save1.filePath, save2.filePath, "指向同一物理存储文件");

    // 目录中物理文件只应有一份
    const files = fs.readdirSync(tmpDir).filter((f) => !f.startsWith("."));
    assert.equal(files.length, 1, "相同内容只物理落盘一份文件");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("StorageService - 防路径穿越 (Path Traversal) 严密安全防护", async () => {
  const tmpDir = createTempDir();
  const storage = new StorageService({ uploadDir: tmpDir });

  try {
    // 1. 上传时文件名含目录穿越字符：会被安全截断为 basename，物理落盘文件名为 hash.pdf
    const maliciousName = "../../../etc/passwd.pdf";
    const saved = await storage.saveFile(Buffer.from("safe content"), maliciousName);
    assert.equal(saved.originalName, "passwd.pdf");
    assert.ok(saved.filePath.startsWith(tmpDir));

    // 2. getFilePath 查询时包含各种路径穿越字符，应均返回 null
    const dangerousIds = [
      "../../../etc/passwd",
      "..\\..\\windows\\system32",
      "../uploads/secret.pdf",
      "subdir/file.pdf",
      "..",
      ".",
      "../../../../test.pdf"
    ];

    for (const badId of dangerousIds) {
      const result = storage.getFilePath(badId);
      assert.equal(result, null, `路径穿越攻击 ID "${badId}" 必须返回 null`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("StorageService - Stream 流式保存与文件物理删除 (deleteFile)", async () => {
  const tmpDir = createTempDir();
  const storage = new StorageService({ uploadDir: tmpDir });

  try {
    // Readable Stream 保存
    const stream = Readable.from([Buffer.from("part 1 "), Buffer.from("part 2")]);
    const saved = await storage.saveFile(stream, "streamed.docx");

    assert.equal(saved.size, 13);
    assert.ok(fs.existsSync(saved.filePath));

    // 删除文件
    const deleted = await storage.deleteFile(saved.fileId);
    assert.equal(deleted, true);
    assert.equal(fs.existsSync(saved.filePath), false, "物理文件已被删除");

    // 再次查询返回 null
    assert.equal(storage.getFilePath(saved.fileId), null);
    // 重复删除返回 false
    const reDelete = await storage.deleteFile(saved.fileId);
    assert.equal(reDelete, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ==========================================
// HTTP 接口层集成测试 (预览、下载、上传与 DB 连通)
// ==========================================

function makeHttpRequest(port, method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks)
          });
        });
      }
    );
    req.on("error", reject);
    if (body) {
      if (Buffer.isBuffer(body)) {
        req.write(body);
      } else {
        req.write(body);
      }
    }
    req.end();
  });
}

test("HTTP 路由 - 文件物理上传、在线预览与附件下载完整链路", async () => {
  const tmpDir = createTempDir();
  const storage = new StorageService({ uploadDir: tmpDir });
  const store = new DatabaseStore(":memory:");

  // 构造独立测试 HTTP Server
  const middlewares = [];
  const fakeCtx = {
    webServer: {
      use: (fn) => middlewares.push(fn)
    }
  };

  registerLearnBuddyRoutes(fakeCtx, { store, storage });

  const testServer = http.createServer(async (req, res) => {
    for (const mw of middlewares) {
      let nextCalled = false;
      await mw(req, res, () => {
        nextCalled = true;
      });
      if (!nextCalled && (res.writableEnded || res.headersSent)) {
        break;
      }
    }
    if (!res.writableEnded && !res.headersSent) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  await new Promise((resolve) => testServer.listen(0, "127.0.0.1", resolve));
  const port = testServer.address().port;

  try {
    // 1. 测试 POST /api/learnbuddy/materials/upload (真实物理落盘并持久化到 DatabaseStore)
    const testPdfContent = Buffer.from("%PDF-1.4 Mock Wireshark Tutorial PDF Content\n%%EOF");
    const base64Pdf = testPdfContent.toString("base64");

    const uploadRes = await makeHttpRequest(
      port,
      "POST",
      "/api/learnbuddy/materials/upload",
      { "Content-Type": "application/json" },
      JSON.stringify({
        fileName: "计网抓包指导.pdf",
        courseId: "network",
        ownerId: "t-chen",
        visibility: "course",
        encoding: "base64",
        content: base64Pdf
      })
    );

    assert.equal(uploadRes.statusCode, 200);
    const uploadData = JSON.parse(uploadRes.body.toString("utf-8"));
    assert.equal(uploadData.ok, true);
    assert.ok(uploadData.file.id);
    assert.equal(uploadData.file.name, "计网抓包指导.pdf");
    assert.ok(uploadData.file.viewUrl);
    assert.ok(uploadData.file.downloadUrl);

    // 验证 DatabaseStore 中成功写入且持久化可查
    const dbMaterial = store.getMaterialById(uploadData.material.id);
    assert.ok(dbMaterial, "DatabaseStore 必须已写入新课件");
    assert.equal(dbMaterial.title, "计网抓包指导.pdf");
    assert.equal(dbMaterial.blobId, uploadData.file.id);
    assert.equal(dbMaterial.courseId, "network");

    const fileId = uploadData.file.id;

    // 2. 测试 GET /api/learnbuddy/files/:id/view (浏览器在线预览 PDF)
    const viewRes = await makeHttpRequest(port, "GET", `/api/learnbuddy/files/${fileId}/view`);
    assert.equal(viewRes.statusCode, 200);
    assert.equal(viewRes.headers["content-type"], "application/pdf");
    assert.ok(viewRes.headers["content-disposition"].includes("inline"), "必须支持在线预览 inline");
    assert.deepEqual(viewRes.body, testPdfContent, "在线预览内容必须完全与物理原件一致");

    // 3. 测试 GET /api/learnbuddy/files/:id/download (附件下载)
    const downloadRes = await makeHttpRequest(port, "GET", `/api/learnbuddy/files/${fileId}/download`);
    assert.equal(downloadRes.statusCode, 200);
    assert.ok(downloadRes.headers["content-disposition"].includes("attachment"), "必须触发附件下载 attachment");
    assert.deepEqual(downloadRes.body, testPdfContent, "下载内容完整");

    // 4. 测试图片在线预览 (image/png)
    const pngContent = Buffer.from("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR");
    const savedPng = await storage.saveFile(pngContent, "topology.png");
    const pngViewRes = await makeHttpRequest(port, "GET", `/api/learnbuddy/files/${savedPng.fileId}/view`);
    assert.equal(pngViewRes.statusCode, 200);
    assert.equal(pngViewRes.headers["content-type"], "image/png");
    assert.ok(pngViewRes.headers["content-disposition"].includes("inline"));

    // 5. 预览不存在的文件返回 404
    const notFoundRes = await makeHttpRequest(port, "GET", "/api/learnbuddy/files/nonexistent.pdf/view");
    assert.equal(notFoundRes.statusCode, 404);

    // 6. 路径穿越请求在 HTTP 接口层被有效阻断并返回 404
    const traversalRes = await makeHttpRequest(port, "GET", "/api/learnbuddy/files/..%2F..%2Fpasswords/view");
    assert.equal(traversalRes.statusCode, 404);

    // 7. 验证 GET /api/learnbuddy/materials 包含新上传的材料
    const listRes = await makeHttpRequest(port, "GET", "/api/learnbuddy/materials?courseId=network&userId=t-chen");
    assert.equal(listRes.statusCode, 200);
    const listData = JSON.parse(listRes.body.toString("utf-8"));
    assert.ok(listData.ok);
    const found = listData.materials.find((m) => m.id === uploadData.material.id);
    assert.ok(found, "课件列表必须能检索到通过上传保存的持久化数据");
  } finally {
    testServer.close();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
