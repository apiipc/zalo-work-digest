import { updateLicense } from "../../lib/store.js";
import { requireAdmin, readJson, sendJson } from "../../lib/http.js";

export default async function handler(req, res) {
  try {
    await requireAdmin(req);
    if (req.method !== "PATCH") return sendJson(res, 405, { error: "Method not allowed" });

    const id = String(req.query?.id || "").trim();
    if (!id) return sendJson(res, 400, { error: "Thiếu id" });
    const body = await readJson(req);
    const status = String(body.status || "").trim();
    if (!["issued", "sold", "revoked"].includes(status)) {
      return sendJson(res, 400, { error: "status phải là issued|sold|revoked" });
    }
    const patch = { status };
    if (status === "sold") patch.soldAt = Date.now();
    if (status === "revoked") patch.revokedAt = Date.now();
    const row = await updateLicense(id, patch);
    return sendJson(res, 200, row);
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message || "Lỗi" });
  }
}
