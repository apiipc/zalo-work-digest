import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultDataDir,
  readDataDir,
  writeDataDir,
  relocateData,
  validateDataDirTarget,
  describeDataLocation
} from "../src/data-location.js";
import { createAccountStore } from "../src/account-store.js";

test("read/write data-path config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-cfg-"));
  const configDir = path.join(root, "config");
  const fallback = defaultDataDir(root);
  assert.equal(readDataDir(configDir, fallback), fallback);
  const custom = path.join(root, "my-data");
  writeDataDir(configDir, custom);
  assert.equal(readDataDir(configDir, fallback), path.resolve(custom));
  const info = describeDataLocation(configDir, custom, fallback);
  assert.equal(info.isDefault, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("validate rejects node_modules and accounts leaf", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-val-"));
  const from = path.join(root, "data");
  fs.mkdirSync(from, { recursive: true });
  assert.throws(() => validateDataDirTarget(root, path.join(root, "node_modules", "x"), { from }));
  assert.throws(() => validateDataDirTarget(root, path.join(from, "accounts"), { from }));
  const ok = validateDataDirTarget(root, path.join(root, "elsewhere"), { from });
  assert.ok(fs.existsSync(ok));
  fs.rmSync(root, { recursive: true, force: true });
});

test("relocate moves account data and preserves groups", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-rel-"));
  const from = path.join(root, "data");
  const to = path.join(root, "elsewhere");
  const configDir = path.join(root, "config");
  const store = createAccountStore(from);
  store.switchAccount("acc-1");
  store.db.saveGroup({ id: "g1", name: "Nhóm giữ", members: [] });
  store.db.setSetting("bot_token", "tok-keep");
  store.close();

  const target = validateDataDirTarget(root, to, { from });
  const result = relocateData({ from, to: target });
  assert.equal(result.moved, true);
  assert.ok(!fs.existsSync(path.join(from, "accounts")));
  assert.ok(fs.existsSync(path.join(to, "accounts", "acc-1", "zalo-digest.db")));

  writeDataDir(configDir, to);
  assert.equal(readDataDir(configDir, from), path.resolve(to));

  const again = createAccountStore(to);
  again.openAccount("acc-1");
  assert.equal(again.db.listGroups()[0].name, "Nhóm giữ");
  assert.equal(again.db.getSetting("bot_token"), "tok-keep");
  again.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("validate rejects destination with foreign accounts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-foreign-"));
  const from = path.join(root, "a");
  const to = path.join(root, "b");
  fs.mkdirSync(path.join(from, "accounts"), { recursive: true });
  fs.mkdirSync(path.join(to, "accounts", "other"), { recursive: true });
  assert.throws(() => validateDataDirTarget(root, to, { from }));
  fs.rmSync(root, { recursive: true, force: true });
});
