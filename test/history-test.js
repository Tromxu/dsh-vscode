"use strict";
/** history.js 单元测试。用法: node test/history-test.js */
const assert = require("node:assert");
const { foldHistory, contentText } = require("../src/history");

let passed = 0;
function ok(name) { passed++; console.log("  ✓", name); }

// contentText
assert.strictEqual(contentText([{ type: "text", text: "hi" }, { type: "text", text: " there" }]), "hi\n there");
ok("contentText 拼接文本块");
assert.strictEqual(contentText([{ type: "image", mediaType: "png", data: "x" }]), "");
ok("contentText 忽略非文本块");
assert.strictEqual(contentText(null), "");
ok("contentText 容忍空输入");

// foldHistory
const events = [
  { type: "permission/preset", seq: 0, time: 1, data: { preset: "workspace-write" } },
  { type: "turn/start", seq: 1, time: 2, data: { turn: 1 } },
  { type: "user/message", seq: 2, time: 3, data: { content: [{ type: "text", text: "帮我修 bug" }] } },
  { type: "tool/call", seq: 3, time: 4, data: { turn: 1, step: 1, callId: "c1", name: "read", arguments: "{}" } },
  { type: "assistant/chunk", seq: 4, time: 5, data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "好" } } },
  { type: "assistant/message", seq: 5, time: 6, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "好的，我修好了" }] } } },
  { type: "turn/end", seq: 6, time: 7, data: { turn: 1, reason: { kind: "completed" } } },
];
const msgs = foldHistory(events);
assert.strictEqual(msgs.length, 2, "应折叠出 2 条消息");
assert.deepStrictEqual(msgs[0], { role: "user", text: "帮我修 bug" });
assert.deepStrictEqual(msgs[1], { role: "assistant", text: "好的，我修好了" });
ok("foldHistory 折叠 user/assistant 消息（跳过工具/边界事件）");

assert.strictEqual(foldHistory([]).length, 0);
ok("foldHistory 空输入");

console.log(`\nhistory-test 全部通过: ${passed} 项`);
process.exit(0);
