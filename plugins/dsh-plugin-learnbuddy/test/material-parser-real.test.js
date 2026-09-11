/**
 * task-14：课件「真实文档解析」测试套件（anydoc 真解析 + 禁止静默失败 + 内嵌图片多模态）
 *
 * 设计红线：
 * 1. **所有输入都是磁盘上的真实文件**：测试运行时用零依赖构造器
 *    （scripts/lib/doc-fixtures.mjs）手写真实 PDF / DOCX / XLSX / CSV / PNG 字节，
 *    再交给 `MaterialParserService.parseAndExtract()` 走完整链路。
 *    **不 mock anydoc、不 mock 解析结果** —— 断言的是「解析出来的内容 == 我们写进去的内容」，
 *    这是证明「真解析」而不是「写死示例文字」的关键。
 * 2. **失败必须如实上报**：损坏 / 加密 / 不支持格式 / 文件不存在 都要断言
 *    `status:"failed"` + 明确的 `errorCode`，并显式断言**没有**回落成假内容。
 * 3. 绝不发真实外部请求、绝不使用真实密钥：LLM 打到本进程的假供应商 Server（127.0.0.1 随机端口）。
 * 4. 图片课件仍走视觉模型（deepseek-flash 这条路径不变）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

import {
  MaterialParserService,
  MAX_EMBEDDED_IMAGES,
  MAX_EMBEDDED_IMAGE_BYTES,
  ANYDOC_ERROR_CODES,
  expectedAnydocPlatformPackage,
  loadAnydoc,
  describeParseError
} from "../src/services/material-parser.js";
import { MultimodalLLMClient } from "../src/services/llm.js";
import { StorageService } from "../src/services/storage.js";
import { DatabaseStore } from "../src/db/store.js";
import { registerLearnBuddyRoutes } from "../src/routes/api.js";
import { renderTextPng } from "../scripts/lib/png-text.mjs";
import {
  buildMinimalPdf,
  buildPdf,
  buildCorruptPdf,
  buildDocx,
  buildXlsx,
  buildPaddedPng
} from "../scripts/lib/doc-fixtures.mjs";

/** 占位假密钥（仓库内不得出现任何真实密钥） */
const FAKE_KEY = "sk-test-placeholder";

const VISION_MODEL = "vision-model-x";
const TEXT_MODEL = "text-model-y";

/**
 * 起一个假供应商 Server：记录请求，返回确定的知识点 JSON。
 * @returns {Promise<{baseUrl:string, requests:object[], close:()=>Promise<void>}>}
 */
async function startFakeProvider(responder) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf-8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      const ctx = { url: req.url, method: req.method, headers: req.headers, body, raw, index: requests.length };
      requests.push(ctx);

      const plan = responder ? responder(ctx) || {} : {};
      const status = plan.status ?? 200;
      const payload =
        plan.body !== undefined
          ? plan.body
          : JSON.stringify({
              model: body?.model || "unknown",
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: JSON.stringify({
                      points: [
                        { id: "kp-1", name: "真解析考点", summary: "来自真实文件内容", page: 1, difficulty: "核心" }
                      ]
                    })
                  },
                  finish_reason: "stop"
                }
              ],
              usage: { total_tokens: 20 }
            });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(payload);
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** 建一个指向假供应商的解析器（含真实的文本/视觉模型路由） */
function makeParser(fake) {
  const client = new MultimodalLLMClient({
    env: {},
    apiKey: FAKE_KEY,
    baseUrl: fake.baseUrl,
    visionModel: VISION_MODEL,
    textModel: TEXT_MODEL
  });
  return new MaterialParserService(client);
}

/** 建临时工作目录，并注册清理 */
async function makeTempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "learnbuddy-anydoc-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** 取出请求体里 user 消息的纯文本部分 */
function userText(body) {
  const content = body.messages[1].content;
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** 取出请求体里的 image_url data URI 列表 */
function userImages(body) {
  const content = body.messages[1].content;
  if (!Array.isArray(content)) return [];
  return content.filter((part) => part.type === "image_url").map((part) => part.image_url.url);
}

// ===========================================================================
// 1. PDF：真实解析（逐字提取，而不是写死的示例文字）
// ===========================================================================

test("真实解析 - PDF：逐字提取真实文本，且 LLM 收到的是文件里的原文", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const dir = await makeTempDir(t);

  const pdfPath = path.join(dir, "wireshark-guide.pdf");
  const lines = ["LEARNBUDDY REAL PDF PARSING 2026", "TCP HANDSHAKE SYN ACK RST"];
  await fs.writeFile(pdfPath, buildMinimalPdf(lines));

  const parser = makeParser(fake);
  const result = await parser.parseAndExtract(pdfPath, "wireshark-guide.pdf");

  assert.equal(result.status, "parsed");
  assert.equal(result.ext, ".pdf");
  assert.equal(result.title, "wireshark-guide.pdf");

  // 【关键断言】解析出的正文就是我们写进 PDF 的原文（证明真解析）
  assert.ok(result.rawContentSummary.includes("LEARNBUDDY REAL PDF PARSING 2026"));
  assert.ok(result.rawContentSummary.includes("TCP HANDSHAKE SYN ACK RST"));

  // 旧实现的假文字绝不能出现
  assert.ok(!result.rawContentSummary.includes("实验目的：掌握 Wireshark 抓包工具"));

  // 体积是真实文件大小，而不是写死的 "2.4 MB"
  const stat = await fs.stat(pdfPath);
  assert.ok(result.size.endsWith("B"), `size 应为真实字节数的可读形式，收到 ${result.size}`);
  assert.notEqual(result.size, "2.4 MB");
  assert.ok(stat.size > 0);

  // 真实原文确实流到了 LLM 请求里
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].body.model, TEXT_MODEL, "纯文本课件走 LLM_MODEL_TEXT");
  const sentText = userText(fake.requests[0].body);
  assert.ok(sentText.includes("LEARNBUDDY REAL PDF PARSING 2026"));
  assert.equal(result.knowledgePoints[0].name, "真解析考点");
});

test("真实解析 - 多页 PDF：按真实页数上报（旧实现写死 12 页）", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const dir = await makeTempDir(t);

  const pdfPath = path.join(dir, "two-pages.pdf");
  await fs.writeFile(
    pdfPath,
    buildPdf([
      ["PAGE ONE TCP HANDSHAKE"],
      ["PAGE TWO RETRANSMISSION"],
      ["PAGE THREE CONGESTION CONTROL"]
    ])
  );

  const parser = makeParser(fake);
  const result = await parser.parseAndExtract(pdfPath, "two-pages.pdf");

  assert.equal(result.status, "parsed");
  assert.equal(result.pages, 3, "三页 PDF 必须上报 3 页");
  assert.ok(result.rawContentSummary.includes("PAGE THREE CONGESTION CONTROL"));
});

// ===========================================================================
// 2. DOCX / XLSX / CSV：真实解析 + 内嵌图片多模态
// ===========================================================================

test("真实解析 - DOCX：正文逐字提取，内嵌图片作为资产交给视觉模型", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const dir = await makeTempDir(t);

  const embeddedPng = renderTextPng("CHART", 4);
  const docxPath = path.join(dir, "lecture.docx");
  await fs.writeFile(
    docxPath,
    buildDocx({
      paragraphs: ["REAL DOCX BODY PARAGRAPH", "WIRESHARK COLUMN ANALYSIS"],
      images: [{ data: embeddedPng, name: "image1.png" }]
    })
  );

  const parser = makeParser(fake);
  const result = await parser.parseAndExtract(docxPath, "lecture.docx");

  assert.equal(result.status, "parsed");
  assert.equal(result.format, "docx");
  assert.ok(result.rawContentSummary.includes("REAL DOCX BODY PARAGRAPH"));
  assert.ok(result.rawContentSummary.includes("WIRESHARK COLUMN ANALYSIS"));

  // 内嵌图片资产被抽出 → 请求走视觉模型，且图片字节 == 我们嵌进 DOCX 的 PNG 字节
  assert.deepEqual(result.embeddedImages, { total: 1, inlined: 1, skipped: 0 });
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].body.model, VISION_MODEL, "含内嵌图片的文档必须走视觉模型");

  const images = userImages(fake.requests[0].body);
  assert.equal(images.length, 1);
  assert.ok(images[0].startsWith("data:image/png;base64,"));
  const decoded = Buffer.from(images[0].split(",")[1], "base64");
  assert.ok(decoded.equals(embeddedPng), "内联的内嵌图片字节必须与文档里的资产一致");

  // 正文与图片同处一条多模态消息（真正的图文关联）
  assert.ok(userText(fake.requests[0].body).includes("REAL DOCX BODY PARAGRAPH"));
});

test("真实解析 - XLSX / CSV：表格类课件也走真解析（内容与输入一致）", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const dir = await makeTempDir(t);

  const xlsxPath = path.join(dir, "ports.xlsx");
  await fs.writeFile(
    xlsxPath,
    buildXlsx({ rows: [["HOST", "PORT"], ["server-alpha", "8080"]] })
  );
  const csvPath = path.join(dir, "points.csv");
  await fs.writeFile(csvPath, "checkpoint,score\nSYN,10\nRST,20\n");

  const parser = makeParser(fake);

  const xlsx = await parser.parseAndExtract(xlsxPath, "ports.xlsx");
  assert.equal(xlsx.status, "parsed");
  assert.equal(xlsx.format, "xlsx");
  assert.ok(xlsx.rawContentSummary.includes("server-alpha"), "必须解析出单元格真实内容");

  const csv = await parser.parseAndExtract(csvPath, "points.csv");
  assert.equal(csv.status, "parsed");
  assert.equal(csv.format, "csv");
  assert.ok(csv.rawContentSummary.includes("checkpoint"));
  assert.ok(csv.rawContentSummary.includes("SYN"));

  // CSV 没有签名，靠扩展名判定，必须也是真解析出来的表格
  assert.ok(userText(fake.requests[1].body).includes("SYN"));
});

test("内嵌图片上限保护：超过张数/单张体积的图片被跳过并计数，其余正常内联", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const dir = await makeTempDir(t);

  // 5 张小图 + 1 张 3MB 大图（超过单张上限）
  const smalls = [1, 2, 3, 4, 5].map((n) => ({
    data: renderTextPng(`IMG${n}`, 3),
    name: `image${n}.png`
  }));
  const oversized = { data: buildPaddedPng(3 * 1024 * 1024), name: "image6.png" };

  const docxPath = path.join(dir, "heavy-slides.docx");
  await fs.writeFile(docxPath, buildDocx({ paragraphs: ["HEAVY SLIDE DECK"], images: [...smalls, oversized] }));

  const parser = makeParser(fake);
  const result = await parser.parseAndExtract(docxPath, "heavy-slides.docx");

  assert.equal(result.status, "parsed", "超限图片只跳过，不应让整条解析失败");
  assert.equal(result.embeddedImages.total, 6);
  assert.equal(result.embeddedImages.inlined, MAX_EMBEDDED_IMAGES, `最多内联 ${MAX_EMBEDDED_IMAGES} 张`);
  assert.equal(result.embeddedImages.skipped, 6 - MAX_EMBEDDED_IMAGES);

  const images = userImages(fake.requests[0].body);
  assert.equal(images.length, MAX_EMBEDDED_IMAGES);
  for (const uri of images) {
    const size = Buffer.from(uri.split(",")[1], "base64").length;
    assert.ok(size <= MAX_EMBEDDED_IMAGE_BYTES, `内联图片不得超过单张上限，收到 ${size} 字节`);
  }
  assert.ok(MAX_EMBEDDED_IMAGES <= 6, "上限应落在 4~6 张的建议区间内");
});

// ===========================================================================
// 3. 禁止静默失败：损坏 / 加密 / 不支持 / 不存在
// ===========================================================================

test("禁止静默失败 - 损坏 PDF：如实报 malformed，绝不返回假内容或伪装 parsed", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const dir = await makeTempDir(t);

  const brokenPath = path.join(dir, "broken.pdf");
  await fs.writeFile(brokenPath, buildCorruptPdf());

  const parser = makeParser(fake);
  const result = await parser.parseAndExtract(brokenPath, "broken.pdf");

  assert.equal(result.status, "failed", "损坏文件绝不能是 parsed");
  assert.equal(result.errorCode, "malformed");
  assert.match(result.error, /\[malformed\]/, "错误信息必须带上 anydoc 的 code 便于排查");
  assert.equal(result.knowledgePoints.length, 0);
  assert.equal(result.rawContentSummary, "");

  // 不得伪造知识点：损坏文件一次 LLM 都不该调用
  assert.equal(fake.requests.length, 0, "解析失败时不得调用 LLM 编造知识点");

  // 旧实现的假文字彻底不许出现
  assert.ok(!JSON.stringify(result).includes("Wireshark 抓包分析"));
  assert.ok(!JSON.stringify(result).includes("TCP 三次握手报文交互与 Flags 识别"));
});

test("禁止静默失败 - 加密 PDF：如实报 encrypted", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const dir = await makeTempDir(t);

  const encPath = path.join(dir, "secret.pdf");
  await fs.writeFile(encPath, buildMinimalPdf(["SECRET"], { encrypt: true }));

  const parser = makeParser(fake);
  const result = await parser.parseAndExtract(encPath, "secret.pdf");

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "encrypted");
  assert.match(result.error, /encrypted/);
  assert.equal(fake.requests.length, 0);
});

test("禁止静默失败 - 不支持的格式：如实报 unsupported（不再回落到占位正文）", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const dir = await makeTempDir(t);

  const weirdPath = path.join(dir, "handout.xyz");
  await fs.writeFile(weirdPath, "这只是一个无法识别的容器");

  const parser = makeParser(fake);
  const result = await parser.parseAndExtract(weirdPath, "handout.xyz");

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "unsupported");
  assert.equal(result.knowledgePoints.length, 0);
  assert.equal(fake.requests.length, 0);
  // 旧实现会把「【课件材料】xxx」喂给 LLM 并编出知识点
  assert.ok(!result.rawContentSummary.includes("【课件材料】"));
});

test("禁止静默失败 - 文件不存在：如实报 io", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const dir = await makeTempDir(t);

  const parser = makeParser(fake);
  const result = await parser.parseAndExtract(path.join(dir, "missing.pdf"), "missing.pdf");

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "io");
  assert.match(result.error, /\[io\]/);
  assert.equal(fake.requests.length, 0);
});

test("禁止静默失败 - 扫描件 PDF：如实报 needsOcr 并点出页码（不做假 OCR 文字）", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const dir = await makeTempDir(t);

  // 页面里没有任何可提取文字（扫描件/纯图片页）
  const scanPath = path.join(dir, "scan.pdf");
  await fs.writeFile(scanPath, buildMinimalPdf([" "]));

  const parser = makeParser(fake);
  const result = await parser.parseAndExtract(scanPath, "scan.pdf");

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "needsOcr");
  assert.match(result.error, /第 1 页/, "错误信息必须点出需要 OCR 的页码");
  assert.deepEqual(result.knowledgePoints, []);
  assert.equal(fake.requests.length, 0, "扫描件不得靠模型幻觉补出正文");
});

test("禁止静默失败 - txt 读取失败同样如实报错", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const dir = await makeTempDir(t);

  const parser = makeParser(fake);
  const result = await parser.parseAndExtract(path.join(dir, "nope.txt"), "nope.txt");

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "io");
  assert.equal(fake.requests.length, 0);
});

test("错误码契约：anydoc 的 code 原样透出，且错误信息可读", () => {
  // 全部 anydoc 错误码 + 引擎缺失，都必须原样保留（不吞成泛化错误）
  for (const code of [...ANYDOC_ERROR_CODES, "engineUnavailable"]) {
    const { errorCode, error } = describeParseError(Object.assign(new Error("boom"), { code }));
    assert.equal(errorCode, code);
    assert.match(error, new RegExp(`\\[${code}\\]`));
  }
  // 无 code 的异常也要有可读输出
  assert.equal(describeParseError(new Error("plain")).errorCode, "unknown");

  // needsOcr 需带上具体页码提示
  const needsOcr = Object.assign(new Error("page 3 of 9 needs OCR"), { code: "needsOcr", pages: [3], pageCount: 9 });
  assert.match(describeParseError(needsOcr).error, /第 3 页/);
});

// ===========================================================================
// 4. 图片路径不变（视觉模型）+ 引擎可用性
// ===========================================================================

test("图片课件路径不变：真实 PNG 仍走视觉模型并内联原图字节", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const dir = await makeTempDir(t);

  const png = renderTextPng("SLIDE", 6);
  const pngPath = path.join(dir, "slide.png");
  await fs.writeFile(pngPath, png);

  const parser = makeParser(fake);
  const result = await parser.parseAndExtract(pngPath, "slide.png");

  assert.equal(result.status, "parsed");
  assert.equal(result.ext, ".png");
  assert.equal(fake.requests[0].body.model, VISION_MODEL);
  const images = userImages(fake.requests[0].body);
  assert.equal(images.length, 1);
  assert.ok(Buffer.from(images[0].split(",")[1], "base64").equals(png));
});

test("引擎可用性：anydoc 可加载，且能给出当前平台的原生包名（缺包时报可读错误）", async () => {
  const anydoc = await loadAnydoc();
  assert.equal(typeof anydoc.toMarkdownBytes, "function");
  assert.equal(typeof anydoc.toDocument, "function");
  assert.equal(typeof anydoc.formatFromBytes, "function");

  const platformPackage = expectedAnydocPlatformPackage();
  assert.match(platformPackage, /@firecrawl\/anydoc|anydoc 未提供/);
  // 本机/服务器上真实装好的平台包名必须能被点出来
  if (process.platform === "win32" && process.arch === "x64") {
    assert.equal(platformPackage, "@firecrawl/anydoc-win32-x64-msvc");
  }
  if (process.platform === "linux" && process.arch === "x64") {
    assert.match(platformPackage, /anydoc-linux-x64-gnu/);
  }
});

// ===========================================================================
// 5. HTTP 上传链路：解析失败不得伪装成「就绪且带知识点」
// ===========================================================================

function makeHttpRequest(port, method, reqPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: reqPath, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("HTTP 上传：真实 DOCX 走真解析；损坏 PDF 明确回传 parseStatus=failed 且 material 不标 ready", async (t) => {
  const dir = await makeTempDir(t);
  const storage = new StorageService({ uploadDir: dir });
  const store = new DatabaseStore(":memory:");
  t.after(() => store.close());

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
  const port = server.address().port;

  // 1) 真实 DOCX（上传白名单内的格式）→ parsed
  const docxContent = buildDocx({ paragraphs: ["UPLOAD CHAIN REAL DOCX BODY"] });
  const okRes = await makeHttpRequest(
    port,
    "POST",
    "/api/learnbuddy/materials/upload",
    { "Content-Type": "application/json" },
    JSON.stringify({
      fileName: "handout.docx",
      courseId: "network",
      ownerId: "t-chen",
      encoding: "base64",
      content: docxContent.toString("base64")
    })
  );
  assert.equal(okRes.statusCode, 200);
  const okData = JSON.parse(okRes.body.toString("utf-8"));
  assert.equal(okData.parseStatus, "parsed");
  assert.equal(okData.material.status, "ready");
  assert.ok(okData.material.knowledge.length >= 1, "真解析成功的课件应带知识点");

  // 2) 损坏 PDF → 原件仍落盘可预览，但解析状态如实为 failed
  const broken = buildCorruptPdf();
  const badRes = await makeHttpRequest(
    port,
    "POST",
    "/api/learnbuddy/materials/upload",
    { "Content-Type": "application/json" },
    JSON.stringify({
      fileName: "broken.pdf",
      courseId: "network",
      ownerId: "t-chen",
      encoding: "base64",
      content: broken.toString("base64")
    })
  );
  assert.equal(badRes.statusCode, 200, "原件已安全落盘，上传本身不算失败");
  const badData = JSON.parse(badRes.body.toString("utf-8"));
  assert.equal(badData.parseStatus, "failed");
  assert.equal(badData.parseErrorCode, "malformed");
  assert.match(badData.parseError, /\[malformed\]/);
  assert.equal(badData.material.status, "pending", "解析失败的材料不得标记为 ready");
  assert.deepEqual(badData.material.knowledge, [], "不得写入伪造知识点");

  // 3) 损坏原件仍可在浏览器预览（真实字节完整）
  const viewRes = await makeHttpRequest(port, "GET", `/api/learnbuddy/files/${badData.file.id}/view`);
  assert.equal(viewRes.statusCode, 200);
  assert.deepEqual(viewRes.body, broken);
});
