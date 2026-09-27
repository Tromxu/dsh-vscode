"use strict";
/**
 * probe-token.js — 探测新版 dsh web 的令牌机制：
 *   1) GET /            是否需要 token
 *   2) GET /?token=...  是否返回 boot 清单、是否下发 cookie
 *   3) POST /api/<method> 无 cookie / 带 cookie 是否可用
 * 用法: $env:DSH_HARNESS="..."; node scripts/probe-token.js
 */
const path = require("node:path");
const { resolveRuntime, getFreePort, RuntimeProcess } = require("../src/runtime");

const HARNESS = process.env.DSH_HARNESS || "";
const HOME = path.join(__dirname, "..", ".smoke", "probe-home");
const WORK = path.join(__dirname, "..", ".smoke", "probe-work");

function parseToken(line) {
  const m = /http:\/\/127\.0\.0\.1:\d+\/\?token=([\w-]+)/.exec(line);
  return m ? m[1] : null;
}

async function main() {
  const fs = require("node:fs");
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });
  const cfg = { harnessRoot: HARNESS, nodePath: "", dshHome: "", port: 0, bootTimeoutSec: 120 };
  const resolved = resolveRuntime(cfg, HOME, WORK);
  const port = await getFreePort();
  const rt = new RuntimeProcess();
  let token = null;
  rt.onLog((l) => {
    console.log("[rt]", l);
    const t = parseToken(l);
    if (t) token = t;
  });
  // 手动启动以便捕获 token：这里复用 start（其 args 含 --port），token 从日志解析
  rt.start(resolved, port);
  // 等待端口可连（不看 boot 清单）
  const deadline = Date.now() + 120000;
  while (!token && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log("解析到的 token:", token ? token.slice(0, 12) + "..." : "(无)");
  const base = `http://127.0.0.1:${port}`;

  // 1) 无 token
  try {
    const r1 = await fetch(base + "/");
    const t1 = await r1.text();
    console.log("GET /            ->", r1.status, "| boot清单:", t1.includes("__DSH_BOOT__"), "| 长度:", t1.length, "| set-cookie:", r1.headers.get("set-cookie") ? "有" : "无");
  } catch (e) { console.log("GET / 失败:", e.message); }

  // 2) 带 token
  let cookie = null;
  try {
    const r2 = await fetch(base + "/?token=" + token);
    const t2 = await r2.text();
    const sc = r2.headers.getSetCookie ? r2.headers.getSetCookie() : [r2.headers.get("set-cookie")].filter(Boolean);
    cookie = sc.map((c) => c.split(";")[0]).join("; ");
    console.log("GET /?token=...  ->", r2.status, "| boot清单:", t2.includes("__DSH_BOOT__"), "| 长度:", t2.length, "| cookies:", sc.length ? sc.map((c) => c.split(";")[0]).join(" ; ") : "(无)");
  } catch (e) { console.log("GET /?token 失败:", e.message); }

  // 3) API：无 cookie / 带 cookie
  const req = JSON.stringify({ type: "client-request", rpcId: "probe-1", method: "host.describe", payload: {} });
  for (const [label, headers] of [
    ["无 cookie", { "Content-Type": "application/json" }],
    ["带 cookie", { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }],
  ]) {
    try {
      const r = await fetch(base + "/api/host.describe", { method: "POST", headers, body: req });
      const t = await r.text();
      console.log("POST /api (" + label + ") ->", r.status, "|", t.slice(0, 160).replace(/\s+/g, " "));
    } catch (e) { console.log("POST /api (" + label + ") 失败:", e.message); }
  }

  await rt.stop();
  for (const d of [HOME, WORK]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  process.exit(0);
}

main().catch((e) => { console.error("probe 失败:", e); process.exit(1); });
