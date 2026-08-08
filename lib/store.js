/**
 * Lưu sổ mã trên Upstash Redis (REST) — miễn phí, chạy tốt trên Vercel.
 * Env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 */
const KEYS_ZSET = "zwd:licenses:ids";
const KEY_PREFIX = "zwd:license:";
const SESSION_PREFIX = "zwd:session:";

function redisEnv() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw Object.assign(
      new Error("Thiếu UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN trên Vercel"),
      { status: 500 }
    );
  }
  return { url: url.replace(/\/$/, ""), token };
}

async function redis(...command) {
  const { url, token } = redisEnv();
  const res = await fetch(`${url}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(command)
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    throw Object.assign(new Error(json.error || "Redis lỗi"), { status: 500 });
  }
  return json.result;
}

export async function saveLicense(row) {
  await redis("SET", KEY_PREFIX + row.id, JSON.stringify(row));
  await redis("ZADD", KEYS_ZSET, String(row.createdAt || Date.now()), row.id);
  return row;
}

export async function getLicense(id) {
  const raw = await redis("GET", KEY_PREFIX + id);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

export async function listLicenses({ q = "", status = "", limit = 200 } = {}) {
  const ids = (await redis("ZREVRANGE", KEYS_ZSET, "0", String(Math.max(0, limit - 1)))) || [];
  const out = [];
  const query = String(q || "").trim().toLowerCase();
  const st = String(status || "").trim().toLowerCase();
  for (const id of ids) {
    const row = await getLicense(id);
    if (!row) continue;
    if (st && row.status !== st) continue;
    if (query) {
      const hay = [row.customer, row.note, row.key, row.id, row.type].join(" ").toLowerCase();
      if (!hay.includes(query)) continue;
    }
    out.push(row);
  }
  return out;
}

export async function updateLicense(id, patch) {
  const row = await getLicense(id);
  if (!row) throw Object.assign(new Error("Không tìm thấy mã"), { status: 404 });
  Object.assign(row, patch, { updatedAt: Date.now() });
  await saveLicense(row);
  return row;
}

export async function createSession(token, ttlSec = 60 * 60 * 24 * 14) {
  await redis("SET", SESSION_PREFIX + token, "1", "EX", String(ttlSec));
}

export async function sessionExists(token) {
  if (!token) return false;
  const v = await redis("GET", SESSION_PREFIX + token);
  return Boolean(v);
}

export async function deleteSession(token) {
  if (!token) return;
  await redis("DEL", SESSION_PREFIX + token);
}
