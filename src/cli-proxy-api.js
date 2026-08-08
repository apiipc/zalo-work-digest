import { spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { getBundledCliProxyApiRoot } from "./app-paths.js";

const require = createRequire(import.meta.url);

const CPA_PORT = 8317;
const CPA_BASE = `http://127.0.0.1:${CPA_PORT}`;
const CPA_V1 = `${CPA_BASE}/v1`;
const LOCAL_API_KEY = "zalo-digest-local";
const GITHUB_LATEST = "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest";

/** Thư mục ghi config (writable) — không ghi vào Program Files / .app bundle. */
function dataDir() {
  if (process.env.ZALO_DIGEST_USER_DATA) {
    return path.join(path.resolve(process.env.ZALO_DIGEST_USER_DATA), "CLIProxyAPI");
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "ZaloWorkDigest", "CLIProxyAPI");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "zalo-work-digest", "CLIProxyAPI");
  }
  return path.join(os.homedir(), ".config", "zalo-work-digest", "CLIProxyAPI");
}

function configPath() {
  return path.join(dataDir(), "config.yaml");
}

function authDir() {
  return path.join(os.homedir(), ".cli-proxy-api");
}

function pickExeInDir(dir) {
  if (!dir) return "";
  const candidates = process.platform === "win32"
    ? [
      path.join(dir, "cli-proxy-api.exe"),
      path.join(dir, "CLIProxyAPI.exe"),
      path.join(dir, "cliproxyapi.exe")
    ]
    : [
      path.join(dir, "cli-proxy-api"),
      path.join(dir, "CLIProxyAPI"),
      path.join(dir, "cliproxyapi")
    ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  try {
    for (const name of fs.readdirSync(dir)) {
      if (/cli.?proxy.?api/i.test(name) && !/\.(txt|md|yml|yaml|json|zip|gz)$/i.test(name)) {
        const full = path.join(dir, name);
        try {
          if (fs.statSync(full).isFile()) return full;
        } catch {}
      }
    }
  } catch {}
  return "";
}

function findExe() {
  const bundled = pickExeInDir(getBundledCliProxyApiRoot());
  if (bundled) return bundled;
  return pickExeInDir(dataDir());
}

function isBundled() {
  return Boolean(pickExeInDir(getBundledCliProxyApiRoot()));
}

function openExternal(url) {
  try {
    if (process.versions.electron) {
      const { shell } = require("electron");
      Promise.resolve(shell.openExternal(url)).catch(() => {});
      return;
    }
  } catch {}
  if (process.platform === "win32") {
    spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
      "-Command", `Start-Process -FilePath (${JSON.stringify(url)})`
    ], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

function runHidden(command, args, { timeoutMs = 300000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      env: process.env,
      cwd: cwd || dataDir(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`Hết thời gian chờ (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);
    child.stdout?.on("data", c => { stdout += c; });
    child.stderr?.on("data", c => { stderr += c; });
    child.on("error", err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim() });
    });
  });
}

function fetchJson(url, { headers = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: { "user-agent": "ZaloWorkDigest", accept: "application/json", ...headers },
      timeout: timeoutMs
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJson(res.headers.location, { headers, timeoutMs }).then(resolve, reject);
        res.resume();
        return;
      }
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(body || "{}")); }
        catch (error) { reject(error); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Hết thời gian chờ mạng")); });
    req.on("error", reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: { "user-agent": "ZaloWorkDigest", accept: "*/*" },
      timeout: 120000
    }, async res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          await downloadFile(res.headers.location, dest);
          resolve();
        } catch (error) {
          reject(error);
        }
        res.resume();
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`Tải thất bại HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      try {
        await pipeline(res, createWriteStream(dest));
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Hết thời gian tải file")); });
    req.on("error", reject);
  });
}

function ensureConfig() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(authDir(), { recursive: true });
  const cfg = configPath();
  if (fs.existsSync(cfg)) return;
  const authPath = authDir().replace(/\\/g, "/");
  const yaml = [
    'host: "127.0.0.1"',
    `port: ${CPA_PORT}`,
    `auth-dir: "${authPath}"`,
    "api-keys:",
    `  - "${LOCAL_API_KEY}"`,
    "debug: false",
    "remote-management:",
    "  allow-remote: false",
    '  secret-key: ""',
    "  disable-control-panel: false",
    ""
  ].join("\n");
  fs.writeFileSync(cfg, yaml, "utf8");
}

function hasAuthTokens() {
  try {
    const dir = authDir();
    if (!fs.existsSync(dir)) return false;
    const names = fs.readdirSync(dir);
    return names.some(name => /\.(json|token|yaml|yml)$/i.test(name) || /oauth|auth|credential|token/i.test(name));
  } catch {
    return false;
  }
}

async function pingCpa() {
  try {
    const res = await fetch(`${CPA_V1}/models`, {
      headers: { authorization: `Bearer ${LOCAL_API_KEY}`, accept: "application/json" },
      signal: AbortSignal.timeout(2500)
    });
    return res.status < 500;
  } catch {
    try {
      const res = await fetch(`${CPA_BASE}/`, { signal: AbortSignal.timeout(2000) });
      return res.status < 500;
    } catch {
      return false;
    }
  }
}

async function probeModels() {
  try {
    const res = await fetch(`${CPA_V1}/models`, {
      headers: { authorization: `Bearer ${LOCAL_API_KEY}`, accept: "application/json" },
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json().catch(() => ({}));
    const models = Array.isArray(json?.data) ? json.data.map(m => m.id).filter(Boolean) : [];
    return { ok: true, models };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function cliProxyApiDefaults() {
  return {
    provider: "cliproxyapi",
    baseUrl: CPA_V1,
    model: "gemini-2.5-flash",
    apiKey: LOCAL_API_KEY
  };
}

export async function getCliProxyApiStatus() {
  const exe = findExe();
  const bundled = isBundled();
  const installed = Boolean(exe);
  const running = await pingCpa();
  const loggedIn = hasAuthTokens();
  let models = [];
  let ready = false;
  if (running) {
    const probe = await probeModels();
    if (probe.ok) {
      models = probe.models || [];
      ready = models.length > 0 || loggedIn;
    }
  }
  let message;
  if (!installed) {
    message = "Chưa có AI brain trong app. Build lại bản cài hoặc bấm Cập nhật.";
  } else if (!running) {
    message = bundled
      ? "AI brain đã có sẵn trong app — bấm Khởi động, rồi Đăng nhập tài khoản."
      : "Đã có AI brain — bấm Khởi động, rồi Đăng nhập tài khoản.";
  } else if (!loggedIn && models.length === 0) {
    message = "AI brain đang chạy — hãy Đăng nhập Google/ChatGPT/Claude, rồi Quét lại.";
  } else {
    message = "AI brain sẵn sàng.";
  }
  return {
    ok: true,
    installed,
    bundled,
    running,
    loggedIn,
    ready: Boolean(running && (ready || loggedIn)),
    baseUrl: CPA_V1,
    apiKey: LOCAL_API_KEY,
    installPath: bundled ? getBundledCliProxyApiRoot() : dataDir(),
    models: models.slice(0, 12),
    message
  };
}

/** Fallback khi bản app chưa kèm binary — tải về thư mục user. */
export async function installCliProxyApi() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  if (isBundled()) {
    ensureConfig();
    return {
      ok: true,
      bundled: true,
      installPath: getBundledCliProxyApiRoot(),
      message: "AI brain đã được đóng gói trong app. Bấm Khởi động rồi Đăng nhập."
    };
  }
  const release = await fetchJson(GITHUB_LATEST);
  let pattern = /windows_amd64\.zip$/i;
  if (process.platform === "darwin") {
    pattern = process.arch === "arm64" ? /darwin_aarch64\.tar\.gz$/i : /darwin_amd64\.tar\.gz$/i;
  } else if (process.platform === "linux") {
    pattern = process.arch === "arm64" ? /linux_aarch64\.tar\.gz$/i : /linux_amd64\.tar\.gz$/i;
  }
  const asset = (release.assets || []).find(a => pattern.test(a.name));
  if (!asset?.browser_download_url) {
    throw new Error("Không tìm thấy bản CLIProxyAPI phù hợp với máy này.");
  }
  const archivePath = path.join(dir, asset.name);
  await downloadFile(asset.browser_download_url, archivePath);
  if (/\.zip$/i.test(asset.name)) {
    if (process.platform === "win32") {
      const expand = await runHidden("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
        "-Command",
        `Expand-Archive -LiteralPath ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(dir)} -Force`
      ], { timeoutMs: 120000, cwd: dir });
      if (expand.code !== 0) throw new Error(expand.stderr || expand.stdout || "Giải nén AI brain thất bại");
    } else {
      const expand = await runHidden("unzip", ["-o", archivePath, "-d", dir], { timeoutMs: 120000, cwd: dir });
      if (expand.code !== 0) throw new Error(expand.stderr || "Giải nén AI brain thất bại");
    }
  } else {
    const expand = await runHidden("tar", ["-xzf", archivePath, "-C", dir], { timeoutMs: 120000, cwd: dir });
    if (expand.code !== 0) throw new Error(expand.stderr || "Giải nén AI brain thất bại");
  }
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const nested = entries.find(e => e.isDirectory() && /cliproxy|CLIProxy/i.test(e.name));
    if (nested && !pickExeInDir(dir)) {
      const nestedPath = path.join(dir, nested.name);
      for (const name of fs.readdirSync(nestedPath)) {
        const from = path.join(nestedPath, name);
        const to = path.join(dir, name);
        try { fs.renameSync(from, to); } catch {}
      }
    }
  } catch {}
  const bin = pickExeInDir(dir);
  if (bin && process.platform !== "win32") {
    try { fs.chmodSync(bin, 0o755); } catch {}
  }
  ensureConfig();
  if (!findExe()) {
    throw new Error("Đã tải nhưng không thấy binary cli-proxy-api.");
  }
  try { fs.unlinkSync(archivePath); } catch {}
  return {
    ok: true,
    version: release.tag_name || "",
    installPath: dir,
    message: `Đã tải AI brain ${release.tag_name || ""}. Bấm Khởi động rồi Đăng nhập.`
  };
}

export async function startCliProxyApi() {
  ensureConfig();
  const exe = findExe();
  if (!exe) throw new Error("Không tìm thấy AI brain trong app. Hãy cài lại bản Zalo Work Digest mới.");
  if (await pingCpa()) {
    return { ok: true, alreadyRunning: true, baseUrl: CPA_V1, message: "AI brain đang chạy." };
  }
  const child = spawn(exe, ["-config", configPath()], {
    windowsHide: true,
    detached: false,
    stdio: "ignore",
    cwd: dataDir(),
    env: process.env
  });
  // Giữ process gắn với app — tắt app sẽ tắt AI brain, gỡ cài không bị khóa file.
  try {
    fs.writeFileSync(path.join(dataDir(), "cli-proxy-api.pid"), String(child.pid || ""), "utf8");
  } catch {}
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 400));
    if (await pingCpa()) {
      return {
        ok: true,
        alreadyRunning: false,
        baseUrl: CPA_V1,
        message: "Đã khởi động AI brain. Hãy Đăng nhập Google/ChatGPT/Claude rồi Kết nối."
      };
    }
  }
  return {
    ok: true,
    starting: true,
    baseUrl: CPA_V1,
    message: "Đã chạy AI brain (đang khởi động). Đợi vài giây rồi Quét lại."
  };
}

/** Tắt AI brain (cli-proxy-api) — gọi khi thoát app / trước khi gỡ cài. */
export function stopCliProxyApi() {
  const pidFile = path.join(dataDir(), "cli-proxy-api.pid");
  try {
    if (fs.existsSync(pidFile)) {
      const pid = Number(String(fs.readFileSync(pidFile, "utf8") || "").trim());
      if (pid > 0) {
        try { process.kill(pid); } catch {}
      }
      try { fs.unlinkSync(pidFile); } catch {}
    }
  } catch {}
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/IM", "cli-proxy-api.exe", "/T"], {
        windowsHide: true,
        detached: true,
        stdio: "ignore"
      }).unref();
    } catch {}
  } else {
    try {
      spawn("pkill", ["-f", "cli-proxy-api"], {
        detached: true,
        stdio: "ignore"
      }).unref();
    } catch {}
  }
}

export async function loginCliProxyApi(provider = "antigravity") {
  ensureConfig();
  const exe = findExe();
  if (!exe) throw new Error("Không tìm thấy AI brain trong app.");
  if (!(await pingCpa())) {
    await startCliProxyApi();
  }
  const map = {
    antigravity: "-antigravity-login",
    google: "-antigravity-login",
    gemini: "-antigravity-login",
    codex: "-codex-login",
    openai: "-codex-login",
    chatgpt: "-codex-login",
    claude: "-claude-login",
    anthropic: "-claude-login"
  };
  const flag = map[String(provider || "antigravity").toLowerCase()] || "-antigravity-login";
  const labels = {
    "-antigravity-login": "Google (Antigravity)",
    "-codex-login": "ChatGPT / Codex",
    "-claude-login": "Claude"
  };
  const result = await runHidden(exe, [flag, "-config", configPath()], {
    timeoutMs: 180000,
    cwd: dataDir()
  });
  if (result.code !== 0 && !hasAuthTokens()) {
    throw new Error(result.stderr || result.stdout || `Đăng nhập ${labels[flag] || provider} thất bại`);
  }
  return {
    ok: true,
    provider,
    message: `Đã xử lý đăng nhập ${labels[flag] || provider}. Nếu trình duyệt đã xong, bấm Quét lại / Kết nối.`
  };
}

export async function connectCliProxyApi() {
  const status = await getCliProxyApiStatus();
  if (!status.installed) throw new Error("Không tìm thấy AI brain trong app.");
  if (!status.running) {
    await startCliProxyApi();
  }
  const probe = await probeModels();
  if (!probe.ok && !hasAuthTokens()) {
    throw new Error("AI brain chưa có tài khoản. Bấm Đăng nhập Google/ChatGPT/Claude trước.");
  }
  const models = probe.models || [];
  const model = models.find(id => /gemini|flash|gpt|claude|codex/i.test(id))
    || models[0]
    || "gemini-2.5-flash";
  return {
    ok: true,
    provider: "cliproxyapi",
    baseUrl: CPA_V1,
    model,
    apiKey: LOCAL_API_KEY,
    models,
    message: "Đã kết nối AI brain. Tài khoản đã đăng nhập sẽ dùng cho báo cáo."
  };
}
