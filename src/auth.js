import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const COOKIE_NAME = "zwd_session";
const SESSION_DAYS = 30;

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password, salt = crypto.randomBytes(16)) {
  const derived = await scrypt(String(password), salt, 64);
  return {
    salt: salt.toString("base64url"),
    hash: Buffer.from(derived).toString("base64url")
  };
}

async function verifyPassword(password, saltB64, hashB64) {
  const salt = Buffer.from(saltB64, "base64url");
  const derived = await scrypt(String(password), salt, 64);
  const a = Buffer.from(derived);
  const b = Buffer.from(hashB64, "base64url");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function cookieOptions({ secure = false, maxAgeSec = SESSION_DAYS * 86400 } = {}) {
  const parts = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, maxAgeSec)}`
  ];
  if (secure) parts.push("Secure");
  return parts;
}

export function createAuth({ dbPath, secureCookies = false } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
  `);

  const q = {
    insertUser: db.prepare(`INSERT INTO users(id,email,password_salt,password_hash,name,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`),
    byEmail: db.prepare("SELECT * FROM users WHERE email=? COLLATE NOCASE"),
    byId: db.prepare("SELECT id,email,name,created_at FROM users WHERE id=?"),
    insertSession: db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)"),
    sessionUser: db.prepare(`SELECT u.id,u.email,u.name,u.created_at,s.expires_at
      FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash=?"),
    deleteUserSessions: db.prepare("DELETE FROM sessions WHERE user_id=?"),
    purgeExpired: db.prepare("DELETE FROM sessions WHERE expires_at<?")
  };

  function publicUser(row) {
    if (!row) return null;
    return { id: row.id, email: row.email, name: row.name || "", createdAt: row.created_at };
  }

  async function register({ email, password, name = "" }) {
    const normalized = String(email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw Object.assign(new Error("Email không hợp lệ"), { status: 400 });
    }
    if (String(password || "").length < 8) {
      throw Object.assign(new Error("Mật khẩu cần ít nhất 8 ký tự"), { status: 400 });
    }
    if (q.byEmail.get(normalized)) {
      throw Object.assign(new Error("Email đã được đăng ký"), { status: 409 });
    }
    const id = crypto.randomBytes(16).toString("hex");
    const { salt, hash } = await hashPassword(password);
    const now = Date.now();
    q.insertUser.run(id, normalized, salt, hash, String(name || "").trim().slice(0, 80), now, now);
    return publicUser(q.byId.get(id));
  }

  async function login({ email, password }) {
    const normalized = String(email || "").trim().toLowerCase();
    const row = q.byEmail.get(normalized);
    if (!row || !(await verifyPassword(password, row.password_salt, row.password_hash))) {
      throw Object.assign(new Error("Email hoặc mật khẩu không đúng"), { status: 401 });
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + SESSION_DAYS * 86400000;
    q.insertSession.run(hashToken(token), row.id, expiresAt, Date.now());
    try { q.purgeExpired.run(Date.now()); } catch {}
    return { user: publicUser(row), token, expiresAt };
  }

  function logout(token) {
    if (!token) return;
    q.deleteSession.run(hashToken(token));
  }

  function userFromToken(token) {
    if (!token) return null;
    const row = q.sessionUser.get(hashToken(token));
    if (!row) return null;
    if (Number(row.expires_at) < Date.now()) {
      q.deleteSession.run(hashToken(token));
      return null;
    }
    return publicUser(row);
  }

  function readSessionToken(req) {
    const cookies = parseCookies(req.headers?.cookie);
    return cookies[COOKIE_NAME] || null;
  }

  function setSessionCookie(res, token) {
    const base = cookieOptions({ secure: secureCookies });
    base[0] = `${COOKIE_NAME}=${encodeURIComponent(token)}`;
    res.setHeader("Set-Cookie", base.join("; "));
  }

  function clearSessionCookie(res) {
    const base = cookieOptions({ secure: secureCookies, maxAgeSec: 0 });
    base[0] = `${COOKIE_NAME}=`;
    res.setHeader("Set-Cookie", base.join("; "));
  }

  function requireAuth(req, res, next) {
    const token = readSessionToken(req);
    const user = userFromToken(token);
    if (!user) {
      res.status(401).json({ error: "Cần đăng nhập", code: "auth_required" });
      return;
    }
    req.user = user;
    req.sessionToken = token;
    next();
  }

  function optionalAuth(req, _res, next) {
    const token = readSessionToken(req);
    req.user = userFromToken(token);
    req.sessionToken = token;
    next();
  }

  return {
    register,
    login,
    logout,
    userFromToken,
    readSessionToken,
    setSessionCookie,
    clearSessionCookie,
    requireAuth,
    optionalAuth,
    COOKIE_NAME,
    close: () => { try { db.close(); } catch {} }
  };
}
