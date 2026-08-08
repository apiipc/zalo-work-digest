import express from "express";
import path from "node:path";
import fs from "node:fs";
import { createAccountStore } from "./account-store.js";
import {
  browseFolderDialog,
  defaultDataDir,
  describeDataLocation,
  hasDataPathConfig,
  readDataDir,
  relocateData,
  validateDataDirTarget,
  writeDataDir
} from "./data-location.js";
import { getAppRoot, getConfigDir } from "./app-paths.js";
import { ZaloAdapter } from "./zalo-adapter.js";
import { callAI, createDigestWithConfig } from "./summarizer.js";
import { formatRuleBotMessage, matchRules } from "./alert-rules.js";
import {
  checkCliCompatibility, clearCliAuth, detectAiCli, detectSingleCli, ensureCliInstalled,
  getCliLoginStatus, getCliReadiness, installCli, isCliProvider, listCliTools,
  startCliLogin, updateCli, waitForCliLogin
} from "./ai-cli.js";
import { AI_API_PRESETS, aiProviderLabel, isApiProviderId, normalizeProviderId } from "./ai-providers.js";
import { connectCliProxyApi, getCliProxyApiStatus, installCliProxyApi, loginCliProxyApi, startCliProxyApi } from "./cli-proxy-api.js";
import { buildMentionMessage } from "./mentions.js";
import { verifyBot, discoverChats, sendBotMessage } from "./bot-client.js";
import { messagesCsv, messagesCsvFull } from "./csv.js";
import { getAssetDir, runWithAssetDir } from "./asset-store.js";
import { appMode, isSaasMode } from "./saas-mode.js";
import { createAuth } from "./auth.js";
import { createTenantRegistry } from "./tenant-runtime.js";
import { encryptSecret } from "./secrets.js";
import { activateLicenseKey, getLicenseStatus, requireLicense } from "./license.js";

const saas = isSaasMode();
let root = getAppRoot();
let configDir = getConfigDir(root);
let fallbackDataDir = defaultDataDir(root, { packaged: process.env.ZALO_DIGEST_PACKAGED === "1" });
let dataDir = readDataDir(configDir, fallbackDataDir);

/** @type {ReturnType<typeof createAuth>|null} */
let auth = null;
/** @type {ReturnType<typeof createTenantRegistry>|null} */
let tenants = null;

let store = null;
let db = null;
let zalo = null;

if (!saas) {
  store = createAccountStore(dataDir);
  db = new Proxy({}, {
    get(_t, prop) {
      const target = store.db;
      const val = target[prop];
      return typeof val === "function" ? val.bind(target) : val;
    }
  });
  zalo = new ZaloAdapter({ accountStore: store });
} else {
  const saasRoot = process.env.ZALO_DIGEST_DATA
    ? path.resolve(process.env.ZALO_DIGEST_DATA)
    : path.join(root, "data");
  fs.mkdirSync(saasRoot, { recursive: true });
  const secret = process.env.SAAS_SECRET || process.env.ZALO_DIGEST_SECRET;
  if (!secret || String(secret).length < 16) {
    console.error("SaaS mode requires SAAS_SECRET (min 16 chars).");
    process.exit(1);
  }
  auth = createAuth({
    dbPath: path.join(saasRoot, "saas.db"),
    secureCookies: process.env.SAAS_SECURE_COOKIES === "1" || process.env.NODE_ENV === "production"
  });
  tenants = createTenantRegistry({
    tenantsRoot: path.join(saasRoot, "tenants"),
    onInbound: (rt, msg) => processInboundAlertRulesFor(rt.store.db, msg)
  });
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function ctx(req) {
  if (saas) {
    if (!req.user?.id) throw Object.assign(new Error("Cần đăng nhập"), { status: 401 });
    const rt = tenants.getRuntime(req.user.id);
    return {
      store: rt.store,
      db: tenants.dbProxy(rt),
      zalo: rt.zalo,
      dataDir: rt.dataDir,
      assetsDir: rt.store.assetsDir,
      withAssets(fn) { return runWithAssetDir(rt.store.assetsDir, fn); }
    };
  }
  return {
    store,
    db,
    zalo,
    dataDir,
    assetsDir: store.assetsDir,
    withAssets(fn) { return fn(); }
  };
}

function zaloOnline(c) {
  return c.zalo.snapshot().status === "online";
}

function requireZalo(c, res) {
  if (zaloOnline(c)) return true;
  res.status(401).json({ error: "Cần đăng nhập Zalo bằng QR trước khi dùng tính năng này." });
  return false;
}

function withZaloLock(c, payload) {
  const online = zaloOnline(c);
  return {
    ...payload,
    zaloOnline: online,
    locked: !online,
    lockReason: online ? "" : "Cần đăng nhập Zalo bằng QR trước khi cấu hình và dùng tính năng.",
    accountId: c.store.accountId
  };
}

function normProvider(id) {
  return normalizeProviderId(id, { saas });
}

function applyDataDir(nextDir) {
  if (saas) throw new Error("Không đổi thư mục dữ liệu ở chế độ SaaS");
  const prevAccountId = store.accountId;
  store.close();
  dataDir = nextDir;
  store = createAccountStore(dataDir);
  zalo.setAccountStore(store);
  if (prevAccountId && prevAccountId !== "_local") {
    try { store.openAccount(prevAccountId); } catch {}
  }
  return store;
}

function rebindPaths({ appRoot, configDirectory, packaged = false } = {}) {
  if (saas) return;
  if (appRoot) root = path.resolve(appRoot);
  configDir = configDirectory ? path.resolve(configDirectory) : getConfigDir(root);
  fallbackDataDir = defaultDataDir(root, { packaged: packaged || process.env.ZALO_DIGEST_PACKAGED === "1" });
  dataDir = readDataDir(configDir, fallbackDataDir);
}

app.get("/api/health", (_req, res) => res.json({ ok: true, mode: appMode() }));
app.get("/api/app-mode", (_req, res) => res.json({
  mode: appMode(),
  saas,
  features: {
    auth: saas,
    aiApi: true,
    aiCli: !saas,
    aiBrain: !saas,
    dataLocation: !saas,
    license: true
  }
}));

app.get("/api/license", (_req, res) => {
  res.json(getLicenseStatus());
});
app.post("/api/license/activate", asyncRoute(async (req, res) => {
  try {
    const status = await activateLicenseKey(req.body?.key || req.body?.licenseKey || "");
    res.json(status);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || "Kích hoạt thất bại" });
  }
}));

// Khóa API khi hết hạn / chưa có quyền (trừ health, app-mode, license, auth).
app.use("/api", (req, res, next) => {
  const p = req.path || "";
  if (
    p === "/health" ||
    p === "/app-mode" ||
    p === "/license" ||
    p.startsWith("/license/") ||
    p.startsWith("/auth/")
  ) return next();
  return requireLicense(req, res, next);
});

if (saas) {
  app.post("/api/auth/register", asyncRoute(async (req, res) => {
    try {
      const user = await auth.register({
        email: req.body?.email,
        password: req.body?.password,
        name: req.body?.name
      });
      const session = await auth.login({ email: req.body.email, password: req.body.password });
      auth.setSessionCookie(res, session.token);
      tenants.getRuntime(user.id);
      res.status(201).json({ user: session.user });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message || "Đăng ký thất bại" });
    }
  }));

  app.post("/api/auth/login", asyncRoute(async (req, res) => {
    try {
      const session = await auth.login({ email: req.body?.email, password: req.body?.password });
      auth.setSessionCookie(res, session.token);
      await tenants.ensureRestored(session.user.id);
      res.json({ user: session.user });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message || "Đăng nhập thất bại" });
    }
  }));

  app.post("/api/auth/logout", (req, res) => {
    const token = auth.readSessionToken(req);
    auth.logout(token);
    auth.clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get("/api/auth/me", (req, res) => {
    const token = auth.readSessionToken(req);
    const user = auth.userFromToken(token);
    if (!user) return res.status(401).json({ error: "Chưa đăng nhập", code: "auth_required" });
    res.json({ user });
  });

  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/auth/") || req.path === "/health" || req.path === "/app-mode") return next();
    return auth.requireAuth(req, res, next);
  });

  app.use("/api", asyncRoute(async (req, res, next) => {
    if (req.path.startsWith("/auth/") || req.path === "/health" || req.path === "/app-mode") return next();
    if (req.user?.id) await tenants.ensureRestored(req.user.id);
    next();
  }));
}

// ——— Data location (local only) ———
app.get("/api/data-location", (req, res) => {
  if (saas) return res.status(404).json({ error: "Không hỗ trợ ở chế độ SaaS" });
  const info = describeDataLocation(configDir, dataDir, fallbackDataDir);
  let writable = true;
  try { validateDataDirTarget(root, dataDir, {}); } catch { writable = false; }
  res.json({ ...info, writable, setupRequired: !hasDataPathConfig(configDir) });
});

app.post("/api/data-location/browse", asyncRoute(async (_req, res) => {
  if (saas) return res.status(404).json({ error: "Không hỗ trợ ở chế độ SaaS" });
  const selected = await browseFolderDialog();
  if (!selected) return res.json({ cancelled: true, path: null });
  res.json({ cancelled: false, path: selected });
}));

app.post("/api/data-location", asyncRoute(async (req, res) => {
  if (saas) return res.status(404).json({ error: "Không hỗ trợ ở chế độ SaaS" });
  const requested = String(req.body?.path || "").trim();
  const useDefault = Boolean(req.body?.useDefault);
  const targetRaw = useDefault ? fallbackDataDir : requested;
  const from = dataDir;
  const target = validateDataDirTarget(root, targetRaw, { from });

  if (path.resolve(target) === path.resolve(from)) {
    writeDataDir(configDir, target);
    return res.json({
      ...describeDataLocation(configDir, target, fallbackDataDir),
      moved: false,
      setupRequired: false,
      message: "Đang dùng thư mục này."
    });
  }

  store.close();
  try {
    const result = relocateData({ from, to: target });
    writeDataDir(configDir, target);
    applyDataDir(target);
    res.json({
      ...describeDataLocation(configDir, target, fallbackDataDir),
      moved: result.moved,
      setupRequired: false,
      message: result.moved ? "Đã chuyển dữ liệu sang thư mục mới." : "Đã cập nhật nơi lưu dữ liệu."
    });
  } catch (error) {
    try { applyDataDir(from); } catch {}
    throw error;
  }
}));

// ——— Zalo ———
app.get("/api/status", (req, res) => {
  const c = ctx(req);
  res.json({ ...c.zalo.snapshot(), accountId: c.store.accountId, user: req.user || null });
});
app.post("/api/login/qr", (req, res) => {
  const c = ctx(req);
  c.withAssets(() => c.zalo.loginQR());
  res.status(202).json({ ok: true });
});
app.post("/api/logout", (req, res) => {
  const c = ctx(req);
  res.json({ ...c.zalo.logout(), integrationsCleared: false, accountId: c.store.accountId });
});
app.post("/api/groups/sync", asyncRoute(async (req, res) => {
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  res.json(await c.withAssets(() => c.zalo.syncGroups()));
}));
app.get("/api/groups", (req, res) => {
  const c = ctx(req);
  if (!zaloOnline(c)) return res.json([]);
  res.json(c.db.listGroups());
});
app.get("/api/contacts", asyncRoute(async (req, res) => {
  const c = ctx(req);
  if (!zaloOnline(c)) return res.json([]);
  let contacts = c.db.listContacts();
  if (!contacts.length) contacts = await c.withAssets(() => c.zalo.syncContacts());
  res.json(contacts);
}));
app.post("/api/contacts/sync", asyncRoute(async (req, res) => {
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  res.json(await c.withAssets(() => c.zalo.syncContacts()));
}));
app.patch("/api/groups/:id", (req, res) => {
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  c.db.enableGroup(req.params.id, Boolean(req.body.enabled));
  res.json({ ok: true });
});
app.get("/api/groups/:id/members", asyncRoute(async (req, res) => {
  const c = ctx(req);
  if (!zaloOnline(c)) return res.json([]);
  let members = c.db.listMembers(req.params.id);
  if (!members.length) {
    await c.withAssets(() => c.zalo.syncGroups());
    members = c.db.listMembers(req.params.id);
  }
  res.json(members);
}));
app.get("/api/groups/:id/messages", (req, res) => {
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const to = Number(req.query.to) || Date.now();
  const from = Number(req.query.from) || to - 86400000;
  res.json(c.db.listMessages({ groupId: req.params.id, from, to, limit: req.query.limit }));
});
app.post("/api/groups/:id/digests", asyncRoute(async (req, res) => {
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const to = Number(req.body.to) || Date.now();
  const from = Number(req.body.from) || to - 86400000;
  const group = c.db.listGroups().find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: "Không tìm thấy nhóm" });
  const messages = c.db.listMessages({ groupId: group.id, from, to, limit: 5000 });
  const content = await createDigestWithConfig(messages, group.name, c.db.aiSettings(true));
  const id = c.db.createDigest({ groupId: group.id, from, to, content });
  res.status(201).json({ id, groupId: group.id, from, to, content });
}));
app.get("/api/groups/:id/digests", (req, res) => {
  const c = ctx(req);
  if (!zaloOnline(c)) return res.json([]);
  res.json(c.db.listDigests(req.params.id));
});
app.get("/api/alerts", (req, res) => {
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const to = Number(req.query.to) || Date.now(), from = Number(req.query.from) || to - 86400000;
  res.json(c.db.listAlerts({
    from, to, limit: req.query.limit,
    groupId: req.query.groupId || "",
    senderId: req.query.senderId || "",
    q: req.query.q || "",
    kind: req.query.kind || ""
  }));
});
app.get("/api/messages/search", (req, res) => {
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const to = Number(req.query.to) || Date.now(), from = Number(req.query.from) || to - 86400000;
  res.json(c.db.searchMessages({
    from, to, limit: req.query.limit,
    groupId: req.query.groupId || "",
    senderId: req.query.senderId || "",
    q: req.query.q || ""
  }));
});
app.get("/api/messages/stats", (req, res) => {
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const granularity = String(req.query.granularity || "hour");
  const now = Date.now();
  let from;
  let to = Number(req.query.to) || now;
  if (Number(req.query.from)) from = Number(req.query.from);
  else if (granularity === "month") {
    const d = new Date(to);
    d.setDate(1); d.setHours(0, 0, 0, 0);
    d.setMonth(d.getMonth() - 11);
    from = d.getTime();
  } else if (granularity === "day") {
    const d = new Date(to);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 29);
    from = d.getTime();
  } else {
    const d = new Date(to);
    d.setHours(0, 0, 0, 0);
    from = d.getTime();
  }
  const buckets = c.db.messageStats({ granularity, from, to });
  const total = buckets.reduce((s, b) => s + b.count, 0);
  res.json({ granularity, from, to, total, buckets });
});
app.get("/api/export.csv", (req, res) => {
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const to = Number(req.query.to) || Date.now(), from = Number(req.query.from) || to - 86400000;
  let messages;
  if (req.query.kind === "alerts") {
    messages = c.db.listAlerts({
      from, to, limit: 5000,
      groupId: req.query.groupId || "",
      senderId: req.query.senderId || "",
      q: req.query.q || "",
      kind: req.query.alertKind || ""
    });
  } else {
    const groupId = String(req.query.groupId || "");
    messages = c.db.listMessages({ groupId, from, to, limit: 5000 }).map(m => ({
      ...m,
      thread_name: c.db.listGroups().find(g => g.id === groupId)?.name || groupId
    }));
  }
  res.setHeader("content-type", "text/csv; charset=utf-8");
  const full = String(req.query.full || "") === "1";
  if (full) {
    const assetsByMessage = {};
    const all = c.db.listAssets({ limit: 10000 });
    for (const a of all) (assetsByMessage[a.message_id] = assetsByMessage[a.message_id] || []).push(a);
    messages = messages.map(m => ({ ...m, assets: assetsByMessage[m.id] || [] }));
    res.setHeader("content-disposition", `attachment; filename=zalo-digest-full-${new Date(to).toISOString().slice(0, 10)}.csv`);
    res.send(messagesCsvFull(messages));
  } else {
    res.setHeader("content-disposition", `attachment; filename=zalo-digest-${new Date(to).toISOString().slice(0, 10)}.csv`);
    res.send(messagesCsv(messages));
  }
});

app.get("/api/assets", (req, res) => {
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  res.json(c.db.listAssets({ limit: 1000 }));
});
app.get("/api/assets/:name", (req, res) => {
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const base = path.basename(req.params.name);
  const assetRoot = c.assetsDir || getAssetDir();
  const filePath = path.join(assetRoot, base);
  if (!path.resolve(filePath).startsWith(path.resolve(assetRoot))) {
    return res.status(400).json({ error: "Đường dẫn không hợp lệ" });
  }
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Không tìm thấy tệp" });
  res.sendFile(filePath);
});

app.get("/api/bot", (req, res) => {
  const c = ctx(req);
  const bot = c.db.botSettings();
  if (!zaloOnline(c)) {
    return res.json(withZaloLock(c, {
      ...bot,
      usable: false,
      statusText: bot.configured ? "Đã lưu cấu hình — cần đăng nhập Zalo để dùng" : "Chưa đăng nhập Zalo"
    }));
  }
  res.json(withZaloLock(c, { ...bot, usable: bot.configured }));
});

app.get("/api/ai-config", asyncRoute(async (req, res) => {
  const c = ctx(req);
  const cfg = c.db.aiSettings(false);
  const normalized = normProvider(cfg.provider);
  if (normalized !== cfg.provider) {
    cfg.provider = normalized;
    try { c.db.setSetting("ai_provider", normalized); } catch {}
  }
  cfg.providerLabel = aiProviderLabel(cfg.provider);
  const isCpa = cfg.provider === "cliproxyapi";
  const isApi = isApiProviderId(cfg.provider) || ["openai", "gemini", "claude", "custom"].includes(cfg.provider);

  if (!zaloOnline(c)) {
    const saved = isCliProvider(cfg.provider)
      ? Boolean(cfg.enabled)
      : Boolean(cfg.apiKey || cfg.maskedKey || cfg.enabled || isCpa);
    cfg.connected = Boolean(cfg.maskedKey) || (isCliProvider(cfg.provider) && saved) || (isCpa && saved) || (isApi && Boolean(cfg.maskedKey));
    return res.json(withZaloLock(c, {
      ...cfg,
      configured: false,
      usable: false,
      hasSavedConfig: saved || Boolean(cfg.maskedKey) || isCliProvider(cfg.provider) || isCpa || isApi,
      statusText: "Đã lưu cấu hình — cần đăng nhập Zalo để dùng",
      cli: null
    }));
  }

  if (saas || isApi) {
    cfg.connected = Boolean(cfg.maskedKey || cfg.apiKey);
    cfg.configured = Boolean(cfg.maskedKey || cfg.apiKey);
    cfg.statusText = cfg.connected ? `${cfg.providerLabel} đã kết nối` : "Chưa nhập API key";
    cfg.usable = Boolean(cfg.configured && cfg.enabled);
    return res.json(withZaloLock(c, cfg));
  }

  if (isCliProvider(cfg.provider)) {
    const cli = await getCliReadiness(cfg.provider);
    cfg.cli = cli;
    cfg.connected = Boolean(cli?.ready || cli?.loggedIn);
    cfg.configured = Boolean(cfg.enabled && cli?.ready);
    cfg.statusText = !cli?.installed
      ? `Chưa cài ${cli?.name || "CLI"}`
      : (!cli?.loggedIn ? `Chưa đăng nhập ${cli?.name || "CLI"}` : `${cli.name} đã kết nối`);
  } else if (isCpa) {
    const cpa = await getCliProxyApiStatus();
    cfg.cliProxyApi = cpa;
    cfg.connected = Boolean(cpa.ready);
    cfg.configured = Boolean(cfg.enabled && cpa.ready);
    cfg.statusText = cpa.message;
  } else {
    cfg.connected = Boolean(cfg.apiKey || cfg.maskedKey);
    cfg.configured = Boolean(cfg.apiKey || cfg.maskedKey);
    cfg.statusText = cfg.connected ? `${cfg.providerLabel} đã kết nối` : "Chưa kết nối AI";
  }
  cfg.usable = Boolean(cfg.configured && cfg.enabled);
  res.json(withZaloLock(c, cfg));
}));

function rejectSaasCli(res) {
  if (!saas) return false;
  res.status(400).json({ error: "Chế độ SaaS chỉ hỗ trợ AI qua API key." });
  return true;
}

app.get("/api/ai-cli", asyncRoute(async (req, res) => {
  if (rejectSaasCli(res)) return;
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const provider = normProvider(String(req.query.provider || "").toLowerCase());
  if (provider && isCliProvider(provider)) {
    const detected = await detectSingleCli(provider);
    res.json({ tools: listCliTools().filter(t => t.id === "codex-cli" || t.id === "claude-cli"), detected: detected ? [detected] : [] });
    return;
  }
  const detected = (await detectAiCli()).filter(t => t.id === "codex-cli" || t.id === "claude-cli");
  res.json({ tools: listCliTools().filter(t => t.id === "codex-cli" || t.id === "claude-cli"), detected });
}));
app.get("/api/ai-cli/login-status", asyncRoute(async (req, res) => {
  if (rejectSaasCli(res)) return;
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const provider = normProvider(String(req.query.provider || "").toLowerCase());
  if (!isCliProvider(provider)) return res.status(400).json({ error: "Chỉ dùng được với nhà cung cấp CLI" });
  res.json(await getCliLoginStatus(provider));
}));
app.post("/api/ai-cli/wait-login", asyncRoute(async (req, res) => {
  if (rejectSaasCli(res)) return;
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const provider = normProvider(String(req.body.provider || "").toLowerCase());
  if (!isCliProvider(provider)) return res.status(400).json({ error: "Chỉ dùng được với nhà cung cấp CLI" });
  const timeoutMs = Math.min(Math.max(Number(req.body.timeoutMs) || 90000, 5000), 180000);
  res.json(await waitForCliLogin(provider, { timeoutMs }));
}));
app.post("/api/ai-cli/login", asyncRoute(async (req, res) => {
  if (rejectSaasCli(res)) return;
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const provider = normProvider(String(req.body.provider || "").toLowerCase());
  if (!isCliProvider(provider)) return res.status(400).json({ error: "Chỉ dùng được với nhà cung cấp CLI" });
  res.json(await startCliLogin(provider, { autoInstall: req.body.autoInstall !== false }));
}));
app.post("/api/ai-cli/install", asyncRoute(async (req, res) => {
  if (rejectSaasCli(res)) return;
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const provider = normProvider(String(req.body.provider || "").toLowerCase());
  if (!isCliProvider(provider)) return res.status(400).json({ error: "Chỉ dùng được với nhà cung cấp CLI" });
  res.json(await installCli(provider));
}));
app.post("/api/ai-cli/compatibility", asyncRoute(async (req, res) => {
  if (rejectSaasCli(res)) return;
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const provider = normProvider(String(req.body.provider || "").toLowerCase());
  if (!isCliProvider(provider)) return res.status(400).json({ error: "Chỉ dùng được với nhà cung cấp CLI" });
  res.json(await checkCliCompatibility(provider));
}));
app.post("/api/ai-cli/update", asyncRoute(async (req, res) => {
  if (rejectSaasCli(res)) return;
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const provider = normProvider(String(req.body.provider || "").toLowerCase());
  if (!isCliProvider(provider)) return res.status(400).json({ error: "Chỉ dùng được với nhà cung cấp CLI" });
  res.json(await updateCli(provider));
}));
app.post("/api/ai-cli/logout", asyncRoute(async (req, res) => {
  if (rejectSaasCli(res)) return;
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const provider = normProvider(String(req.body.provider || "").toLowerCase());
  if (!isCliProvider(provider)) return res.status(400).json({ error: "Chỉ dùng được với nhà cung cấp CLI" });
  res.json(clearCliAuth(provider));
}));

app.get("/api/cli-proxy-api/status", asyncRoute(async (req, res) => {
  if (rejectSaasCli(res)) return;
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  res.json(await getCliProxyApiStatus());
}));
app.post("/api/cli-proxy-api/install", asyncRoute(async (req, res) => {
  if (rejectSaasCli(res)) return;
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  res.json(await installCliProxyApi());
}));
app.post("/api/cli-proxy-api/start", asyncRoute(async (req, res) => {
  if (rejectSaasCli(res)) return;
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  res.json(await startCliProxyApi());
}));
app.post("/api/cli-proxy-api/login", asyncRoute(async (req, res) => {
  if (rejectSaasCli(res)) return;
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  res.json(await loginCliProxyApi(req.body?.provider || "antigravity"));
}));
app.post("/api/cli-proxy-api/connect", asyncRoute(async (req, res) => {
  if (rejectSaasCli(res)) return;
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const connected = await connectCliProxyApi();
  c.db.setSetting("ai_enabled", "1");
  c.db.setSetting("ai_provider", "cliproxyapi");
  c.db.setSetting("ai_base_url", connected.baseUrl);
  c.db.setSetting("ai_model", connected.model);
  if (connected.apiKey) c.db.setSetting("ai_api_key", connected.apiKey);
  c.db.setSetting("ai_saved_at", Date.now());
  const cfg = c.db.aiSettings(false);
  cfg.providerLabel = aiProviderLabel("cliproxyapi");
  cfg.connected = true;
  cfg.configured = true;
  cfg.usable = true;
  cfg.statusText = connected.message;
  res.json({ ...connected, config: withZaloLock(c, cfg) });
}));

app.post("/api/ai-config", asyncRoute(async (req, res) => {
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const provider = normProvider(String(req.body.provider || (saas ? "openai" : "codex-cli")).toLowerCase());

  if (saas || isApiProviderId(provider) || ["openai", "gemini", "claude", "custom"].includes(provider)) {
    const defaults = AI_API_PRESETS[provider] || AI_API_PRESETS.openai;
    const incomingKey = String(req.body.apiKey || "").trim();
    const existing = c.db.getSetting("ai_api_key") || "";
    if (!incomingKey && !existing) {
      return res.status(400).json({ error: "Cần nhập API key" });
    }
    c.db.setSetting("ai_enabled", req.body.enabled ? "1" : "0");
    c.db.setSetting("ai_provider", provider);
    c.db.setSetting("ai_base_url", String(req.body.baseUrl || defaults.baseUrl).trim());
    c.db.setSetting("ai_model", String(req.body.model || defaults.model).trim());
    c.db.setSetting("ai_prompt", String(req.body.prompt || "").trim());
    if (incomingKey) {
      c.db.setSetting("ai_api_key", saas ? encryptSecret(incomingKey) : incomingKey);
    }
    c.db.setSetting("ai_saved_at", Date.now());
    const cfg = c.db.aiSettings(false);
    cfg.providerLabel = aiProviderLabel(provider);
    cfg.connected = Boolean(cfg.maskedKey);
    cfg.configured = Boolean(cfg.maskedKey);
    cfg.usable = Boolean(cfg.configured && cfg.enabled);
    cfg.statusText = cfg.connected ? `${cfg.providerLabel} đã lưu API key` : "Chưa có API key";
    return res.json(withZaloLock(c, cfg));
  }

  const presets = {
    "codex-cli": { baseUrl: "", model: "codex-cli" },
    "claude-cli": { baseUrl: "", model: "claude-cli" },
    cliproxyapi: { baseUrl: "http://127.0.0.1:8317/v1", model: "gemini-2.5-flash" }
  };
  if (!presets[provider]) return res.status(400).json({ error: "Nhà cung cấp AI không hợp lệ." });
  let installNote = "";
  if (isCliProvider(provider)) {
    try {
      const ensured = await ensureCliInstalled(provider);
      if (ensured.installedNow) installNote = ensured.message || `Đã cài ${provider}.`;
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const cli = await getCliReadiness(provider);
    if (!cli?.installed) return res.status(400).json({ error: `Chưa cài ${cli?.name || provider}. ${cli?.installHint || ""}`.trim() });
    if (!cli?.loggedIn) return res.status(400).json({ error: `${cli.name} chưa đăng nhập. Hãy bấm Đăng nhập trên trình duyệt trước.${installNote ? ` ${installNote}` : ""}` });
  } else if (provider === "cliproxyapi") {
    const cpa = await getCliProxyApiStatus();
    if (!cpa.ready && req.body.enabled) {
      return res.status(400).json({ error: cpa.message || "AI brain chưa sẵn sàng. Khởi động, đăng nhập, rồi Kết nối." });
    }
  }
  const defaults = presets[provider];
  c.db.setSetting("ai_enabled", req.body.enabled ? "1" : "0");
  c.db.setSetting("ai_provider", provider);
  c.db.setSetting("ai_base_url", String(req.body.baseUrl || defaults.baseUrl).trim());
  c.db.setSetting("ai_model", String(req.body.model || defaults.model).trim());
  c.db.setSetting("ai_prompt", String(req.body.prompt || "").trim());
  if (provider === "cliproxyapi") {
    const key = String(req.body.apiKey || "").trim() || c.db.getSetting("ai_api_key") || "zalo-digest-local";
    c.db.setSetting("ai_api_key", key);
  }
  c.db.setSetting("ai_saved_at", Date.now());
  const cfg = c.db.aiSettings(false);
  cfg.providerLabel = aiProviderLabel(provider);
  if (isCliProvider(provider)) {
    const cli = await getCliReadiness(provider);
    cfg.cli = cli;
    cfg.connected = Boolean(cli?.ready || cli?.loggedIn);
    cfg.configured = Boolean(cfg.enabled && cli?.ready);
    cfg.statusText = cfg.configured ? `${cli.name} đã sẵn sàng` : (cli?.detail || "Chưa sẵn sàng");
    if (installNote) cfg.installNote = installNote;
  } else if (provider === "cliproxyapi") {
    const cpa = await getCliProxyApiStatus();
    cfg.cliProxyApi = cpa;
    cfg.connected = Boolean(cpa.ready);
    cfg.configured = Boolean(cfg.enabled && cpa.ready);
    cfg.statusText = cpa.message;
  }
  cfg.usable = Boolean(cfg.configured && cfg.enabled);
  res.json(withZaloLock(c, cfg));
}));

app.post("/api/ai-config/test", asyncRoute(async (req, res) => {
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const bodyProvider = normProvider(String(req.body?.provider || "").toLowerCase());
  const cfg = c.db.aiSettings(true);
  if (bodyProvider) cfg.provider = bodyProvider;
  if (typeof req.body?.enabled === "boolean") cfg.enabled = req.body.enabled;
  const apiProviders = ["openai", "gemini", "claude", "custom", "anthropic"];

  if (saas || apiProviders.includes(cfg.provider)) {
    if (!cfg.apiKey) return res.status(400).json({ error: "Chưa có API key" });
    cfg.enabled = true;
    if (cfg.provider === "claude") cfg.provider = "claude";
    const output = await callAI(cfg, "Trả lời ngắn gọn bằng tiếng Việt.", "Chỉ trả lời: Kết nối AI thành công");
    return res.json({ ok: true, output: String(output).slice(0, 300) });
  }

  if (isCliProvider(cfg.provider)) {
    const cli = await getCliReadiness(cfg.provider);
    if (!cli?.installed) return res.status(400).json({ error: `Chưa cài ${cli?.name || cfg.provider}` });
    if (!cli?.loggedIn) return res.status(400).json({ error: `${cli.name} chưa đăng nhập. Hãy bấm Đăng nhập trên trình duyệt.` });
    cfg.enabled = true;
  } else if (cfg.provider === "cliproxyapi") {
    const cpa = await getCliProxyApiStatus();
    if (!cpa.ready) return res.status(400).json({ error: cpa.message || "AI brain chưa sẵn sàng" });
    cfg.enabled = true;
    cfg.baseUrl = cfg.baseUrl || cpa.baseUrl;
    if (!cfg.apiKey) cfg.apiKey = cpa.apiKey || "zalo-digest-local";
  } else {
    return res.status(400).json({ error: "Nhà cung cấp AI không hỗ trợ kiểm tra." });
  }
  const output = await callAI(cfg, "Trả lời ngắn gọn bằng tiếng Việt.", "Chỉ trả lời: Kết nối AI thành công");
  res.json({ ok: true, output: String(output).slice(0, 300) });
}));

app.post("/api/bot", asyncRoute(async (req, res) => {
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const token = String(req.body.token || "").trim(), chatId = String(req.body.chatId || "").trim();
  if (!token) return res.status(400).json({ error: "Thiếu Bot Token" });
  const info = await verifyBot(token);
  c.db.setSetting("bot_token", token);
  c.db.setSetting("bot_name", info.account_name || info.name || info.id || "Zalo Bot");
  if (chatId) c.db.setSetting("bot_chat_id", chatId);
  c.db.setSetting("bot_saved_at", Date.now());
  res.json(withZaloLock(c, c.db.botSettings()));
}));
app.post("/api/bot/discover", asyncRoute(async (req, res) => {
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const token = c.db.getSetting("bot_token");
  if (!token) return res.status(400).json({ error: "Chưa lưu Bot Token" });
  res.json(await discoverChats(token));
}));
app.post("/api/bot/test", asyncRoute(async (req, res) => {
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const token = c.db.getSetting("bot_token");
  const chatId = String(req.body.chatId || c.db.getSetting("bot_chat_id") || "");
  if (!token || !chatId) return res.status(400).json({ error: "Thiếu token hoặc chat_id" });
  c.db.setSetting("bot_chat_id", chatId);
  await sendBotMessage(token, chatId, "Zalo Work Digest đã kết nối thành công.");
  res.json({ ok: true });
}));

app.get("/api/digest-schedules", (req, res) => {
  const c = ctx(req);
  if (!zaloOnline(c)) return res.json([]);
  res.json(c.db.listDigestSchedules());
});
app.post("/api/digest-schedules", (req, res) => {
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const { groupId = "*", timeOfDay, channels = "web,csv" } = req.body;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeOfDay || "")) return res.status(400).json({ error: "Giờ xuất không hợp lệ" });
  const normalized = String(channels || "").split(",").map(s => s.trim().toLowerCase()).filter(ch => ["web", "csv", "bot"].includes(ch));
  if (!normalized.length) return res.status(400).json({ error: "Chọn ít nhất một kênh nhận (web, csv, bot)" });
  res.status(201).json({ id: c.db.createDigestSchedule({ groupId, timeOfDay, channels: normalized.join(",") }) });
});
app.delete("/api/digest-schedules/:id", (req, res) => {
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  if (!c.db.deleteDigestSchedule(Number(req.params.id))) return res.status(404).json({ error: "Không tìm thấy lịch tổng hợp" });
  res.json({ ok: true });
});
app.get("/api/schedules", (req, res) => {
  const c = ctx(req);
  if (!zaloOnline(c)) return res.json([]);
  res.json(c.db.listSchedules());
});
app.post("/api/schedules", (req, res) => {
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  const { groupId, targetType = "group", content, members = [], runAt, recurrence = "once" } = req.body;
  if (!groupId || !String(content || "").trim() || !Number(runAt)) return res.status(400).json({ error: "Thiếu người/nhóm nhận, nội dung hoặc thời gian" });
  if (!["group", "user"].includes(targetType)) return res.status(400).json({ error: "Loại người nhận không hợp lệ" });
  if (!["once", "daily"].includes(recurrence)) return res.status(400).json({ error: "Kiểu lặp không hợp lệ" });
  if (Number(runAt) < Date.now() + 5000) return res.status(400).json({ error: "Thời gian gửi phải cách hiện tại ít nhất 5 giây" });
  const prepared = targetType === "group" ? buildMentionMessage(String(content).trim(), members) : { msg: String(content).trim(), mentions: [] };
  const id = c.db.createSchedule({ groupId, targetType, content: prepared.msg, mentions: prepared.mentions, runAt: Number(runAt), recurrence });
  res.status(201).json({ id, preview: prepared });
});
app.delete("/api/schedules/:id", (req, res) => {
  const c = ctx(req);
  if (!requireZalo(c, res)) return;
  if (!c.db.deletePendingSchedule(Number(req.params.id))) return res.status(409).json({ error: "Chỉ có thể xóa lịch chưa được gửi" });
  res.json({ ok: true });
});

app.get("/api/alert-rules", (req, res) => res.json(ctx(req).db.listAlertRules()));
app.post("/api/alert-rules", (req, res) => {
  const c = ctx(req);
  const { name, keywords, matchMention, matchAny, groupId, priority, notifyBot, enabled } = req.body || {};
  if (!String(name || "").trim() && !String(keywords || "").trim() && !matchMention && !matchAny) {
    return res.status(400).json({ error: "Cần tên hoặc từ khóa hoặc bật điều kiện tag / tag-hoặc-từ-khóa" });
  }
  const id = c.db.createAlertRule({
    name: name || "Quy tắc cảnh báo",
    keywords: keywords || "",
    matchMention: Boolean(matchMention) || Boolean(matchAny),
    matchAny: Boolean(matchAny),
    groupId: groupId || "*",
    priority: priority === "high" ? "high" : "normal",
    notifyBot: Boolean(notifyBot),
    enabled: enabled !== false
  });
  res.status(201).json({ id, rule: c.db.listAlertRules().find(r => r.id === id) });
});
app.delete("/api/alert-rules/:id", (req, res) => {
  const c = ctx(req);
  if (!c.db.deleteAlertRule(Number(req.params.id))) return res.status(404).json({ error: "Không tìm thấy quy tắc" });
  res.json({ ok: true });
});

async function processInboundAlertRulesFor(dbInst, msg) {
  try {
    const rules = dbInst.listEnabledAlertRules();
    if (!rules.length) return;
    const hits = matchRules(msg, rules);
    if (!hits.length) return;
    const token = dbInst.getSetting("bot_token");
    const chatId = dbInst.getSetting("bot_chat_id");
    const threadName = dbInst.listGroups().find(g => g.id === msg.groupId)?.name
      || (msg.threadType === "user" ? (msg.senderName || "Tin riêng") : msg.groupId);
    for (const rule of hits) {
      if (!Number(rule.notify_bot)) {
        dbInst.recordAlertRuleHit(msg.groupId, msg.id, rule.id);
        continue;
      }
      if (!token || !chatId) continue;
      if (dbInst.hasAlertRuleHit(msg.groupId, msg.id, rule.id)) continue;
      await sendBotMessage(token, chatId, formatRuleBotMessage({ rule, message: msg, threadName }));
      dbInst.recordAlertRuleHit(msg.groupId, msg.id, rule.id);
    }
  } catch (error) {
    console.error("Alert rules:", error.message);
  }
}

if (!saas) {
  zalo.on("inbound", msg => { processInboundAlertRulesFor(db, msg); });
}

async function runSchedulerFor(c) {
  if (!zaloOnline(c)) return;
  for (const job of c.db.dueSchedules(Date.now())) {
    if (!c.db.markScheduleRunning(job.id)) continue;
    try {
      const sent = await c.withAssets(() =>
        c.zalo.send(job.group_id, { msg: job.content, mentions: JSON.parse(job.mentions_json) }, job.target_type || "group")
      );
      c.db.finishSchedule(job.id, { ok: true, messageId: sent.messageId });
    } catch (error) {
      c.db.finishSchedule(job.id, { ok: false, error: error.message });
    }
  }
}

async function runDigestSchedulerFor(c) {
  if (!zaloOnline(c)) return;
  const now = new Date(), date = now.toLocaleDateString("en-CA"), time = now.toTimeString().slice(0, 5);
  for (const job of c.db.dueDigestSchedules(date, time)) {
    try {
      const channels = String(job.channels || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
      const groups = job.group_id === "*" ? c.db.listGroups().filter(g => g.enabled) : c.db.listGroups().filter(g => g.id === job.group_id);
      const from = new Date(now); from.setHours(0, 0, 0, 0);
      const fromTs = from.getTime();
      const toTs = now.getTime();
      const digests = [];
      for (const group of groups) {
        const messages = c.db.listMessages({ groupId: group.id, from: fromTs, to: toTs, limit: 5000 });
        const content = await createDigestWithConfig(messages, group.name, c.db.aiSettings(true));
        digests.push({ group, messages, content });
      }
      const combined = digests.map(d => d.content).join("\n\n").slice(0, 2000);

      if (channels.includes("web")) {
        for (const item of digests) {
          c.db.createDigest({
            groupId: item.group.id,
            from: fromTs,
            to: toTs,
            content: item.content || "Hôm nay chưa có tin nhắn cần tổng hợp."
          });
        }
      }

      if (channels.includes("csv")) {
        const exportDir = path.join(c.store.dataDir, "exports");
        fs.mkdirSync(exportDir, { recursive: true });
        const stamp = `${date}_${String(time).replace(":", "")}`;
        const allMessages = digests.flatMap(item => item.messages.map(m => ({
          ...m,
          thread_name: item.group.name || m.group_id
        })));
        fs.writeFileSync(path.join(exportDir, `digest-${stamp}.csv`), messagesCsv(allMessages), "utf8");
        fs.writeFileSync(path.join(exportDir, `digest-${stamp}.txt`), combined || "Hôm nay chưa có tin nhắn cần tổng hợp.", "utf8");
      }

      if (channels.includes("bot")) {
        const token = c.db.getSetting("bot_token"), chatId = c.db.getSetting("bot_chat_id");
        if (!token || !chatId) throw new Error("Chưa cấu hình Zalo Bot");
        await sendBotMessage(token, chatId, combined || "Hôm nay chưa có tin nhắn cần tổng hợp.");
      }

      c.db.finishDigestSchedule(job.id, date);
    } catch (error) {
      console.error("Digest schedule:", error.message);
    }
  }
}

async function runScheduler() {
  if (saas) {
    for (const rt of tenants.listRuntimes()) {
      const c = {
        store: rt.store,
        db: tenants.dbProxy(rt),
        zalo: rt.zalo,
        withAssets(fn) { return runWithAssetDir(rt.store.assetsDir, fn); }
      };
      await runSchedulerFor(c);
    }
    return;
  }
  await runSchedulerFor({ store, db, zalo, withAssets: fn => fn() });
}

async function runDigestScheduler() {
  if (saas) {
    for (const rt of tenants.listRuntimes()) {
      const c = {
        store: rt.store,
        db: tenants.dbProxy(rt),
        zalo: rt.zalo,
        withAssets(fn) { return runWithAssetDir(rt.store.assetsDir, fn); }
      };
      await runDigestSchedulerFor(c);
    }
    return;
  }
  await runDigestSchedulerFor({ store, db, zalo, withAssets: fn => fn() });
}

setInterval(runScheduler, 5000).unref();
setInterval(runDigestScheduler, 30000).unref();

app.use(express.static(path.join(root, "public")));

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = error.status || 500;
  res.status(status).json({ error: error.message || "Lỗi máy chủ" });
});

export async function startServer({
  port = Number(process.env.PORT) || 4782,
  host = process.env.HOST || (saas ? "0.0.0.0" : "127.0.0.1")
} = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, async () => {
      console.log(`Zalo Work Digest (${appMode()}): http://${host}:${port}`);
      try {
        if (saas) {
          await tenants.restoreAllKnown();
        } else {
          await zalo.restore();
        }
      } catch (error) {
        console.error("Restore Zalo:", error.message);
      }
      resolve({ app, server, port, host, url: `http://${host}:${port}`, zalo, store, tenants, auth });
    });
    server.on("error", reject);
  });
}

export { app, zalo, rebindPaths, store, tenants, auth };

const isDirectRun = !process.env.ZALO_DIGEST_MANUAL_LISTEN;
if (isDirectRun) {
  startServer().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
