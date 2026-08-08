import fs from "node:fs";
import path from "node:path";
import { createDatabase } from "./db.js";
import { setAssetDir } from "./asset-store.js";

export const LOCAL_ACCOUNT_ID = "_local";
const PENDING_SESSION = "session.pending.json";
const SHARED_SETTINGS = "shared-settings.json";

/** AI/Bot dùng chung mọi tài khoản Zalo; nhóm/tin/lịch vẫn tách theo tài khoản. */
export const SHARED_INTEGRATION_KEYS = [
  "ai_enabled", "ai_provider", "ai_base_url", "ai_model", "ai_api_key", "ai_prompt", "ai_saved_at",
  "bot_token", "bot_chat_id", "bot_name", "bot_saved_at"
];
const SHARED_KEY_SET = new Set(SHARED_INTEGRATION_KEYS);

function safeAccountId(id) {
  const raw = String(id || LOCAL_ACCOUNT_ID).trim() || LOCAL_ACCOUNT_ID;
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function integrationSnapshot(db) {
  const out = {};
  for (const key of SHARED_INTEGRATION_KEYS) {
    const value = db.getSetting(key);
    if (value != null && value !== "") out[key] = value;
  }
  return out;
}

/**
 * Mỗi tài khoản Zalo có thư mục riêng: DB + session + assets.
 * data/accounts/<zalo_user_id>/...
 * AI/Bot lưu chung tại data/shared-settings.json
 */
export function createAccountStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const accountsDir = path.join(dataDir, "accounts");
  const metaPath = path.join(dataDir, "meta.json");
  const sharedPath = path.join(dataDir, SHARED_SETTINGS);
  fs.mkdirSync(accountsDir, { recursive: true });

  let accountId = null;
  let rawDb = null;
  let db = null;
  let sessionFile = null;

  const readMeta = () => {
    try { return JSON.parse(fs.readFileSync(metaPath, "utf8")); }
    catch { return {}; }
  };
  const writeMeta = (patch) => {
    const meta = { ...readMeta(), ...patch, updatedAt: Date.now() };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    return meta;
  };

  const readShared = () => {
    try { return JSON.parse(fs.readFileSync(sharedPath, "utf8")); }
    catch { return {}; }
  };
  const writeShared = (data) => {
    fs.writeFileSync(sharedPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  };
  const mergeIntoShared = (snap) => {
    if (!snap || !Object.keys(snap).length) return;
    const shared = readShared();
    let changed = false;
    for (const [key, value] of Object.entries(snap)) {
      if (!SHARED_KEY_SET.has(key)) continue;
      if (shared[key] == null || shared[key] === "") {
        shared[key] = value;
        changed = true;
      }
    }
    if (changed) writeShared(shared);
  };

  const accountPath = (id) => path.join(accountsDir, safeAccountId(id));
  const dbFile = (id) => path.join(accountPath(id), "zalo-digest.db");
  const sessionFileFor = (id) => path.join(accountPath(id), "session.json");
  const assetsDirFor = (id) => path.join(accountPath(id), "assets");

  const moveIfPresent = (src, dest) => {
    if (!fs.existsSync(src) || fs.existsSync(dest)) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    return true;
  };

  /** Gắn AI/Bot dùng chung vào DB tài khoản (mọi method nội bộ đều thấy). */
  const wrapDb = (target) => {
    const origGet = target.getSetting.bind(target);
    const origSet = target.setSetting.bind(target);
    target.getSetting = (key) => {
      if (SHARED_KEY_SET.has(key)) {
        const shared = readShared();
        if (shared[key] != null && shared[key] !== "") return String(shared[key]);
      }
      return origGet(key);
    };
    target.setSetting = (key, value) => {
      if (SHARED_KEY_SET.has(key)) {
        const shared = readShared();
        shared[key] = String(value);
        writeShared(shared);
      }
      return origSet(key, value);
    };
    return target;
  };

  /** Chuyển DB/session cũ (một file chung) sang accounts/<id>/ một lần. */
  const migrateLegacy = () => {
    const legacyDb = path.join(dataDir, "zalo-digest.db");
    if (!fs.existsSync(legacyDb)) return null;

    let uid = "";
    let snap = {};
    const tmp = createDatabase(legacyDb);
    try {
      uid = tmp.getZaloUserId() || "";
      snap = integrationSnapshot(tmp);
    } finally { try { tmp.close(); } catch {} }

    if (!uid) {
      try {
        const session = JSON.parse(fs.readFileSync(path.join(dataDir, "session.json"), "utf8"));
        uid = String(session?.profile?.id || "");
      } catch {}
    }
    if (!uid) uid = "legacy";

    const destDir = accountPath(uid);
    fs.mkdirSync(destDir, { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      moveIfPresent(legacyDb + suffix, path.join(destDir, `zalo-digest.db${suffix}`));
    }
    moveIfPresent(path.join(dataDir, "session.json"), sessionFileFor(uid));
    const legacyAssets = path.join(dataDir, "assets");
    if (fs.existsSync(legacyAssets) && !fs.existsSync(assetsDirFor(uid))) {
      fs.renameSync(legacyAssets, assetsDirFor(uid));
    }
    mergeIntoShared(snap);
    writeMeta({ activeAccountId: safeAccountId(uid), migratedFromLegacy: true });
    return safeAccountId(uid);
  };

  const openAccount = (id) => {
    const sid = safeAccountId(id);
    if (accountId === sid && db) return db;
    if (rawDb) {
      try { rawDb.close(); } catch {}
      rawDb = null;
      db = null;
    }
    fs.mkdirSync(accountPath(sid), { recursive: true });
    fs.mkdirSync(assetsDirFor(sid), { recursive: true });
    rawDb = createDatabase(dbFile(sid));
    // Seed shared AI/Bot từ DB tài khoản nếu shared còn trống.
    mergeIntoShared(integrationSnapshot(rawDb));
    if (sid !== LOCAL_ACCOUNT_ID) rawDb.setSetting("zalo_user_id", sid);
    db = wrapDb(rawDb);
    accountId = sid;
    sessionFile = sessionFileFor(sid);
    setAssetDir(assetsDirFor(sid));
    writeMeta({ activeAccountId: sid });
    return db;
  };

  /** Đổi sang kho dữ liệu của tài khoản `userId` (giữ nguyên dữ liệu tài khoản cũ trên đĩa). */
  const switchAccount = (userId) => {
    const from = accountId;
    const to = safeAccountId(userId);
    if (from === to && db) return { switched: false, from, to, db };
    openAccount(to);
    return { switched: from !== to, from, to, db };
  };

  migrateLegacy();
  // Seed shared từ mọi tài khoản đã có (ưu tiên giá trị đã có trong shared).
  try {
    for (const name of fs.readdirSync(accountsDir)) {
      const p = path.join(accountsDir, name, "zalo-digest.db");
      if (!fs.existsSync(p)) continue;
      const tmp = createDatabase(p);
      try { mergeIntoShared(integrationSnapshot(tmp)); }
      finally { try { tmp.close(); } catch {} }
    }
  } catch {}

  const startId = readMeta().activeAccountId || LOCAL_ACCOUNT_ID;
  openAccount(startId);

  return {
    get db() { return db; },
    get dataDir() { return dataDir; },
    get accountId() { return accountId; },
    get sessionFile() { return sessionFile; },
    get pendingSessionFile() { return path.join(dataDir, PENDING_SESSION); },
    get assetsDir() { return assetsDirFor(accountId || LOCAL_ACCOUNT_ID); },
    get sharedSettingsPath() { return sharedPath; },
    accountsDir,
    openAccount,
    switchAccount,
    close() {
      if (rawDb) {
        try { rawDb.close(); } catch {}
        rawDb = null;
        db = null;
      }
    },
    resolveSessionForRestore() {
      const id = readMeta().activeAccountId;
      if (!id || id === LOCAL_ACCOUNT_ID) return null;
      const sf = sessionFileFor(id);
      if (!fs.existsSync(sf)) return null;
      openAccount(id);
      return sf;
    },
    adoptPendingSession(userId) {
      const pending = path.join(dataDir, PENDING_SESSION);
      switchAccount(userId);
      if (fs.existsSync(pending)) {
        fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
        try { if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile); } catch {}
        fs.renameSync(pending, sessionFile);
      }
      return sessionFile;
    }
  };
}
