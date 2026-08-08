import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAccountStore, LOCAL_ACCOUNT_ID } from "../src/account-store.js";
import { createDatabase } from "../src/db.js";

test("each Zalo account gets isolated db and assets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-accounts-"));
  const store = createAccountStore(root);
  assert.equal(store.accountId, LOCAL_ACCOUNT_ID);

  store.switchAccount("acc-a");
  store.db.saveGroup({ id: "g-a", name: "Nhóm A", members: [] });
  store.db.setSetting("bot_token", "token-a");
  fs.writeFileSync(path.join(store.assetsDir, "a.txt"), "a");

  store.switchAccount("acc-b");
  assert.equal(store.db.listGroups().length, 0);
  // AI/Bot dùng chung giữa các tài khoản
  assert.equal(store.db.getSetting("bot_token"), "token-a");
  store.db.saveGroup({ id: "g-b", name: "Nhóm B", members: [] });
  assert.ok(!fs.existsSync(path.join(store.assetsDir, "a.txt")));

  store.switchAccount("acc-a");
  assert.equal(store.db.listGroups().length, 1);
  assert.equal(store.db.listGroups()[0].name, "Nhóm A");
  assert.equal(store.db.getSetting("bot_token"), "token-a");
  assert.ok(fs.existsSync(path.join(store.assetsDir, "a.txt")));

  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("removeGroupsNotIn refuses empty list wipe", () => {
  const db = createDatabase(":memory:");
  db.saveGroup({ id: "g1", name: "Keep", members: [] });
  assert.equal(db.removeGroupsNotIn([]), 0);
  assert.equal(db.listGroups().length, 1);
  db.close();
});

test("legacy single db migrates into accounts folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-legacy-"));
  const legacy = createDatabase(path.join(root, "zalo-digest.db"));
  legacy.setZaloUserId("user-legacy");
  legacy.saveGroup({ id: "g1", name: "Cũ", members: [] });
  legacy.close();
  fs.writeFileSync(path.join(root, "session.json"), JSON.stringify({ profile: { name: "X", id: "user-legacy" } }));

  const store = createAccountStore(root);
  assert.equal(store.accountId, "user-legacy");
  assert.equal(store.db.listGroups()[0].name, "Cũ");
  assert.ok(!fs.existsSync(path.join(root, "zalo-digest.db")));
  assert.ok(fs.existsSync(path.join(root, "accounts", "user-legacy", "zalo-digest.db")));
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
