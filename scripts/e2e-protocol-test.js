"use strict";
/**
 * e2e-protocol-test.js — 协议端到端测试（无需 VS Code / 无需 API Key）。
 *
 * 真实启动 dsh web（隔离 DSH_HOME），用 src/session-client.js 完整走一遍：
 *   host.describe → session.create → session.prompt → 收集 mux 事件帧。
 * 没有 API Key 时 prompt 应返回 model-unavailable 业务错误——这本身就证明
 * 信封/信任围栏/会话/RPC 错误路径全部打通。
 *
 * 用法: node scripts/e2e-protocol-test.js
 */
const path = require("node:path");
const { resolveRuntime, getFreePort, RuntimeProcess } = require("../src/runtime");
const { SessionClient } = require("../src/session-client");

const HARNESS = process.env.DSH_HARNESS || ""; // 空 = resolveRuntime 自动探测
const SMOKE_HOME = path.join(__dirname, "..", ".smoke", "e2e-home");
const WORKSPACE = process.cwd();

async function main() {
  const cfg = { harnessRoot: HARNESS, nodePath: "", dshHome: "", port: 0, bootTimeoutSec: 120 };
  const resolved = resolveRuntime(cfg, SMOKE_HOME, WORKSPACE);
  const port = await getFreePort();
  const rt = new RuntimeProcess();
  rt.onLog((l) => console.log("[rt]", l));
  rt.start(resolved, port);
  await rt.waitReady(150000, (m) => console.log("[boot]", m));
  console.log("READY:", rt.url);

  const client = new SessionClient(rt);
  client.onLog((l) => console.log("[client]", l));
  const frames = [];
  client.onServerRequest((msg) => {
    frames.push(msg);
    const f = msg.payload;
    console.log(
      "[frame]",
      f.type,
      f.type === "session/event" ? f.event.type : "",
      JSON.stringify(f).slice(0, 200)
    );
  });
  await client.connect();
  console.log("--- connected ---");

  const host = await client.hostDescribe();
  console.log("host.describe ok, top keys:", Object.keys(host).join(","));

  const created = await client.sessionCreate({});
  console.log("session.create ->", created.sessionId);

  // 可选：设置一个假 Key 验证 credentials.set 生效（错误应变为 401/网络错误，而非 no API key）
  const fakeKey = process.env.DSH_TEST_FAKE_KEY;
  if (fakeKey) {
    await client.credentialsSet("DEEPSEEK_API_KEY", fakeKey);
    const view = await client.credentialsDescribe(["DEEPSEEK_API_KEY"]);
    console.log("credentials.describe ->", JSON.stringify(view));
  }

  try {
    const accepted = await client.sessionPrompt({
      sessionId: created.sessionId,
      mode: "queue",
      content: [{ type: "text", text: "请只回复两个字：你好" }],
    });
    console.log("session.prompt accepted:", JSON.stringify(accepted));
  } catch (e) {
    console.log("session.prompt error (无 Key 时预期 model-unavailable):", e.code, "-", e.message);
  }

  await new Promise((r) => setTimeout(r, 8000));
  const evCount = frames.filter((m) => m.payload.type === "session/event").length;
  console.log("mux event frames received:", evCount);
  console.log("---- frames summary ----");
  for (const m of frames) {
    const f = m.payload;
    if (f.type === "session/event") {
      const d = f.event.data;
      let extra = "";
      if (f.event.type === "tool/call") extra = " name=" + d.name;
      if (f.event.type === "assistant/chunk" && d.chunk && d.chunk.type === "text-delta") {
        extra = " text=" + JSON.stringify(d.chunk.text);
      }
      console.log("  ", f.event.type, extra);
    } else {
      console.log("  ", f.type);
    }
  }

  client.dispose();
  await rt.stop();
  console.log("DONE");
}

main().catch((e) => {
  console.error("E2E FAIL:", e);
  process.exit(1);
});
