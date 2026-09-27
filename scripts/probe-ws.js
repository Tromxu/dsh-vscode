"use strict";
/**
 * probe-ws.js — 探测新版 dsh 的 WebSocket 下行流认证方式。
 * 用法: $env:DSH_HARNESS="..."; node scripts/probe-ws.js
 */
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");
const { resolveRuntime, getFreePort, RuntimeProcess } = require("../src/runtime");

const HARNESS = process.env.DSH_HARNESS || "";
const HOME = path.join(__dirname, "..", ".smoke", "probe-ws-home");
const WORK = path.join(__dirname, "..", ".smoke", "probe-ws-work");

function tryWs(label, url, opts) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, opts || {});
    const timer = setTimeout(() => { try { ws.terminate(); } catch {} resolve(label + " -> 超时"); }, 8000);
    ws.on("open", () => { clearTimeout(timer); try { ws.close(); } catch {} resolve(label + " -> ✅ 升级成功"); });
    ws.on("error", (e) => { clearTimeout(timer); resolve(label + " -> ❌ " + e.message); });
    ws.on("unexpected-response", (_req, res) => { clearTimeout(timer); resolve(label + " -> ❌ HTTP " + res.statusCode); });
  });
}

async function main() {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });
  const resolved = resolveRuntime({ harnessRoot: HARNESS, nodePath: "", dshHome: "", port: 0 }, HOME, WORK);
  const port = await getFreePort();
  const rt = new RuntimeProcess();
  rt.onLog((l) => { if (/认证|token|Cookie/.test(l)) console.log("[rt]", l); });
  rt.start(resolved, port);
  await rt.waitReady(150000, () => {});
  console.log("运行时就绪:", rt.url, "| token:", rt.token ? "有" : "无", "| cookie:", rt.cookie ? rt.cookie.slice(0, 30) + "..." : "无");

  const base = "ws://127.0.0.1:" + port + "/api/events.mux";
  console.log(await tryWs("无认证       ", base));
  console.log(await tryWs("Cookie 头    ", base, { headers: { cookie: rt.cookie || "" } }));
  console.log(await tryWs("查询 token   ", base + "?token=" + (rt.token || "")));
  console.log(await tryWs("Cookie+token ", base + "?token=" + (rt.token || ""), { headers: { cookie: rt.cookie || "" } }));

  await rt.stop();
  for (const d of [HOME, WORK]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  process.exit(0);
}

main().catch((e) => { console.error("probe-ws 失败:", e); process.exit(1); });
