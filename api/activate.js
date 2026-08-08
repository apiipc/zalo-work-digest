import { parseLicenseKey } from "../lib/license.js";
import { getLicense, saveLicense } from "../lib/store.js";
import { readJson, sendJson } from "../lib/http.js";

/**
 * API công khai cho app desktop (tùy chọn): ghi nhận kích hoạt / kiểm tra revoked.
 * POST { key, machineId? }
 */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
    const body = await readJson(req);
    const { key, payload } = parseLicenseKey(body.key || body.licenseKey || "");
    const row = await getLicense(payload.id);
    if (!row) {
      // Mã hợp lệ chữ ký nhưng chưa có trên sổ Vercel → vẫn cho phép (offline-first)
      return sendJson(res, 200, {
        ok: true,
        registered: false,
        type: payload.t === "life" ? "lifetime" : "trial",
        days: payload.d,
        message: "Mã hợp lệ (chưa có trên sổ cloud)."
      });
    }
    if (row.status === "revoked") {
      return sendJson(res, 403, { ok: false, error: "Mã đã bị thu hồi", code: "revoked" });
    }
    const machineId = String(body.machineId || "").slice(0, 64);
    const activations = Array.isArray(row.activations) ? row.activations : [];
    if (machineId && !activations.some(a => a.machineId === machineId)) {
      activations.push({ machineId, at: Date.now() });
      row.activations = activations.slice(-20);
      if (row.status === "issued") row.status = "sold";
      row.lastActivatedAt = Date.now();
      await saveLicense(row);
    }
    return sendJson(res, 200, {
      ok: true,
      registered: true,
      type: row.type,
      days: row.days,
      status: row.status,
      message: row.type === "lifetime" ? "Vĩnh viễn" : `Dùng thử ${row.days} ngày`
    });
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message || "Lỗi", ok: false });
  }
}
