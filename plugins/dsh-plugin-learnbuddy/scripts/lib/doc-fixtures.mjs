// 零依赖「真实文档」构造器（供测试与实盘验证脚本生成**内容确定**的课件文件）。
//
// 为什么手写而不引第三方库（与 png-text.mjs 同一纪律）：
//   1. 本插件刻意保持极小的运行时依赖面（anydoc 是唯一的生产依赖）；
//      测试若要 PDF/DOCX 生成器而引入 pdfkit / jszip，等于给测试加原生负担。
//   2. 测试的**关键证据**是「anydoc 解析出来的文字 == 我们写进去的文字」，
//      因此文件内容必须逐字节可预期，不能是某个库的私有输出。
//   3. Node 内置能力足够：PDF 是纯文本语法；DOCX 是 ZIP（node:zlib + CRC32），
//      本文件复用 png-text.mjs 里已验证的 crc32。
//
// 产物：
//   - buildMinimalPdf(text, options)  → 结构完整的单页 PDF（含 xref/trailer，可被真实解析器读取）
//   - buildDocx({ paragraphs, images }) → 结构完整的 WordprocessingML 包（可内嵌真实 PNG 资产）
//   - buildCorruptPdf()               → 头部合法但结构损坏的 PDF（用于「必须报错」的负例）
//   - buildEncryptedPdf()             → 带 /Encrypt 字典的加密 PDF

import { crc32 } from "./png-text.mjs";

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/** 转义 PDF 字面量字符串里的特殊字符 \ ( ) */
function escapePdfText(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** 把一页的文本行渲染成 PDF 内容流 */
function pageContentStream(rows) {
  const lines = ["BT", "/F1 16 Tf", "72 720 Td"];
  rows.forEach((row, index) => {
    const text = escapePdfText(row);
    if (index === 0) lines.push(`(${text}) Tj`);
    else lines.push("0 -28 Td", `(${text}) Tj`);
  });
  lines.push("ET");
  return `${lines.join("\n")}\n`;
}

/**
 * 构造结构完整的真实 PDF（含 xref 表与 trailer，可被真实解析器逐字读出）。
 *
 * 对象布局：1 Catalog / 2 Pages / 3 Font / 每页〔Page, Contents〕（从 4 开始两两一组）
 *
 * @param {string[][]} pages 每页的文本行
 * @param {{encrypt?: boolean}} [options] encrypt=true 时追加 /Encrypt 字典（构造加密样本）
 * @returns {Buffer}
 */
export function buildPdf(pages, options = {}) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new RangeError("buildPdf: 至少需要一页内容");
  }

  const objects = [];
  const pageNumbers = pages.map((_, index) => 4 + index * 2);

  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(
    `<< /Type /Pages /Kids [${pageNumbers.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>`
  );
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  pages.forEach((rows, index) => {
    const pageNumber = 4 + index * 2;
    const contentNumber = pageNumber + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNumber} 0 R >>`
    );
    const content = pageContentStream(rows);
    objects.push(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`);
  });

  // 仅声明「本文件被加密」；没有真实 RC4/AES 密钥材料，足以让解析器判定为 encrypted。
  const encryptObjectNumber = objects.length + 1;
  if (options.encrypt) {
    objects.push("<< /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -1 >>");
  }

  const header = "%PDF-1.4\n";
  const chunks = [Buffer.from(header, "latin1")];
  const offsets = [0];
  let cursor = Buffer.byteLength(header, "latin1");

  objects.forEach((body, index) => {
    const serialized = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "latin1");
    offsets.push(cursor);
    chunks.push(serialized);
    cursor += serialized.length;
  });

  const xrefOffset = cursor;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailerRoot = options.encrypt
    ? `<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt ${encryptObjectNumber} 0 R >>`
    : `<< /Size ${objects.length + 1} /Root 1 0 R >>`;
  const trailer = `trailer\n${trailerRoot}\nstartxref\n${xrefOffset}\n%%EOF\n`;

  chunks.push(Buffer.from(xref + trailer, "latin1"));
  return Buffer.concat(chunks);
}

/**
 * 构造单页真实 PDF：页面上用 Helvetica 画出若干行文本。
 * @param {string|string[]} lines
 * @param {{encrypt?: boolean}} [options]
 * @returns {Buffer}
 */
export function buildMinimalPdf(lines, options = {}) {
  const rows = Array.isArray(lines) ? lines : [lines];
  return buildPdf([rows], options);
}

/** 头部是 PDF 签名、其余全为垃圾字节的「损坏 PDF」——必须被解析器判定为失败 */
export function buildCorruptPdf() {
  const head = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog", "latin1");
  const junk = Buffer.alloc(2048);
  for (let i = 0; i < junk.length; i += 1) junk[i] = (i * 37 + 11) & 0xff;
  return Buffer.concat([head, junk]);
}

// ---------------------------------------------------------------------------
// DOCX (WordprocessingML package)
// ---------------------------------------------------------------------------

/** 把一个文件写进 ZIP（stored / method 0；不压缩，结构最简单且完全可预期） */
function storedZipEntry(entry) {
  const nameBytes = Buffer.from(entry.name, "utf8");
  const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header signature
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method = stored
  local.writeUInt16LE(0, 10); // mod time
  local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); // compressed size
  local.writeUInt32LE(data.length, 22); // uncompressed size
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28); // extra length

  return { nameBytes, data, crc, localHeader: local };
}

/**
 * 用 stored 方式打包 ZIP（OOXML 包容器）。
 * @param {Array<{name:string, data:Buffer|string}>} entries
 * @returns {Buffer}
 */
export function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const { nameBytes, data, crc, localHeader } = storedZipEntry(entry);
    parts.push(localHeader, nameBytes, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central directory signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(0, 10); // method
    cd.writeUInt16LE(0, 12); // mod time
    cd.writeUInt16LE(0x21, 14); // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // relative offset of local header
    central.push(Buffer.concat([cd, nameBytes]));

    offset += localHeader.length + nameBytes.length + data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk with cd
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...parts, centralBuffer, eocd]);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

function xmlEscape(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function paragraphXml(text) {
  return `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

/** 一张内嵌图片的 DrawingML 段落（rId 指向 word/_rels/document.xml.rels） */
function imageRunXml(relId, name) {
  return (
    `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="914400" cy="914400"/>` +
    `<wp:docPr id="1" name="${xmlEscape(name)}"/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="${xmlEscape(name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  );
}

/**
 * 构造真实 DOCX（WordprocessingML 包），可含内嵌 PNG 资产。
 *
 * @param {{paragraphs?: string[], images?: Array<{data: Buffer, name?: string}>}} [spec]
 * @returns {Buffer} 合法的 .docx 字节
 */
export function buildDocx(spec = {}) {
  const paragraphs = spec.paragraphs || ["Default paragraph"];
  const images = spec.images || [];

  const bodyParts = paragraphs.map(paragraphXml);
  images.forEach((image, index) => {
    bodyParts.push(imageRunXml(`rIdImg${index + 1}`, image.name || `image${index + 1}.png`));
  });

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document ${W_NS}><w:body>${bodyParts.join("")}<w:sectPr/></w:body></w:document>`;

  const documentRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    images
      .map(
        (image, index) =>
          `<Relationship Id="rIdImg${index + 1}" ` +
          `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ` +
          `Target="media/${image.name || `image${index + 1}.png`}"/>`
      )
      .join("") +
    `</Relationships>`;

  const entries = [
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "word/document.xml", data: documentXml },
    { name: "word/_rels/document.xml.rels", data: documentRels }
  ];
  images.forEach((image, index) => {
    entries.push({
      name: `word/media/${image.name || `image${index + 1}.png`}`,
      data: image.data
    });
  });

  return buildZip(entries);
}

/**
 * 构造真实 XLSX（SpreadsheetML 包），用于验证「表格类课件也走真解析」。
 * @param {{rows: string[][], sheetName?: string}} spec
 * @returns {Buffer}
 */
export function buildXlsx(spec) {
  const rows = spec.rows || [];
  const sheetName = spec.sheetName || "Sheet1";

  const sheetRows = rows
    .map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 1}">` +
        row
          .map(
            (cell, colIndex) =>
              `<c r="${String.fromCharCode(65 + colIndex)}${rowIndex + 1}" t="inlineStr">` +
              `<is><t xml:space="preserve">${xmlEscape(cell)}</t></is></c>`
          )
          .join("") +
        `</row>`
    )
    .join("");

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${sheetRows}</sheetData></worksheet>`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  return buildZip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "xl/workbook.xml", data: workbookXml },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    { name: "xl/worksheets/sheet1.xml", data: sheetXml }
  ]);
}

/** 生成一个「体积确定」的伪 PNG（仅用于体积上限测试，字节内容无意义） */
export function buildPaddedPng(sizeInBytes, seed = 7) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const filler = Buffer.alloc(Math.max(0, sizeInBytes - signature.length));
  for (let i = 0; i < filler.length; i += 1) filler[i] = (i * seed + 13) & 0xff;
  return Buffer.concat([signature, filler]);
}
