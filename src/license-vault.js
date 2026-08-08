import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLicenseKey, parseLicenseKey } from "./license.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultVaultPath = path.join(root, "licenses", "issued.json");

function vaultPath() {
  return process.env.LICENSE_VAULT_PATH
    ? path.resolve(process.env.LICENSE_VAULT_PATH)
    : defaultVaultPath;
}

function readVault() {
  const file = vaultPath();
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data.keys) ? data : { keys: [] };
  } catch {
    return { keys: [] };
  }
}

function writeVault(data) {
  const file = vaultPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ updatedAt: Date.now(), keys: data.keys || [] }, null, 2), { mode: 0o600 });
}

/** Phát hành mã và lưu vào sổ quản lý. */
export function issueLicense({
  type = "trial",
  days = 5,
  note = "",
  customer = "",
  count = 1
} = {}) {
  const vault = readVault();
  const issued = [];
  const n = Math.max(1, Math.min(100, Number(count) || 1));
  for (let i = 0; i < n; i++) {
    const cust = String(customer || "").trim();
    const noteText = [cust && `KH:${cust}`, String(note || "").trim()].filter(Boolean).join(" | ").slice(0, 40);
    const { key, code, payload } = createLicenseKey({ type, days, note: noteText });
    const row = {
      id: payload.id,
      key,
      code,
      type: payload.t === "life" ? "lifetime" : "trial",
      days: payload.t === "life" ? null : payload.d,
      customer: cust,
      note: String(note || "").trim(),
      status: "issued",
      createdAt: Date.now()
    };
    vault.keys.unshift(row);
    issued.push(row);
  }
  writeVault(vault);
  return issued;
}

export function listLicenses({ q = "", status = "" } = {}) {
  const query = String(q || "").trim().toLowerCase();
  const st = String(status || "").trim().toLowerCase();
  return readVault().keys.filter(row => {
    if (st && row.status !== st) return false;
    if (!query) return true;
    const hay = [row.customer, row.note, row.key, row.code, row.id, row.type].join(" ").toLowerCase();
    return hay.includes(query);
  });
}

export function setLicenseStatus(id, status) {
  const vault = readVault();
  const row = vault.keys.find(k => k.id === id);
  if (!row) throw Object.assign(new Error("Không tìm thấy mã"), { status: 404 });
  row.status = status;
  if (status === "revoked") row.revokedAt = Date.now();
  if (status === "sold") row.soldAt = Date.now();
  writeVault(vault);
  return row;
}

export function exportLicensesCsv(rows = listLicenses()) {
  const header = ["id", "type", "days", "customer", "note", "status", "createdAt", "key"];
  const lines = [header.join(",")];
  for (const r of rows) {
    const cols = [
      r.id,
      r.type,
      r.days ?? "",
      JSON.stringify(r.customer || ""),
      JSON.stringify(r.note || ""),
      r.status,
      r.createdAt ? new Date(r.createdAt).toISOString() : "",
      r.key
    ];
    lines.push(cols.join(","));
  }
  return lines.join("\n");
}

export function getVaultFilePath() {
  return vaultPath();
}

export function verifyKeyInVault(raw) {
  const parsed = parseLicenseKey(raw);
  const row = readVault().keys.find(k =>
    k.id === parsed.payload?.id ||
    k.key === parsed.key ||
    (parsed.code && k.code === parsed.code)
  );
  return { key: parsed.key, payload: parsed.payload, record: row || null };
}
