/**
 * Mã kích hoạt:
 * - Ngắn (mặc định): ZWD-XXXX-XXXX-XXXX  → tra cứu trên server/vault
 * - Cũ: ZWD1.<payload>.<sig>             → vẫn chấp nhận
 */
import crypto from "node:crypto";

const DEFAULT_SECRET = "zalo-work-digest-license-v1-change-me-before-release";
/** Bỏ 0/O/1/I để dễ đọc khi gửi Zalo. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function licenseSecret() {
  return String(process.env.LICENSE_SECRET || DEFAULT_SECRET);
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function signPayload(payloadB64, secret = licenseSecret()) {
  return crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

function randomCodeBody(len = 12) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** ZWD-XXXX-XXXX-XXXX */
export function formatShortCode(body) {
  const raw = String(body || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const chunks = raw.match(/.{1,4}/g) || [];
  return `ZWD-${chunks.join("-")}`;
}

export function normalizeShortCode(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function isShortCode(raw) {
  const n = normalizeShortCode(raw);
  // ZWD + 12 ký tự alphabet ≈ 15; cho phép 12–16 sau prefix
  if (!n.startsWith("ZWD")) return false;
  const body = n.slice(3);
  if (body.length < 12 || body.length > 16) return false;
  return [...body].every(c => ALPHABET.includes(c));
}

export function isLegacyKey(raw) {
  return String(raw || "").trim().startsWith("ZWD1.");
}

/**
 * Tạo mã ngắn gửi khách. Payload nội bộ vẫn có id/type/days.
 * @returns {{ key: string, code: string, payload: object }}
 */
export function createLicenseKey({ type = "trial", days = 5, note = "" } = {}) {
  const t = String(type).toLowerCase() === "lifetime" || type === "life" ? "lifetime" : "trial";
  const d = t === "lifetime" ? 0 : Math.max(1, Math.min(365, Number(days) || 5));
  const id = crypto.randomBytes(8).toString("hex");
  const body = randomCodeBody(12);
  const key = formatShortCode(body);
  const code = normalizeShortCode(key);
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

/** Chỉ dùng khi cần key offline kiểu cũ. */
export function createLegacyLicenseKey({ type = "trial", days = 5, note = "" } = {}) {
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
  return { key: `ZWD1.${payloadB64}.${sig}`, payload };
}

/**
 * Parse key khách nhập.
 * Short code → { kind:"short", key, code } (cần lookup).
 * ZWD1 → { kind:"legacy", key, payload }.
 */
export function parseLicenseKey(raw) {
  const input = String(raw || "").trim().replace(/\s+/g, "");
  if (isShortCode(input)) {
    const code = normalizeShortCode(input);
    const key = formatShortCode(code.slice(3));
    return {
      kind: "short",
      key,
      code,
      payload: { v: 2, id: null, code, t: null, d: null }
    };
  }
  if (!isLegacyKey(input)) {
    throw Object.assign(
      new Error("Mã không đúng định dạng (vd: ZWD-XXXX-XXXX-XXXX)"),
      { status: 400 }
    );
  }
  const parts = input.split(".");
  if (parts.length !== 3 || parts[0] !== "ZWD1") {
    throw Object.assign(new Error("Mã không đúng định dạng"), { status: 400 });
  }
  const [, payloadB64, sig] = parts;
  const expect = signPayload(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw Object.assign(new Error("Mã không hợp lệ"), { status: 400 });
  }
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  if (!payload?.id || !["trial", "life"].includes(payload.t)) {
    throw Object.assign(new Error("Mã không hỗ trợ"), { status: 400 });
  }
  return { kind: "legacy", key: input, payload };
}
