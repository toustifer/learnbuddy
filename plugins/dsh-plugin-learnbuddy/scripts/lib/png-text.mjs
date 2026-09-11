// 零依赖 PNG 文本渲染器（供 scripts/verify-live-llm.mjs 生成「内容确定」的验证图）。
//
// 为什么不用 canvas / sharp：
//   本插件刻意保持 **零运行时依赖**（package.json dependencies 为空），
//   实盘验证脚本也不应为了画一张图而引入原生依赖。
//   这里用 5x7 点阵字体 + node:zlib 手写 PNG 编码，Node 内置能力即可完成。
//
// 产物：灰度 8bit PNG（白底黑字），文字内容**完全确定**，
// 因此实盘脚本可以对「模型是否读出了该文字」做硬断言。
import zlib from "node:zlib";

/** 5x7 点阵字体（大写字母 + 数字 + '-'）；每字符 7 行，每行 5 位，'1' = 黑点 */
export const FONT = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  2: ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
  3: ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  4: ["00100", "01100", "10100", "11111", "00100", "00100", "00100"],
  5: ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  6: ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  9: ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"]
};

export const GLYPH_W = 5;
export const GLYPH_H = 7;

/** PNG 文件签名 */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 把一行文本渲染成灰度位图。
 * @param {string} text 仅支持 FONT 中的字符（小写会自动转大写）
 * @param {number} scale 放大倍数，默认 14 → 每个字符 70x98 像素
 * @returns {{width:number, height:number, grid:Uint8Array[]}} grid[y][x] = 0(黑) / 255(白)
 */
export function renderTextBitmap(text, scale = 14) {
  if (!Number.isInteger(scale) || scale < 1) throw new RangeError(`scale 必须是正整数，收到 ${scale}`);
  const chars = [...String(text).toUpperCase()];
  if (chars.length === 0) throw new RangeError("renderTextBitmap: text 不能为空");

  const margin = scale * 4;
  const letterSpacing = scale * 2;
  const glyphW = GLYPH_W * scale;

  const rowW = chars.length * glyphW + (chars.length - 1) * letterSpacing;
  const width = rowW + margin * 2;
  const height = GLYPH_H * scale + margin * 2;

  // 白底
  const grid = Array.from({ length: height }, () => new Uint8Array(width).fill(255));

  chars.forEach((ch, ci) => {
    const glyph = FONT[ch];
    if (!glyph) throw new Error(`renderTextBitmap: 字体缺少字符 "${ch}"`);
    const originX = margin + ci * (glyphW + letterSpacing);
    for (let gy = 0; gy < GLYPH_H; gy += 1) {
      for (let gx = 0; gx < GLYPH_W; gx += 1) {
        if (glyph[gy][gx] !== "1") continue;
        for (let sy = 0; sy < scale; sy += 1) {
          const y = margin + gy * scale + sy;
          for (let sx = 0; sx < scale; sx += 1) {
            grid[y][originX + gx * scale + sx] = 0;
          }
        }
      }
    }
  });

  return { width, height, grid };
}

/** CRC-32（PNG chunk 校验），查表实现 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 构造一个 PNG chunk（长度 + 类型 + 数据 + CRC） */
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * 把位图编码为真实 PNG Buffer（灰度 8bit，filter=None），只用 node:zlib。
 * @param {{width:number, height:number, grid:Uint8Array[]}} bitmap
 * @returns {Buffer}
 */
export function encodePng(bitmap) {
  const { width, height, grid } = bitmap;

  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0; // filter type: None
    Buffer.from(grid[y].buffer, grid[y].byteOffset, width).copy(raw, y * (width + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression method: deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace: none

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

/** 便捷方法：文本 → PNG Buffer */
export function renderTextPng(text, scale = 14) {
  return encodePng(renderTextBitmap(text, scale));
}

/**
 * 解回位图（仅供测试/自检使用；解析灰度 8bit、filter=None 的 PNG）。
 * @returns {{width:number, height:number, grid:Uint8Array[]}}
 */
export function decodeGrayscalePng(png) {
  if (!Buffer.isBuffer(png) || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("decodeGrayscalePng: PNG 签名不合法");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatParts = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idatParts.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length; // length(4) + type(4) + data + crc(4)
  }

  if (bitDepth !== 8 || colorType !== 0) {
    throw new Error(`decodeGrayscalePng: 仅支持灰度 8bit，收到 bitDepth=${bitDepth} colorType=${colorType}`);
  }

  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const stride = width + 1;
  const grid = [];
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * stride];
    if (filter !== 0) throw new Error(`decodeGrayscalePng: 仅支持 filter=0，收到 ${filter}`);
    grid.push(Uint8Array.from(raw.subarray(y * stride + 1, y * stride + 1 + width)));
  }

  return { width, height, grid };
}
