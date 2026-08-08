#!/usr/bin/env node
/**
 * Quản lý mã kích hoạt trên máy bạn (localhost).
 * Mở trình duyệt: http://127.0.0.1:4791
 *
 *   npm run license:admin
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportLicensesCsv, getVaultFilePath, issueLicense, listLicenses, setLicenseStatus } from "../src/license-vault.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.LICENSE_ADMIN_PORT) || 4791;
const host = "127.0.0.1";

function send(res, status, body, type = "application/json; charset=utf-8") {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const htmlPath = path.join(root, "public", "license-admin.html");

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/license-admin.html")) {
      return send(res, 200, fs.readFileSync(htmlPath, "utf8"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/api/licenses") {
      return send(res, 200, {
        vault: getVaultFilePath(),
        keys: listLicenses({ q: url.searchParams.get("q") || "", status: url.searchParams.get("status") || "" })
      });
    }
    if (req.method === "GET" && url.pathname === "/api/licenses/export.csv") {
      const csv = exportLicensesCsv(listLicenses({
        q: url.searchParams.get("q") || "",
        status: url.searchParams.get("status") || ""
      }));
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": "attachment; filename=zalo-digest-licenses.csv"
      });
      return res.end(csv);
    }
    if (req.method === "POST" && url.pathname === "/api/licenses") {
      const body = await readBody(req);
      const issued = issueLicense({
        type: body.type || "trial",
        days: body.days || 5,
        customer: body.customer || "",
        note: body.note || "",
        count: body.count || 1
      });
      return send(res, 201, { issued });
    }
    if (req.method === "PATCH" && url.pathname.startsWith("/api/licenses/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/licenses/".length));
      const body = await readBody(req);
      const row = setLicenseStatus(id, body.status || "issued");
      return send(res, 200, row);
    }
    send(res, 404, { error: "Not found" });
  } catch (error) {
    send(res, error.status || 500, { error: error.message || "Lỗi" });
  }
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.log(`Quản lý mã kích hoạt: ${url}`);
  console.log(`Sổ mã lưu tại: ${getVaultFilePath()}`);
  // Windows: mở trình duyệt
  import("node:child_process").then(({ exec }) => {
    const cmd = process.platform === "win32" ? `start "" "${url}"`
      : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd);
  }).catch(() => {});
});
