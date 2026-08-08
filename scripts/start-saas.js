/**
 * Entry point SaaS web. Ưu tiên biến môi trường đã set;
 * nếu thiếu thì đọc .env / .env.saas.example (Node 20+ --env-file cũng được).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") process.env[key] = val;
  }
}

loadEnvFile(path.join(root, ".env"));
loadEnvFile(path.join(root, ".env.saas"));
loadEnvFile(path.join(root, ".env.saas.example"));

process.env.ZALO_DIGEST_MODE = process.env.ZALO_DIGEST_MODE || "saas";
process.env.HOST = process.env.HOST || "0.0.0.0";
process.env.PORT = process.env.PORT || "4782";

if (!process.env.SAAS_SECRET || String(process.env.SAAS_SECRET).length < 16) {
  console.error("Thiếu SAAS_SECRET (≥ 16 ký tự). Copy .env.saas.example → .env.saas và sửa secret.");
  process.exit(1);
}

await import("../src/server.js");
