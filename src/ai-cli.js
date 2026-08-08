import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getBundledCliRoot } from "./app-paths.js";

const require = createRequire(import.meta.url);

const CLI_TOOLS = [
  {
    id: "codex-cli",
    name: "ChatGPT / Codex",
    command: "codex",
    npmPackage: "@openai/codex",
    installHint: "npm install -g @openai/codex",
    loginHint: "Bấm Đăng nhập để mở trang ChatGPT trên trình duyệt",
    loginArgs: ["login"],
    statusArgs: ["login", "status"],
    authPaths: [path.join(os.homedir(), ".codex", "auth.json")],
    args: ["exec", "--skip-git-repo-check", "-"],
    stdinMode: "prompt"
  },
  {
    id: "claude-cli",
    name: "Claude",
    command: "claude",
    npmPackage: "@anthropic-ai/claude-code",
    installHint: "npm install -g @anthropic-ai/claude-code",
    loginHint: "Bấm Đăng nhập để mở xác thực Claude trên trình duyệt",
    loginArgs: ["auth", "login"],
    statusArgs: ["auth", "status"],
    authPaths: [
      path.join(os.homedir(), ".claude", ".credentials.json"),
      path.join(os.homedir(), ".config", "claude", "credentials.json")
    ],
    args: [
      "-p", "Hãy thực hiện đúng yêu cầu trong stdin. Chỉ trả về nội dung báo cáo tiếng Việt, không chạy lệnh hay sửa file.",
      "--bare",
      "--permission-mode", "dontAsk",
      "--output-format", "text"
    ],
    stdinMode: "prompt"
  },
  {
    id: "antigravity-cli",
    name: "Antigravity (Gemini)",
    command: "agy",
    npmPackage: "",
    wingetId: "Google.AntigravityCLI",
    installHint: "winget install --id Google.AntigravityCLI",
    loginHint: "Bấm Đăng nhập — app mở Google OAuth cho Antigravity CLI (thay Gemini CLI).",
    loginArgs: null,
    statusArgs: null,
    authPaths: [
      path.join(os.homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token"),
      path.join(os.homedir(), ".gemini", "antigravity-cli", "oauth_token"),
      path.join(os.homedir(), ".gemini", "antigravity-cli", "credentials.json")
    ],
    // --model trước -p; -p nhận chuỗi prompt (không dùng stdin).
    args: ["--dangerously-skip-permissions", "--output-format", "text", "--print-timeout", "3m"],
    promptFlag: "-p",
    stdinMode: "none"
  }
];

const PROVIDER_ALIASES = {
  "gemini-cli": "antigravity-cli"
};

const pendingCliLogins = new Map();

const BUNDLED_CLI_ENTRY = {
  codex: { type: "js", rel: "@openai/codex/bin/codex.js" },
  claude: { type: "exe", rel: "@anthropic-ai/claude-code/bin/claude.exe" }
};

export function normalizeCliProvider(provider) {
  const id = String(provider || "").toLowerCase();
  return PROVIDER_ALIASES[id] || id;
}

function findCliTool(provider) {
  const id = normalizeCliProvider(provider);
  return CLI_TOOLS.find(item => item.id === id) || null;
}

function resolveSystemBinary(command) {
  if (command !== "agy") return "";
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const candidates = [
    path.join(local, "Microsoft", "WinGet", "Links", "agy.exe"),
    path.join(local, "agy", "bin", "agy.exe"),
    path.join(local, "Programs", "agy", "agy.exe")
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  try {
    const packages = path.join(local, "Microsoft", "WinGet", "Packages");
    if (!fs.existsSync(packages)) return "";
    for (const dir of fs.readdirSync(packages)) {
      if (!/AntigravityCLI/i.test(dir)) continue;
      const exe = path.join(packages, dir, "agy.exe");
      if (fs.existsSync(exe)) return exe;
    }
  } catch {}
  return "";
}

function bundledEntry(command) {
  const root = getBundledCliRoot();
  const spec = BUNDLED_CLI_ENTRY[command];
  if (!root || !spec) return null;
  const full = path.join(root, "node_modules", spec.rel);
  if (!fs.existsSync(full)) return null;
  return { ...spec, path: full, root };
}

function bundledBin(command) {
  const entry = bundledEntry(command);
  if (entry) return entry.path;
  const root = getBundledCliRoot();
  if (!root) return "";
  const binDir = path.join(root, "node_modules", ".bin");
  const names = process.platform === "win32"
    ? [`${command}.cmd`, `${command}.exe`, command]
    : [command];
  for (const name of names) {
    const full = path.join(binDir, name);
    if (fs.existsSync(full)) return full;
  }
  return "";
}

function resolveCliCommand(command) {
  return bundledBin(command) || resolveSystemBinary(command) || command;
}

function isBundledCli(command) {
  return Boolean(bundledEntry(command) || bundledBin(command));
}

function nodeRunner() {
  if (process.versions.electron) return process.execPath;
  return process.execPath;
}

function spawnCli(command, args, { detached = false, windowsHide = true, stdio, env } = {}) {
  const entry = bundledEntry(command);
  const finalEnv = env || (command === "agy" ? agyAuthEnv() : cliEnv());
  const opts = {
    detached,
    windowsHide,
    env: finalEnv,
    cwd: os.homedir(),
    stdio: stdio || (detached ? "ignore" : "pipe")
  };

  if (entry?.type === "exe") {
    return spawn(entry.path, args, { ...opts, shell: false });
  }
  if (entry?.type === "js") {
    finalEnv.ELECTRON_RUN_AS_NODE = "1";
    return spawn(nodeRunner(), [entry.path, ...args], { ...opts, shell: false });
  }

  const resolved = resolveCliCommand(command);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    return spawn("cmd.exe", ["/d", "/s", "/c", resolved, ...args], { ...opts, shell: false });
  }
  return spawn(resolved, args, { ...opts, shell: false });
}

function cliEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  const root = getBundledCliRoot();
  if (root) {
    const bin = path.join(root, "node_modules", ".bin");
    const joined = `${bin}${path.delimiter}${env.PATH || env.Path || ""}`;
    env.PATH = joined;
    env.Path = joined;
  }
  const agy = resolveSystemBinary("agy");
  if (agy) {
    const dir = path.dirname(agy);
    const joined = `${dir}${path.delimiter}${env.PATH || env.Path || ""}`;
    env.PATH = joined;
    env.Path = joined;
  }
  return env;
}

function agyAuthEnv() {
  // Ép lưu token ra file thay vì Windows Credential Manager — dễ phát hiện đăng nhập.
  return cliEnv({
    SSH_CONNECTION: "127.0.0.1 22 127.0.0.1 22",
    SSH_CLIENT: "127.0.0.1 59500 22",
    SSH_TTY: "notty"
  });
}

export function isCliProvider(provider) {
  return Boolean(findCliTool(provider));
}

function extractSemver(text) {
  const match = String(text || "").match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : "";
}

export function listCliTools() {
  return CLI_TOOLS.map(tool => ({
    id: tool.id,
    name: tool.name,
    command: tool.command,
    loginHint: tool.loginHint,
    installHint: tool.installHint,
    npmPackage: tool.npmPackage || "",
    canBrowserLogin: Boolean(tool.loginArgs) || tool.id === "antigravity-cli",
    canAutoInstall: Boolean(tool.npmPackage) || Boolean(tool.wingetId) || isBundledCli(tool.command)
  }));
}

function runProcess(command, args, { input = "", timeoutMs = 180000, allowEmpty = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCli(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`CLI AI hết thời gian chờ (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);

    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr?.on("data", chunk => { stderr += chunk; });
    child.on("error", error => {
      clearTimeout(timer);
      reject(new Error(`Không chạy được lệnh ${command}: ${error.message}`));
    });
    child.on("close", code => {
      clearTimeout(timer);
      const text = String(stdout || "").trim();
      const errText = String(stderr || "").trim();
      const combined = text || errText;
      if (combined) return resolve({ code, stdout: combined, stderr: errText });
      if (allowEmpty && code === 0) return resolve({ code, stdout: "", stderr: errText });
      reject(new Error(errText.slice(0, 400) || `CLI ${command} thoát với mã ${code ?? "?"}`));
    });

    if (input && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

async function probeCommand(command) {
  if (bundledEntry(command)) {
    try {
      const out = await runProcess(command, ["--version"], { timeoutMs: 12000, allowEmpty: true });
      const rawVersion = out.stdout.split(/\r?\n/).find(Boolean) || "đã cài";
      return { installed: true, version: rawVersion, semver: extractSemver(rawVersion) };
    } catch (error) {
      return { installed: false, error: error.message };
    }
  }
  try {
    const out = await runProcess(command, ["--version"], { timeoutMs: 8000, allowEmpty: true });
    const rawVersion = out.stdout.split(/\r?\n/).find(Boolean) || "đã cài";
    return { installed: true, version: rawVersion, semver: extractSemver(rawVersion) };
  } catch (error) {
    return { installed: false, error: error.message };
  }
}

function antigravityTokenFiles() {
  const root = path.join(os.homedir(), ".gemini", "antigravity-cli");
  const found = [];
  const names = [
    "antigravity-oauth-token",
    "oauth_token",
    "oauth-token",
    "credentials.json",
    "auth.json",
    "token.json",
    "tokens.json"
  ];
  for (const name of names) {
    const full = path.join(root, name);
    if (fs.existsSync(full)) found.push(full);
  }
  try {
    if (!fs.existsSync(root)) return found;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (/oauth|token|cred|auth/i.test(entry.name) && !/\.(log|lock|txt|md|db)$/i.test(entry.name)) {
        found.push(path.join(root, entry.name));
      }
    }
  } catch {}
  return [...new Set(found)];
}

function hasAuthFiles(paths = []) {
  return paths.some(file => {
    try { return fs.existsSync(file) && fs.statSync(file).size > 8; } catch { return false; }
  });
}

function probeAuthFiles(tool) {
  const paths = tool.id === "antigravity-cli"
    ? [...(tool.authPaths || []), ...antigravityTokenFiles()]
    : (tool.authPaths || []);
  for (const file of paths) {
    try {
      if (!fs.existsSync(file) || fs.statSync(file).size <= 8) continue;
      if (tool.id === "codex-cli") {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        if (data?.auth_mode === "chatgpt" && data?.tokens) {
          return { loggedIn: true, detail: "Đã đăng nhập ChatGPT/Codex" };
        }
        if (data?.OPENAI_API_KEY) {
          return { loggedIn: true, detail: "Đã có API key Codex" };
        }
      }
      if (tool.id === "claude-cli") {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        if (data && typeof data === "object" && Object.keys(data).length) {
          return { loggedIn: true, detail: "Đã đăng nhập Claude" };
        }
      }
      if (tool.id === "antigravity-cli") {
        return { loggedIn: true, detail: "Đã có phiên Antigravity cục bộ" };
      }
      return { loggedIn: true, detail: "Đã có phiên đăng nhập cục bộ" };
    } catch {}
  }
  return null;
}

async function probeLogin(tool, { lightweight = false } = {}) {
  if (process.env.ANTIGRAVITY_API_KEY || process.env.ANTIGRAVITY_TOKEN || process.env.GEMINI_API_KEY) {
    if (tool.id === "antigravity-cli") {
      return { loggedIn: true, detail: "Đã có API key Antigravity/Gemini trong môi trường" };
    }
  }

  const fromFiles = probeAuthFiles(tool);
  if (fromFiles) return fromFiles;
  if (lightweight) return { loggedIn: false, detail: "Chưa đăng nhập" };

  if (tool.statusArgs) {
    try {
      const out = await runProcess(tool.command, tool.statusArgs, { timeoutMs: 15000, allowEmpty: true });
      const text = `${out.stdout}\n${out.stderr}`.toLowerCase();
      if (/logged in|signed in|authenticated|chatgpt|ok/.test(text) && !/not logged|logged out|unauthenticated/.test(text)) {
        return { loggedIn: true, detail: (out.stdout || out.stderr).split(/\r?\n/).find(Boolean) || "Đã đăng nhập" };
      }
      if (out.code === 0 && hasAuthFiles(tool.authPaths)) {
        return { loggedIn: true, detail: out.stdout.split(/\r?\n/).find(Boolean) || "Đã đăng nhập" };
      }
    } catch {}
  }
  if (hasAuthFiles(tool.authPaths)) {
    return { loggedIn: true, detail: "Đã có phiên đăng nhập cục bộ" };
  }
  return { loggedIn: false, detail: "Chưa đăng nhập" };
}

export async function waitForCliLogin(provider, { timeoutMs = 90000, intervalMs = 3000 } = {}) {
  const tool = findCliTool(provider);
  if (!tool) throw new Error("CLI AI không hợp lệ");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const login = await probeLogin(tool, { lightweight: true });
    if (login.loggedIn) {
      const readiness = await getCliReadiness(tool.id);
      return { ok: true, provider: tool.id, readiness, message: "Đã nhận đăng nhập CLI." };
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error("Chưa thấy đăng nhập CLI. Hoàn tất trên trình duyệt rồi bấm Quét lại.");
}

function buildCliDetection(tool, probe, login) {
  const bundled = isBundledCli(tool.command);
  const ready = probe.installed && login.loggedIn;
  return {
    id: tool.id,
    name: tool.name,
    command: tool.command,
    loginHint: tool.loginHint,
    installHint: bundled ? "CLI đã đóng gói sẵn trong ứng dụng — chỉ cần đăng nhập." : tool.installHint,
    npmPackage: tool.npmPackage || "",
    canBrowserLogin: Boolean(tool.loginArgs) || tool.id === "antigravity-cli",
    canAutoInstall: Boolean(tool.npmPackage) || Boolean(tool.wingetId) || bundled,
    bundled,
    installed: probe.installed,
    loggedIn: login.loggedIn,
    ready,
    version: probe.version || "",
    detail: probe.installed
      ? (bundled ? `${login.detail} (bản đóng gói trong app)` : login.detail)
      : (tool.installHint || probe.error || "Chưa tìm thấy lệnh"),
    error: probe.installed ? "" : (probe.error || "Chưa tìm thấy lệnh")
  };
}

export async function detectSingleCli(provider) {
  const tool = findCliTool(provider);
  if (!tool) return null;
  const probe = await probeCommand(tool.command);
  const login = probe.installed ? await probeLogin(tool) : { loggedIn: false, detail: "Chưa cài CLI" };
  return buildCliDetection(tool, probe, login);
}

export async function getCliLoginStatus(provider) {
  const tool = findCliTool(provider);
  if (!tool) throw new Error("CLI AI không hợp lệ");
  const login = await probeLogin(tool, { lightweight: true });
  const installed = Boolean(resolveCliCommand(tool.command) && (bundledEntry(tool.command) || resolveSystemBinary(tool.command) || isBundledCli(tool.command)));
  const probe = await probeCommand(tool.command);
  return {
    provider: tool.id,
    installed: probe.installed || installed,
    loggedIn: login.loggedIn,
    ready: (probe.installed || installed) && login.loggedIn,
    detail: login.detail
  };
}

export async function detectAiCli() {
  const results = [];
  for (const tool of CLI_TOOLS) {
    const probe = await probeCommand(tool.command);
    const login = probe.installed ? await probeLogin(tool) : { loggedIn: false, detail: "Chưa cài CLI" };
    results.push(buildCliDetection(tool, probe, login));
  }
  return results;
}

export async function getCliReadiness(provider) {
  return detectSingleCli(provider);
}

export async function installCli(provider) {
  const tool = findCliTool(provider);
  if (!tool) throw new Error("CLI AI không hợp lệ");

  const before = await probeCommand(tool.command);
  if (before.installed) {
    return {
      ok: true,
      provider: tool.id,
      alreadyInstalled: true,
      bundled: isBundledCli(tool.command),
      version: before.version,
      message: isBundledCli(tool.command)
        ? `${tool.name} đã có sẵn trong bộ cài (${before.version}).`
        : `${tool.name} đã có sẵn (${before.version}).`
    };
  }

  if (tool.wingetId) {
    if (process.platform !== "win32") {
      throw new Error(`${tool.name} trên máy này cần cài thủ công. Xem: https://antigravity.google/docs/cli/getting-started`);
    }
    try {
      await runProcess("winget", [
        "install", "--id", tool.wingetId, "-e",
        "--accept-package-agreements", "--accept-source-agreements"
      ], { timeoutMs: 420000, allowEmpty: true });
    } catch (error) {
      throw new Error(`Cài ${tool.name} qua winget thất bại: ${error.message}`);
    }
    const afterWinget = await probeCommand(tool.command);
    if (!afterWinget.installed) {
      throw new Error(`Đã chạy winget nhưng chưa thấy lệnh ${tool.command}. Hãy mở lại app hoặc kiểm tra PATH.`);
    }
    return {
      ok: true,
      provider: tool.id,
      alreadyInstalled: false,
      version: afterWinget.version,
      message: `Đã cài ${tool.name} (${afterWinget.version}). Tiếp theo hãy đăng nhập.`
    };
  }

  if (bundledEntry(tool.command) || (process.env.ZALO_DIGEST_PACKAGED === "1" && !tool.npmPackage)) {
    throw new Error(
      bundledEntry(tool.command)
        ? `${tool.name} có trong bộ cài nhưng chưa chạy được. Hãy khởi động lại app hoặc cài lại bản Setup mới nhất.`
        : `${tool.name} chưa có trong bộ cài. Hãy cài lại app từ file Setup mới nhất.`
    );
  }

  if (!tool.npmPackage) throw new Error(`${tool.name} chưa hỗ trợ cài tự động. ${tool.installHint}`);

  try {
    await runProcess("npm", ["install", "-g", tool.npmPackage], { timeoutMs: 420000, allowEmpty: true });
  } catch (error) {
    throw new Error(`Cài ${tool.name} thất bại: ${error.message}`);
  }

  const after = await probeCommand(tool.command);
  if (!after.installed) {
    throw new Error(`Đã chạy npm install nhưng chưa thấy lệnh ${tool.command}. Hãy mở lại app hoặc kiểm tra PATH.`);
  }
  return {
    ok: true,
    provider: tool.id,
    alreadyInstalled: false,
    version: after.version,
    message: `Đã cài ${tool.name} (${after.version}). Tiếp theo hãy đăng nhập.`
  };
}

async function latestNpmVersion(npmPackage) {
  if (!npmPackage) return "";
  try {
    const out = await runProcess("npm", ["view", npmPackage, "version"], { timeoutMs: 15000 });
    return String(out.stdout || "").trim().split(/\r?\n/).pop() || "";
  } catch {
    return "";
  }
}

export async function checkCliCompatibility(provider) {
  const tool = findCliTool(provider);
  if (!tool) throw new Error("CLI AI không hợp lệ");

  const probe = await probeCommand(tool.command);
  if (!probe.installed) {
    return {
      ok: true,
      provider: tool.id,
      compatible: false,
      installed: false,
      command: tool.command,
      reason: `Chưa tìm thấy lệnh ${tool.command}`,
      latestVersion: tool.npmPackage ? await latestNpmVersion(tool.npmPackage) : "",
      updateAvailable: false
    };
  }

  const login = await probeLogin(tool);
  const latest = tool.npmPackage ? await latestNpmVersion(tool.npmPackage) : "";
  const installedSemver = probe.semver || "";
  const updateAvailable = Boolean(latest && installedSemver && latest !== installedSemver);
  const statusCheck = Boolean(tool.statusArgs);
  const compatible = Boolean(probe.installed && (login.loggedIn || statusCheck || tool.id === "antigravity-cli"));

  return {
    ok: true,
    provider: tool.id,
    name: tool.name,
    command: tool.command,
    installed: probe.installed,
    installedVersion: probe.version || "",
    installedSemver,
    latestVersion: latest,
    updateAvailable,
    loggedIn: login.loggedIn,
    statusCheck,
    compatible,
    reason: compatible
      ? "CLI tương thích với cơ chế hiện tại của ứng dụng."
      : "CLI có thể đã đổi cách đăng nhập/trạng thái, cần kiểm tra thủ công.",
    suggestions: [
      !login.loggedIn ? `Đăng nhập ${tool.name} trước khi lưu cấu hình.` : "",
      updateAvailable ? `Có bản mới ${latest}. Có thể bấm Cập nhật CLI để nâng cấp.` : "",
      tool.id === "antigravity-cli" ? "Antigravity CLI thay thế Gemini CLI (Google ngừng hỗ trợ tài khoản cá nhân từ 18/6/2026)." : ""
    ].filter(Boolean)
  };
}

export async function updateCli(provider) {
  const tool = findCliTool(provider);
  if (!tool) throw new Error("CLI AI không hợp lệ");

  if (tool.wingetId) {
    if (process.platform !== "win32") throw new Error(`${tool.name} chưa hỗ trợ cập nhật tự động trên hệ này.`);
    const before = await probeCommand(tool.command);
    try {
      await runProcess("winget", [
        "upgrade", "--id", tool.wingetId, "-e",
        "--accept-package-agreements", "--accept-source-agreements"
      ], { timeoutMs: 420000, allowEmpty: true });
    } catch (error) {
      throw new Error(`Cập nhật ${tool.name} thất bại: ${error.message}`);
    }
    const after = await probeCommand(tool.command);
    return {
      ok: true,
      provider: tool.id,
      beforeVersion: before.version || "",
      version: after.version || "",
      changed: Boolean(before.version && after.version && before.version !== after.version),
      message: `Đã cập nhật ${tool.name} (${after.version || "không rõ phiên bản"}).`
    };
  }

  if (!tool.npmPackage) throw new Error(`${tool.name} chưa hỗ trợ cập nhật tự động.`);

  const before = await probeCommand(tool.command);
  const latest = await latestNpmVersion(tool.npmPackage);
  const versionLabel = latest ? `@${latest}` : "@latest";
  try {
    await runProcess("npm", ["install", "-g", `${tool.npmPackage}${versionLabel}`], { timeoutMs: 420000, allowEmpty: true });
  } catch (error) {
    throw new Error(`Cập nhật ${tool.name} thất bại: ${error.message}`);
  }
  const after = await probeCommand(tool.command);
  if (!after.installed) {
    throw new Error(`Đã cập nhật nhưng chưa thấy lệnh ${tool.command}. Hãy mở lại terminal/app và kiểm tra PATH.`);
  }
  const beforeSemver = before.semver || "";
  const afterSemver = after.semver || "";
  const changed = Boolean(beforeSemver && afterSemver && beforeSemver !== afterSemver);
  return {
    ok: true,
    provider: tool.id,
    beforeVersion: before.version || "",
    version: after.version || "",
    changed,
    message: changed
      ? `Đã cập nhật ${tool.name} từ ${beforeSemver} lên ${afterSemver}.`
      : `${tool.name} đang ở bản mới nhất (${after.version || "không rõ phiên bản"}).`
  };
}

export async function ensureCliInstalled(provider) {
  const tool = findCliTool(provider);
  if (!tool) throw new Error("CLI AI không hợp lệ");
  const probe = await probeCommand(tool.command);
  if (probe.installed) return { installed: true, installedNow: false, version: probe.version };
  const result = await installCli(tool.id);
  return { installed: true, installedNow: true, version: result.version, message: result.message };
}

export function clearCliAuth(provider) {
  const tool = findCliTool(provider);
  if (!tool) throw new Error("CLI AI không hợp lệ");
  const removed = [];
  for (const file of tool.authPaths || []) {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        removed.push(path.basename(file));
      }
    } catch (error) {
      throw new Error(`Không xóa được ${path.basename(file)}: ${error.message}`);
    }
  }
  if (tool.id === "codex-cli") {
    try {
      spawnCli(tool.command, ["logout"], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
    } catch {}
  }
  return {
    ok: true,
    provider: tool.id,
    removed,
    message: removed.length
      ? `Đã xóa phiên ${tool.name}. Bấm Đăng nhập (hoặc chạy lại CLI) để đăng nhập mới.`
      : `${tool.name} không còn file phiên cục bộ để xóa.`
  };
}

function extractOauthUrl(text) {
  const match = String(text || "").match(/https:\/\/accounts\.google\.com\/[^\s]+/i);
  return match ? match[0].replace(/[)\],"']+$/g, "") : "";
}

function openBrowserUrl(url) {
  if (!url) return false;
  // Chỉ mở 1 lần — tránh tràn tab. Trên Windows, URL có "&" phải được quote,
  // nếu không cmd cắt mất response_type → Google lỗi 400.
  try {
    if (process.versions.electron) {
      try {
        const { shell } = require("electron");
        Promise.resolve(shell.openExternal(url)).catch(() => {});
        return true;
      } catch {}
    }
    if (process.platform === "win32") {
      spawn("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
        "-Command", `Start-Process -FilePath (${JSON.stringify(url)})`
      ], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
      return true;
    }
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
      detached: true,
      stdio: "ignore"
    }).unref();
    return true;
  } catch {
    return false;
  }
}

async function startAntigravityLogin(tool, installedNow) {
  const previous = pendingCliLogins.get(tool.id);
  if (previous?.child) {
    try { previous.child.kill(); } catch {}
    pendingCliLogins.delete(tool.id);
  }

  const env = agyAuthEnv();
  const child = spawnCli(tool.command, [
    "--dangerously-skip-permissions",
    "--output-format", "text",
    "--print-timeout", "90s",
    "-p", "Reply with exactly: OK"
  ], {
    windowsHide: true,
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
    env
  });

  const session = {
    child,
    stdout: "",
    stderr: "",
    oauthUrl: "",
    done: false,
    startedAt: Date.now(),
    browserOpened: false
  };
  pendingCliLogins.set(tool.id, session);

  const onChunk = (chunk, which) => {
    const text = String(chunk || "");
    session[which] += text;
    if (!session.oauthUrl) {
      const url = extractOauthUrl(session.stderr) || extractOauthUrl(session.stdout);
      if (url) {
        session.oauthUrl = url;
        if (!session.browserOpened) {
          session.browserOpened = true;
          openBrowserUrl(url);
        }
      }
    }
  };
  child.stdout?.on("data", chunk => onChunk(chunk, "stdout"));
  child.stderr?.on("data", chunk => onChunk(chunk, "stderr"));
  child.on("close", () => { session.done = true; });
  child.on("error", () => { session.done = true; });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !session.oauthUrl && !session.done) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  if (session.oauthUrl) {
    if (!session.browserOpened) {
      session.browserOpened = true;
      openBrowserUrl(session.oauthUrl);
    }
    return {
      ok: true,
      provider: tool.id,
      installedNow,
      needsAuthCode: true,
      pasteInTerminal: false,
      oauthUrl: session.oauthUrl,
      authExpiresInSec: 50,
      browserOpened: true,
      message: "Đã mở 1 tab Google. Copy mã → dán vào ô trong app → Gửi mã (trong ~50 giây). Nếu tab lỗi, bấm “Mở trang Google đăng nhập”."
    };
  }

  const login = await probeLogin(tool, { lightweight: true });
  if (login.loggedIn || /\bok\b/i.test(session.stdout)) {
    try { child.kill(); } catch {}
    pendingCliLogins.delete(tool.id);
    return {
      ok: true,
      provider: tool.id,
      installedNow,
      alreadyLoggedIn: true,
      message: `${tool.name} đã đăng nhập.`
    };
  }

  // Vẫn cho dán mã / thử lại — đôi khi URL đến chậm.
  return {
    ok: true,
    provider: tool.id,
    installedNow,
    needsAuthCode: true,
    pasteInTerminal: false,
    oauthUrl: "",
    message: "Chưa bắt được link Google tự động. Bấm Đăng nhập lại, hoặc mở cửa sổ login và copy URL thủ công. Có thể dùng Gemini API key (nhanh hơn)."
  };
}

export async function submitCliAuthCode(provider, code) {
  const tool = findCliTool(provider);
  if (!tool) throw new Error("CLI AI không hợp lệ");
  const session = pendingCliLogins.get(tool.id);
  if (!session?.child || session.done) {
    throw new Error("Phiên đăng nhập đã hết (~60 giây). Bấm Đăng nhập Antigravity lại, lấy mã MỚI, rồi dán ngay vào cửa sổ đen (hoặc ô mã) trong vòng 1 phút.");
  }
  const ageSec = Math.round((Date.now() - (session.startedAt || Date.now())) / 1000);
  if (ageSec > 55) {
    try { session.child.kill(); } catch {}
    pendingCliLogins.delete(tool.id);
    throw new Error("Đã quá 55 giây — mã/phiên hết hạn. Bấm Đăng nhập lại và dán mã mới ngay.");
  }
  const token = String(code || "").trim();
  if (!token) throw new Error("Thiếu mã xác thực");
  try {
    session.child.stdin?.write(`${token}\n`);
    session.child.stdin?.end();
  } catch (error) {
    throw new Error(`Không gửi được mã: ${error.message}`);
  }

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const combined = `${session.stdout || ""}\n${session.stderr || ""}`;
    if (/auth timed out|invalid.?code|authentication failed/i.test(combined)) {
      pendingCliLogins.delete(tool.id);
      throw new Error("Mã không hợp lệ hoặc đã hết hạn. Bấm Đăng nhập lại và lấy mã mới.");
    }
    if (session.done || /\bok\b/i.test(session.stdout || "")) {
      // Đợi token ghi ra đĩa một nhịp ngắn.
      await new Promise(resolve => setTimeout(resolve, 800));
      const login = await probeLogin(tool, { lightweight: false });
      if (login.loggedIn || /\bok\b/i.test(session.stdout || "")) {
        pendingCliLogins.delete(tool.id);
        return { ok: true, provider: tool.id, message: "Đã nhận đăng nhập Antigravity." };
      }
    }
    const login = await probeLogin(tool, { lightweight: true });
    if (login.loggedIn) {
      pendingCliLogins.delete(tool.id);
      return { ok: true, provider: tool.id, message: "Đã nhận đăng nhập Antigravity." };
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Gửi mã xong nhưng chưa thấy đăng nhập. Thử lại: Đăng nhập → dán mã vào cửa sổ đen trong 60 giây. Hoặc dùng Gemini API key.");
}

export async function startCliLogin(provider, { autoInstall = true } = {}) {
  const tool = findCliTool(provider);
  if (!tool) throw new Error("CLI AI không hợp lệ");
  const isAntigravity = tool.id === "antigravity-cli";
  if (!tool.loginArgs && !isAntigravity) {
    throw new Error(tool.loginHint || "CLI này không hỗ trợ mở đăng nhập trình duyệt từ app. Hãy dùng API key.");
  }
  let installedNow = false;
  if (autoInstall) {
    const ensured = await ensureCliInstalled(tool.id);
    installedNow = Boolean(ensured.installedNow);
  } else {
    const probe = await probeCommand(tool.command);
    if (!probe.installed) throw new Error(`Chưa cài ${tool.name}. ${tool.installHint}`);
  }
  try {
    if (isAntigravity) return startAntigravityLogin(tool, installedNow);

    const child = spawnCli(tool.command, tool.loginArgs, {
      windowsHide: true,
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return {
      ok: true,
      provider: tool.id,
      installedNow,
      message: installedNow
        ? `Đã cài ${tool.name} và mở đăng nhập trên trình duyệt. Hoàn tất rồi bấm Quét lại.`
        : `Đã mở đăng nhập ${tool.name}. Hoàn tất trên trình duyệt, rồi bấm Quét lại trạng thái.`
    };
  } catch (error) {
    throw new Error(`Không mở được đăng nhập: ${error.message}`);
  }
}

function buildDigestPrompt(systemPrompt, userPrompt) {
  return [
    systemPrompt,
    "",
    userPrompt,
    "",
    "Chỉ trả lời nội dung báo cáo bằng tiếng Việt.",
    "Không chạy lệnh shell, không đọc/sửa file, không giải thích công cụ."
  ].join("\n");
}

function buildCliArgs(tool, prompt, cfg = {}) {
  const args = [...(tool.args || [])];
  if (tool.id === "antigravity-cli" && cfg.model && !String(cfg.model).endsWith("-cli")) {
    args.unshift("--model", String(cfg.model));
  }
  if (tool.promptFlag) {
    args.push(tool.promptFlag, prompt.slice(0, 28000));
  }
  return args;
}

export async function callAiCli(cfg, systemPrompt, userPrompt) {
  const tool = findCliTool(cfg.provider);
  if (!tool) throw new Error("CLI AI không hợp lệ");
  const readiness = await getCliReadiness(tool.id);
  if (!readiness?.installed) throw new Error(`Chưa cài ${tool.name}. ${tool.installHint}`);
  if (!readiness?.loggedIn) throw new Error(`${tool.name} chưa đăng nhập. Hãy bấm Đăng nhập trên trình duyệt.`);
  const command = String(cfg.cliCommand || tool.command).trim() || tool.command;
  const prompt = buildDigestPrompt(systemPrompt, userPrompt).slice(0, 100000);
  const args = buildCliArgs(tool, prompt, cfg);
  try {
    const result = await runProcess(command, args, {
      input: tool.stdinMode === "prompt" ? prompt : "",
      timeoutMs: Number(cfg.cliTimeoutMs) || 180000
    });
    const text = String(result.stdout || "").trim();
    if (!text) {
      throw new Error(`${tool.name} không trả về nội dung (stdout trống). Thử lại hoặc dùng Gemini API key.`);
    }
    return text;
  } catch (error) {
    const text = String(error.message || "");
    if (/Not enough arguments following:\s*p/i.test(text)) {
      throw new Error("CLI nhận sai tham số prompt. Hãy cập nhật app rồi thử lại, hoặc dùng API key Gemini.");
    }
    if (/IneligibleTier|no longer supported for Gemini Code Assist|UNSUPPORTED_CLIENT|migrate to the Antigravity/i.test(text)) {
      throw new Error("Google đã chuyển Gemini CLI sang Antigravity CLI. Hãy chọn Antigravity (Gemini) hoặc dùng Gemini API key.");
    }
    if (/Authentication required/i.test(text)) {
      throw new Error(`${tool.name} chưa đăng nhập. Bấm Đăng nhập trên trình duyệt.`);
    }
    throw error;
  }
}
