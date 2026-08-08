import { createLicenseKey } from "../lib/license.js";
import { deleteLicense, hasRedis, listLicenses, saveLicense } from "../lib/store.js";
import { requireAdmin, readJson, sendJson } from "../lib/http.js";

export default async function handler(req, res) {
  try {
    await requireAdmin(req);

    if (req.method === "GET") {
      if (!hasRedis()) {
        return sendJson(res, 200, {
          keys: [],
          storage: "none",
          warning: "Chưa gắn Upstash Redis — không lưu danh sách / IP / thu hồi được. Thêm UPSTASH_REDIS_REST_URL và TOKEN rồi Redeploy."
        });
      }
      const url = new URL(req.url, "http://localhost");
      const keys = await listLicenses({
        q: url.searchParams.get("q") || "",
        status: url.searchParams.get("status") || ""
      });
      return sendJson(res, 200, { keys, storage: "upstash", warning: null });
    }

    if (req.method === "POST") {
      if (!hasRedis()) {
        return sendJson(res, 503, {
          error: "Cần Upstash Redis để tạo mã có chống share / thu hồi. Thêm UPSTASH_REDIS_REST_URL + TOKEN trên Vercel."
        });
      }
      const body = await readJson(req);
      const type = body.type || "trial";
      const days = Number(body.days) || 5;
      const customer = String(body.customer || "").trim();
      const note = String(body.note || "").trim();
      const count = Math.max(1, Math.min(50, Number(body.count) || 1));
      const maxDevices = Math.max(1, Number(body.maxDevices) || Number(process.env.LICENSE_MAX_DEVICES) || 1);
      const issued = [];
      for (let i = 0; i < count; i++) {
        const noteText = [customer && `KH:${customer}`, note].filter(Boolean).join(" | ").slice(0, 40);
        const { key, code, payload } = createLicenseKey({ type, days, note: noteText });
        const row = {
          id: payload.id,
          key,
          code,
          type: payload.t === "life" ? "lifetime" : "trial",
          days: payload.t === "life" ? null : payload.d,
          customer,
          note,
          status: "issued",
          maxDevices,
          createdAt: Date.now(),
          activations: []
        };
        await saveLicense(row);
        issued.push(row);
      }
      return sendJson(res, 201, { issued, persisted: true });
    }

    return sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message || "Lỗi" });
  }
}
