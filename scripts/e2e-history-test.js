"use strict";
/**
 * e2e-history-test.js — 验证会话历史跨运行时重启持久化。
 * 用法: $env:DSH_HARNESS="..." ; node scripts/e2e-history-test.js
 */
const fs = require("node:fs");
const path = require("node:path");
const { resolveRuntime, getFreePort, RuntimeProcess } = require("../src/runtime");
const { SessionClient } = require("../src/session-client");

const HARNESS = process.env.DSH_HARNESS || "";
const HOME = path.join(__dirname, "..", ".smoke", "e2e-history-home");
const WORK = path.join(__dirname, "..", ".smoke", "e2e-history-work");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function boot() {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });
  // 复制桌面版配置/凭据（让回合真实完成）；不复制 profiles/（见 full-loop 测试说明）
  const real = process.env.DSH_REAL_HOME;
  if (real && fs.existsSync(real)) {
    for (const name of [".credentials.yaml", "settings.yaml"]) {
      const src = path.join(real, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(HOME, name));
    }
  }
  const cfg = { harnessRoot: HARNESS, nodePath: "", dshHome: "", port: 0, bootTimeoutSec: 120 };
  const resolved = resolveRuntime(cfg, HOME, WORK);
  const port = await getFreePort();
  const rt = new RuntimeProcess();
  rt.start(resolved, port);
  await rt.waitReady(150000, () => {});
  const client = new SessionClient(rt);
  let ended = false;
  client.onServerRequest((msg) => {
    const f = msg.payload;
    if (f.type === "session/event" && f.event.type === "turn/end") ended = true;
  });
  await client.connect();
  return { rt, client, get ended() { return ended; }, markEnded() { ended = true; } };
}

async function main() {
  console.log("== 第 1 次启动：创建会话并跑一个回合 ==");
  const s1 = await boot();
  const created = await s1.client.sessionCreate({});
  const sid = created.sessionId;
  console.log("session:", sid);
  await s1.client.sessionPrompt({ sessionId: sid, mode: "queue", content: [{ type: "text", text: "请只回复：历史测试" }] });
  const d1 = Date.now() + 60000;
  while (!s1.ended && Date.now() < d1) await sleep(500);
  console.log("turn/end:", s1.ended);
  s1.client.dispose();
  await s1.rt.stop();
  console.log("已停止运行时（模拟重启）\n");

  console.log("== 第 2 次启动：同一 DSH_HOME，应能列出并读取历史 ==");
  const s2 = await boot();
  const list = await s2.client.sessionList();
  const found = list.items.find((i) => i.sessionId === sid);
  console.log("session.list 中找到该会话:", !!found);
  if (found) console.log("  会话 cwd:", found.cwd, "| blank:", found.blank);
  const hist = await s2.client.sessionHistory({ sessionId: sid, maxMessages: 10 });
  const types = hist.events.map((h) => h.event.type);
  console.log("history 事件类型:", types.join(","));
  const hasUser = types.includes("user/message");
  const hasAssistant = types.includes("assistant/message");
  console.log("历史含用户消息:", hasUser, "| 含助手消息:", hasAssistant);
  s2.client.dispose();
  await s2.rt.stop();

  const pass = !!found && hasUser && hasAssistant;
  console.log("\n=== " + (pass ? "PASS ✅ 历史可跨重启恢复" : "FAIL ❌") + " ===");
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
