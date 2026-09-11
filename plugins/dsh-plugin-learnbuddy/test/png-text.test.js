/**
 * 实盘验证用「零依赖 PNG 文本渲染器」单元测试
 * (scripts/lib/png-text.mjs — task-10)
 *
 * 为什么需要这层测试：
 * `scripts/verify-live-llm.mjs` 的图片理解断言是「模型必须读出图中文字」，
 * 这个断言只有在**图确实是合法 PNG 且字形正确**时才成立。
 * 实盘脚本由 Leader 用真实密钥执行，跑一次代价高，所以这里用离线测试
 * 把「PNG 编码正确性 + 字形渲染正确性」钉死，避免实盘时才发现图画错了。
 *
 * 全部离线、零外部请求、零依赖。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  FONT,
  GLYPH_H,
  GLYPH_W,
  PNG_SIGNATURE,
  crc32,
  decodeGrayscalePng,
  encodePng,
  renderTextBitmap,
  renderTextPng
} from "../scripts/lib/png-text.mjs";

/** 读 PNG chunk 列表（用于结构断言） */
function readChunks(png) {
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    const crc = png.readUInt32BE(offset + 8 + length);
    chunks.push({ type, length, data, crc, typeAndData: png.subarray(offset + 4, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}

test("FONT：每个字形都是 7 行 x 5 列且只含 0/1", () => {
  for (const [ch, glyph] of Object.entries(FONT)) {
    assert.equal(glyph.length, GLYPH_H, `字符 "${ch}" 应有 ${GLYPH_H} 行`);
    for (const row of glyph) {
      assert.equal(row.length, GLYPH_W, `字符 "${ch}" 每行应为 ${GLYPH_W} 列`);
      assert.match(row, /^[01]+$/, `字符 "${ch}" 只允许 0/1`);
    }
  }
});

test("FONT：覆盖实盘脚本用到的字符集（DEEPSEEK / PONG-7391 等）", () => {
  for (const ch of "DEEPSEEKPONGBUDDY1234567890- ") {
    assert.ok(FONT[ch], `FONT 缺少实盘需要用到的字符 "${ch}"`);
  }
});

test("renderTextBitmap：尺寸随文本长度与缩放倍数增长", () => {
  const one = renderTextBitmap("A", 10);
  const two = renderTextBitmap("AA", 10);
  const bigger = renderTextBitmap("A", 20);

  // width = margin*2 + n*glyphW + (n-1)*letterSpacing ; margin=4*scale, spacing=2*scale, glyphW=5*scale
  assert.equal(one.width, 4 * 10 * 2 + 5 * 10);
  assert.equal(one.height, 7 * 10 + 4 * 10 * 2);
  assert.ok(two.width > one.width, "两个字符应比一个字符宽");
  assert.equal(two.height, one.height, "单行文本高度与字符数无关");
  assert.ok(bigger.width > one.width && bigger.height > one.height);
});

test("renderTextBitmap：小写自动转大写，且每个像素只有黑(0)/白(255)", () => {
  const lower = renderTextBitmap("deepseek", 4);
  const upper = renderTextBitmap("DEEPSEEK", 4);
  assert.deepEqual(
    lower.grid.map((r) => Array.from(r)),
    upper.grid.map((r) => Array.from(r)),
    "小写与大写应渲染出完全相同的位图"
  );
  for (const row of lower.grid) {
    for (const px of row) assert.ok(px === 0 || px === 255, `灰度值只能是 0 或 255，收到 ${px}`);
  }
});

test("renderTextBitmap：非法输入（空文本 / 缺字符 / 非法 scale）抛错", () => {
  assert.throws(() => renderTextBitmap(""), /不能为空/);
  assert.throws(() => renderTextBitmap("AB€"), /缺少字符/);
  assert.throws(() => renderTextBitmap("A", 0), /正整数/);
  assert.throws(() => renderTextBitmap("A", -3), /正整数/);
  assert.throws(() => renderTextBitmap("A", 1.5), /正整数/);
});

test("renderTextBitmap：字形在边距内，且确实画出了黑点", () => {
  const bmp = renderTextBitmap("H", 6);
  const margin = 6 * 4;

  let blackCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < bmp.height; y += 1) {
    for (let x = 0; x < bmp.width; x += 1) {
      if (bmp.grid[y][x] === 0) {
        blackCount += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  assert.ok(blackCount > 0, "必须画出黑点");
  assert.ok(minX >= margin && minY >= margin, "字形不得越过左边距/上边距");
  assert.ok(maxX < bmp.width - margin && maxY < bmp.height - margin, "字形不得越过右边距/下边距");
});

test("renderTextBitmap：'H' 的中间横杠存在（验证字形结构而非只有外框）", () => {
  const scale = 4;
  const bmp = renderTextBitmap("H", scale);
  const margin = scale * 4;
  // 'H' 第 4 行（index 3）是 "11111" —— 全横杠
  const midRow = margin + 3 * scale + Math.floor(scale / 2);
  const middleX = margin + 2 * scale + Math.floor(scale / 2); // 横杠中间
  assert.equal(bmp.grid[midRow][middleX], 0, "H 中间横杠应为黑");

  // 对照：'H' 第 1 行（index 0）是 "10001" —— 只有左右两竖
  const topRow = margin + Math.floor(scale / 2);
  assert.equal(bmp.grid[topRow][middleX], 255, "H 顶部中间应为白");
});

test("encodePng：产出合法 PNG 结构（签名 + IHDR/IDAT/IEND + CRC 正确）", () => {
  const png = encodePng(renderTextBitmap("A", 4));

  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), "必须以 PNG 签名开头（魔数 PNG）");

  const chunks = readChunks(png);
  assert.deepEqual(
    chunks.map((c) => c.type),
    ["IHDR", "IDAT", "IEND"],
    "chunk 顺序必须是 IHDR → IDAT → IEND"
  );

  for (const c of chunks) {
    assert.equal(c.crc, crc32(c.typeAndData), `${c.type} 的 CRC 必须正确`);
  }

  const ihdr = chunks[0].data;
  assert.equal(ihdr.length, 13);
  assert.equal(ihdr.readUInt32BE(0), 4 * 4 * 2 + 5 * 4, "IHDR 宽度正确");
  assert.equal(ihdr[8], 8, "bit depth = 8");
  assert.equal(ihdr[9], 0, "color type = 灰度");
  assert.equal(ihdr[12], 0, "interlace = none");
});

test("CRLF 往返：encodePng → decodeGrayscalePng 得到完全相同的位图", () => {
  for (const text of ["DEEPSEEK", "PONG-7391", "A", "TCP ACK"]) {
    const bitmap = renderTextBitmap(text, 5);
    const decoded = decodeGrayscalePng(encodePng(bitmap));

    assert.equal(decoded.width, bitmap.width, `"${text}" 宽度应一致`);
    assert.equal(decoded.height, bitmap.height, `"${text}" 高度应一致`);
    assert.deepEqual(
      decoded.grid.map((r) => Array.from(r)),
      bitmap.grid.map((r) => Array.from(r)),
      `"${text}" 往返后位图必须逐像素一致`
    );
  }
});

test("decodeGrayscalePng：拒绝非法输入", () => {
  assert.throws(() => decodeGrayscalePng(Buffer.from("not a png")), /签名不合法/);
  assert.throws(() => decodeGrayscalePng(null), /签名不合法/);
  assert.throws(() => decodeGrayscalePng("x"), /签名不合法/);
});

test("renderTextPng：实盘脚本实际使用的入口，产出可被解码的 PNG", () => {
  const png = renderTextPng("DEEPSEEK", 14);
  assert.ok(Buffer.isBuffer(png));
  assert.ok(png.length > 100, "PNG 应有实际内容");

  const decoded = decodeGrayscalePng(png);
  assert.equal(decoded.width, 868, "与实盘脚本自检时的观测尺寸一致");
  assert.equal(decoded.height, 210);
  // 确认确实有黑色字形像素（不是一张纯白空图）
  const black = decoded.grid.reduce((acc, row) => acc + row.filter((v) => v === 0).length, 0);
  assert.ok(black > 1000, `应有足量黑色字形像素，实际 ${black}`);
});

test("确定性：同样输入两次渲染出的 PNG 字节完全一致", () => {
  const a = renderTextPng("LEARNBUDDY", 8);
  const b = renderTextPng("LEARNBUDDY", 8);
  assert.ok(a.equals(b), "渲染必须确定性（实盘断言依赖固定的图内容）");
});
