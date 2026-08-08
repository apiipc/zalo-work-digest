import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getConfigDir } from "./app-paths.js";

/** Đổi secret này trước khi phát hành rộng — và dùng cùng secret khi chạy generate-license. */
const DEFAULT_SECRET = "zalo-work-digest-license-v1-change-me-before-release";

export function licenseSecret() {
  return String(process.env.LICENSE_SECRET || DEFAULT_SECRET);
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

function machineId() {
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

/**
 * Tạo mã kích hoạt.
 * @param {{ type: 'trial'|'lifetime', days?: number, note?: string }} opts
 */
export function createLicenseKey({ type = "trial", days = 5, note = "" } = {}) {
  const t = String(type).toLowerCase() === "lifetime" || type === "life" ? "lifetime" : "trial";
  const d = t === "lifetime" ? 0 : Math.max(1, Math.min(365, Number(days) || 5));
  const payload = {
    v: 1,
    t: t === "lifetime" ? "life" : "trial",
    d,
    id: crypto.randomBytes(8).toString("hex"),
    note: String(note || "").slice(0, 40)
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = signPayload(payloadB64);
  const key = `ZWD1.${payloadB64}.${sig}`;
  return { key, payload };
}

export function parseLicenseKey(raw) {
  const key = String(raw || "").trim().replace(/\s+/g, "");
  const parts = key.split(".");
  if (parts.length !== 3 || parts[0] !== "ZWD1") {
    throw Object.assign(new Error("Mã không đúng định dạng"), { status: 400 });
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
  return { key, payload };
}

/** Bắt đầu dùng thử miễn phí trên máy (một lần), nếu chưa có license. */
export function ensureFreeTrial({ days = 5, configDir = getConfigDir() } = {}) {
  const state = readState(configDir);
  if (state?.activatedAt) return state;
  const now = Date.now();
  const trialDays = Math.max(1, Number(days) || 5);
  const next = {
    source: "free-trial",
    type: "trial",
    days: trialDays,
    keyId: `free-${machineId()}`,
    fingerprint: machineId(),
    activatedAt: now,
    expiresAt: now + trialDays * 86400000,
    note: "Dùng thử miễn phí trên máy này"
  };
  writeState(next, configDir);
  return next;
}

export async function activateLicenseKey(raw, { configDir = getConfigDir() } = {}) {
  const { key, payload } = parseLicenseKey(raw);

  const server = String(process.env.LICENSE_SERVER_URL || "").replace(/\/$/, "");
  if (server) {
    try {
      const res = await fetch(`${server}/api/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, machineId: machineId() })
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 || data.code === "revoked") {
        throw Object.assign(new Error(data.error || "Mã đã bị thu hồi"), { status: 403 });
      }
      if (!res.ok && res.status >= 500) {
        // Cloud lỗi: vẫn cho kích hoạt offline nếu chữ ký đúng
        console.warn("LICENSE_SERVER_URL lỗi:", data.error || res.status);
      }
    } catch (error) {
      if (error.status === 403) throw error;
      console.warn("Không gọi được LICENSE_SERVER_URL:", error.message);
    }
  }

  const now = Date.now();
  const isLife = payload.t === "life";
  const days = isLife ? 0 : Math.max(1, Number(payload.d) || 5);
  const state = {
    source: "key",
    type: isLife ? "lifetime" : "trial",
    days,
    keyId: payload.id,
    keyFingerprint: crypto.createHash("sha256").update(key).digest("hex").slice(0, 16),
    fingerprint: machineId(),
    activatedAt: now,
    expiresAt: isLife ? null : now + days * 86400000,
    note: payload.note || "",
    keyPreview: `${key.slice(0, 12)}…${key.slice(-6)}`
  };
  writeState(state, configDir);
  return getLicenseStatus(configDir);
}

export function clearLicense({ configDir = getConfigDir() } = {}) {
  try { fs.unlinkSync(licensePath(configDir)); } catch {}
  return getLicenseStatus(configDir);
}

export function getLicenseStatus(configDir = getConfigDir()) {
  let state = readState(configDir);
  if (!state?.activatedAt) {
    ensureFreeTrial({ configDir, days: Number(process.env.LICENSE_FREE_TRIAL_DAYS) || 5 });
    state = readState(configDir);
  }
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

export function requireLicense(req, res, next) {
  const status = getLicenseStatus();
  if (status.ok) return next();
  res.status(402).json({
    error: status.message || "Cần mã kích hoạt",
    code: "license_required",
    license: status
  });
}
