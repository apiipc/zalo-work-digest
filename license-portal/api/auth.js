import { loginAdmin, setSessionCookie, readJson, sendJson, clearSessionCookie, logoutAdmin } from "../lib/http.js";

export default async function handler(req, res) {
  try {
    if (req.method === "POST") {
      const body = await readJson(req);
      const token = await loginAdmin(body.password);
      setSessionCookie(res, token);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "DELETE") {
      await logoutAdmin(req);
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    return sendJson(res, error.status || 500, { error: error.message || "Lỗi" });
  }
}
