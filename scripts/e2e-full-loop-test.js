"use strict";
/**
 * e2e-full-loop-test.js — 全链路端到端测试（真实模型回合）。
 *
 * 用桌面版 DSH_HOME 的配置/凭据（通过 DSH_REAL_HOME 指向，脚本仅复制文件、不读密钥），
 * 在隔离工作区跑一个微小任务，验证完整 agent 循环：
 *   模型输出 → tool/call(write/grep) → tool/result(meta.diffs) → 文件落盘 → turn/end(completed)
 *
 * 用法（先准备好隔离 home 的 config 副本）:
 *   node scripts/e2e-full-loop-test.js
 */
const fs = require("node:fs");
const path = require("node:path");
const { resolveRuntime, getFreePort, RuntimeProcess } = require("../src/runtime");
const { SessionClient } = require("../src/session-client");

const HARNESS = process.env.DSH_HARNESS || ""; // 空 = resolveRuntime 自动探测
const ISOLATED_HOME = path.join(__dirname, "..", ".smoke", "e2e-real-home");
const WORK_DIR = path.join(__dirname, "..", ".smoke", "e2e-work");
const REAL_HOME = process.env.DSH_REAL_HOME; // 桌面版 dsh-home（可选）

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  fs.mkdirSync(ISOLATED_HOME, { recursive: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });

  // 复制桌面版配置/凭据到隔离 home（不读取凭据内容）。
  // 注意：不复制 profiles/——其 node_modules 回退目录是真实目录而非符号链接，
  // 会触发 dsh 的 healProfilesModuleFallback 校验失败；profile 会从 bundle 自动初始化。
  if (REAL_HOME && fs.existsSync(REAL_HOME)) {
    for (const name of [".credentials.yaml", "settings.yaml"]) {
      const src = path.join(REAL_HOME, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(ISOLATED_HOME, name));
    }
    console.log("[prep] 已复制桌面版 settings.yaml + .credentials.yaml 到隔离 home（未读取密钥内容）");
  }

  const cfg = { harnessRoot: HARNESS, nodePath: "", dshHome: "", port: 0, bootTimeoutSec: 120 };
  const resolved = resolveRuntime(cfg, ISOLATED_HOME, WORK_DIR);
  const port = await getFreePort();
  const rt = new RuntimeProcess();
  rt.onLog((l) => console.log("[rt]", l));
  rt.start(resolved, port);
  await rt.waitReady(150000, (m) => console.log("[boot]", m));
  console.log("READY:", rt.url);

  const client = new SessionClient(rt);
  client.onLog((l) => console.log("[client]", l));
  const toolCalls = [];
  const toolResults = [];
  let ended = null;
  let assistantText = "";
  // 注意：SessionClient 只保留一个 server-request 回调，所有收集逻辑合并到这里
  client.onServerRequest((msg) => {
    const f = msg.payload;
    if (f.type !== "session/event") return;
    const ev = f.event;
    if (ev.type === "tool/call") {
      toolCalls.push({ name: ev.data.name, args: ev.data.arguments });
      console.log("[tool/call]", ev.data.name, ev.data.arguments.slice(0, 160));
    } else if (ev.type === "tool/result") {
      const meta = ev.data.meta;
      const hasDiff = !!(meta && Array.isArray(meta.diffs) && meta.diffs.length);
      const msg = ev.data.message || {};
      if (toolResults.length === 0) console.log("[debug] tool/result message keys:", Object.keys(msg).join(","));
      toolResults.push({ name: msg.toolName, hasDiff, diffPaths: hasDiff ? meta.diffs.map((d) => d.path) : [] });
      console.log("[tool/result]", msg.toolName || "(unknown)", "meta.diffs:", hasDiff ? meta.diffs.length + " hunks" : "无");
    } else if (ev.type === "assistant/chunk" && ev.data.chunk && ev.data.chunk.type === "text-delta") {
      assistantText += ev.data.chunk.text;
    } else if (ev.type === "turn/end") {
      ended = ev.data.reason;
    }
  });
  await client.connect();
  console.log("--- connected ---");

  const created = await client.sessionCreate({});
  const sessionId = created.sessionId;
  console.log("session:", sessionId);

  const task = "在当前工作目录先创建文件 demo.txt，内容为 line-one；然后把它修改为 line-two；最后只回复：完成";
  await client.sessionPrompt({ sessionId, mode: "queue", content: [{ type: "text", text: task }] });
  console.log("prompt accepted，等待回合结束…");

  // 轮询直到 turn/end
  const deadline = Date.now() + 180000;
  while (!ended && Date.now() < deadline) {
    await sleep(1000);
  }
  if (!ended) {
    console.log("超时未收到 turn/end");
    process.exitCode = 1;
  } else {
    console.log("turn/end reason:", JSON.stringify(ended));
    console.log("assistant 文本: " + JSON.stringify(assistantText.slice(0, 300)));
  }

  // 验证文件落盘
  const file = path.join(WORK_DIR, "demo.txt");
  const fileExists = fs.existsSync(file);
  const fileContent = fileExists ? fs.readFileSync(file, "utf8") : null;
  console.log("demo.txt 存在:", fileExists, fileExists ? "内容: " + JSON.stringify(fileContent) : "");

  const passed =
    ended && ended.kind === "completed" &&
    toolCalls.some((t) => t.name === "write") &&
    toolResults.some((t) => t.hasDiff) &&
    fileExists;
  console.log("\n=== 结果: " + (passed ? "PASS ✅" : "FAIL ❌") + " ===");
  console.log("tool/call 数:", toolCalls.length, "| tool/result 数:", toolResults.length);

  client.dispose();
  await rt.stop();
  // 清理隔离 home（其中含复制来的凭据）与工作区
  try { fs.rmSync(ISOLATED_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E FAIL:", e);
  process.exit(1);
});
