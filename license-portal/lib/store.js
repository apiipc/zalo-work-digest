/**
 * Lưu sổ mã trên Upstash Redis (REST) nếu có env.
 * Không có Redis: vẫn tạo mã được, chỉ không lưu danh sách cloud.
 */
const KEYS_ZSET = "zwd:licenses:ids";
const KEY_PREFIX = "zwd:license:";

export function hasRedis() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

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
  if (!hasRedis()) return { ...row, persisted: false };
  await redis("SET", KEY_PREFIX + row.id, JSON.stringify(row));
  await redis("ZADD", KEYS_ZSET, String(row.createdAt || Date.now()), row.id);
  return { ...row, persisted: true };
}

export async function getLicense(id) {
  if (!hasRedis()) return null;
  const raw = await redis("GET", KEY_PREFIX + id);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
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
      const hay = [row.customer, row.note, row.key, row.id, row.type].join(" ").toLowerCase();
      if (!hay.includes(query)) continue;
    }
    out.push(row);
  }
  return out;
}

export async function updateLicense(id, patch) {
  if (!hasRedis()) {
    throw Object.assign(new Error("Cần Upstash Redis để cập nhật trạng thái mã trên cloud"), { status: 400 });
  }
  const row = await getLicense(id);
  if (!row) throw Object.assign(new Error("Không tìm thấy mã"), { status: 404 });
  Object.assign(row, patch, { updatedAt: Date.now() });
  await saveLicense(row);
  return row;
}
