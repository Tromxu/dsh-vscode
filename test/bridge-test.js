"use strict";
/**
 * bridge-test.js — NativeBridge 单元测试（用 vscode 桩，无 GUI）。
 * 覆盖：assistant 流式缓冲、tool/call 展示与文件跟随、tool/result diff→WorkspaceEdit、
 *       meta.diffs 回退、镜像终端、approval 原生对话框→respond、question QuickPick→respond。
 * 用法: node test/bridge-test.js
 */
const assert = require("node:assert");
const path = require("node:path");

// ---- 注入 vscode 桩 ----
const vscodeStub = require("./vscode-stub");
const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscodeStub;
  return originalLoad.apply(this, arguments);
};
const { NativeBridge } = require("../src/bridge");
const { state } = vscodeStub;

const WS = path.resolve("D:/AI/Hermess"); // 模拟工作区根
state.workspaceFolders = [{ uri: { fsPath: WS } }];
vscodeStub.workspace.workspaceFolders = state.workspaceFolders;

function reset() {
  state.applyEditCalls.length = 0;
  state.createdTerminals.length = 0;
  state.openedDocuments.length = 0;
  state.warningCalls.length = 0;
  state.quickPickCalls.length = 0;
  state.docContents.clear();
}

function makeBridge() {
  const chat = { posted: [], post(m) { this.posted.push(m); } };
  const client = { responded: [], async respond(rpcId, value) { this.responded.push({ rpcId, value }); } };
  const output = { lines: [], appendLine(l) { this.lines.push(l); } };
  const bridge = new NativeBridge({}, client, chat, output);
  return { bridge, chat, client, output };
}

function serverRequest(payload) {
  return { type: "server-request", rpcId: "rpc-" + Math.random().toString(36).slice(2), method: payload.type, payload };
}

function sessionEvent(event, view) {
  return serverRequest({ type: "session/event", sessionId: "s1", event, view });
}

let passed = 0;
function ok(name) { passed++; console.log("  ✓", name); }
const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  console.log("== 1. assistant 流式缓冲（多块、乱序 index） ==");
  {
    reset();
    const { bridge, chat } = makeBridge();
    bridge.handleServerRequest(sessionEvent({ type: "assistant/chunk", seq: 1, time: 0, data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "你" } } }));
    bridge.handleServerRequest(sessionEvent({ type: "assistant/chunk", seq: 2, time: 0, data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 1, text: "好" } } }));
    bridge.handleServerRequest(sessionEvent({ type: "assistant/chunk", seq: 3, time: 0, data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "们" } } }));
    const last = chat.posted[chat.posted.length - 1];
    assert.strictEqual(last.type, "assistantDelta");
    assert.strictEqual(last.text, "你们好"); // index0: 你+们, index1: 好 → 按 index 排序拼接
    ok("流式文本按块索引拼接: " + JSON.stringify(last.text));
  }

  console.log("== 2. tool/call diff 视图：卡片 + 文件跟随 ==");
  {
    reset();
    const { bridge, chat } = makeBridge();
    state.docContents.set(path.join(WS, "src/a.js"), "OLD");
    bridge.handleServerRequest(sessionEvent({
      type: "tool/call", seq: 4, time: 0,
      data: { turn: 1, step: 1, callId: "c1", name: "write", arguments: JSON.stringify({ file_path: "src/a.js", content: "NEW" }) },
    }, { for: "call", view: { card: "diff", title: "Write src/a.js", diffs: [{ path: "src/a.js", oldText: null, newText: "NEW" }], locations: [{ path: "src/a.js" }] } }));
    assert.strictEqual(chat.posted[0].type, "toolCall");
    assert.strictEqual(chat.posted[0].tool.path, "src/a.js");
    assert.ok(state.openedDocuments.length >= 1, "应打开文件跟随");
    ok("toolCall 卡片带路径，且调用了 openTextDocument");
  }

  console.log("== 3. tool/result diff → WorkspaceEdit 应用 ==");
  {
    reset();
    const { bridge, chat } = makeBridge();
    state.docContents.set(path.join(WS, "src/a.js"), "OLD");
    bridge.handleServerRequest(sessionEvent({
      type: "tool/result", seq: 5, time: 0,
      data: { turn: 1, step: 1, callId: "c1", message: { role: "tool", content: [], callId: "c1", toolName: "write" } },
    }, { for: "result", view: { card: "diff", title: "Write src/a.js", diffs: [{ path: "src/a.js", oldText: "OLD", newText: "NEW" }] } }));
    await tick();
    assert.strictEqual(state.applyEditCalls.length, 1, "应调用 applyEdit 一次");
    ok("diff 已通过 WorkspaceEdit 应用到编辑器");
    assert.ok(chat.posted.some((m) => m.type === "toolResult"));
  }

  console.log("== 4. tool/result meta.diffs 回退（无 view） ==");
  {
    reset();
    const { bridge } = makeBridge();
    state.docContents.set(path.join(WS, "src/b.js"), "OLD B");
    bridge.handleServerRequest(sessionEvent({
      type: "tool/result", seq: 6, time: 0,
      data: { turn: 1, step: 1, callId: "c2", message: { role: "tool", content: [], callId: "c2", toolName: "edit" }, meta: { diffs: [{ path: "src/b.js", oldText: "OLD B", newText: "NEW B" }] } },
    }));
    await tick();
    assert.strictEqual(state.applyEditCalls.length, 1);
    ok("meta.diffs 回退路径生效");
  }

  console.log("== 5. 终端镜像：命令+输出进只读终端 ==");
  {
    reset();
    const { bridge } = makeBridge();
    bridge.handleServerRequest(sessionEvent({
      type: "tool/result", seq: 7, time: 0,
      data: { turn: 1, step: 1, callId: "c3", message: { role: "tool", content: [], callId: "c3", toolName: "bash" } },
    }, { for: "result", view: { card: "terminal", title: "npm test", cwd: "D:/AI/Hermess", output: "PASS 1 test", exitCode: 0 } }));
    assert.strictEqual(state.createdTerminals.length, 1);
    const term = state.createdTerminals[0];
    assert.strictEqual(term.name, "DSH 命令");
    ok("创建了 DSH 只读镜像终端");
  }

  console.log("== 6. approval/requested → 原生对话框 → respond allowed-once ==");
  {
    reset();
    state.warningResult = "允许一次";
    const { bridge, client } = makeBridge();
    bridge.handleServerRequest(serverRequest({ type: "approval/requested", sessionId: "s1", approvalId: "ap1", toolName: "bash", reason: "执行 npm test" }));
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(state.warningCalls.length, 1, "应弹原生确认框");
    assert.strictEqual(client.responded.length, 1);
    assert.deepStrictEqual(client.responded[0].value, { sessionId: "s1", approvalId: "ap1", outcome: "allowed-once" });
    ok("允许一次 → respond {outcome: allowed-once}");
  }

  console.log("== 7. approval 拒绝 ==");
  {
    reset();
    state.warningResult = "拒绝";
    const { bridge, client } = makeBridge();
    bridge.handleServerRequest(serverRequest({ type: "approval/requested", sessionId: "s1", approvalId: "ap2", toolName: "bash" }));
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(client.responded[0].value.outcome, "rejected");
    ok("拒绝 → respond {outcome: rejected}");
  }

  console.log("== 8. question/requested → QuickPick → respond ==");
  {
    reset();
    state.quickPickResult = { label: "yes" };
    const { bridge, client } = makeBridge();
    bridge.handleServerRequest(serverRequest({
      type: "question/requested", sessionId: "s1",
      questions: [{ id: "q1", question: "继续？", options: [{ label: "yes" }, { label: "no" }] }],
    }));
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(state.quickPickCalls.length, 1);
    assert.deepStrictEqual(client.responded[0].value, { sessionId: "s1", answer: { answers: [{ id: "q1", selected: ["yes"] }] } });
    ok("问题 → QuickPick → respond answers 正确");
  }

  console.log("== 9. stream/error → 聊天视图错误提示 ==");
  {
    reset();
    const { bridge, chat } = makeBridge();
    bridge.handleServerRequest(serverRequest({ type: "stream/error", error: { code: "internal", message: "boom" } }));
    assert.strictEqual(chat.posted[0].type, "error");
    assert.ok(chat.posted[0].message.includes("boom"));
    ok("stream/error 转发到聊天视图");
  }

  console.log(`\n全部通过: ${passed} 项`);
  process.exit(0);
})().catch((e) => {
  console.error("测试失败:", e);
  process.exit(1);
});
