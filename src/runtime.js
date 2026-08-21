"use strict";
/**
 * runtime.js — 定位并拉起 DeepSeek Harness 运行时（dsh CLI）。
 *
 * 与桌面版 DeepSeek Harness 完全相同的启动配方（见其主进程 main.js）：
 *   node --expose-internals <bin.js> --profile web --port <port>
 * 环境：DSH_HOME=<数据目录>、DSH_TELEMETRY_DISABLED=1、NODE_ENV=production
 * cwd  = 工作区文件夹（智能体实际操作的文件范围）
 * 就绪判据：GET http://127.0.0.1:<port>/ 返回 <500 且正文包含 __DSH_BOOT__
 */
const { spawn, execFile } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

/**
 * 自动探测 DeepSeek Harness 安装目录。
 * 优先级：环境变量 DSH_HARNESS → 各平台标准安装位置 → 返回 ""（交由用户设置）。
 */
function detectHarnessRoot() {
  const candidates = [];
  if (process.env.DSH_HARNESS) candidates.push(process.env.DSH_HARNESS);
  if (process.platform === "win32") {
    candidates.push(
      path.join(process.env.LOCALAPPDATA || "", "Programs", "DeepSeek Harness"),
      path.join(process.env.ProgramFiles || "", "DeepSeek Harness"),
      path.join(process.env["ProgramFiles(x86)"] || "", "DeepSeek Harness")
    );
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/DeepSeek Harness.app/Contents/Resources");
  } else {
    candidates.push("/opt/DeepSeek Harness/resources", "/usr/lib/deepseek-harness/resources");
  }
  for (const c of candidates) {
    if (!c) continue;
    const bin = path.join(c, "resources", "dsh", "vendor", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    if (fs.existsSync(bin)) return c;
  }
  return candidates.find(Boolean) || "";
}

/** 校验并解析运行时要用的路径。 */
function resolveRuntime(cfg, isolatedHome, workspace) {
  const harnessRoot = cfg.harnessRoot || detectHarnessRoot();
  if (!harnessRoot) {
    throw new Error(
      "未找到 DeepSeek Harness 安装目录。\n请在 VS Code 设置（dsh.harnessRoot）中填写，或设置环境变量 DSH_HARNESS。"
    );
  }
  const node = cfg.nodePath || path.join(harnessRoot, "resources", "node", "node.exe");
  const bin = path.join(
    harnessRoot,
    "resources", "dsh", "vendor", "node_modules",
    "@deepseek-ai", "dsh", "lib", "bin.js"
  );
  const missing = [];
  if (!fs.existsSync(node)) missing.push(node);
  if (!fs.existsSync(bin)) missing.push(bin);
  if (missing.length > 0) {
    throw new Error(
      "找不到 DSH 运行时文件：\n" +
      missing.join("\n") +
      "\n\n请在 VS Code 设置（dsh.harnessRoot）中填写 DeepSeek Harness 安装目录。"
    );
  }
  const dshHome = cfg.dshHome || isolatedHome;
  return { node, bin, dshHome, workspace };
}

/** 分配一个 127.0.0.1 上的空闲端口。 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** 轮询 URL 直到返回 <500。 */
async function waitForServer(url, timeoutMs, onTick) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return res;
      lastErr = new Error("HTTP " + res.status);
    } catch (e) {
      lastErr = e;
    }
    if (onTick) onTick(lastErr ? lastErr.message : "无响应");
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    "DSH 服务在 " + Math.round(timeoutMs / 1000) + "s 内未就绪：" +
    (lastErr ? lastErr.message : "无响应")
  );
}

/** 一个受控的 dsh web 运行时进程。 */
class RuntimeProcess {
  constructor() {
    this.child = null;
    this.port = 0;
    this.url = "";
    this.log = "";
    this._logListeners = [];
  }

  onLog(fn) {
    this._logListeners.push(fn);
  }

  _emitLog(line) {
    this.log += line + "\n";
    if (this.log.length > 200000) this.log = this.log.slice(-100000);
    for (const fn of this._logListeners) fn(line);
  }

  get running() {
    return !!(this.child && this.child.exitCode === null);
  }

  start(resolved, port) {
    if (this.running) return;
    fs.mkdirSync(resolved.dshHome, { recursive: true });
    const env = {
      ...process.env,
      DSH_HOME: resolved.dshHome,
      DSH_TELEMETRY_DISABLED: "1",
      NODE_ENV: "production",
    };
    delete env.ELECTRON_RUN_AS_NODE;

    this.port = port;
    this.url = "http://127.0.0.1:" + port + "/";
    this._emitLog("启动命令: " + resolved.node + " --expose-internals " + resolved.bin +
      " --profile web --port " + port);
    this._emitLog("DSH_HOME : " + resolved.dshHome);
    this._emitLog("工作区   : " + resolved.workspace);

    const child = spawn(
      resolved.node,
      ["--expose-internals", resolved.bin, "--profile", "web", "--port", String(port)],
      {
        env,
        cwd: resolved.workspace,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );
    this.child = child;
    child.stdout.on("data", (d) => this._emitLog(String(d).trimEnd()));
    child.stderr.on("data", (d) => this._emitLog("[err] " + String(d).trimEnd()));
    child.on("error", (e) => this._emitLog("[spawn error] " + e.message));
    child.on("exit", (code, sig) => {
      this._emitLog("[dsh 退出 code=" + code + " signal=" + sig + "]");
    });
  }

  /** 等待 HTTP 就绪且返回 DSH boot 清单。 */
  async waitReady(timeoutMs, onTick) {
    const res = await waitForServer(this.url, timeoutMs, onTick);
    const text = await res.text();
    if (!text.includes("__DSH_BOOT__")) {
      throw new Error("服务已响应，但缺少 DSH boot 清单（页面异常）。");
    }
  }

  /** 优雅停止：SIGTERM → 5s 宽限 → taskkill 整棵进程树。 */
  stop() {
    return new Promise((resolve) => {
      const child = this.child;
      if (!child || child.exitCode !== null) {
        resolve();
        return;
      }
      const pid = child.pid;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          execFile("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true }, () => resolve());
        } catch {
          resolve();
        }
      }, 5000);
    });
  }
}

/** 无头（headless）单次任务：一次性跑完并退出，不占用端口。 */
function runHeadless(resolved, task, onData, onExit) {
  fs.mkdirSync(resolved.dshHome, { recursive: true });
  const env = {
    ...process.env,
    DSH_HOME: resolved.dshHome,
    DSH_TELEMETRY_DISABLED: "1",
    NODE_ENV: "production",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    resolved.node,
    ["--expose-internals", resolved.bin, "--profile", "headless", task],
    {
      env,
      cwd: resolved.workspace,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  child.stdout.on("data", (d) => onData(String(d)));
  child.stderr.on("data", (d) => onData(String(d)));
  child.on("error", (e) => onData("[spawn error] " + e.message));
  child.on("exit", (code) => onExit(code));
  return child;
}

module.exports = { resolveRuntime, detectHarnessRoot, getFreePort, waitForServer, RuntimeProcess, runHeadless };
