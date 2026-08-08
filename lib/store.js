/**
 * Lưu sổ mã + lịch sử kích hoạt trên Upstash Redis.
 * Bắt buộc để: danh sách cloud, IP, chống share máy, thu hồi.
 */
const KEYS_ZSET = "zwd:licenses:ids";
const KEY_PREFIX = "zwd:license:";
const CODE_PREFIX = "zwd:code:";

export function hasRedis() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function redisEnv() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw Object.assign(
      new Error("Thiếu UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN trên Vercel"),
      { status: 503, code: "storage_missing" }
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
  if (row.code) {
    await redis("SET", CODE_PREFIX + String(row.code).toUpperCase(), row.id);
  }
  return { ...row, persisted: true };
}

export async function getLicense(id) {
  const raw = await redis("GET", KEY_PREFIX + id);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

export async function getLicenseByCode(code) {
  const normalized = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!normalized) return null;
  const id = await redis("GET", CODE_PREFIX + normalized);
  if (!id) return null;
  const row = await getLicense(id);
  if (!row) {
    // Index mồ côi sau khi xóa — dọn luôn
    await redis("DEL", CODE_PREFIX + normalized);
    return null;
  }
  return row;
}

export async function deleteLicense(id) {
  const row = await getLicense(id);
  if (!row) throw Object.assign(new Error("Không tìm thấy mã"), { status: 404 });
  await redis("DEL", KEY_PREFIX + id);
  await redis("ZREM", KEYS_ZSET, id);
  if (row.code) await redis("DEL", CODE_PREFIX + String(row.code).toUpperCase());
  return { ok: true, id };
}

export async function listLicenses({ q = "", status = "", limit = 200 } = {}) {
  if (!hasRedis()) return [];
  const ids = (await redis("ZREVRANGE", KEYS_ZSET, "0", String(Math.max(0, limit - 1)))) || [];
  const out = [];
  const query = String(q || "").trim().toLowerCase();
  const st = String(status || "").trim().toLowerCase();
  for (const id of ids) {
    const row = await getLicense(id);
    if (!row) continue;
    if (st && row.status !== st) continue;
    if (query) {
      const hay = [row.customer, row.note, row.key, row.code, row.id, row.type, ...(row.activations || []).map(a => a.ip)].join(" ").toLowerCase();
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

export function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || String(req.headers["x-real-ip"] || req.socket?.remoteAddress || "").trim() || "unknown";
}
