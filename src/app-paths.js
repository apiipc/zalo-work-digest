import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

/** Thư mục gốc app (public/, package.json). Packaged: resources/app hoặc asar. */
export function getAppRoot() {
  if (process.env.ZALO_DIGEST_ROOT) return path.resolve(process.env.ZALO_DIGEST_ROOT);
  if (process.versions.electron && process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, "app");
    if (exists(path.join(packaged, "public"))) return packaged;
    // asar: app.getAppPath() được truyền qua env từ main
    if (process.env.ZALO_DIGEST_APP_PATH) return path.resolve(process.env.ZALO_DIGEST_APP_PATH);
  }
  return projectRoot;
}

/** Nơi ghi data-path.json (không nằm trong Program Files khi packaged). */
export function getConfigDir(appRoot = getAppRoot()) {
  if (process.env.ZALO_DIGEST_CONFIG_DIR) return path.resolve(process.env.ZALO_DIGEST_CONFIG_DIR);
  if (process.env.ZALO_DIGEST_USER_DATA) {
    return path.join(path.resolve(process.env.ZALO_DIGEST_USER_DATA), "config");
  }
  return path.join(appRoot, "config");
}

/** CLI AI đóng gói sẵn (extraResources/cli). */
export function getBundledCliRoot() {
  if (process.env.ZALO_DIGEST_CLI_ROOT) return path.resolve(process.env.ZALO_DIGEST_CLI_ROOT);
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "cli"));
  if (process.execPath) {
    candidates.push(path.join(path.dirname(process.execPath), "resources", "cli"));
  }
  const dev = path.join(projectRoot, "build", "bundled-cli");
  candidates.push(dev);
  for (const p of candidates) {
    if (exists(path.join(p, "node_modules"))) return p;
  }
  return "";
}

/** CLIProxyAPI đóng gói sẵn (extraResources/cliproxyapi). */
export function getBundledCliProxyApiRoot() {
  if (process.env.ZALO_DIGEST_CLIPROXYAPI_ROOT) {
    return path.resolve(process.env.ZALO_DIGEST_CLIPROXYAPI_ROOT);
  }
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "cliproxyapi"));
  if (process.execPath) {
    candidates.push(path.join(path.dirname(process.execPath), "resources", "cliproxyapi"));
    // macOS: .../App.app/Contents/MacOS → ../Resources/cliproxyapi
    candidates.push(path.join(path.dirname(process.execPath), "..", "Resources", "cliproxyapi"));
  }
  candidates.push(path.join(projectRoot, "build", "bundled-cliproxyapi"));
  for (const p of candidates) {
    if (
      exists(path.join(p, "cli-proxy-api.exe"))
      || exists(path.join(p, "CLIProxyAPI.exe"))
      || exists(path.join(p, "cliproxyapi.exe"))
      || exists(path.join(p, "cli-proxy-api"))
      || exists(path.join(p, "CLIProxyAPI"))
      || exists(path.join(p, "cliproxyapi"))
    ) {
      return p;
    }
    try {
      const names = fs.readdirSync(p);
      if (names.some(n => /cli.?proxy.?api/i.test(n) && !/\.(txt|md|yml|yaml|json)$/i.test(n))) {
        return p;
      }
    } catch {}
  }
  return "";
}

export function getDefaultDocumentsDataDir() {
  const home = process.env.USERPROFILE || process.env.HOME || projectRoot;
  return path.join(home, "Documents", "ZaloWorkDigest");
}
