import crypto from "node:crypto";
import { createSession, deleteSession, sessionExists } from "./store.js";

export const COOKIE = "zwd_lic_admin";

export function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function adminPassword() {
  return String(process.env.LICENSE_ADMIN_PASSWORD || "").trim();
}

export async function requireAdmin(req) {
  const pwd = adminPassword();
  if (!pwd) {
    throw Object.assign(new Error("Chưa cấu hình LICENSE_ADMIN_PASSWORD trên Vercel"), { status: 500 });
  }
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[COOKIE];
  if (!token) {
    throw Object.assign(new Error("Cần đăng nhập quản trị"), { status: 401 });
  }
  if (!(await sessionExists(token))) {
    throw Object.assign(new Error("Cần đăng nhập quản trị"), { status: 401 });
  }
  return true;
}

export async function loginAdmin(password) {
  const expect = adminPassword();
  if (!expect) throw Object.assign(new Error("Chưa cấu hình LICENSE_ADMIN_PASSWORD"), { status: 500 });
  if (String(password || "") !== expect) {
    throw Object.assign(new Error("Mật khẩu không đúng"), { status: 401 });
  }
  const token = crypto.randomBytes(24).toString("base64url");
  await createSession(token);
  return token;
}

export async function logoutAdmin(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  await deleteSession(cookies[COOKIE]);
}

export function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=1209600"
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
  const parts = [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(Object.assign(new Error("JSON không hợp lệ"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}
