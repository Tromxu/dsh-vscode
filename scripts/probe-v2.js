"use strict";
/**
 * probe-v2.js — 探明新版（0.1.2-rc.1）RPC 载荷格式与流端点。
 * 用法: $env:DSH_HARNESS="..."; node scripts/probe-v2.js
 */
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");
const { randomUUID } = require("node:crypto");
const { resolveRuntime, getFreePort, RuntimeProcess } = require("../src/runtime");

const HARNESS = process.env.DSH_HARNESS || "";
const HOME = path.join(__dirname, "..", ".smoke", "probe2-home");
const WORK = path.join(__dirname, "..", ".smoke", "probe2-work");

async function post(base, cookie, endpoint, payload) {
  const rpcId = randomUUID();
  const res = await fetch(base + "/api/" + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload }),
  });
  const text = await res.text();
  return { status: res.status, text: text.slice(0, 300).replace(/\s+/g, " ") };
}

async function main() {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });
  const resolved = resolveRuntime({ harnessRoot: HARNESS, nodePath: "", dshHome: "", port: 0 }, HOME, WORK);
  const port = await getFreePort();
  const rt = new RuntimeProcess();
  rt.start(resolved, port);
  await rt.waitReady(150000, () => {});
  const base = "http://127.0.0.1:" + port;
  console.log("就绪 | cookie:", rt.cookie ? "有" : "无");

  console.log("\n=== unary 载荷格式试探 ===");
  for (const [label, ep, payload] of [
    ["session/list {args:{}}", "session/list", { args: {} }],
    ["session/list 裸 {}", "session/list", {}],
    ["host/describe {args:{}}", "host/describe", { args: {} }],
    ["host/describe 裸 {}", "host/describe", {}],
  ]) {
    try {
      const r = await post(base, rt.cookie, ep, payload);
      console.log(label.padEnd(26), r.status, r.text);
    } catch (e) {
      console.log(label.padEnd(26), "失败:", e.message);
    }
  }

  console.log("\n=== 流端点试探（mux /api/remote.mux） ===");
  const muxUrl = "ws://127.0.0.1:" + port + "/api/remote.mux";
  const ws = new WebSocket(muxUrl, { headers: rt.cookie ? { cookie: rt.cookie } : {} });
  await new Promise((resolve) => {
    const t = setTimeout(() => { console.log("mux 连接超时"); resolve(); }, 8000);
    ws.on("open", () => { clearTimeout(t); console.log("mux 已连接 ✅"); resolve(); });
    ws.on("error", (e) => { clearTimeout(t); console.log("mux 连接失败 ❌", e.message); resolve(); });
    ws.on("unexpected-response", (_q, r) => { clearTimeout(t); console.log("mux 升级被拒 ❌ HTTP", r.statusCode); resolve(); });
  });
  if (ws.readyState === WebSocket.OPEN) {
    const frames = [];
    ws.on("message", (d) => {
      const s = d.toString();
      frames.push(s);
      if (frames.length <= 6) console.log("  <-", s.slice(0, 220));
    });
    for (const ep of ["session/control", "session/follow", "$events"]) {
      const args = ep === "session/follow" ? { sessionId: "probe-session" } : {};
      ws.send(JSON.stringify({ type: "open", streamId: "s-" + ep.replace(/\W/g, "_"), endpoint: ep, payload: { args } }));
      await new Promise((r) => setTimeout(r, 2500));
      console.log("  已打开:", ep, "| 收到帧数:", frames.length);
    }
    ws.close();
  }

  await rt.stop();
  for (const d of [HOME, WORK]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  process.exit(0);
}

main().catch((e) => { console.error("probe-v2 失败:", e); process.exit(1); });
