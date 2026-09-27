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
const { foldHistory } = require("./history");

let runtime = null;
let panel = null;
let output = null;
let chatProvider = null;
let sessionClient = null;
let bridge = null;
let currentSessionId = null;
let follow = null;
let followSessionId = null;

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

/** 设置工程位置（保存为全局设置；下次消息将在新目录新建会话，无需重启）。 */
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
  // 会话级 cwd：无需重启运行时，下次发送消息会在新目录新建会话
  stopFollow();
  currentSessionId = null;
  vscode.window.showInformationMessage(
    "工程位置已切换为：" + dir + "\n无需重启，发送消息后智能体将在该目录工作。"
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
  stopFollow();
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
    output.appendLine("[session] 已连接（协议模式：" + sessionClient.mode + "）");
    postStatus("ok", "已连接 · " + rt.url);
  }
  return rt;
}

/** 新版：跟随会话（快照即历史，随后实时事件进桥接）。 */
function startFollow(context, sessionId) {
  if (!sessionClient || sessionClient.mode !== "new") return;
  if (follow && followSessionId === sessionId) return;
  stopFollow();
  followSessionId = sessionId;
  follow = sessionClient.followSession(sessionId, {
    onSnapshot: (snap) => {
      const records = (snap.records || []).filter((r) => r && r.type === "event").map((r) => r.event);
      const msgs = foldHistory(records);
      if (chatProvider) {
        chatProvider.post({ type: "history", messages: msgs });
        chatProvider.post({ type: "workspace", path: getWorkspace() });
      }
      output.appendLine("[follow] 快照 " + msgs.length + " 条消息（cursor=" + snap.cursor + "，cwd=" + ((snap.header && snap.header.cwd) || "?") + "）");
    },
    onEvent: (ev) => {
      if (bridge) bridge.handleEvent(sessionId, ev);
    },
    onError: (err) => output.appendLine("[follow] 流错误: " + JSON.stringify(err)),
  });
  output.appendLine("[follow] 已跟随会话 " + sessionId);
}

function stopFollow() {
  if (follow) {
    try { follow.close(); } catch { /* ignore */ }
    follow = null;
  }
  followSessionId = null;
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
    // 打开面板时恢复该工程上次的会话与聊天记录
    const key = sessionKey();
    const saved = context.globalState.get(key);
    if (saved) {
      try {
        currentSessionId = saved;
        await renderHistory(context);
      } catch (e) {
        output.appendLine("[restore] " + e.message);
        currentSessionId = null;
      }
    }
  } catch (e) {
    postStatus("bad", "连接失败");
    output.appendLine("[view-open] " + e.message);
  }
}

/** 会话持久化键：按工程位置区分。 */
function sessionKey() {
  return "dsh.session." + getWorkspace();
}

/** 确保存在当前会话：优先恢复本工程上次的会话，否则新建并持久化；随后开始跟随。 */
async function ensureSessionId(context) {
  if (currentSessionId) {
    startFollow(context, currentSessionId);
    return currentSessionId;
  }
  const key = sessionKey();
  const saved = context.globalState.get(key);
  if (saved) {
    try {
      if (sessionClient.mode === "new") {
        // 新版：跟随成功即证明会话可用（快照会带回历史）
        startFollow(context, saved);
      } else {
        await sessionClient.sessionHistory({ sessionId: saved, maxMessages: 1 });
      }
      currentSessionId = saved;
      output.appendLine("[session] 恢复历史会话: " + saved);
      return saved;
    } catch (e) {
      output.appendLine("[session] 历史会话不可用，将新建: " + e.message);
    }
  }
  const created = await sessionClient.sessionCreate({ cwd: getWorkspace() });
  currentSessionId = created.sessionId;
  await context.globalState.update(key, currentSessionId);
  output.appendLine("[session] created: " + currentSessionId);
  startFollow(context, currentSessionId);
  return currentSessionId;
}

/** 把当前会话的历史消息渲染到聊天视图（新版由 follow 快照完成）。 */
async function renderHistory(context) {
  if (!currentSessionId || !sessionClient) return;
  if (sessionClient.mode === "new") {
    startFollow(context, currentSessionId);
    postStatus("ok", "已恢复历史会话 · " + (runtime ? runtime.url : ""));
    return;
  }
  const hist = await sessionClient.sessionHistory({ sessionId: currentSessionId, maxMessages: 100 });
  const msgs = foldHistory(hist.events.map((h) => h.event));
  if (chatProvider) {
    chatProvider.post({ type: "history", messages: msgs });
    chatProvider.post({ type: "workspace", path: getWorkspace() });
  }
  postStatus("ok", "已恢复历史会话 · " + (runtime ? runtime.url : ""));
  output.appendLine("[history] 已渲染 " + msgs.length + " 条历史消息");
}

/** 打开历史工程/会话：列出持久化会话，恢复选择项并可切换工程位置。 */
async function openHistory(context) {
  try {
    await ensureSession(context);
    const list = await sessionClient.sessionList();
    const items = list.items || [];
    if (!items.length) {
      vscode.window.showInformationMessage("暂无历史会话（首次使用后会自动记录）。");
      return;
    }
    const picks = items.map((i) => ({
      label: (i.projections && i.projections.values && i.projections.values.title) || "(未命名会话)",
      description: i.cwd || "（无工程记录）",
      detail: "更新于 " + new Date(i.updatedAt).toLocaleString() + (i.blank ? " · 未开始" : ""),
      sessionId: i.sessionId,
      cwd: i.cwd || "",
    }));
    const pick = await vscode.window.showQuickPick(picks, {
      placeHolder: "选择历史工程/会话（回车恢复并继续对话）",
      matchOnDescription: true,
      ignoreFocusOut: true,
    });
    if (!pick) return;
    const ws = getWorkspace();
    if (pick.cwd && path.resolve(pick.cwd) !== path.resolve(ws)) {
      const go = await vscode.window.showInformationMessage(
        "该历史会话的工程位于：" + pick.cwd + "\n是否将工程位置切换到这里，便于继续修复该工程的 bug？",
        { modal: true },
        "切换并打开",
        "仅恢复会话"
      );
      if (go === "切换并打开") {
        await vscode.workspace
          .getConfiguration("dsh")
          .update("workspaceRoot", pick.cwd, vscode.ConfigurationTarget.Global);
      }
    }
    stopFollow();
    currentSessionId = pick.sessionId;
    await context.globalState.update(sessionKey(), pick.sessionId);
    await renderHistory(context);
    vscode.window.showInformationMessage("已恢复历史会话，可直接继续对话（例如：修复这个工程的 bug）。");
  } catch (e) {
    vscode.window.showErrorMessage("打开历史会话失败: " + e.message);
  }
}

async function onUserSend(text) {
  if (!chatProvider) return;
  try {
    await ensureSession(chatProvider._context);
    postStatus("ok", "已连接 · " + (runtime ? runtime.url : ""));
    await ensureSessionId(chatProvider._context);
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
    await ensureSessionId(context);
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
      case "command":
        // 快捷操作条按钮：触发扩展自身命令（免命令面板）
        try {
          await vscode.commands.executeCommand(m.command);
        } catch (e) {
          output.appendLine("[command] " + m.command + " -> " + e.message);
        }
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
    vscode.commands.registerCommand("dsh.openHistory", () => openHistory(context)),
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
