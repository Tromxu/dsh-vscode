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

/**
 * 工程位置（智能体工作区）：
 * 优先 dsh.workspaceRoot 设置（工程存储位置）→ VS Code 当前打开的第一个文件夹 → 用户主目录。
 */
function getWorkspace() {
  const cfg = vscode.workspace.getConfiguration("dsh");
  const configured = String(cfg.get("workspaceRoot") || "").trim();
  if (configured) return configured;
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : os.homedir();
}

/** 设置工程位置（保存为全局设置并重启运行时，下次会话在新目录工作）。 */
async function setWorkspace(context) {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "选择工程存储位置",
    title: "DSH: 设置工程位置（智能体将在此目录工作）",
  });
  if (!picked || !picked[0]) return;
  const dir = picked[0].fsPath;
  await vscode.workspace
    .getConfiguration("dsh")
    .update("workspaceRoot", dir, vscode.ConfigurationTarget.Global);
  // 工作区变了：重启运行时并新建会话，确保下次会话以新目录为 cwd
  currentSessionId = null;
  await stopRuntime();
  vscode.window.showInformationMessage(
    "工程位置已设置为：" + dir + "\n运行时已重启，发送消息后将在该目录工作。"
  );
  if (chatProvider) chatProvider.post({ type: "workspace", path: dir });
}

/** 打开工程位置（在资源管理器中定位；未设置则打开当前工作区文件夹）。 */
async function openWorkspace() {
  const ws = getWorkspace();
  try {
    const uri = vscode.Uri.file(ws);
    await vscode.commands.executeCommand("revealInExplorer", uri);
  } catch (e) {
    try {
      await vscode.env.openExternal(vscode.Uri.file(ws));
    } catch {
      output.appendLine("[openWorkspace] " + e.message);
    }
  }
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
    const msg = e.message || String(e);
    const isMissingInstall = msg.includes("未找到 DeepSeek Harness 安装目录") || msg.includes("DSH 运行时文件缺失");
    vscode.window
      .showErrorMessage(msg, ...(isMissingInstall ? ["打开设置", "选择安装目录…"] : ["打开设置"]))
      .then(async (choice) => {
        if (choice === "打开设置") {
          vscode.commands.executeCommand("workbench.action.openSettings", "dsh.harnessRoot");
        } else if (choice === "选择安装目录…") {
          const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: "选择 DeepSeek Harness 安装目录",
          });
          if (picked && picked[0]) {
            await vscode.workspace
              .getConfiguration("dsh")
              .update("harnessRoot", picked[0].fsPath, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
              "已保存 dsh.harnessRoot = " + picked[0].fsPath + "，请重新打开 DSH 面板或再发一条消息重试。"
            );
          }
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

/** 推送工程位置到侧边栏头部（点击可在资源管理器打开）。 */
function postWorkspace() {
  if (chatProvider) chatProvider.post({ type: "workspace", path: getWorkspace() });
}

/** 视图打开时自动启动运行时并连接，避免停留在「未连接」。 */
async function onViewOpen(context) {
  postWorkspace();
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

/** 全流程开发：产品设计 → 软件开发 → 软件测试 → 封装发布（四阶段团队流水线）。 */
async function fullPipeline(context) {
  const idea = await vscode.window.showInputBox({
    prompt: "你的软件想法（一句话），DSH 将按「设计→开发→测试→封装发布」四阶段全流程执行",
    placeHolder: "例如：一个带历史记录和搜索的桌面便签应用",
    ignoreFocusOut: true,
  });
  if (!idea || !idea.trim()) return;
  const prompt =
    "请以「软件开发全流程团队」的方式，在当前工作区完成这个项目：\n" +
    idea.trim() + "\n\n" +
    "按以下 4 个阶段依次推进；全程用 todo 工具维护任务清单与进度（每完成一项更新状态），每个阶段结束用一句话汇报：\n" +
    "阶段 1 · 产品设计：撰写需求说明（PRD）与架构/技术选型文档，落到 docs/ 目录（无 docs 则创建）；\n" +
    "阶段 2 · 软件开发：按设计实现全部代码，保持可运行；\n" +
    "阶段 3 · 软件测试：编写并运行测试（单元/集成），修复缺陷直到全部通过；\n" +
    "阶段 4 · 封装发布：完成构建与打包（如 npm run build / package），生成可交付的安装包或产物，最后告知产物路径。";
  try {
    await ensureSession(context);
    postStatus("ok", "已连接 · " + (runtime ? runtime.url : ""));
    if (!currentSessionId) {
      const created = await sessionClient.sessionCreate({});
      currentSessionId = created.sessionId;
      output.appendLine("[session] created: " + currentSessionId);
    }
    await sessionClient.sessionPrompt({
      sessionId: currentSessionId,
      mode: "queue",
      content: [{ type: "text", text: prompt }],
    });
    vscode.window.showInformationMessage("全流程开发已启动：产品设计 → 开发 → 测试 → 封装发布（进度见侧边栏面板）。");
  } catch (e) {
    vscode.window.showErrorMessage("全流程启动失败: " + e.message);
  }
}

/** 打开打包产物（打包预览）。 */
async function openArtifact(rawPath) {
  try {
    const uri = path.isAbsolute(rawPath)
      ? vscode.Uri.file(rawPath)
      : (() => {
          const f = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
          return f ? vscode.Uri.joinPath(f.uri, rawPath) : vscode.Uri.file(rawPath);
        })();
    await vscode.commands.executeCommand("revealInExplorer", uri);
  } catch (e) {
    output.appendLine("[openArtifact] " + e.message);
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
      case "openArtifact":
        await openArtifact(m.path);
        break;
      case "openWorkspace":
        await openWorkspace();
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
    vscode.commands.registerCommand("dsh.fullPipeline", () => fullPipeline(context)),
    vscode.commands.registerCommand("dsh.setWorkspace", () => setWorkspace(context)),
    vscode.commands.registerCommand("dsh.openWorkspace", () => openWorkspace()),
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
