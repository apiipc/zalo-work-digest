import { parseLicenseKey } from "../lib/license.js";
import { clientIp, getLicense, getLicenseByCode, hasRedis, saveLicense } from "../lib/store.js";
import { readJson, sendJson } from "../lib/http.js";

const MAX_DEVICES = Math.max(1, Number(process.env.LICENSE_MAX_DEVICES) || 1);

/**
 * App desktop gọi khi kích hoạt / mỗi lần mở app (heartbeat).
 * POST { key, machineId, hostname? }
 * key: ZWD-XXXX-XXXX-XXXX hoặc ZWD1....
 */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
    if (!hasRedis()) {
      return sendJson(res, 503, {
        ok: false,
        code: "storage_missing",
        error: "Server chưa cấu hình Upstash — không kiểm tra được kích hoạt/thu hồi."
      });
    }

    const body = await readJson(req);
    const parsed = parseLicenseKey(body.key || body.licenseKey || "");
    const machineId = String(body.machineId || "").slice(0, 64);
    if (!machineId) {
      return sendJson(res, 400, { ok: false, error: "Thiếu machineId", code: "no_machine" });
    }

    let row = null;
    if (parsed.kind === "short") {
      row = await getLicenseByCode(parsed.code);
    } else {
      row = await getLicense(parsed.payload.id);
    }

    if (!row) {
      return sendJson(res, 404, {
        ok: false,
        code: "not_registered",
        error: "Mã không có trên hệ thống (chỉ dùng mã tạo từ trang quản trị)."
      });
    }
    if (row.status === "revoked" || row.status === "deleted") {
      return sendJson(res, 403, { ok: false, error: "Mã đã bị thu hồi / xóa", code: "revoked" });
    }

    const maxDevices = Math.max(1, Number(row.maxDevices) || MAX_DEVICES);
    const ip = clientIp(req);
    const hostname = String(body.hostname || "").slice(0, 80);
    const activations = Array.isArray(row.activations) ? [...row.activations] : [];
    const existing = activations.find(a => a.machineId === machineId);

    if (!existing) {
      if (activations.length >= maxDevices) {
        return sendJson(res, 403, {
          ok: false,
          code: "device_limit",
          error: `Mã đã kích hoạt trên máy khác (tối đa ${maxDevices} máy).`,
          activations: activations.map(a => ({
            machineId: a.machineId,
            ip: a.ip,
            hostname: a.hostname,
            at: a.at
          }))
        });
      }
      activations.push({ machineId, ip, hostname, at: Date.now(), lastSeenAt: Date.now() });
      if (row.status === "issued") row.status = "sold";
    } else {
      existing.ip = ip;
      existing.hostname = hostname || existing.hostname;
      existing.lastSeenAt = Date.now();
    }

    row.activations = activations;
    row.lastActivatedAt = Date.now();
    row.lastIp = ip;
    await saveLicense(row);

    return sendJson(res, 200, {
      ok: true,
      registered: true,
      id: row.id,
      type: row.type,
      days: row.days,
      status: row.status,
      key: row.key,
      maxDevices,
      deviceCount: activations.length,
      message: row.type === "lifetime" ? "Vĩnh viễn" : `Dùng thử ${row.days} ngày`,
      activation: activations.find(a => a.machineId === machineId)
    });
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message || "Lỗi", ok: false, code: error.code });
  }
}
