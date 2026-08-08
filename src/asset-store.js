// Tải và lưu ảnh/tệp Zalo về máy, lưu lại lâu dài.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL, fileURLToPath } from "node:url";

const ASSET_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
let ASSET_DIR = path.join(ASSET_ROOT, "assets");
const assetAls = new AsyncLocalStorage();

function setAssetDir(dir) {
  ASSET_DIR = path.resolve(dir);
  fs.mkdirSync(ASSET_DIR, { recursive: true });
}

function getAssetDir() {
  return assetAls.getStore()?.dir || ASSET_DIR;
}

/** Chạy fn với thư mục asset theo tenant (tránh đụng khi nhiều user). */
function runWithAssetDir(dir, fn) {
  const resolved = path.resolve(dir);
  fs.mkdirSync(resolved, { recursive: true });
  return assetAls.run({ dir: resolved }, fn);
}

function ensureDirs(dir = getAssetDir()) {
  fs.mkdirSync(dir, { recursive: true });
}

function assetNameFor(ext) {
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext || ""}`;
}

// Chuyển http/https sang file:// cho các hàm tải nội bộ.
function toFetchable(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

// Lưu nội dung nhị phân đã có sẵn (ví dụ từ zca-js đã tải).
function saveRaw({ ext = "", buffer, webUrl = "", kind = "image", threadId = "", dir } = {}) {
  const baseDir = dir ? path.resolve(dir) : getAssetDir();
  ensureDirs(baseDir);
  if (!buffer || (Buffer.isBuffer(buffer) && buffer.length === 0)) return null;
  const name = assetNameFor(ext || ".bin");
  const filePath = path.join(baseDir, name);
  fs.writeFileSync(filePath, buffer);
  const stat = fs.statSync(filePath);
  return {
    name,
    filePath,
    size: stat.size,
    mime: ext ? mimeFromExt(ext) : "",
    webUrl: webUrl || "",
    hash: crypto.createHash("sha256").update(buffer).digest("hex"),
    kind,
    threadId: threadId || "",
  };
}

function mimeFromExt(ext) {
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
  };
  return map[(ext || "").toLowerCase()] || "application/octet-stream";
}

function extFromUrl(url) {
  try {
    return path.extname(new URL(url).pathname).toLowerCase() || "";
  } catch {
    return "";
  }
}

function assetUrlToFile(record) {
  if (!record || !record.filePath) return "";
  try {
    return pathToFileURL(record.filePath).href;
  } catch {
    return "";
  }
}

function assetFilePathFromUrl(fileUrl) {
  if (!fileUrl) return null;
  try {
    const u = new URL(fileUrl);
    if (u.protocol === "file:") {
      return decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, "$1");
    }
  } catch {}
  return null;
}

export {
  ensureDirs,
  saveRaw,
  mimeFromExt,
  extFromUrl,
  toFetchable,
  assetUrlToFile,
  assetFilePathFromUrl,
  setAssetDir,
  getAssetDir,
  runWithAssetDir,
};

