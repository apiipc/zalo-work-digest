/**
 * Logic mã kích hoạt (dùng chung portal Vercel).
 * Phải cùng LICENSE_SECRET với app desktop.
 */
import crypto from "node:crypto";

const DEFAULT_SECRET = "zalo-work-digest-license-v1-change-me-before-release";

export function licenseSecret() {
  return String(process.env.LICENSE_SECRET || DEFAULT_SECRET);
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function signPayload(payloadB64, secret = licenseSecret()) {
  return crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

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
  return { key: `ZWD1.${payloadB64}.${sig}`, payload };
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
    throw Object.assign(new Error("Mã không hợp lệ"), { status: 400 });
  }
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  if (!payload?.id || !["trial", "life"].includes(payload.t)) {
    throw Object.assign(new Error("Mã không hỗ trợ"), { status: 400 });
  }
  return { key, payload };
}
