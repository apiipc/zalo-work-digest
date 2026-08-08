const { app, BrowserWindow, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const http = require("http");

const isPackaged = app.isPackaged;
const projectRoot = isPackaged
  ? app.getAppPath()
  : path.resolve(__dirname, "..");
const userData = app.getPath("userData");
const configDir = path.join(userData, "config");
const resourcesRoot = isPackaged ? process.resourcesPath : path.join(projectRoot, "build");
const cliRoot = isPackaged
  ? path.join(resourcesRoot, "cli")
  : path.join(projectRoot, "build", "bundled-cli");
const cliproxyRoot = isPackaged
  ? path.join(resourcesRoot, "cliproxyapi")
  : path.join(projectRoot, "build", "bundled-cliproxyapi");

process.env.ZALO_DIGEST_MANUAL_LISTEN = "1";
process.env.ZALO_DIGEST_PACKAGED = isPackaged ? "1" : "0";
process.env.ZALO_DIGEST_ROOT = projectRoot;
process.env.ZALO_DIGEST_APP_PATH = isPackaged ? app.getAppPath() : projectRoot;
process.env.ZALO_DIGEST_CONFIG_DIR = configDir;
process.env.ZALO_DIGEST_USER_DATA = userData;
if (!process.env.LICENSE_SERVER_URL) {
  process.env.LICENSE_SERVER_URL = "https://zalo-work-digest.vercel.app";
}
if (fs.existsSync(path.join(cliRoot, "node_modules"))) {
  process.env.ZALO_DIGEST_CLI_ROOT = cliRoot;
}
if (fs.existsSync(cliproxyRoot)) {
  process.env.ZALO_DIGEST_CLIPROXYAPI_ROOT = cliproxyRoot;
}

let mainWindow = null;
let serverInfo = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function iconPath() {
  const ico = path.join(projectRoot, "build", "icon.ico");
  const png = path.join(projectRoot, "build", "icon.png");
  if (fs.existsSync(ico)) return ico;
  if (fs.existsSync(png)) return png;
  return undefined;
}

function waitForUrl(url, attempts = 40) {
  return new Promise((resolve, reject) => {
    let left = attempts;
    const tick = () => {
      const req = http.get(url, res => {
        res.resume();
        resolve(url);
      });
      req.on("error", () => {
        left -= 1;
        if (left <= 0) reject(new Error("Máy chủ app không khởi động được."));
        else setTimeout(tick, 250);
      });
    };
    tick();
  });
}

async function createWindow(startUrl) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  await mainWindow.loadURL(startUrl);
}

async function bootstrap() {
  fs.mkdirSync(configDir, { recursive: true });

  const serverModuleUrl = pathToFileURL(path.join(projectRoot, "src", "server.js")).href;
  const { startServer } = await import(serverModuleUrl);
  serverInfo = await startServer({ host: "127.0.0.1", port: Number(process.env.PORT) || 4782 });

  const base = serverInfo.url.replace(/\/$/, "");
  await waitForUrl(`${base}/api/status`);

  let setupRequired = false;
  try {
    const res = await fetch(`${base}/api/data-location`);
    const info = await res.json();
    setupRequired = Boolean(info.setupRequired);
  } catch {}

  const startUrl = setupRequired ? `${base}/setup.html` : `${base}/`;
  await createWindow(startUrl);
}

app.whenReady().then(() => {
  bootstrap().catch(async error => {
    console.error(error);
    dialog.showErrorBox("Zalo Work Digest", error.message || String(error));
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function stopBundledAiBrain() {
  try {
    const { spawnSync } = require("child_process");
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/IM", "cli-proxy-api.exe", "/T"], {
        windowsHide: true,
        stdio: "ignore"
      });
    } else {
      spawnSync("pkill", ["-f", "cli-proxy-api"], { stdio: "ignore" });
    }
  } catch {}
  try {
    const pidFile = path.join(userData, "CLIProxyAPI", "cli-proxy-api.pid");
    if (fs.existsSync(pidFile)) {
      const pid = Number(String(fs.readFileSync(pidFile, "utf8") || "").trim());
      if (pid > 0) {
        try { process.kill(pid); } catch {}
      }
      try { fs.unlinkSync(pidFile); } catch {}
    }
  } catch {}
  try {
    const winPid = path.join(process.env.LOCALAPPDATA || "", "ZaloWorkDigest", "CLIProxyAPI", "cli-proxy-api.pid");
    if (winPid && fs.existsSync(winPid)) {
      const pid = Number(String(fs.readFileSync(winPid, "utf8") || "").trim());
      if (pid > 0) {
        try { process.kill(pid); } catch {}
      }
      try { fs.unlinkSync(winPid); } catch {}
    }
  } catch {}
}

app.on("before-quit", () => {
  stopBundledAiBrain();
});
app.on("will-quit", () => {
  stopBundledAiBrain();
});