import crypto from "node:crypto";

const PREFIX = "enc:v1:";

function secretKey() {
  const raw = process.env.SAAS_SECRET || process.env.ZALO_DIGEST_SECRET || "";
  if (!raw || raw.length < 16) {
    throw new Error("Thiếu SAAS_SECRET (ít nhất 16 ký tự) để mã hóa dữ liệu nhạy cảm.");
  }
  return crypto.createHash("sha256").update(raw).digest();
}

/** Mã hóa chuỗi (API key) at-rest. */
export function encryptSecret(plain) {
  const text = String(plain || "");
  if (!text) return "";
  if (text.startsWith(PREFIX)) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64url");
}

/** Giải mã; trả về nguyên bản nếu chưa mã hóa (legacy). */
export function decryptSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (!text.startsWith(PREFIX)) return text;
  const buf = Buffer.from(text.slice(PREFIX.length), "base64url");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function isEncryptedSecret(value) {
  return String(value || "").startsWith(PREFIX);
}

/** Che key khi hiển thị (sau khi decrypt nếu cần). */
export function maskSecret(value) {
  let plain = "";
  try { plain = decryptSecret(value); } catch { plain = String(value || ""); }
  if (!plain) return "";
  if (plain.length <= 10) return "••••••••";
  return `${plain.slice(0, 4)}…${plain.slice(-4)}`;
}
