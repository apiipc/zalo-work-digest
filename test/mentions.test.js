import test from "node:test";
import assert from "node:assert/strict";
import { buildMentionMessage } from "../src/mentions.js";

test("builds correct Zalo mention offsets", () => {
  const out = buildMentionMessage("gửi báo cáo", [{ id: "10", name: "Lan Anh" }, { id: "20", name: "Minh" }]);
  assert.equal(out.msg, "@Lan Anh @Minh gửi báo cáo");
  assert.deepEqual(out.mentions, [
    { pos: 0, len: 7, uid: "10" },
    { pos: 9, len: 4, uid: "20" }
  ]);
});

test("keeps plain message without members", () => {
  assert.deepEqual(buildMentionMessage("xin chào", []), { msg: "xin chào", mentions: [] });
});
