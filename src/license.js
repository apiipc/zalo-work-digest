import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getConfigDir } from "./app-paths.js";

/** Đổi secret này trước khi phát hành rộng — và dùng cùng secret khi chạy generate-license / Vercel. */
const DEFAULT_SECRET = "zalo-work-digest-license-v1-change-me-before-release";
const DEFAULT_SERVER = "https://zalo-work-digest.vercel.app";

export function licenseSecret() {
  return String(process.env.LICENSE_SECRET || DEFAULT_SECRET);
}

export function licenseServerUrl() {
  const raw = process.env.LICENSE_SERVER_URL;
  if (raw === "0" || raw === "off" || raw === "false") return "";
  return String(raw || DEFAULT_SERVER).replace(/\/$/, "");
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function fromB64url(str) {
  return Buffer.from(String(str), "base64url");
}

function signPayload(payloadB64, secret = licenseSecret()) {
  return crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

function licensePath(configDir = getConfigDir()) {
  return path.join(configDir, "license.json");
}

export function machineId() {
  const raw = [os.hostname(), os.userInfo().username, os.platform(), os.arch()].join("|");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function readState(configDir = getConfigDir()) {
  try {
    return JSON.parse(fs.readFileSync(licensePath(configDir), "utf8"));
  } catch {
    return null;
  }
}

function writeState(state, configDir = getConfigDir()) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(licensePath(configDir), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function createLicenseKey({ type = "trial", days = 5, note = "" } = {}) {
  const t = String(type).toLowerCase() === "lifetime" || type === "life" ? "lifetime" : "trial";
  const d = t === "lifetime" ? 0 : Math.max(1, Math.min(365, Number(days) || 5));
  const id = crypto.randomBytes(8).toString("hex");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(12);
  let body = "";
  for (let i = 0; i < 12; i++) body += alphabet[bytes[i] % alphabet.length];
  const chunks = body.match(/.{1,4}/g) || [];
  const key = `ZWD-${chunks.join("-")}`;
  const code = `ZWD${body}`;
  const payload = {
    v: 2,
    t: t === "lifetime" ? "life" : "trial",
    d,
    id,
    code,
    note: String(note || "").slice(0, 40)
  };
  return { key, code, payload };
}

export function isShortCode(raw) {
  const n = String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!n.startsWith("ZWD") || n.startsWith("ZWD1")) return false;
  const body = n.slice(3);
  if (body.length < 12 || body.length > 16) return false;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return [...body].every(c => alphabet.includes(c));
}

export function parseLicenseKey(raw) {
  const input = String(raw || "").trim().replace(/\s+/g, "");
  if (isShortCode(input)) {
    const n = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const body = n.slice(3);
    const chunks = body.match(/.{1,4}/g) || [];
    const key = `ZWD-${chunks.join("-")}`;
    return {
      kind: "short",
      key,
      code: n,
      payload: { v: 2, id: null, code: n, t: null, d: null }
    };
  }
  const parts = input.split(".");
  if (parts.length !== 3 || parts[0] !== "ZWD1") {
    throw Object.assign(new Error("Mã không đúng định dạng (vd: ZWD-XXXX-XXXX-XXXX)"), { status: 400 });
  }
  const [, payloadB64, sig] = parts;
  const expect = signPayload(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw Object.assign(new Error("Mã không hợp lệ hoặc đã bị sửa"), { status: 400 });
  }
  let payload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Mã bị hỏng"), { status: 400 });
  }
  if (!payload?.id || !["trial", "life"].includes(payload.t)) {
    throw Object.assign(new Error("Mã không hỗ trợ"), { status: 400 });
  }
  return { kind: "legacy", key: input, payload };
}

export function ensureFreeTrial({ days = 5, configDir = getConfigDir() } = {}) {
  // Giữ hàm để tương thích cũ — không còn tự cấp dùng thử.
  // Dùng thử chỉ qua mã trial tạo trên portal (ZWD-XXXX-...).
  void days;
  return readState(configDir);
}

function isKeyActivated(state) {
  return Boolean(state?.activatedAt && state.source === "key" && state.fullKey);
}

async function callLicenseServer(key) {
  const server = licenseServerUrl();
  if (!server || !key) return { skipped: true, reason: !server ? "no_server" : "no_key" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`${server}/api/activate`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        key,
        machineId: machineId(),
        hostname: os.hostname()
      }),
      signal: ctrl.signal
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 200) }; }
    return { res, data, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

function isDeniedLicenseResponse(status, data = {}) {
  if ([401, 403, 404].includes(Number(status))) return true;
  if (["revoked", "device_limit", "not_registered", "deleted"].includes(data.code)) return true;
  if (data.ok === false && data.registered === false) return true;
  return false;
}

export async function activateLicenseKey(raw, { configDir = getConfigDir() } = {}) {
  const parsed = parseLicenseKey(raw);
  const key = parsed.key;
  const server = licenseServerUrl();

  let typeFromServer = null;
  let daysFromServer = null;
  let idFromServer = null;

  if (server) {
    const result = await callLicenseServer(key);
    if (result.skipped) {
      throw Object.assign(new Error("Thiếu máy chủ license"), { status: 503 });
    }
    const { res, data, status } = result;
    if (isDeniedLicenseResponse(status, data)) {
      throw Object.assign(new Error(data.error || "Không kích hoạt được mã"), { status: 403, code: data.code });
    }
    if (!res.ok && status !== 503) {
      throw Object.assign(new Error(data.error || `Máy chủ license lỗi (${status})`), { status: status || 500 });
    }
    if (status === 503) {
      throw Object.assign(new Error(data.error || "Máy chủ license chưa sẵn sàng (thiếu Upstash)"), { status: 503 });
    }
    typeFromServer = data.type || null;
    daysFromServer = data.days;
    idFromServer = data.id || null;
  } else if (parsed.kind === "short") {
    throw Object.assign(new Error("Mã ngắn cần máy chủ license (LICENSE_SERVER_URL)"), { status: 503 });
  }

  const now = Date.now();
  const isLife =
    typeFromServer === "lifetime" ||
    parsed.payload?.t === "life";
  const days = isLife
    ? 0
    : Math.max(1, Number(daysFromServer ?? parsed.payload?.d) || 5);
  const keyId = idFromServer || parsed.payload?.id || parsed.code;
  const state = {
    source: "key",
    type: isLife ? "lifetime" : "trial",
    days,
    keyId,
    keyFingerprint: crypto.createHash("sha256").update(key).digest("hex").slice(0, 16),
    fingerprint: machineId(),
    activatedAt: now,
    expiresAt: isLife ? null : now + days * 86400000,
    note: parsed.payload?.note || "",
    keyPreview: key,
    fullKey: key,
    lastServerCheckAt: Date.now()
  };
  writeState(state, configDir);
  return getLicenseStatus(configDir);
}

export function clearLicense({ configDir = getConfigDir() } = {}) {
  try { fs.unlinkSync(licensePath(configDir)); } catch {}
  return getLicenseStatus(configDir);
}

function statusFromState(state) {
  const now = Date.now();
  if (!state?.activatedAt) {
    return {
      ok: false,
      licensed: false,
      type: null,
      label: "Chưa kích hoạt",
      message: "Nhập mã kích hoạt để dùng app.",
      expiresAt: null,
      daysLeft: null,
      activatedAt: null
    };
  }
  if (state.serverBlocked) {
    return {
      ok: false,
      licensed: false,
      type: state.type || null,
      label: "Mã bị khóa",
      message: state.serverMessage || "Mã đã bị thu hồi hoặc dùng trên máy khác.",
      expiresAt: state.expiresAt || null,
      daysLeft: 0,
      activatedAt: state.activatedAt,
      keyPreview: state.keyPreview || null
    };
  }
  const isLife = state.type === "lifetime" || state.expiresAt == null;
  if (isLife) {
    return {
      ok: true,
      licensed: true,
      type: "lifetime",
      label: "Vĩnh viễn",
      message: "Đã kích hoạt bản quyền vĩnh viễn.",
      expiresAt: null,
      daysLeft: null,
      activatedAt: state.activatedAt,
      keyPreview: state.keyPreview || null,
      note: state.note || ""
    };
  }
  const expiresAt = Number(state.expiresAt) || 0;
  const msLeft = expiresAt - now;
  const daysLeft = Math.max(0, Math.ceil(msLeft / 86400000));
  if (msLeft <= 0) {
    return {
      ok: false,
      licensed: false,
      type: "trial",
      label: "Hết hạn dùng thử",
      message: "Thời gian dùng thử đã hết. Nhập mã mới (dùng thử hoặc vĩnh viễn).",
      expiresAt,
      daysLeft: 0,
      activatedAt: state.activatedAt,
      keyPreview: state.keyPreview || null
    };
  }
  return {
    ok: true,
    licensed: true,
    type: "trial",
    label: `Dùng thử còn ${daysLeft} ngày`,
    message: `Bản dùng thử còn hiệu lực đến ${new Date(expiresAt).toLocaleString("vi-VN")}.`,
    expiresAt,
    daysLeft,
    activatedAt: state.activatedAt,
    keyPreview: state.keyPreview || null,
    note: state.note || ""
  };
}

﻿const SERVER_CHECK_MS = 15 * 1000;
const OFFLINE_GRACE_MS = 10 * 60 * 1000;

function wipeLicense(configDir = getConfigDir()) {
  try { fs.unlinkSync(licensePath(configDir)); } catch {}
}

function blockedStatus(message) {
  return {
    ok: false,
    licensed: false,
    type: null,
    label: "Mã không còn hiệu lực",
    message: message || "Mã đã bị xóa / thu hồi trên hệ thống. Nhập mã mới để tiếp tục.",
    expiresAt: null,
    daysLeft: 0,
    activatedAt: null,
    keyPreview: null
  };
}

/** Đồng bộ với server (thu hồi / xóa / đổi máy). */
export async function syncLicenseWithServer({ configDir = getConfigDir(), force = false } = {}) {
  let state = readState(configDir);
  if (state?.source === "free-trial" || (state?.activatedAt && !state.fullKey)) {
    wipeLicense(configDir);
    state = null;
  }
  if (!isKeyActivated(state)) {
    return statusFromState(null);
  }
  const server = licenseServerUrl();
  if (!server) {
    wipeLicense(configDir);
    return blockedStatus("Thiếu LICENSE_SERVER_URL — không kiểm tra được mã.");
  }

  const last = Number(state.lastServerCheckAt) || 0;
  if (!force && !state.serverBlocked && Date.now() - last < SERVER_CHECK_MS) {
    return statusFromState(state);
  }

  try {
    const result = await callLicenseServer(state.fullKey);
    if (result.skipped) {
      wipeLicense(configDir);
      return blockedStatus("Không gọi được máy chủ license.");
    }
    const { res, data, status } = result;
    state.lastServerStatus = status;
    state.lastServerCheckAt = Date.now();

    if (isDeniedLicenseResponse(status, data)) {
      wipeLicense(configDir);
      return blockedStatus(data.error || "Mã đã bị xóa / thu hồi trên hệ thống.");
    }
    if (res.ok && data.ok !== false) {
      state.serverBlocked = false;
      state.serverMessage = "";
      writeState(state, configDir);
      return statusFromState(state);
    }
    if (status === 503 || status >= 500) {
      writeState(state, configDir);
      if (last && Date.now() - last > OFFLINE_GRACE_MS) {
        wipeLicense(configDir);
        return blockedStatus("Máy chủ license lỗi quá lâu. Thử lại sau hoặc nhập mã mới.");
      }
      return statusFromState(state);
    }
    wipeLicense(configDir);
    return blockedStatus(data.error || `Mã không hợp lệ (HTTP ${status}).`);
  } catch (error) {
    console.warn("syncLicenseWithServer:", error.message);
    const lastOk = Number(state.lastServerCheckAt) || 0;
    if (!lastOk || Date.now() - lastOk > OFFLINE_GRACE_MS) {
      wipeLicense(configDir);
      return blockedStatus("Không kết nối được máy chủ license. Kiểm tra mạng rồi kích hoạt lại.");
    }
  }
  return statusFromState(readState(configDir));
}

export async function getLicenseStatus(configDir = getConfigDir(), opts = {}) {
  const force = Boolean(opts && opts.force);
  return syncLicenseWithServer({ configDir: configDir || getConfigDir(), force });
}

export async function requireLicense(req, res, next) {
  try {
    const status = await getLicenseStatus(getConfigDir(), { force: false });
    if (status.ok) return next();
    res.status(402).json({
      error: status.message || "Cần mã kích hoạt",
      code: "license_required",
      license: status
    });
  } catch (error) {
    next(error);
  }
}
