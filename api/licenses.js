import { createLicenseKey } from "../lib/license.js";
import { hasRedis, listLicenses, saveLicense } from "../lib/store.js";
import { requireAdmin, readJson, sendJson } from "../lib/http.js";

export default async function handler(req, res) {
  try {
    await requireAdmin(req);

    if (req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const keys = await listLicenses({
        q: url.searchParams.get("q") || "",
        status: url.searchParams.get("status") || ""
      });
      return sendJson(res, 200, {
        keys,
        storage: hasRedis() ? "upstash" : "none",
        warning: hasRedis() ? null : "Chưa gắn Upstash — tạo mã vẫn được nhưng không lưu danh sách cloud."
      });
    }

    if (req.method === "POST") {
      const body = await readJson(req);
      const type = body.type || "trial";
      const days = Number(body.days) || 5;
      const customer = String(body.customer || "").trim();
      const note = String(body.note || "").trim();
      const count = Math.max(1, Math.min(50, Number(body.count) || 1));
      const issued = [];
      for (let i = 0; i < count; i++) {
        const noteText = [customer && `KH:${customer}`, note].filter(Boolean).join(" | ").slice(0, 40);
        const { key, payload } = createLicenseKey({ type, days, note: noteText });
        const row = {
          id: payload.id,
          key,
          type: payload.t === "life" ? "lifetime" : "trial",
          days: payload.t === "life" ? null : payload.d,
          customer,
          note,
          status: "issued",
          createdAt: Date.now(),
          activations: []
        };
        const saved = await saveLicense(row);
        issued.push(saved);
      }
      return sendJson(res, 201, {
        issued,
        persisted: hasRedis(),
        warning: hasRedis() ? null : "Mã đã tạo & có thể copy. Chưa lưu danh sách vì thiếu Upstash Redis."
      });
    }

    return sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message || "Lỗi" });
  }
}
