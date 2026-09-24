import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseStore } from "../src/db/store.js";
import { StorageService } from "../src/services/storage.js";
import { registerLearnBuddyRoutes } from "../src/routes/api.js";
import { tokenFor } from "./helpers/auth.js";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "learnbuddy-idempotency-"));
}

function makeRequest(port, method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: headers || {}
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: raw,
            text: raw.toString("utf-8"),
            json: () => {
              try {
                return JSON.parse(raw.toString("utf-8"));
              } catch (e) {
                return null;
              }
            }
          });
        });
      }
    );
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

test("课件上传幂等性 (Idempotency) - 覆盖 4 种边界场景与离线验证", async (t) => {
  const tmpDir = createTempDir();
  const storage = new StorageService({ uploadDir: tmpDir });
  const store = new DatabaseStore(":memory:");

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

  t.after(async () => {
    await new Promise((resolve) => testServer.close(resolve));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // 获取陈老师 (t-chen) 与林老师 (t-lin) 的访问令牌
  const chenToken = await tokenFor(port, { username: "teacher.chen", password: "123" });
  assert.ok(chenToken, "陈老师登录必须成功并取得令牌");
  const linToken = await tokenFor(port, { username: "teacher.lin", password: "123" });
  assert.ok(linToken, "林老师登录必须成功并取得令牌");

  // 测试文件 A
  const fileAContent = Buffer.from("%PDF-1.4\n% Idempotency Test Material A Content\n%%EOF\n");
  const fileABase64 = fileAContent.toString("base64");

  // 测试文件 B（内容不同，blobId 不同）
  const fileBContent = Buffer.from("%PDF-1.4\n% Idempotency Test Material B Different Content\n%%EOF\n");
  const fileBBase64 = fileBContent.toString("base64");

  let firstMaterialId = null;
  let fileABlobId = null;

  await t.test("① 首次上传成功新建", async () => {
    const res = await makeRequest(
      port,
      "POST",
      "/api/learnbuddy/materials/upload",
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${chenToken}`
      },
      JSON.stringify({
        fileName: "网络体系结构-讲义.pdf",
        courseId: "network",
        visibility: "course",
        encoding: "base64",
        content: fileABase64
      })
    );

    assert.equal(res.statusCode, 200, `首次上传应返回 200: ${res.text}`);
    const data = res.json();
    assert.equal(data.ok, true);
    assert.equal(data.duplicate, false, "首次上传 duplicate 应为 false");
    assert.ok(data.material, "应当返回 material 对象");
    assert.ok(data.material.id, "material 必须有 id");
    assert.equal(data.material.courseId, "network");
    assert.equal(data.material.ownerId, "t-chen");
    assert.equal(data.material.title, "网络体系结构-讲义.pdf");
    assert.ok(data.file && data.file.id, "必须包含 file 信息");

    firstMaterialId = data.material.id;
    fileABlobId = data.file.id;

    // 验证数据库已落库
    const fromDb = store.getMaterialById(firstMaterialId);
    assert.ok(fromDb, "数据库必须已存入该记录");
    assert.equal(fromDb.id, firstMaterialId);
    assert.equal(fromDb.blobId, fileABlobId);
  });

  await t.test("② 同课同人同文件第二次不落库且返回已有 id", async () => {
    // 记录上传前数据库中的 materials 记录数量
    const allMaterialsBefore = store.listMaterials();
    const countBefore = allMaterialsBefore.filter(
      (m) => m.courseId === "network" && m.ownerId === "t-chen" && m.blobId === fileABlobId
    ).length;
    assert.equal(countBefore, 1, "上传前应只有 1 条记录");

    const res = await makeRequest(
      port,
      "POST",
      "/api/learnbuddy/materials/upload",
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${chenToken}`
      },
      JSON.stringify({
        fileName: "网络体系结构-讲义-再次上传.pdf",
        courseId: "network",
        visibility: "course",
        encoding: "base64",
        content: fileABase64
      })
    );

    assert.equal(res.statusCode, 200, `重复上传应返回 200: ${res.text}`);
    const data = res.json();
    assert.equal(data.ok, true);
    assert.equal(data.duplicate, true, "重复上传必须明确标记 duplicate: true");
    assert.ok(
      typeof data.message === "string" && data.message.includes("未重复添加"),
      `应当返回清楚的提示文案，当前: ${data.message}`
    );
    assert.equal(data.material.id, firstMaterialId, "返回的 material id 必须与已有的完全一致");

    // 验证数据库中记录数量未增加，绝不落库新记录
    const allMaterialsAfter = store.listMaterials();
    const countAfter = allMaterialsAfter.filter(
      (m) => m.courseId === "network" && m.ownerId === "t-chen" && m.blobId === fileABlobId
    ).length;
    assert.equal(countAfter, 1, "重复上传后数据库记录数不得增加，依然为 1");
    assert.equal(allMaterialsAfter.length, allMaterialsBefore.length, "资料总记录数不得增加");
  });

  await t.test("③ 不同课程同文件正常新建", async () => {
    const res = await makeRequest(
      port,
      "POST",
      "/api/learnbuddy/materials/upload",
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${chenToken}`
      },
      JSON.stringify({
        fileName: "网络体系结构-操作系统课程引用.pdf",
        courseId: "os", // 不同课程
        visibility: "course",
        encoding: "base64",
        content: fileABase64 // 同一文件
      })
    );

    assert.equal(res.statusCode, 200, `不同课程上传应返回 200: ${res.text}`);
    const data = res.json();
    assert.equal(data.ok, true);
    assert.equal(data.duplicate, false, "不同课程同文件应正常新建，duplicate 为 false");
    assert.notEqual(data.material.id, firstMaterialId, "新课程应生成全新的 material id");
    assert.equal(data.material.courseId, "os");
    assert.equal(data.material.ownerId, "t-chen");
    assert.equal(data.file.id, fileABlobId, "底层 blobId 寻址相同");

    // 验证数据库确实新建了一条记录
    const fromDb = store.getMaterialById(data.material.id);
    assert.ok(fromDb, "数据库中必须新建了该课程的资料记录");
    assert.equal(fromDb.courseId, "os");
    assert.equal(fromDb.ownerId, "t-chen");
    assert.equal(fromDb.blobId, fileABlobId);
  });

  await t.test("④ 不同人同文件正常新建", async () => {
    const res = await makeRequest(
      port,
      "POST",
      "/api/learnbuddy/materials/upload",
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${linToken}` // 林老师身份
      },
      JSON.stringify({
        fileName: "网络体系结构-林老师讲义.pdf",
        courseId: "network", // 同一课程
        visibility: "course",
        encoding: "base64",
        content: fileABase64 // 同一文件
      })
    );

    assert.equal(res.statusCode, 200, `不同人上传应返回 200: ${res.text}`);
    const data = res.json();
    assert.equal(data.ok, true);
    assert.equal(data.duplicate, false, "不同人同文件应正常新建，duplicate 为 false");
    assert.notEqual(data.material.id, firstMaterialId, "不同人上传必须生成全新的 material id");
    assert.equal(data.material.courseId, "network");
    assert.equal(data.material.ownerId, "t-lin");
    assert.equal(data.file.id, fileABlobId);

    // 验证数据库确实新建了一条记录
    const fromDb = store.getMaterialById(data.material.id);
    assert.ok(fromDb, "数据库中必须新建了该所有者的资料记录");
    assert.equal(fromDb.courseId, "network");
    assert.equal(fromDb.ownerId, "t-lin");
    assert.equal(fromDb.blobId, fileABlobId);
  });

  await t.test("⑤ 补充场景：同课同人不同文件 (不同 blobId) 正常新建", async () => {
    const res = await makeRequest(
      port,
      "POST",
      "/api/learnbuddy/materials/upload",
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${chenToken}`
      },
      JSON.stringify({
        fileName: "新实验-不同内容.pdf",
        courseId: "network",
        visibility: "course",
        encoding: "base64",
        content: fileBBase64 // 不同文件内容
      })
    );

    assert.equal(res.statusCode, 200);
    const data = res.json();
    assert.equal(data.ok, true);
    assert.equal(data.duplicate, false, "不同内容文件正常新建，duplicate 为 false");
    assert.notEqual(data.material.id, firstMaterialId);
    assert.notEqual(data.file.id, fileABlobId, "不同内容的 blobId 应不同");

    const fromDb = store.getMaterialById(data.material.id);
    assert.ok(fromDb);
    assert.equal(fromDb.blobId, data.file.id);
  });

  await t.test("⑥ 补充场景：multipart/form-data 表单上传同文件同样幂等", async () => {
    const boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW";
    const bodyParts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="courseId"\r\n\r\nnetwork\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="visibility"\r\n\r\ncourse\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="讲义-multipart.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      fileAContent,
      `\r\n--${boundary}--\r\n`
    ];
    const multipartBody = Buffer.concat(bodyParts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));

    const res = await makeRequest(
      port,
      "POST",
      "/api/learnbuddy/materials/upload",
      {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        Authorization: `Bearer ${chenToken}`
      },
      multipartBody
    );

    assert.equal(res.statusCode, 200);
    const data = res.json();
    assert.equal(data.ok, true);
    assert.equal(data.duplicate, true, "multipart 上传相同文件必须同样触发幂等去重");
    assert.equal(data.material.id, firstMaterialId);
  });
});
