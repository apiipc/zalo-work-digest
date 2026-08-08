#!/usr/bin/env node
/**
 * Tạo mã kích hoạt và lưu vào sổ quản lý (licenses/issued.json).
 *
 *   node scripts/generate-license.js --trial 5 --customer "Anh Hai"
 *   node scripts/generate-license.js --lifetime --customer "Cong ty A"
 *   node scripts/generate-license.js --list
 */
import { issueLicense, listLicenses, getVaultFilePath } from "../src/license-vault.js";

function parseArgs(argv) {
  const out = { type: "trial", days: 5, count: 1, note: "", customer: "", list: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lifetime" || a === "--life") out.type = "lifetime";
    else if (a === "--trial") {
      out.type = "trial";
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n)) { out.days = n; i++; }
    } else if (a === "--days") out.days = Number(argv[++i]) || 5;
    else if (a === "--count" || a === "-n") out.count = Math.max(1, Math.min(100, Number(argv[++i]) || 1));
    else if (a === "--note") out.note = String(argv[++i] || "");
    else if (a === "--customer" || a === "--khach") out.customer = String(argv[++i] || "");
    else if (a === "--list") out.list = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const opts = parseArgs(process.argv);
if (opts.help) {
  console.log(`Usage:
  npm run license:admin          # giao diện quản lý (khuyến nghị)
  node scripts/generate-license.js --trial 5 --customer "Anh Hai"
  node scripts/generate-license.js --lifetime --customer "Cong ty A"
  node scripts/generate-license.js --list
`);
  process.exit(0);
}

if (opts.list) {
  const rows = listLicenses();
  console.log(`Sổ mã: ${getVaultFilePath()}`);
  for (const r of rows) {
    const label = r.type === "lifetime" ? "VĨNH VIỄN" : `TRIAL ${r.days}d`;
    console.log(`${r.status}\t${label}\t${r.customer || "-"}\t${r.key}`);
  }
  process.exit(0);
}

const issued = issueLicense(opts);
for (const row of issued) {
  const label = row.type === "lifetime" ? "VĨNH VIỄN" : `DÙNG THỬ ${row.days} ngày`;
  console.log(`${label}\t${row.customer || "-"}\t${row.key}`);
}
console.log(`\nĐã lưu vào: ${getVaultFilePath()}`);
