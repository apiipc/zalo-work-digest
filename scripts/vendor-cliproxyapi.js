import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "build", "bundled-cliproxyapi");
const GITHUB_LATEST = "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest";

function targetPlatform() {
  return process.env.CPA_PLATFORM || process.platform;
}

function targetArch() {
  return process.env.CPA_ARCH || process.arch;
}

/** Map host → CLIProxyAPI release asset pattern */
function assetPattern(platform = targetPlatform(), arch = targetArch()) {
  if (platform === "win32") {
    return /windows_amd64\.zip$/i;
  }
  if (platform === "darwin") {
    if (arch === "arm64") return /darwin_aarch64\.tar\.gz$/i;
    return /darwin_amd64\.tar\.gz$/i;
  }
  if (platform === "linux") {
    if (arch === "arm64") return /linux_aarch64\.tar\.gz$/i;
    return /linux_amd64\.tar\.gz$/i;
  }
  return /windows_amd64\.zip$/i;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: { "user-agent": "ZaloWorkDigest-vendor", accept: "application/json" },
      timeout: 30000
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJson(res.headers.location).then(resolve, reject);
        res.resume();
        return;
      }
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}`));
        else {
          try { resolve(JSON.parse(body || "{}")); }
          catch (e) { reject(e); }
        }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: { "user-agent": "ZaloWorkDigest-vendor", accept: "*/*" },
      timeout: 180000
    }, async res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          await downloadFile(res.headers.location, dest);
          resolve();
        } catch (e) { reject(e); }
        res.resume();
        return;
      }
      if (res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      try {
        await pipeline(res, createWriteStream(dest));
        resolve();
      } catch (e) { reject(e); }
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("download timeout")); });
    req.on("error", reject);
  });
}

function findBinary(dir) {
  const winNames = ["cli-proxy-api.exe", "CLIProxyAPI.exe", "cliproxyapi.exe"];
  const unixNames = ["cli-proxy-api", "CLIProxyAPI", "cliproxyapi"];
  for (const name of [...winNames, ...unixNames]) {
    const full = path.join(dir, name);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  try {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      try {
        if (!fs.statSync(full).isFile()) continue;
      } catch { continue; }
      if (/cli.?proxy.?api/i.test(name) && !/\.(txt|md|yml|yaml|json|zip|gz)$/i.test(name)) {
        return full;
      }
    }
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const nested = findBinary(path.join(dir, ent.name));
      if (nested) return nested;
    }
  } catch {}
  return "";
}

function extractArchive(archivePath, dest) {
  if (/\.zip$/i.test(archivePath)) {
    if (process.platform === "win32") {
      const expand = spawnSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
        "-Command",
        `Expand-Archive -LiteralPath ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(dest)} -Force`
      ], { stdio: "inherit", windowsHide: true });
      return expand.status === 0;
    }
    const unzip = spawnSync("unzip", ["-o", archivePath, "-d", dest], { stdio: "inherit" });
    return unzip.status === 0;
  }
  // tar.gz
  const tar = spawnSync("tar", ["-xzf", archivePath, "-C", dest], { stdio: "inherit" });
  return tar.status === 0;
}

function flattenBinary(dest) {
  let bin = findBinary(dest);
  if (bin && path.dirname(bin) !== dest) {
    const nestedDir = path.dirname(bin);
    for (const name of fs.readdirSync(nestedDir)) {
      const from = path.join(nestedDir, name);
      const to = path.join(dest, name);
      try {
        if (fs.existsSync(to) && to !== from) fs.rmSync(to, { recursive: true, force: true });
        fs.renameSync(from, to);
      } catch {}
    }
    try { fs.rmSync(nestedDir, { recursive: true, force: true }); } catch {}
    bin = findBinary(dest);
  }
  if (bin && process.platform !== "win32") {
    try { fs.chmodSync(bin, 0o755); } catch {}
  }
  return bin;
}

async function main() {
  const platform = targetPlatform();
  const arch = targetArch();
  const pattern = assetPattern(platform, arch);

  fs.mkdirSync(outDir, { recursive: true });
  const existing = findBinary(outDir);
  // Nếu đã có binary đúng nền tảng thì bỏ qua (tránh giữ bản Windows khi build Mac)
  const existingOk = existing && (
    (platform === "win32" && /\.exe$/i.test(existing))
    || (platform !== "win32" && !/\.exe$/i.test(existing))
  );
  if (existingOk && process.env.FORCE_VENDOR_CPA !== "1") {
    console.log("Đã có CLIProxyAPI bundled:", existing);
    return;
  }

  // Xóa binary nền tảng khác trước khi tải
  if (existing && !existingOk) {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(outDir, { recursive: true });
  }

  console.log(`Đang tải CLIProxyAPI (${platform}/${arch}) từ GitHub Releases…`);
  const release = await fetchJson(GITHUB_LATEST);
  const asset = (release.assets || []).find(a => pattern.test(a.name));
  if (!asset?.browser_download_url) {
    console.error(`Không tìm thấy asset khớp ${pattern}`);
    process.exit(1);
  }

  const archiveName = asset.name;
  const archivePath = path.join(outDir, archiveName);
  await downloadFile(asset.browser_download_url, archivePath);

  if (!extractArchive(archivePath, outDir)) {
    console.error("Giải nén thất bại");
    process.exit(1);
  }

  const bin = flattenBinary(outDir);
  try { fs.unlinkSync(archivePath); } catch {}

  if (!bin) {
    console.error("Không thấy binary cli-proxy-api sau khi giải nén");
    process.exit(1);
  }

  fs.writeFileSync(
    path.join(outDir, "VERSION.txt"),
    `${release.tag_name || ""}\n${platform}/${arch}\n${archiveName}\n`,
    "utf8"
  );
  console.log(`Đã đóng gói CLIProxyAPI ${release.tag_name || ""} →`, bin);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
