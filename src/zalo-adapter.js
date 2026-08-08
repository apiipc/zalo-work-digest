import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Zalo, LoginQRCallbackEventType, ThreadType } from "zca-js";
import { saveRaw, extFromUrl } from "./asset-store.js";
import crypto from "node:crypto";

export class ZaloAdapter extends EventEmitter {
  constructor({ accountStore, sessionFile, db } = {}) {
    super();
    // Ưu tiên accountStore (mỗi tài khoản một kho). fallback sessionFile/db cho test cũ.
    this.store = accountStore || null;
    this._sessionFile = sessionFile || null;
    this._db = db || null;
    this.api = null;
    this.state = { status: "offline", qr: null, profile: null, error: null };
  }

  get db() { return this.store ? this.store.db : this._db; }
  get sessionFile() { return this.store ? this.store.sessionFile : this._sessionFile; }

  setAccountStore(accountStore) {
    this.store = accountStore || null;
  }

  snapshot() { return this.state; }
  setState(patch) { this.state = { ...this.state, ...patch }; this.emit("state", this.state); }

  async restore() {
    const sessionPath = this.store
      ? this.store.resolveSessionForRestore()
      : (this.sessionFile && fs.existsSync(this.sessionFile) ? this.sessionFile : null);
    if (!sessionPath) return false;
    try {
      const credentials = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
      this.setState({ status: "connecting", error: null });
      this.api = await new Zalo({ logging: false, selfListen: true }).login(credentials);
      await this.afterLogin(credentials.profile || null);
      return true;
    } catch (error) {
      this.setState({ status: "offline", error: `Phiên cũ không dùng được: ${error.message}` });
      return false;
    }
  }

  async loginQR() {
    if (this.state.status === "waiting_qr" || this.state.status === "connecting") return;
    this.setState({ status: "connecting", qr: null, error: null });
    const zalo = new Zalo({ logging: false, selfListen: true });
    const pendingFile = this.store?.pendingSessionFile || this.sessionFile;
    try {
      this.api = await zalo.loginQR({}, event => {
        if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
          this.setState({ status: "waiting_qr", qr: `data:image/png;base64,${event.data.image}` });
        } else if (event.type === LoginQRCallbackEventType.QRCodeScanned) {
          this.setState({ status: "confirming", profile: { name: event.data.display_name, avatar: event.data.avatar } });
        } else if (event.type === LoginQRCallbackEventType.QRCodeExpired) {
          event.actions.retry();
        } else if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
          fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
          fs.writeFileSync(pendingFile, JSON.stringify({
            cookie: event.data.cookie, imei: event.data.imei, userAgent: event.data.userAgent,
            profile: this.state.profile
          }, null, 2), { mode: 0o600 });
        }
      });
      await this.afterLogin(this.state.profile);
    } catch (error) {
      this.setState({ status: "offline", qr: null, error: error.message });
    }
  }

  async afterLogin(profile) {
    const ownId = String(this.api.getOwnId());
    let accountSwitched = false;
    if (this.store) {
      const prevId = this.store.accountId;
      this.store.adoptPendingSession(ownId);
      // Cập nhật profile trong session đã chuyển vào thư mục tài khoản.
      try {
        if (fs.existsSync(this.sessionFile)) {
          const cred = JSON.parse(fs.readFileSync(this.sessionFile, "utf8"));
          cred.profile = { ...(cred.profile || {}), ...(profile || {}), id: ownId };
          fs.writeFileSync(this.sessionFile, JSON.stringify(cred, null, 2), { mode: 0o600 });
        }
      } catch {}
      accountSwitched = Boolean(prevId && prevId !== "_local" && prevId !== ownId);
      if (accountSwitched) this.emit("account-switched", { from: prevId, to: ownId });
    } else {
      // Fallback cũ: xóa data khi đổi tài khoản trên cùng một DB.
      const prevId = this.db.getZaloUserId();
      const hasLocalZaloData = this.db.listGroups().length > 0
        || this.db.listContacts().length > 0
        || this.db.listAlerts({ from: 0, to: Date.now() + 1e12, kind: "all", limit: 1 }).length > 0;
      if ((prevId && prevId !== ownId) || (!prevId && hasLocalZaloData)) {
        this.db.clearZaloAccountData();
        accountSwitched = true;
        this.emit("account-switched", { from: prevId || "(unknown)", to: ownId });
      }
    }
    this.db.setZaloUserId(ownId);
    this.setState({
      status: "online",
      qr: null,
      profile: { ...(profile || {}), id: ownId },
      error: null,
      accountSwitched,
      accountId: ownId
    });
    this.api.listener.on("message", msg => this.onMessage(msg));
    this.api.listener.on("disconnected", (code, reason) => {
      if (!this.api) return;
      this.setState({ status: "offline", error: `Mất kết nối (${code}): ${reason || "không rõ"}` });
    });
    this.api.listener.on("error", error => this.setState({ error: error?.message || String(error) }));
    this.api.listener.start();
    await this.syncGroups();
    await this.syncContacts();
    if (accountSwitched) this.setState({ accountSwitched: false });
  }

  logout() {
    const api = this.api;
    this.api = null;
    if (api?.listener) {
      try {
        api.listener.removeAllListeners();
        api.listener.stop();
      } catch {}
    }
    try {
      if (this.sessionFile && fs.existsSync(this.sessionFile)) fs.unlinkSync(this.sessionFile);
    } catch {}
    this.setState({ status: "offline", qr: null, profile: null, error: null });
    return this.snapshot();
  }

  async syncContacts() {
    if (!this.api) throw new Error("Zalo chưa đăng nhập");
    const response = await this.api.getAllFriends();
    const contacts = (Array.isArray(response) ? response : response?.friends || response?.profiles || Object.values(response || {}))
      .filter(Boolean).map(item => ({
        id: String(item.userId || item.uid || item.id || ""),
        name: item.displayName || item.dName || item.zaloName || item.name || String(item.userId || item.uid || item.id || ""),
        avatar: item.avatar || item.avatarUrl || ""
      })).filter(item => item.id);
    // Tránh xóa danh bạ/tin riêng khi API trả về rỗng (lỗi tạm thời).
    if (!contacts.length) {
      const existing = this.db.listContacts().length;
      if (existing > 0) {
        this.emit("warning", "Zalo không trả về danh bạ — giữ danh bạ/tin riêng đã lưu.");
        return this.db.listContacts();
      }
    }
    this.db.replaceContacts(contacts);
    this.db.pruneOrphanAccountData();
    return this.db.listContacts();
  }

  async syncGroups() {
    if (!this.api) throw new Error("Zalo chưa đăng nhập");
    const all = await this.api.getAllGroups();
    const ids = Object.keys(all?.gridVerMap || {});
    // Quan trọng: ids rỗng ≠ "không còn nhóm" — thường là lỗi API. Không được xóa dữ liệu đã lưu.
    if (!ids.length) {
      this.emit("warning", "Zalo không trả về danh sách nhóm — giữ nguyên nhóm/tin/lịch đã lưu trên máy.");
      return this.db.listGroups();
    }
    for (let i = 0; i < ids.length; i += 20) {
      const response = await this.api.getGroupInfo(ids.slice(i, i + 20));
      for (const [id, g] of Object.entries(response.gridInfoMap || {})) {
        const memberMap = new Map((g.currentMems || []).map(m => [String(m.id), {
          id: String(m.id), name: m.dName || m.zaloName || String(m.id), avatar: m.avatar || ""
        }]));
        const memberIds = (g.memberIds?.length ? g.memberIds : (g.memVerList || []).map(item => String(item).split("_")[0]));
        const missingIds = memberIds.map(String).filter(memberId => !memberMap.has(memberId));
        for (let offset = 0; offset < missingIds.length; offset += 100) {
          try {
            const info = await this.api.getGroupMembersInfo(missingIds.slice(offset, offset + 100));
            for (const [memberId, m] of Object.entries(info.profiles || {})) {
              memberMap.set(String(memberId), {
                id: String(m.id || memberId), name: m.displayName || m.zaloName || String(memberId), avatar: m.avatar || ""
              });
            }
          } catch (error) {
            this.emit("warning", `Không lấy đủ thành viên nhóm ${g.name || id}: ${error.message}`);
          }
        }
        this.db.saveGroup({
          id, name: g.name || `Nhóm ${id}`, avatar: g.avt || g.fullAvt || "", memberCount: g.totalMember || g.memberIds?.length || 0,
          members: [...memberMap.values()]
        });
      }
    }
    this.db.removeGroupsNotIn(ids);
    this.db.pruneOrphanAccountData();
    return this.db.listGroups();
  }

  onMessage(message) {
    const isGroup = message.type === ThreadType.Group;
    if (isGroup && !this.db.isGroupEnabled(message.threadId)) return;
    if (!isGroup && message.type !== ThreadType.User) return;
    const d = message.data;
    const content = typeof d.content === "string" ? d.content : d.content?.title || d.notify || `[${d.msgType || "đính kèm"}]`;
    const mentions = d.mentions || d.mentionInfo || d.mention || [];
    const mentionText = typeof mentions === "string" ? mentions : JSON.stringify(mentions);
    const isMention = isGroup && mentionText.includes(String(this.state.profile?.id || "__none__"));
    const assetHints = this.extractAssetHints(d);
    const savedMsg = this.db.saveMessage({
      id: String(d.msgId || d.cliMsgId || `${d.ts}-${d.uidFrom}`), groupId: message.threadId,
      senderId: String(d.uidFrom || d.userId || ""), senderName: d.dName || "", content,
      type: d.msgType || "text", sentAt: Number(d.ts) || Date.now(), isSelf: message.isSelf, raw: d,
      threadType: isGroup ? "group" : "user", isMention, assetHints
    });
    const payload = {
      id: savedMsg.id,
      groupId: message.threadId,
      senderId: String(d.uidFrom || d.userId || ""),
      senderName: d.dName || "",
      content,
      isSelf: Boolean(message.isSelf),
      isMention,
      threadType: isGroup ? "group" : "user",
      sentAt: Number(d.ts) || Date.now()
    };
    this.emit("message", payload);
    if (!payload.isSelf) this.emit("inbound", payload);
    if (assetHints.length) this.downloadAssets(savedMsg.id, message.threadId, assetHints);
  }

  extractAssetHints(d) {
    const hints = [];
    const seen = new Set();
    const push = (url, kind = "image") => {
      if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url) || seen.has(url)) return;
      seen.add(url);
      hints.push({ url, kind });
    };
    const c = d.content;
    if (typeof c === "string" && /^https?:\/\//i.test(c)) push(c, "file");
    if (c && typeof c === "object") {
      push(c.href || c.url || c.normalUrl || c.thumbUrl || c.hdUrl, c.fileName ? "file" : "image");
      for (const key of ["href", "url", "normalUrl", "thumbUrl", "hdUrl", "oriUrl"]) push(c[key], "image");
    }
    push(d.topOut, "file");
    return hints.slice(0, 8);
  }

  downloadAssets(messageId, threadId, hints = []) {
    (async () => {
      for (const h of hints) {
        try {
          const ext = extFromUrl(h.url) || ".bin";
          const res = await fetch(h.url);
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          const rec = saveRaw({ ext, buffer: buf, webUrl: h.url, kind: h.kind, threadId });
          if (!rec) continue;
          this.db.saveAsset({
            id: crypto.randomUUID(),
            messageId,
            threadId,
            kind: rec.kind,
            name: rec.name,
            filePath: rec.filePath,
            webUrl: rec.webUrl,
            mime: rec.mime,
            size: rec.size,
            hash: rec.hash
          });
        } catch {}
      }
    })();
  }
}
