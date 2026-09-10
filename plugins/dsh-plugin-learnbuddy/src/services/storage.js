/**
 * LearnBuddy File Storage Service
 * 
 * 核心职责：
 * 1. 文件物理落盘至 uploads 目录
 * 2. 多格式白名单校验 (.pdf, .ppt, .pptx, .docx, .png, .jpg, .jpeg)
 * 3. 单文件大小限制校验 (默认 20MB)
 * 4. 计算 SHA-256 哈希去重与完整性校验，安全生成文件名彻底杜绝路径穿越
 * 5. 提供 getFilePath(fileId)、saveFile(buffer/stream, originalName)、deleteFile(fileId)
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ALLOWED_EXTENSIONS = new Set([
  ".pdf",
  ".ppt",
  ".pptx",
  ".docx",
  ".png",
  ".jpg",
  ".jpeg"
]);

export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

export const MIME_TYPES = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};

export function formatFileSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${parseFloat(val.toFixed(1))} ${sizes[i]}`;
}

export function getMimeType(filenameOrExt) {
  if (!filenameOrExt) return "application/octet-stream";
  const ext = (path.extname(filenameOrExt) || filenameOrExt).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

export class StorageService {
  /**
   * @param {object} [options]
   * @param {string} [options.uploadDir] 文件存储目录
   * @param {number} [options.maxSize] 最大文件限制 (字节)
   * @param {Set<string>} [options.allowedExtensions] 允许的扩展名集合
   */
  constructor(options = {}) {
    this.uploadDir = options.uploadDir || path.resolve(__dirname, "../../uploads");
    this.maxSize = options.maxSize || MAX_FILE_SIZE;
    this.allowedExtensions = options.allowedExtensions || ALLOWED_EXTENSIONS;

    // 确保上传物理目录存在
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }

    // 元数据存储文件（可选索引）
    this.metaFilePath = options.metaFilePath || path.join(this.uploadDir, ".metadata.json");
    this.meta = this._loadMeta();
  }

  _loadMeta() {
    try {
      if (fs.existsSync(this.metaFilePath)) {
        const raw = fs.readFileSync(this.metaFilePath, "utf-8");
        return JSON.parse(raw);
      }
    } catch {
      // 忽略损坏的元数据缓存，重新构建
    }
    return {};
  }

  _saveMeta() {
    try {
      fs.writeFileSync(this.metaFilePath, JSON.stringify(this.meta, null, 2), "utf-8");
    } catch {
      // 忽略元数据保存异常
    }
  }

  /**
   * 校验文件扩展名白名单
   * @param {string} originalName 原始文件名
   * @returns {string} 规范化小写扩展名 (包含前导点，如 ".pdf")
   */
  validateExtension(originalName) {
    if (!originalName || typeof originalName !== "string") {
      throw new Error("文件名不能为空。");
    }
    const ext = path.extname(originalName).toLowerCase();
    if (!ext || !this.allowedExtensions.has(ext)) {
      throw new Error(
        `不支持的文件格式: "${ext || '无后缀'}"。仅支持白名单格式: ${Array.from(this.allowedExtensions).join(", ")}`
      );
    }
    return ext;
  }

  /**
   * 校验文件大小限制
   * @param {number} size 字节大小
   */
  validateSize(size) {
    if (typeof size !== "number" || size < 0) {
      throw new Error("文件大小异常。");
    }
    if (size > this.maxSize) {
      throw new Error(
        `文件大小 (${formatFileSize(size)}) 超过单文件限制 (${formatFileSize(this.maxSize)})。`
      );
    }
  }

  /**
   * 计算 Buffer 的 SHA-256 哈希值
   * @param {Buffer} buffer 
   * @returns {string} 64 位十六进制哈希字符串
   */
  computeHash(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
  }

  /**
   * 保存文件到物理存储，支持 Buffer 或 Stream
   * @param {Buffer | import('node:stream').Readable | string} bufferOrStream 
   * @param {string} originalName 原始文件名
   * @param {object} [options] 额外自定义元数据
   * @returns {Promise<{
   *   fileId: string,
   *   hash: string,
   *   originalName: string,
   *   ext: string,
   *   size: number,
   *   sizeFormatted: string,
   *   mimeType: string,
   *   filePath: string
   * }>}
   */
  async saveFile(bufferOrStream, originalName, options = {}) {
    // 1. 扩展名白名单校验
    const ext = this.validateExtension(originalName);

    // 2. 清理文件名并防路径穿越
    const safeOriginalName = path.basename(originalName);

    // 3. 将 Stream 或 Buffer 统一读取为 Buffer 并做大小限制校验
    let buffer;
    if (Buffer.isBuffer(bufferOrStream)) {
      buffer = bufferOrStream;
      this.validateSize(buffer.length);
    } else if (typeof bufferOrStream === "string") {
      buffer = Buffer.from(bufferOrStream);
      this.validateSize(buffer.length);
    } else if (bufferOrStream && typeof bufferOrStream[Symbol.asyncIterator] === "function") {
      // Readable Stream
      const chunks = [];
      let totalSize = 0;
      for await (const chunk of bufferOrStream) {
        totalSize += chunk.length;
        if (totalSize > this.maxSize) {
          throw new Error(
            `文件流大小超过单文件限制 (${formatFileSize(this.maxSize)})。`
          );
        }
        chunks.push(chunk);
      }
      buffer = Buffer.concat(chunks);
      this.validateSize(buffer.length);
    } else {
      throw new Error("无效的文件数据输入：必须是 Buffer、Stream 或文本内容。");
    }

    // 4. 计算 SHA-256 哈希
    const hash = this.computeHash(buffer);

    // 5. 生成安全物理存储文件名（由哈希+白名单扩展名构成，完全杜绝路径穿越与恶意命名）
    const fileId = `${hash}${ext}`;
    const targetFilePath = path.join(this.uploadDir, fileId);

    // 6. 去重与写入：如果同名哈希文件已在物理盘上存在，免去重复磁盘写入
    if (!fs.existsSync(targetFilePath)) {
      await fsp.writeFile(targetFilePath, buffer);
    }

    // 7. 维护元数据索引
    const fileInfo = {
      fileId,
      hash,
      originalName: safeOriginalName,
      ext,
      size: buffer.length,
      sizeFormatted: formatFileSize(buffer.length),
      mimeType: getMimeType(ext),
      filePath: targetFilePath,
      uploadedAt: new Date().toISOString(),
      ...options
    };

    this.meta[fileId] = fileInfo;
    this.meta[hash] = fileInfo; // 支持以单纯 hash 检索
    this._saveMeta();

    return fileInfo;
  }

  /**
   * 安全获取文件物理路径，严密防范路径穿越
   * @param {string} fileId 文件 ID 或哈希
   * @returns {string | null} 物理存在的文件绝对路径，或 null
   */
  getFilePath(fileId) {
    if (!fileId || typeof fileId !== "string") {
      return null;
    }

    // 严格安全审查：拒绝一切包含 ..、路径分隔符 / 或 \ 的请求
    if (fileId.includes("..") || fileId.includes("/") || fileId.includes("\\")) {
      return null;
    }

    const cleanId = path.basename(fileId);
    if (cleanId !== fileId) {
      return null;
    }

    // 1. 尝试直接路径比对
    const directPath = path.join(this.uploadDir, cleanId);
    if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
      return directPath;
    }

    // 2. 检查索引映射
    if (this.meta[cleanId] && this.meta[cleanId].fileId) {
      const mappedPath = path.join(this.uploadDir, this.meta[cleanId].fileId);
      if (fs.existsSync(mappedPath) && fs.statSync(mappedPath).isFile()) {
        return mappedPath;
      }
    }

    // 3. 检查是否有该哈希为前缀的文件（例如传入不带扩展名的 64 位 hash）
    try {
      const files = fs.readdirSync(this.uploadDir);
      const matched = files.find((f) => f.startsWith(`${cleanId}.`));
      if (matched) {
        const fullMatchedPath = path.join(this.uploadDir, matched);
        if (fs.existsSync(fullMatchedPath) && fs.statSync(fullMatchedPath).isFile()) {
          return fullMatchedPath;
        }
      }
    } catch {
      // 忽略读取目录异常
    }

    return null;
  }

  /**
   * 删除指定物理文件
   * @param {string} fileId 文件 ID
   * @returns {Promise<boolean>} 是否删除成功
   */
  async deleteFile(fileId) {
    const filePath = this.getFilePath(fileId);
    if (!filePath) {
      return false;
    }

    try {
      await fsp.unlink(filePath);
      const baseName = path.basename(filePath);
      delete this.meta[baseName];
      if (fileId !== baseName) {
        delete this.meta[fileId];
      }
      this._saveMeta();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取文件元数据
   * @param {string} fileId 
   */
  getFileMetadata(fileId) {
    if (!fileId) return null;
    const cleanId = path.basename(fileId);
    if (this.meta[cleanId]) return this.meta[cleanId];

    const filePath = this.getFilePath(fileId);
    if (!filePath) return null;

    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    return {
      fileId: path.basename(filePath),
      filePath,
      size: stat.size,
      sizeFormatted: formatFileSize(stat.size),
      ext,
      mimeType: getMimeType(ext)
    };
  }
}

export const defaultStorage = new StorageService();
export default StorageService;
