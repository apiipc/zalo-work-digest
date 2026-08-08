#!/usr/bin/env node
/** Đồng bộ api/ + lib/ (deploy Vercel) → license-portal/ (bản mirror trong repo). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function cp(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`synced ${path.relative(root, src)} -> ${path.relative(root, dest)}`);
}

cp(path.join(root, "api"), path.join(root, "license-portal", "api"));
cp(path.join(root, "lib"), path.join(root, "license-portal", "lib"));
