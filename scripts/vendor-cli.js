import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "build", "bundled-cli");

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({
  name: "zalo-digest-bundled-cli",
  private: true,
  dependencies: {
    "@openai/codex": "latest",
    "@anthropic-ai/claude-code": "latest",
    "@google/gemini-cli": "latest"
  }
}, null, 2));

console.log("Đang cài CLI AI vào build/bundled-cli (có thể mất vài phút)…");
const result = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: outDir,
  shell: true,
  stdio: "inherit",
  env: process.env
});
if (result.status !== 0) {
  console.error("vendor:cli thất bại");
  process.exit(result.status || 1);
}
console.log("Đã đóng gói CLI vào", outDir);
