"use strict";
/**
 * e2e-cwd-test.js — 验证「会话级工作目录」：运行时 cwd=A，会话 cwd=B，智能体应在 B 里工作。
 * 若成立，则切换工程位置无需重启运行时。
 * 用法: $env:DSH_HARNESS="..."; $env:DSH_REAL_HOME="..."; node scripts/e2e-cwd-test.js
 */
const fs = require("node:fs");
const path = require("node:path");
const { resolveRuntime, getFreePort, RuntimeProcess } = require("../src/runtime");
const { SessionClient } = require("../src/session-client");

const HARNESS = process.env.DSH_HARNESS || "";
const HOME = path.join(__dirname, "..", ".smoke", "e2e-cwd-home");
const WORK_A = path.join(__dirname, "..", ".smoke", "e2e-cwd-a");
const WORK_B = path.join(__dirname, "..", ".smoke", "e2e-cwd-b");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  for (const d of [HOME, WORK_A, WORK_B]) {
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
  }
  const real = process.env.DSH_REAL_HOME;
  if (real && fs.existsSync(real)) {
    for (const name of [".credentials.yaml", "settings.yaml"]) {
      const src = path.join(real, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(HOME, name));
    }
  }

  // 运行时以 WORK_A 为 cwd 启动
  const cfg = { harnessRoot: HARNESS, nodePath: "", dshHome: "", port: 0, bootTimeoutSec: 120 };
  const resolved = resolveRuntime(cfg, HOME, WORK_A);
  const port = await getFreePort();
  const rt = new RuntimeProcess();
  rt.onLog((l) => console.log("[rt]", l));
  rt.start(resolved, port);
  await rt.waitReady(150000, () => {});
  console.log("运行时已启动 (cwd = WORK_A)");

  const client = new SessionClient(rt);
  client.onLog((l) => console.log("[client]", l));
  let ended = false;
  await client.connect();
  console.log("协议模式:", client.mode);

  // 关键：会话显式指定 cwd = WORK_B（不重启运行时）
  const created = await client.sessionCreate({ cwd: WORK_B });
  console.log("session.create({cwd: WORK_B}) ->", created.sessionId);

  // 新版用 follow 流收事件；旧版用 mux/host 下行
  if (client.mode === "new") {
    const snap = await new Promise((resolve) => {
      let got = null;
      const h = client.followSession(created.sessionId, {
        onSnapshot: (s) => { got = s; resolve(s); },
        onEvent: (ev) => { if (ev.type === "turn/end") ended = true; },
      });
      setTimeout(() => resolve(got || { records: [] }), 20000);
    });
    console.log("follow 快照记录数:", (snap.records || []).length, "| cwd:", snap.header && snap.header.cwd);
  } else {
    client.onServerRequest((msg) => {
      const f = msg.payload;
      if (f.type === "session/event" && f.event.type === "turn/end") ended = true;
    });
  }

  await client.sessionPrompt({
    sessionId: created.sessionId,
    mode: "queue",
    content: [{ type: "text", text: "在当前工作目录创建文件 cwd-test.txt，内容为 hello-cwd，然后只回复：完成" }],
  });
  const deadline = Date.now() + 120000;
  while (!ended && Date.now() < deadline) await sleep(500);
  console.log("turn/end:", ended);

  const inB = fs.existsSync(path.join(WORK_B, "cwd-test.txt"));
  const inA = fs.existsSync(path.join(WORK_A, "cwd-test.txt"));
  console.log("文件落在 WORK_B:", inB, "| 落在 WORK_A:", inA);

  client.dispose();
  await rt.stop();
  for (const d of [HOME, WORK_A, WORK_B]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  const pass = ended && inB && !inA;
  console.log("\n=== " + (pass ? "PASS ✅ 会话级 cwd 生效，切换工程无需重启运行时" : "FAIL ❌") + " ===");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
