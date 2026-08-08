#!/usr/bin/env node
/** Đồng bộ license-portal → api/ + lib/ (cho deploy Vercel từ root repo). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function cp(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`synced ${path.relative(root, src)} -> ${path.relative(root, dest)}`);
}

cp(path.join(root, "license-portal", "api"), path.join(root, "api"));
cp(path.join(root, "license-portal", "lib"), path.join(root, "lib"));
