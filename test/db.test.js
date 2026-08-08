import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/db.js";

test("stores enabled group and de-duplicates messages", () => {
  const db = createDatabase(":memory:");
  db.saveGroup({ id: "g1", name: "Nhóm 1", members: [{ id: "u1", name: "An" }] });
  db.enableGroup("g1", true);
  assert.equal(db.isGroupEnabled("g1"), true);
  const msg = { id: "m1", groupId: "g1", senderId: "u1", senderName: "An", content: "Chào", sentAt: 1 };
  db.saveMessage(msg); db.saveMessage(msg);
  assert.equal(db.listMessages({ groupId: "g1", from: 0, to: 2 }).length, 1);
  assert.equal(db.listMembers("g1")[0].display_name, "An");
  db.close();
});

test("collects direct messages and mentions as alerts", () => {
  const db = createDatabase(":memory:");
  db.saveMessage({ id:"d1",groupId:"u2",senderId:"u2",senderName:"Bình",content:"Alo",sentAt:10,threadType:"user" });
  db.saveMessage({ id:"m2",groupId:"g1",senderId:"u2",senderName:"Bình",content:"@Tôi xem nhé",sentAt:11,threadType:"group",isMention:true });
  assert.equal(db.listAlerts({from:0,to:20}).length,2);
  db.close();
});
