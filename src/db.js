import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { decryptSecret, maskSecret } from "./secrets.js";

export function createDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT DEFAULT '',
      member_count INTEGER DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar TEXT DEFAULT '',
      PRIMARY KEY (group_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS contacts (
      user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, avatar TEXT DEFAULT '', updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT DEFAULT '',
      content TEXT NOT NULL,
      message_type TEXT DEFAULT 'text',
      sent_at INTEGER NOT NULL,
      is_self INTEGER NOT NULL DEFAULT 0,
      raw_json TEXT,
      PRIMARY KEY (group_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_group_time ON messages(group_id, sent_at);
    CREATE TABLE IF NOT EXISTS digests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      content TEXT NOT NULL,
      mentions_json TEXT NOT NULL DEFAULT '[]',
      run_at INTEGER NOT NULL,
      recurrence TEXT NOT NULL DEFAULT 'once',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      sent_message_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS digest_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL DEFAULT '*',
      time_of_day TEXT NOT NULL, channels TEXT NOT NULL DEFAULT 'web,csv',
      enabled INTEGER NOT NULL DEFAULT 1, last_run_date TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL DEFAULT '',
      thread_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'image',
      name TEXT NOT NULL DEFAULT '',
      file_path TEXT NOT NULL DEFAULT '',
      web_url TEXT NOT NULL DEFAULT '',
      mime TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      hash TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alert_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '',
      match_mention INTEGER NOT NULL DEFAULT 0,
      match_any INTEGER NOT NULL DEFAULT 0,
      group_id TEXT NOT NULL DEFAULT '*',
      priority TEXT NOT NULL DEFAULT 'normal',
      notify_bot INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alert_rule_hits (
      group_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      rule_id INTEGER NOT NULL,
      notified_at INTEGER NOT NULL,
      PRIMARY KEY (group_id, message_id, rule_id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_sender_time ON messages(sender_id, sent_at);
  `);
  for (const sql of [
    "ALTER TABLE messages ADD COLUMN thread_type TEXT NOT NULL DEFAULT 'group'",
    "ALTER TABLE messages ADD COLUMN is_mention INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE schedules ADD COLUMN target_type TEXT NOT NULL DEFAULT 'group'",
    "ALTER TABLE messages ADD COLUMN has_asset INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE messages ADD COLUMN asset_info TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE alert_rules ADD COLUMN match_any INTEGER NOT NULL DEFAULT 0"
  ]) { try { db.exec(sql); } catch {} }

  const q = {
    upsertGroup: db.prepare(`INSERT INTO groups(id,name,avatar,member_count,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,avatar=excluded.avatar,
      member_count=excluded.member_count,updated_at=excluded.updated_at`),
    upsertMember: db.prepare(`INSERT INTO members(group_id,user_id,display_name,avatar)
      VALUES(?,?,?,?) ON CONFLICT(group_id,user_id) DO UPDATE SET display_name=excluded.display_name,avatar=excluded.avatar`),
    insertMessage: db.prepare(`INSERT OR IGNORE INTO messages
      (id,group_id,sender_id,sender_name,content,message_type,sent_at,is_self,raw_json,thread_type,is_mention)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`),
    addAssetFlag: db.prepare("UPDATE messages SET has_asset=1, asset_info=? WHERE group_id=? AND id=?"),
  };

  return {
    raw: db,
    close: () => db.close(),
    listGroups: () => db.prepare("SELECT * FROM groups ORDER BY enabled DESC, name COLLATE NOCASE").all(),
    saveGroup(group) {
      q.upsertGroup.run(group.id, group.name, group.avatar || "", group.memberCount || 0, Date.now());
      for (const m of group.members || []) q.upsertMember.run(group.id, m.id, m.name, m.avatar || "");
    },
    enableGroup(id, enabled) {
      db.prepare("UPDATE groups SET enabled=? WHERE id=?").run(enabled ? 1 : 0, id);
    },
    isGroupEnabled(id) {
      return Boolean(db.prepare("SELECT enabled FROM groups WHERE id=?").get(id)?.enabled);
    },
    listMembers(id) {
      return db.prepare("SELECT user_id,display_name,avatar FROM members WHERE group_id=? ORDER BY display_name COLLATE NOCASE").all(id);
    },
    saveContacts(contacts) {
      const stmt = db.prepare(`INSERT INTO contacts(user_id,display_name,avatar,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,avatar=excluded.avatar,updated_at=excluded.updated_at`);
      for (const contact of contacts) stmt.run(contact.id, contact.name, contact.avatar || "", Date.now());
    },
    replaceContacts(contacts) {
      db.prepare("DELETE FROM contacts").run();
      this.saveContacts(contacts || []);
    },
    removeGroupsNotIn(ids = []) {
      // Không bao giờ xóa hết khi danh sách rỗng (tránh mất data vì sync lỗi).
      if (!Array.isArray(ids) || ids.length === 0) return 0;
      const keep = new Set(ids.map(String));
      const rows = db.prepare("SELECT id FROM groups").all();
      let removed = 0;
      for (const row of rows) {
        if (keep.has(String(row.id))) continue;
        db.prepare("DELETE FROM members WHERE group_id=?").run(row.id);
        db.prepare("DELETE FROM groups WHERE id=?").run(row.id);
        removed += 1;
      }
      return removed;
    },
    pruneOrphanAccountData() {
      db.prepare("DELETE FROM members WHERE group_id NOT IN (SELECT id FROM groups)").run();
      db.prepare("DELETE FROM messages WHERE thread_type='group' AND group_id NOT IN (SELECT id FROM groups)").run();
      db.prepare("DELETE FROM digests WHERE group_id <> '*' AND group_id NOT IN (SELECT id FROM groups)").run();
      db.prepare("DELETE FROM digest_schedules WHERE group_id <> '*' AND group_id NOT IN (SELECT id FROM groups)").run();
      db.prepare("DELETE FROM schedules WHERE COALESCE(target_type,'group')='group' AND group_id NOT IN (SELECT id FROM groups)").run();
      db.prepare("DELETE FROM messages WHERE thread_type='user' AND group_id NOT IN (SELECT user_id FROM contacts)").run();
      db.prepare("DELETE FROM schedules WHERE target_type='user' AND group_id NOT IN (SELECT user_id FROM contacts)").run();
      const orphanAssets = db.prepare(`SELECT id,file_path FROM assets WHERE message_id <> '' AND message_id NOT IN (SELECT id FROM messages)`).all();
      for (const row of orphanAssets) {
        db.prepare("DELETE FROM assets WHERE id=?").run(row.id);
        if (row.file_path && fs.existsSync(row.file_path)) {
          try { fs.unlinkSync(row.file_path); } catch {}
        }
      }
    },
    listContacts() { return db.prepare("SELECT user_id,display_name,avatar FROM contacts ORDER BY display_name COLLATE NOCASE").all(); },
    saveMessage(message) {
      const out = q.insertMessage.run(message.id, message.groupId, message.senderId, message.senderName || "",
        message.content, message.type || "text", message.sentAt, message.isSelf ? 1 : 0, JSON.stringify(message.raw || {}),
        message.threadType || "group", message.isMention ? 1 : 0);
      const hints = message.assetHints || [];
      if (hints.length) q.addAssetFlag.run(JSON.stringify(hints.map(h => h.url)), message.groupId, message.id);
      return { id: message.id };
    },
    listMessages({ groupId, from, to, limit = 500 }) {
      return db.prepare(`SELECT * FROM messages WHERE group_id=? AND sent_at BETWEEN ? AND ?
        ORDER BY sent_at ASC LIMIT ?`).all(groupId, from, to, Math.min(Number(limit) || 500, 5000));
    },
    createDigest({ groupId, from, to, content }) {
      const out = db.prepare(`INSERT INTO digests(group_id,period_start,period_end,content,created_at)
        VALUES(?,?,?,?,?)`).run(groupId, from, to, content, Date.now());
      return Number(out.lastInsertRowid);
    },
    listDigests(groupId) {
      return db.prepare("SELECT * FROM digests WHERE group_id=? ORDER BY created_at DESC LIMIT 30").all(groupId);
    },
    listAlerts({ from = 0, to = Date.now(), limit = 500, groupId = "", senderId = "", q = "", kind = "" } = {}) {
      const where = ["m.sent_at BETWEEN ? AND ?", "m.is_self=0"];
      const params = [from, to];
      const k = String(kind || "").toLowerCase();
      if (k === "mention") where.push("m.is_mention=1");
      else if (k === "dm") where.push("m.thread_type='user'");
      else if (k === "all") { /* mọi tin không phải self */ }
      else where.push("(m.is_mention=1 OR m.thread_type='user')");
      if (groupId) { where.push("m.group_id=?"); params.push(String(groupId)); }
      if (senderId) { where.push("m.sender_id=?"); params.push(String(senderId)); }
      const keyword = String(q || "").trim();
      if (keyword) { where.push("m.content LIKE ? COLLATE NOCASE"); params.push(`%${keyword.replace(/%/g, "")}%`); }
      params.push(Math.min(Number(limit) || 500, 5000));
      return db.prepare(`SELECT m.*,COALESCE(g.name,m.sender_name,'Tin nhắn riêng') thread_name FROM messages m
        LEFT JOIN groups g ON g.id=m.group_id WHERE ${where.join(" AND ")}
        ORDER BY m.sent_at DESC LIMIT ?`).all(...params);
    },
    searchMessages({ groupId = "", senderId = "", q = "", from = 0, to = Date.now(), limit = 500 } = {}) {
      const where = ["m.sent_at BETWEEN ? AND ?", "m.is_self=0"];
      const params = [from, to];
      if (groupId) { where.push("m.group_id=?"); params.push(String(groupId)); }
      if (senderId) { where.push("m.sender_id=?"); params.push(String(senderId)); }
      const keyword = String(q || "").trim();
      if (keyword) { where.push("m.content LIKE ? COLLATE NOCASE"); params.push(`%${keyword.replace(/%/g, "")}%`); }
      params.push(Math.min(Number(limit) || 500, 5000));
      return db.prepare(`SELECT m.*,COALESCE(g.name,m.sender_name,'Tin nhắn') thread_name FROM messages m
        LEFT JOIN groups g ON g.id=m.group_id WHERE ${where.join(" AND ")}
        ORDER BY m.sent_at DESC LIMIT ?`).all(...params);
    },
    countMessages({ from = 0, to = Date.now() } = {}) {
      return Number(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE is_self=0 AND sent_at BETWEEN ? AND ?").get(from, to)?.c || 0);
    },
    messageStats({ granularity = "hour", from = 0, to = Date.now() } = {}) {
      const g = String(granularity || "hour");
      const start = Number(from) || 0;
      const end = Number(to) || Date.now();
      const rows = db.prepare("SELECT sent_at FROM messages WHERE is_self=0 AND sent_at BETWEEN ? AND ?").all(start, end);
      const buckets = [];
      if (g === "month") {
        const cursor = new Date(start);
        cursor.setDate(1); cursor.setHours(0, 0, 0, 0);
        while (cursor.getTime() <= end) {
          const bFrom = cursor.getTime();
          const label = `${String(cursor.getMonth() + 1).padStart(2, "0")}/${cursor.getFullYear()}`;
          cursor.setMonth(cursor.getMonth() + 1);
          buckets.push({ key: label, label, from: bFrom, to: Math.min(cursor.getTime() - 1, end), count: 0 });
        }
        for (const row of rows) {
          const d = new Date(row.sent_at);
          const key = `${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
          const hit = buckets.find(b => b.key === key);
          if (hit) hit.count += 1;
        }
      } else if (g === "day") {
        const cursor = new Date(start);
        cursor.setHours(0, 0, 0, 0);
        while (cursor.getTime() <= end) {
          const bFrom = cursor.getTime();
          const label = `${String(cursor.getDate()).padStart(2, "0")}/${String(cursor.getMonth() + 1).padStart(2, "0")}`;
          const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
          cursor.setDate(cursor.getDate() + 1);
          buckets.push({ key, label, from: bFrom, to: Math.min(cursor.getTime() - 1, end), count: 0 });
        }
        for (const row of rows) {
          const d = new Date(row.sent_at);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          const hit = buckets.find(b => b.key === key);
          if (hit) hit.count += 1;
        }
      } else {
        const day = new Date(start);
        day.setHours(0, 0, 0, 0);
        for (let h = 0; h < 24; h++) {
          const bFrom = day.getTime() + h * 3600000;
          const bTo = bFrom + 3600000 - 1;
          buckets.push({
            key: String(h),
            label: String(h).padStart(2, "0"),
            from: bFrom,
            to: Math.min(bTo, end),
            count: 0
          });
        }
        for (const row of rows) {
          if (row.sent_at < day.getTime()) continue;
          const h = new Date(row.sent_at).getHours();
          if (buckets[h]) buckets[h].count += 1;
        }
      }
      return buckets;
    },
    listAlertRules() {
      return db.prepare("SELECT * FROM alert_rules ORDER BY id DESC").all();
    },
    listEnabledAlertRules() {
      return db.prepare("SELECT * FROM alert_rules WHERE enabled=1 ORDER BY id").all();
    },
    createAlertRule({ name, keywords = "", matchMention = false, matchAny = false, groupId = "*", priority = "normal", notifyBot = false, enabled = true }) {
      const out = db.prepare(`INSERT INTO alert_rules(name,keywords,match_mention,match_any,group_id,priority,notify_bot,enabled,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(
        String(name || "").trim() || "Quy tắc",
        String(keywords || "").trim(),
        matchMention ? 1 : 0,
        matchAny ? 1 : 0,
        String(groupId || "*"),
        priority === "high" ? "high" : "normal",
        notifyBot ? 1 : 0,
        enabled === false ? 0 : 1,
        Date.now()
      );
      return Number(out.lastInsertRowid);
    },
    deleteAlertRule(id) {
      db.prepare("DELETE FROM alert_rule_hits WHERE rule_id=?").run(id);
      return db.prepare("DELETE FROM alert_rules WHERE id=?").run(id).changes === 1;
    },
    hasAlertRuleHit(groupId, messageId, ruleId) {
      return Boolean(db.prepare("SELECT 1 FROM alert_rule_hits WHERE group_id=? AND message_id=? AND rule_id=?").get(groupId, messageId, ruleId));
    },
    recordAlertRuleHit(groupId, messageId, ruleId) {
      db.prepare(`INSERT OR IGNORE INTO alert_rule_hits(group_id,message_id,rule_id,notified_at) VALUES(?,?,?,?)`)
        .run(groupId, messageId, ruleId, Date.now());
    },
    getSetting(key) { return db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value ?? null; },
    setSetting(key, value) { db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value)); },
    botSettings() {
      const token = this.getSetting("bot_token");
      return { configured: Boolean(token), token: token ? `${token.slice(0, 5)}…${token.slice(-4)}` : "", chatId: this.getSetting("bot_chat_id") || "", botName: this.getSetting("bot_name") || "", savedAt: Number(this.getSetting("bot_saved_at")) || null };
    },
    disconnectIntegrations() {
      this.setSetting("ai_enabled", "0");
      this.setSetting("bot_token", "");
      this.setSetting("bot_chat_id", "");
      this.setSetting("bot_name", "");
      this.setSetting("bot_saved_at", "");
    },
    aiSettings(includeSecret = false) {
      const storedKey = this.getSetting("ai_api_key") || "";
      let apiKey = storedKey;
      let masked = "";
      try {
        apiKey = decryptSecret(storedKey);
        masked = maskSecret(storedKey);
      } catch {
        apiKey = storedKey;
        masked = storedKey ? `${storedKey.slice(0, 4)}…${storedKey.slice(-4)}` : "";
      }
      let provider = this.getSetting("ai_provider") || "codex-cli";
      const raw = String(provider || "").toLowerCase();
      if (["gemini-cli", "antigravity-cli", "9router", "cliproxy", "cli-proxy-api"].includes(raw)) {
        provider = "cliproxyapi";
        try { this.setSetting("ai_provider", "cliproxyapi"); } catch {}
      } else if (raw === "anthropic") {
        provider = "claude";
      } else if (raw === "codex") {
        provider = "codex-cli";
      }
      const cli = provider === "codex-cli" || provider === "claude-cli";
      const account = cli || provider === "cliproxyapi";
      const api = ["openai", "gemini", "claude", "custom"].includes(provider);
      return {
        enabled: this.getSetting("ai_enabled") === "1",
        provider,
        baseUrl: this.getSetting("ai_base_url") || (provider === "cliproxyapi" ? "http://127.0.0.1:8317/v1" : ""),
        model: this.getSetting("ai_model") || (provider === "cliproxyapi" ? "gemini-2.5-flash" : provider),
        apiKey: includeSecret ? apiKey : "",
        prompt: this.getSetting("ai_prompt") || "Tóm tắt, quyết định, đầu việc, người phụ trách, thời hạn, câu hỏi tồn đọng và rủi ro.",
        configured: account
          ? Boolean(this.getSetting("ai_enabled") === "1" && (cli || apiKey || provider === "cliproxyapi"))
          : Boolean(apiKey),
        maskedKey: masked || "",
        mode: cli ? "cli" : (provider === "cliproxyapi" ? "account" : (api ? "api" : "api")),
        savedAt: Number(this.getSetting("ai_saved_at")) || null
      };
    },
    createDigestSchedule({ groupId = "*", timeOfDay, channels = "web,csv" }) {
      return Number(db.prepare("INSERT INTO digest_schedules(group_id,time_of_day,channels,created_at) VALUES(?,?,?,?)").run(groupId,timeOfDay,channels,Date.now()).lastInsertRowid);
    },
    listDigestSchedules() { return db.prepare("SELECT * FROM digest_schedules ORDER BY time_of_day").all(); },
    deleteDigestSchedule(id) { return db.prepare("DELETE FROM digest_schedules WHERE id=?").run(id).changes === 1; },
    dueDigestSchedules(date, time) { return db.prepare("SELECT * FROM digest_schedules WHERE enabled=1 AND time_of_day<=? AND COALESCE(last_run_date,'')<>?").all(time,date); },
    finishDigestSchedule(id,date) { db.prepare("UPDATE digest_schedules SET last_run_date=? WHERE id=?").run(date,id); },
    createSchedule({ groupId, targetType = "group", content, mentions, runAt, recurrence = "once" }) {
      const out = db.prepare(`INSERT INTO schedules(group_id,target_type,content,mentions_json,run_at,recurrence,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(groupId, targetType, content, JSON.stringify(mentions || []), runAt, recurrence, Date.now());
      return Number(out.lastInsertRowid);
    },
    listSchedules() {
      return db.prepare("SELECT * FROM schedules ORDER BY run_at DESC LIMIT 100").all();
    },
    dueSchedules(now) {
      return db.prepare("SELECT * FROM schedules WHERE status='pending' AND run_at<=? ORDER BY run_at LIMIT 20").all(now);
    },
    markScheduleRunning(id) {
      return db.prepare("UPDATE schedules SET status='running',attempts=attempts+1 WHERE id=? AND status='pending'").run(id).changes === 1;
    },
    deletePendingSchedule(id) {
      return db.prepare("DELETE FROM schedules WHERE id=? AND status='pending'").run(id).changes === 1;
    },
    finishSchedule(id, result) {
      const job = db.prepare("SELECT recurrence,run_at FROM schedules WHERE id=?").get(id);
      if (job?.recurrence === "daily") {
        const next = new Date(job.run_at);
        do next.setDate(next.getDate() + 1); while (next.getTime() <= Date.now());
        db.prepare(`UPDATE schedules SET status='pending',run_at=?,last_error=?,sent_message_id=? WHERE id=?`)
          .run(next.getTime(), result.error || null, result.messageId || null, id);
        return;
      }
      db.prepare("UPDATE schedules SET status=?,last_error=?,sent_message_id=? WHERE id=?")
        .run(result.ok ? "sent" : "failed", result.error || null, result.messageId || null, id);
    },
    saveAsset(asset) {
      db.prepare(`INSERT OR REPLACE INTO assets(id,message_id,thread_id,kind,name,file_path,web_url,mime,size,hash,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        asset.id, asset.messageId || "", asset.threadId || "", asset.kind || "image",
        asset.name || "", asset.filePath || "", asset.webUrl || "",
        asset.mime || "", Number(asset.size) || 0, asset.hash || "", Date.now());
    },
    listAssetsByMessage(messageId) {
      return db.prepare("SELECT * FROM assets WHERE message_id=? ORDER BY created_at").all(messageId);
    },
    listAssets({ limit = 500 } = {}) {
      return db.prepare("SELECT * FROM assets ORDER BY created_at DESC LIMIT ?").all(Math.min(Number(limit) || 500, 5000));
    },
    deleteAsset(id) {
      return db.prepare("DELETE FROM assets WHERE id=?").run(id).changes === 1;
    },
    /** Xóa dữ liệu gắn tài khoản Zalo (giữ cấu hình AI/Bot và quy tắc cảnh báo). */
    clearZaloAccountData() {
      const assetRows = db.prepare("SELECT file_path, name FROM assets").all();
      db.exec(`
        DELETE FROM alert_rule_hits;
        DELETE FROM assets;
        DELETE FROM messages;
        DELETE FROM members;
        DELETE FROM groups;
        DELETE FROM contacts;
        DELETE FROM digests;
        DELETE FROM schedules;
        DELETE FROM digest_schedules;
      `);
      for (const row of assetRows) {
        const p = row.file_path || "";
        if (p && fs.existsSync(p)) {
          try { fs.unlinkSync(p); } catch {}
        }
      }
      return { ok: true };
    },
    getZaloUserId() {
      return this.getSetting("zalo_user_id") || "";
    },
    setZaloUserId(id) {
      this.setSetting("zalo_user_id", String(id || ""));
    }
  };
}
