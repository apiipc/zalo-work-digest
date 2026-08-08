import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDefaultDocumentsDataDir } from "./app-paths.js";

const execFileAsync = promisify(execFile);

/** Các mục trong thư mục data cần chuyển khi đổi chỗ lưu. */
export const DATA_ENTRIES = [
  "accounts",
  "shared-settings.json",
  "meta.json",
  "session.pending.json",
  "exports"
];

export function defaultDataDir(appRoot, { packaged = false } = {}) {
  if (packaged || process.env.ZALO_DIGEST_PACKAGED === "1") {
    return getDefaultDocumentsDataDir();
  }
  return path.resolve(appRoot, "data");
}

export function dataPathConfigFile(configDir) {
  return path.join(configDir, "data-path.json");
}

export function readDataDir(configDir, fallbackDataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(dataPathConfigFile(configDir), "utf8"));
    const p = String(raw.path || "").trim();
    if (p) return path.resolve(p);
  } catch {}
  return path.resolve(fallbackDataDir);
}

export function writeDataDir(configDir, dataPath) {
  fs.mkdirSync(configDir, { recursive: true });
  const resolved = path.resolve(dataPath);
  fs.writeFileSync(
    dataPathConfigFile(configDir),
    JSON.stringify({ path: resolved, updatedAt: Date.now() }, null, 2)
  );
  return resolved;
}

export function hasDataPathConfig(configDir) {
  return fs.existsSync(dataPathConfigFile(configDir));
}

function norm(p) {
  return path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
}

/** Tạo thư mục và kiểm tra ghi được. */
export function assertUsableDir(dir) {
  const resolved = path.resolve(dir);
  fs.mkdirSync(resolved, { recursive: true });
  const probe = path.join(resolved, `.zalo-digest-write-${process.pid}-${Date.now()}`);
  fs.writeFileSync(probe, "ok");
  fs.unlinkSync(probe);
  return resolved;
}

/**
 * Kiểm tra path đích hợp lệ trước khi relocate.
 * @param {string} root - thư mục gốc app
 * @param {string} target - path người dùng chọn
 * @param {{ from?: string }} opts - from = dataDir hiện tại
 */
export function validateDataDirTarget(root, target, { from } = {}) {
  const raw = String(target || "").trim();
  if (!raw) throw new Error("Chưa nhập đường dẫn thư mục");
  const resolved = path.resolve(raw);
  const n = norm(resolved);

  if (n.includes(`${path.sep}node_modules${path.sep}`) || n.endsWith(`${path.sep}node_modules`)) {
    throw new Error("Không được chọn thư mục trong node_modules");
  }
  if (path.basename(resolved).toLowerCase() === "accounts") {
    throw new Error("Chọn thư mục cha chứa dữ liệu, không chọn thư mục accounts");
  }

  if (from) {
    const fromResolved = path.resolve(from);
    if (n === norm(fromResolved)) return assertUsableDir(resolved);
    const accounts = path.join(fromResolved, "accounts");
    if (n === norm(accounts) || n.startsWith(`${norm(accounts)}${path.sep}`)) {
      throw new Error("Không được chọn thư mục con của kho dữ liệu hiện tại");
    }
    // Không chọn thư mục nằm trong project root/config nhầm
    const destAccounts = path.join(resolved, "accounts");
    if (fs.existsSync(destAccounts)) {
      const entries = fs.readdirSync(destAccounts).filter(name => !name.startsWith("."));
      if (entries.length > 0) {
        throw new Error("Thư mục đích đã có dữ liệu accounts khác. Hãy chọn thư mục trống.");
      }
    }
    for (const name of ["shared-settings.json", "meta.json"]) {
      if (fs.existsSync(path.join(resolved, name))) {
        throw new Error(`Thư mục đích đã có file ${name}. Hãy chọn thư mục trống.`);
      }
    }
  }

  return assertUsableDir(resolved);
}

/**
 * Copy dữ liệu từ `from` → `to`, rồi xóa các mục đã copy ở nguồn.
 * Caller phải đóng DB trước.
 */
export function relocateData({ from, to }) {
  const src = path.resolve(from);
  const dest = path.resolve(to);
  if (norm(src) === norm(dest)) return { moved: false, path: dest };

  fs.mkdirSync(dest, { recursive: true });

  for (const name of DATA_ENTRIES) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (!fs.existsSync(s)) continue;
    if (fs.existsSync(d)) {
      throw new Error(`Không thể chuyển: đích đã tồn tại “${name}”`);
    }
    fs.cpSync(s, d, { recursive: true });
  }

  for (const name of DATA_ENTRIES) {
    const s = path.join(src, name);
    if (fs.existsSync(s)) fs.rmSync(s, { recursive: true, force: true });
  }

  return { moved: true, path: dest };
}

/** Windows: mở dialog chọn thư mục. Trả về path hoặc null nếu hủy. */
export async function browseFolderDialog(title = "Chọn thư mục lưu dữ liệu Zalo Work Digest") {
  if (process.platform !== "win32") {
    throw new Error("Chọn thư mục chỉ hỗ trợ trên Windows. Hãy dán đường dẫn thủ công.");
  }
  // Shell.Application BrowseForFolder hiện ổn định hơn FolderBrowserDialog khi gọi từ Node (service/ẩn).
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$title = ${JSON.stringify(title)}
# Ưu tiên WinForms với form TopMost để dialog không bị khuất sau trình duyệt.
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.Opacity = 0
$form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
$form.Show()
$form.BringToFront() | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $title
$dialog.ShowNewFolderButton = $true
$dialog.SelectedPath = [Environment]::GetFolderPath('MyDocuments')
$result = $dialog.ShowDialog($form)
$form.Close()
$form.Dispose()
if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
  [Console]::Out.WriteLine($dialog.SelectedPath)
  exit 0
}
# Fallback COM nếu WinForms bị hủy/không hiện
$shell = New-Object -ComObject Shell.Application
$folder = $shell.BrowseForFolder(0, $title, 0x0001)
if ($null -ne $folder -and $null -ne $folder.Self -and $folder.Self.Path) {
  [Console]::Out.WriteLine($folder.Self.Path)
}
`;
  const { stdout, stderr } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      // Phải hiện process UI — windowsHide:true thường làm dialog không thấy.
      windowsHide: false,
      timeout: 300000,
      maxBuffer: 1024 * 1024
    }
  );
  if (stderr && /error|exception/i.test(String(stderr))) {
    throw new Error(String(stderr).trim().slice(0, 300));
  }
  const selected = String(stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
  return selected || null;
}

export function describeDataLocation(configDir, dataDir, fallbackDefault) {
  const resolved = path.resolve(dataDir);
  const def = path.resolve(fallbackDefault);
  return {
    path: resolved,
    defaultPath: def,
    isDefault: norm(resolved) === norm(def),
    configDir: path.resolve(configDir)
  };
}
