import test from "node:test";
import assert from "node:assert/strict";
import { localDigest } from "../src/summarizer.js";

test("local digest extracts tasks and decisions", () => {
  const report = localDigest([
    { sender_name: "An", content: "Chốt phương án A" },
    { sender_name: "Bình", content: "Lan phụ trách gửi báo cáo trước thứ Sáu" }
  ], "Dự án A");
  assert.match(report, /BÁO CÁO: Dự án A/);
  assert.match(report, /Quyết định\/xác nhận/);
  assert.match(report, /phụ trách gửi báo cáo/);
});
