import fs from "node:fs";
import path from "node:path";
import { createAccountStore } from "./account-store.js";
import { ZaloAdapter } from "./zalo-adapter.js";
import { runWithAssetDir } from "./asset-store.js";

/**
 * Registry runtime theo SaaS userId.
 * Mỗi user: data/tenants/<userId>/ + ZaloAdapter riêng.
 */
export function createTenantRegistry({ tenantsRoot, onInbound } = {}) {
  fs.mkdirSync(tenantsRoot, { recursive: true });
  /** @type {Map<string, { userId: string, dataDir: string, store: any, zalo: ZaloAdapter, restoring: Promise<void>|null }>} */
  const map = new Map();

  function tenantDir(userId) {
    const safe = String(userId || "").replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(tenantsRoot, safe);
  }

  function getRuntime(userId) {
    const id = String(userId || "");
    if (!id) throw new Error("Thiếu userId");
    let rt = map.get(id);
    if (rt) return rt;

    const dataDir = tenantDir(id);
    fs.mkdirSync(dataDir, { recursive: true });
    const store = createAccountStore(dataDir);
    const zalo = new ZaloAdapter({ accountStore: store });
    rt = { userId: id, dataDir, store, zalo, restoring: null };
    map.set(id, rt);

    zalo.on("inbound", msg => {
      runWithAssetDir(store.assetsDir, () => {
        if (typeof onInbound === "function") onInbound(rt, msg);
      });
    });

    return rt;
  }

  async function ensureRestored(userId) {
    const rt = getRuntime(userId);
    if (rt.zalo.snapshot().status === "online") return rt;
    if (!rt.restoring) {
      rt.restoring = runWithAssetDir(rt.store.assetsDir, async () => {
        try { await rt.zalo.restore(); }
        catch (error) { console.error(`Restore Zalo [${userId}]:`, error.message); }
        finally { rt.restoring = null; }
      });
    }
    await rt.restoring;
    return rt;
  }

  function listRuntimes() {
    return [...map.values()];
  }

  async function restoreAllKnown() {
    if (!fs.existsSync(tenantsRoot)) return;
    for (const name of fs.readdirSync(tenantsRoot)) {
      const dir = path.join(tenantsRoot, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      try {
        await ensureRestored(name);
      } catch (error) {
        console.error(`Restore tenant ${name}:`, error.message);
      }
    }
  }

  function dbProxy(rt) {
    return new Proxy({}, {
      get(_t, prop) {
        const target = rt.store.db;
        const val = target[prop];
        return typeof val === "function" ? val.bind(target) : val;
      }
    });
  }

  return {
    tenantsRoot,
    getRuntime,
    ensureRestored,
    listRuntimes,
    dbProxy,
    restoreAllKnown,
    closeAll() {
      for (const rt of map.values()) {
        try { rt.zalo.logout?.(); } catch {}
        try { rt.store.close(); } catch {}
      }
      map.clear();
    }
  };
}
