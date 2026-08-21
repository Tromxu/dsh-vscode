"use strict";
/**
 * extension.js — DSH 原生智能体扩展（v0.2 完整接线）。
 *
 * 架构：
 *   [侧边栏会话视图 ChatViewProvider] <-> [NativeBridge] <-> [SessionClient] <-> [dsh web 运行时]
 *                                                              ^
 *                                                    (HTTP /api + WS events.mux/host)
 *   NativeBridge 把会话事件映射为 VS Code 原生动作：
 *   文件写→编辑器 WorkspaceEdit（可撤销/进 SCM）、命令→只读镜像终端、
 *   提问/审批→原生对话框并 respond。
 *
 * 命令：
 *   DSH: 打开智能体会话（活动栏图标）
 *   DSH: 配置 DeepSeek API Key（credentials.set → DEEPSEEK_API_KEY）
 *   DSH: 快速任务（无头模式） / DSH: 停止运行时 / DSH: 查看运行日志
 *   DSH: 打开 Web 面板（旧版兜底）
 */
const vscode = require("vscode");
const os = require("node:os");
const path = require("node:path");
const { resolveRuntime, getFreePort, RuntimeProcess, runHeadless } = require("./runtime");
const { createPanel } = require("./webview");
const { ChatViewProvider } = require("./chat-webview");
const { SessionClient } = require("./session-client");
const { NativeBridge } = require("./bridge");

let runtime = null;
let panel = null;
let output = null;
let chatProvider = null;
let sessionClient = null;
let bridge = null;
let currentSessionId = null;

function getWorkspace() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : os.homedir();
}

function resolveFor(context) {
  const cfg = vscode.workspace.getConfiguration("dsh");
  const isolatedHome = path.join(context.globalStorageUri.fsPath, "dsh-home");
  return resolveRuntime(cfg, isolatedHome, getWorkspace());
}

async function ensureRuntime(context) {
  if (runtime && runtime.running) return runtime;
  const cfg = vscode.workspace.getConfiguration("dsh");
  let resolved;
  try {
    resolved = resolveFor(context);
  } catch (e) {
    vscode.window
      .showErrorMessage(e.message, "打开设置")
      .then((choice) => {
        if (choice === "打开设置") {
          vscode.commands.executeCommand("workbench.action.openSettings", "dsh.harnessRoot");
        }
      });
    throw e;
  }
  const port = Number(cfg.get("port")) || (await getFreePort());
  const timeoutMs = (Number(cfg.get("bootTimeoutSec")) || 120) * 1000;
  const rt = new RuntimeProcess();
  rt.onLog((line) => output.appendLine(line));
  rt.start(resolved, port);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "DSH: 正在启动本地运行时…" },
      () => rt.waitReady(timeoutMs, (msg) => output.appendLine("[boot] " + msg))
    );
  } catch (e) {
    const tail = rt.log.split("\n").slice(-15).join("\n");
    await rt.stop();
    runtime = null;
    vscode.window
      .showErrorMessage("DSH 启动失败：" + e.message + "\n\n最近日志：\n" + tail, "查看日志")
      .then((c) => { if (c === "查看日志") output.show(true); });
    throw e;
  }
  runtime = rt;
  output.appendLine("DSH 已就绪: " + rt.url);
  return rt;
}

async function stopRuntime() {
  if (!runtime) return;
  const rt = runtime;
  runtime = null;
  if (sessionClient) {
    sessionClient.dispose();
    sessionClient = null;
  }
  currentSessionId = null;
  await rt.stop();
  output.appendLine("DSH 运行时已停止。");
  if (chatProvider) chatProvider.post({ type: "status", state: "bad", label: "已停止" });
}

async function ensureSession(context) {
  const rt = await ensureRuntime(context);
  if (!sessionClient) {
    sessionClient = new SessionClient(rt);
    sessionClient.onLog((line) => output.appendLine("[session] " + line));
    bridge = new NativeBridge(context, sessionClient, chatProvider, output);
    sessionClient.onServerRequest((msg) => bridge.handleServerRequest(msg));
    await sessionClient.connect();
    output.appendLine("[session] 已连接事件流");
    postStatus("ok", "已连接 · " + rt.url);
  }
  return rt;
}

function postStatus(state, label) {
  if (chatProvider) chatProvider.post({ type: "status", state, label });
}

/** 视图打开时自动启动运行时并连接，避免停留在「未连接」。 */
async function onViewOpen(context) {
  if (sessionClient) {
    postStatus("ok", "已连接 · " + (runtime ? runtime.url : ""));
    return;
  }
  postStatus("", "正在启动本地运行时…");
  try {
    const rt = await ensureSession(context);
    postStatus("ok", "已连接 · " + rt.url);
  } catch (e) {
    postStatus("bad", "连接失败");
    output.appendLine("[view-open] " + e.message);
  }
}

async function onUserSend(text) {
  if (!chatProvider) return;
  try {
    await ensureSession(chatProvider._context);
    postStatus("ok", "已连接 · " + (runtime ? runtime.url : ""));
    if (!currentSessionId) {
      const created = await sessionClient.sessionCreate({});
      currentSessionId = created.sessionId;
      output.appendLine("[session] created: " + currentSessionId);
    }
    await sessionClient.sessionPrompt({
      sessionId: currentSessionId,
      mode: "queue",
      content: [{ type: "text", text }],
    });
  } catch (e) {
    chatProvider.post({ type: "error", message: e.message });
  }
}

async function onUserStop() {
  if (sessionClient && currentSessionId) {
    try {
      await sessionClient.sessionCancel(currentSessionId);
    } catch (e) {
      output.appendLine("[cancel] " + e.message);
    }
  }
}

/** 配置 DeepSeek API Key（写入 DSH 凭据库，供面板会话与无头任务共用）。 */
async function setApiKey(context) {
  try {
    await ensureSession(context);
    const key = await vscode.window.showInputBox({
      prompt: "DeepSeek API Key（platform.deepseek.com → API Keys 申请）",
      password: true,
      ignoreFocusOut: true,
      placeHolder: "sk-...",
    });
    if (!key || !key.trim()) return;
    await sessionClient.credentialsSet("DEEPSEEK_API_KEY", key.trim());
    vscode.window.showInformationMessage("DeepSeek API Key 已保存（存储于 DSH_HOME 凭据库）。");
  } catch (e) {
    vscode.window.showErrorMessage("配置失败: " + e.message);
  }
}

function activate(context) {
  output = vscode.window.createOutputChannel("DSH Agent");
  context.subscriptions.push(output);

  chatProvider = new ChatViewProvider();
  chatProvider._context = context;
  chatProvider._onViewOpen = () => onViewOpen(context);
  chatProvider._onHostMessage = async (m) => {
    switch (m.type) {
      case "send":
        await onUserSend(m.text);
        break;
      case "stop":
        await onUserStop();
        break;
      case "respond":
        // 提问/审批由 bridge 用原生对话框处理，webview 不再直接应答
        break;
    }
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("dsh.chatView", chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dsh.openChat", () => {
      vscode.commands.executeCommand("workbench.view.extension.dsh");
    }),
    vscode.commands.registerCommand("dsh.setApiKey", () => setApiKey(context)),
    vscode.commands.registerCommand("dsh.openPanel", () => openPanel(context)),
    vscode.commands.registerCommand("dsh.quickTask", () => quickTask(context)),
    vscode.commands.registerCommand("dsh.stop", () => stopRuntime()),
    vscode.commands.registerCommand("dsh.openLog", () => output.show(true))
  );

  context.subscriptions.push({
    dispose: () => {
      if (sessionClient) sessionClient.dispose();
      if (runtime) runtime.stop();
    },
  });

  const cfg = vscode.workspace.getConfiguration("dsh");
  if (cfg.get("autoOpen")) {
    vscode.commands.executeCommand("workbench.view.extension.dsh");
  }
}

async function openPanel(context) {
  let rt;
  try {
    rt = await ensureRuntime(context);
  } catch {
    return;
  }
  if (!panel) {
    panel = createPanel(rt.url, getWorkspace(), (url) => vscode.env.openExternal(vscode.Uri.parse(url)));
    panel.onDidDispose(() => { panel = null; }, null, context.subscriptions);
  } else {
    panel.reveal(vscode.ViewColumn.One);
  }
}

async function quickTask(context) {
  const task = await vscode.window.showInputBox({
    prompt: "DSH 无头任务",
    placeHolder: "输入要交给 DSH 的任务…",
    ignoreFocusOut: true,
  });
  if (!task || !task.trim()) return;
  let resolved;
  try {
    resolved = resolveFor(context);
  } catch (e) {
    vscode.window.showErrorMessage(e.message);
    return;
  }
  output.show(true);
  output.appendLine("");
  output.appendLine("$ dsh --profile headless " + JSON.stringify(task));
  runHeadless(
    resolved,
    task,
    (chunk) => output.append(chunk),
    (code) => {
      output.appendLine("");
      output.appendLine("[headless 结束 code=" + code + "]");
      vscode.window.showInformationMessage(
        code === 0 ? "DSH 任务完成 ✅（详见 DSH Agent 输出面板）" : "DSH 任务失败（code=" + code + "），详见输出面板"
      );
    }
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
