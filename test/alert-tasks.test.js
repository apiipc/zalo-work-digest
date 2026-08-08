import test from "node:test";
import assert from "node:assert/strict";
import { matchRules, parseKeywords, formatRuleBotMessage } from "../src/alert-rules.js";
import { createDatabase } from "../src/db.js";

test("parseKeywords splits commas and trims", () => {
  assert.deepEqual(parseKeywords("gấp, deadline; hạn"), ["gấp", "deadline", "hạn"]);
});

test("matchRules AND vs OR (match_any)", () => {
  const msg = { content: "xin chào", groupId: "g1", isMention: false };
  assert.equal(matchRules(msg, [{ id: 1, keywords: "", match_mention: 0, group_id: "*", enabled: 1 }]).length, 0);
  assert.equal(matchRules({ ...msg, isMention: true }, [{ id: 2, keywords: "", match_mention: 1, group_id: "*", enabled: 1 }]).length, 1);
  assert.equal(matchRules({ content: "Deadline hôm nay", groupId: "g1" }, [{ id: 3, keywords: "deadline,gấp", match_mention: 0, group_id: "*", enabled: 1 }]).length, 1);
  assert.equal(matchRules({ content: "Deadline", groupId: "g2", isMention: false }, [{ id: 4, keywords: "deadline", match_mention: 1, group_id: "*", enabled: 1 }]).length, 0);
  assert.equal(matchRules({ content: "gấp", groupId: "g9" }, [{ id: 5, keywords: "gấp", match_mention: 0, group_id: "g1", enabled: 1 }]).length, 0);
  // OR: tag alone
  assert.equal(matchRules({ content: "@Nguyen alo", groupId: "g1", isMention: true }, [{ id: 6, keywords: "gấp", match_mention: 1, match_any: 1, group_id: "*", enabled: 1 }]).length, 1);
  // OR: keyword alone
  assert.equal(matchRules({ content: "cần gấp nha", groupId: "g1", isMention: false }, [{ id: 7, keywords: "gấp", match_mention: 1, match_any: 1, group_id: "*", enabled: 1 }]).length, 1);
  // OR: neither
  assert.equal(matchRules({ content: "alo", groupId: "g1", isMention: false }, [{ id: 8, keywords: "gấp", match_mention: 1, match_any: 1, group_id: "*", enabled: 1 }]).length, 0);
});

test("formatRuleBotMessage includes priority and excerpt", () => {
  const text = formatRuleBotMessage({
    rule: { name: "Gấp", priority: "high" },
    message: { senderName: "An", content: "Deadline gấp chiều nay" },
    threadName: "Nhóm A"
  });
  assert.match(text, /ƯU TIÊN/);
  assert.match(text, /An/);
  assert.match(text, /Deadline/);
});

test("messageStats buckets by hour day month", () => {
  const db = createDatabase(":memory:");
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const t10 = day.getTime() + 10 * 3600000;
  const t17 = day.getTime() + 17 * 3600000;
  db.saveMessage({ id: "h1", groupId: "g1", senderId: "u1", senderName: "An", content: "a", sentAt: t10 });
  db.saveMessage({ id: "h2", groupId: "g1", senderId: "u1", senderName: "An", content: "b", sentAt: t10 + 1000 });
  db.saveMessage({ id: "h3", groupId: "g1", senderId: "u1", senderName: "An", content: "c", sentAt: t17 });
  const hours = db.messageStats({ granularity: "hour", from: day.getTime(), to: day.getTime() + 86400000 - 1 });
  assert.equal(hours.length, 24);
  assert.equal(hours[10].count, 2);
  assert.equal(hours[17].count, 1);
  const days = db.messageStats({ granularity: "day", from: day.getTime() - 2 * 86400000, to: day.getTime() + 86400000 - 1 });
  assert.ok(days.some(b => b.count >= 3));
  db.close();
});

test("listAlerts supports filters and alert rules", () => {
  const db = createDatabase(":memory:");
  db.saveGroup({ id: "g1", name: "Nhóm 1", members: [] });
  db.saveMessage({ id: "m1", groupId: "g1", senderId: "u1", senderName: "An", content: "Deadline gấp", sentAt: 100, isMention: true });
  db.saveMessage({ id: "m2", groupId: "g1", senderId: "u2", senderName: "Bình", content: "hello", sentAt: 101, isMention: true });
  db.saveMessage({ id: "d1", groupId: "u3", senderId: "u3", senderName: "Cường", content: "ping", sentAt: 102, threadType: "user" });
  assert.equal(db.listAlerts({ from: 0, to: 200, q: "deadline" }).length, 1);
  assert.equal(db.listAlerts({ from: 0, to: 200, kind: "dm" }).length, 1);
  assert.equal(db.listAlerts({ from: 0, to: 200, senderId: "u1" }).length, 1);
  const ruleId = db.createAlertRule({ name: "Gấp", keywords: "gấp", notifyBot: true, priority: "high" });
  assert.equal(db.listAlertRules().length, 1);
  assert.equal(db.deleteAlertRule(ruleId), true);
  db.close();
});

test("removeGroupsNotIn prunes foreign groups and messages", () => {
  const db = createDatabase(":memory:");
  db.saveGroup({ id: "keep", name: "Keep", members: [{ id: "u1", name: "An" }] });
  db.saveGroup({ id: "old", name: "Old", members: [{ id: "u2", name: "Bình" }] });
  db.saveMessage({ id: "m1", groupId: "keep", senderId: "u1", senderName: "An", content: "ok", sentAt: 1, threadType: "group" });
  db.saveMessage({ id: "m2", groupId: "old", senderId: "u2", senderName: "Bình", content: "bye", sentAt: 2, threadType: "group" });
  db.replaceContacts([{ id: "u1", name: "An" }]);
  db.saveMessage({ id: "d1", groupId: "u9", senderId: "u9", senderName: "X", content: "dm", sentAt: 3, threadType: "user" });
  assert.equal(db.removeGroupsNotIn(["keep"]), 1);
  db.pruneOrphanAccountData();
  assert.equal(db.listGroups().length, 1);
  assert.equal(db.listGroups()[0].id, "keep");
  assert.equal(db.listAlerts({ from: 0, to: 10, kind: "all" }).length, 1);
  db.close();
});
