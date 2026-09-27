"use strict";
/**
 * bridge.js — DSH 会话事件 → VS Code 原生操作 的桥接层（完整实现）。
 *
 * 依据 docs/protocol-events.md 与 events 域契约（dsh-host-apiproxy/lib/types/api/events.d.ts）：
 *   - session/event 帧：turn/start、assistant/chunk（text-delta 流式）、assistant/message、
 *     tool/call、tool/result（含 ToolEventView：diff/terminal/read/search 呈现）、turn/end
 *   - approval/requested：原生确认框 → sessionClient.respond(rpcId, {sessionId, approvalId, outcome})
 *   - question/requested：原生 QuickPick → respond(rpcId, {sessionId, answer:{answers}})
 *
 * 编辑器桥接：写文件工具在 result 帧携带 FileDiff[]（oldText/newText + 上下文），
 * 桥接把它应用到打开的编辑器（WorkspaceEdit，可撤销、进 SCM diff）。
 * 命令可见性：终端类工具用「只读镜像终端」展示命令与输出（真实执行仍在 dsh 沙箱内）。
 */
const vscode = require("vscode");
const path = require("node:path");
const fs = require("node:fs");

/** 产物文件扩展名（打包预览：vsix/exe/zip/...） */
const ARTIFACT_RE = /[\w.\\/:-]+\.(vsix|exe|zip|msi|apk|aab|jar|dmg|pkg|deb|rpm|tar\.gz|dll|appx)/gi;

/** 只读镜像终端：在 VS Code 集成终端里显示 dsh 已执行的命令与输出，不重新执行。 */
class MirrorTerminal {
  constructor(name) {
    this._emitter = new vscode.EventEmitter();
    this.terminal = vscode.window.createTerminal({
      name,
      pty: {
        onDidWrite: this._emitter.event,
        open: () => {},
        close: () => {},
        handleInput: () => { /* 只读镜像：忽略输入 */ },
      },
    });
    this.terminal.show(true);
  }
  write(s) {
    this._emitter.fire(String(s).replace(/\r?\n/g, "\r\n"));
  }
  line(s) {
    this.write(s + "\n");
  }
  dispose() {
    try { this.terminal.dispose(); } catch { /* ignore */ }
    this._emitter.dispose();
  }
}

class NativeBridge {
  constructor(context, sessionClient, chatView, output) {
    this.context = context;
    this.sessionClient = sessionClient;
    this.chatView = chatView;
    this.output = output;
    this._assistantBuf = new Map(); // sessionId -> Map<index, text>
    this._mirror = null;
  }

  /** 每个 ServerRequest 进来（mux + host 统一）。 */
  handleServerRequest(msg) {
    const frame = msg.payload;
    if (!frame || typeof frame !== "object") return;
    switch (frame.type) {
      case "session/event":
        this.handleSessionEvent(frame);
        break;
      case "session/subscribed":
        break;
      case "approval/requested":
        this.handleApproval(msg);
        break;
      case "approval/resolved":
        break;
      case "question/requested":
        this.handleQuestion(msg);
        break;
      case "question/resolved":
        break;
      case "session/queue":
      case "session/jobs":
      case "session/projection":
        break;
      case "stream/error":
        this.chatView.post({ type: "error", message: (frame.error && frame.error.message) || "事件流错误" });
        break;
      default:
        break;
    }
  }

  /** 新版 follow 流：直接投递裸会话事件（无 frame 包装）。 */
  handleEvent(sessionId, event) {
    if (!event || typeof event !== "object") return;
    this.handleSessionEvent({ sessionId, event });
  }

  handleSessionEvent(frame) {
    const { event, view } = frame;
    const d = event.data;
    switch (event.type) {
      case "turn/start":
        this.chatView.post({ type: "status", state: "", label: "正在运行…" });
        break;
      case "assistant/chunk": {
        const c = d.chunk;
        if (c && c.type === "text-delta") {
          let buf = this._assistantBuf.get(frame.sessionId);
          if (!buf) {
            buf = new Map();
            this._assistantBuf.set(frame.sessionId, buf);
          }
          buf.set(c.index, (buf.get(c.index) || "") + c.text);
          const text = [...buf.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, t]) => t)
            .join("");
          this.chatView.post({ type: "assistantDelta", text });
        }
        break;
      }
      case "assistant/message": {
        const prov = d.message && d.message.provenance;
        this.chatView.post({ type: "assistantDone", model: (prov && prov.model) || undefined });
        break;
      }
      case "tool/call": {
        let args = {};
        try { args = JSON.parse(d.arguments); } catch { /* raw string kept */ }
        const t = this._callView(d, view);
        if (t.path) this._reveal(t.path);
        this.chatView.post({ type: "toolCall", tool: t });
        this.chatView.post({ type: "currentAction", tool: { name: t.name, path: t.path, kind: t.kind } });
        break;
      }
      case "tool/result": {
        const r = this._resultView(d, view);
        if (r.diffs && r.diffs.length) this._applyDiffs(r.diffs);
        if (r.terminal) this._mirrorTerminal(r.terminal);
        // 打包预览：扫描结果文本与终端输出中的产物路径
        const hay = [
          d.message && d.message.content ? JSON.stringify(d.message.content) : "",
          r.terminal && r.terminal.output ? r.terminal.output : "",
        ].join("\n");
        for (const art of this._detectArtifacts(hay)) {
          this.chatView.post({ type: "artifact", artifact: art });
        }
        this.chatView.post({ type: "toolResult", tool: { state: "完成" } });
        break;
      }
      case "todo/write":
        this.chatView.post({ type: "todos", todos: (d && d.todos) || [] });
        break;
      case "turn/end":
        this.chatView.post({ type: "status", state: "ok", label: "空闲" });
        break;
      default:
        break;
    }
  }

  /** tool/call → 展示视图。 */
  _callView(d, view) {
    let title = d.name;
    let kind = "other";
    let pathText = "";
    let detail = "";
    const args = (() => { try { return JSON.parse(d.arguments); } catch { return {}; } })();
    if (view && view.for === "call" && view.view) {
      const v = view.view;
      title = v.title || title;
      if (v.card === "diff") {
        kind = "edit";
        const loc = v.locations && v.locations[0];
        if (loc) pathText = loc.path;
        detail = this._diffHtml(v.diffs);
      } else if (v.card === "terminal") {
        kind = "execute";
        if (v.cwd) pathText = v.cwd;
      } else if (v.card === "generic") {
        kind = v.kind || "other";
        if (v.locations && v.locations[0]) pathText = v.locations[0].path;
      }
    }
    if (!pathText && args.file_path) pathText = args.file_path;
    if (!pathText && args.path) pathText = args.path;
    if (!detail && pathText) detail = escapeHtml(d.name + " " + pathText);
    return { name: title, path: pathText, state: "运行中", detail };
  }

  /** tool/result → 提取 diffs / terminal 呈现。 */
  _resultView(d, view) {
    let diffs = null;
    let terminal = null;
    if (view && view.for === "result" && view.view) {
      const v = view.view;
      if (v.card === "diff") diffs = v.diffs;
      if (v.card === "terminal") terminal = v;
    }
    if (!diffs && d.meta && Array.isArray(d.meta.diffs)) diffs = d.meta.diffs;
    return { diffs, terminal };
  }

  _diffHtml(diffs) {
    if (!diffs || !diffs.length) return "";
    const parts = diffs.slice(0, 3).map((fd) => {
      const oldT = fd.oldText === null ? "" : fd.oldText;
      return '<div class="code">' + escapeHtml(fd.path) +
        "\n- " + escapeHtml(oldT.split("\n").slice(0, 8).join("\n")) +
        "\n+ " + escapeHtml(fd.newText.split("\n").slice(0, 12).join("\n")) + "</div>";
    });
    return parts.join("");
  }

  _workspaceUri() {
    const f = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    return f ? f.uri : null;
  }

  _resolveUri(p) {
    if (path.isAbsolute(p)) return vscode.Uri.file(p);
    const ws = this._workspaceUri();
    if (ws) return vscode.Uri.joinPath(ws, p);
    return vscode.Uri.file(p);
  }

  /** 打开/聚焦文件（tool/call 跟随）。 */
  async _reveal(p) {
    try {
      const uri = this._resolveUri(p);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (e) {
      this.output.appendLine("[reveal] " + e.message);
    }
  }

  /** 把已应用的写文件 diff 反映到打开的编辑器（可撤销、进 SCM）。 */
  async _applyDiffs(diffs) {
    for (const diff of diffs) {
      try {
        const uri = this._resolveUri(diff.path);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        if (diff.oldText === null) {
          // 新建文件：磁盘已是新内容，打开即显示；无需编辑
          continue;
        }
        const text = doc.getText();
        const idx = text.indexOf(diff.oldText);
        if (idx >= 0) {
          const start = doc.positionAt(idx);
          const end = doc.positionAt(idx + diff.oldText.length);
          const edit = new vscode.WorkspaceEdit();
          edit.replace(uri, new vscode.Range(start, end), diff.newText);
          await vscode.workspace.applyEdit(edit);
          this.output.appendLine("[editor] 已应用变更: " + diff.path);
        }
      } catch (e) {
        this.output.appendLine("[applyDiff] " + e.message);
      }
    }
  }

  /** 命令可见性：只读镜像终端展示 dsh 已执行的命令与输出。 */
  _mirrorTerminal(v) {
    if (!this._mirror) this._mirror = new MirrorTerminal("DSH 命令");
    this._mirror.line("── DSH 执行命令 ──────────────────────────────");
    if (v.cwd) this._mirror.line("$ cd " + v.cwd);
    if (v.title) this._mirror.line("$ " + v.title);
    if (v.output) this._mirror.write(v.output);
    this._mirror.line("");
    this._mirror.line("└ exit " + (v.exitCode !== undefined ? v.exitCode : (v.signal || "?")) + "（执行于 dsh 沙箱）");
  }

  /** 打包预览：从文本中提取存在的构建产物路径（.vsix/.exe/...）。 */
  _detectArtifacts(text) {
    if (!text) return [];
    const found = [];
    const seen = new Set();
    for (const m of String(text).matchAll(ARTIFACT_RE)) {
      let p = m[0].trim().replace(/["')\],;:]+$/, "");
      if (!p || seen.has(p)) continue;
      let uri;
      try { uri = this._resolveUri(p); } catch { continue; }
      if (uri && fs.existsSync(uri.fsPath)) {
        seen.add(p);
        found.push({ path: p, label: path.basename(p) });
      }
    }
    return found;
  }

  /** 审批：原生确认框 → respond。 */
  async handleApproval(msg) {
    const frame = msg.payload;
    const cfg = vscode.workspace.getConfiguration("dsh");
    const auto = !cfg.get("approveCommands", true);
    let allowed = auto;
    if (!auto) {
      const detail = [
        frame.reason ? "原因: " + frame.reason : "",
        frame.toolName ? "工具: " + frame.toolName : "",
      ].filter(Boolean).join("\n");
      allowed = (await vscode.window.showWarningMessage(
        "DSH 请求执行操作" + (detail ? "\n" + detail : ""),
        { modal: true },
        "允许一次",
        "拒绝"
      )) === "允许一次";
    }
    try {
      await this.sessionClient.respond(msg.rpcId, {
        sessionId: frame.sessionId,
        approvalId: frame.approvalId,
        outcome: allowed ? "allowed-once" : "rejected",
      });
    } catch (e) {
      this.output.appendLine("[approval respond] " + e.message);
    }
  }

  /** 提问：原生 QuickPick → respond。 */
  async handleQuestion(msg) {
    const frame = msg.payload;
    const answers = [];
    try {
      for (const item of frame.questions || []) {
        const opts = (item.options || []).map((o) => ({ label: o.label, description: o.description }));
        if (!opts.length) opts.push({ label: "确定" });
        const picked = await vscode.window.showQuickPick(opts, {
          placeHolder: item.question,
          canPickMany: !!item.multiSelect,
          ignoreFocusOut: true,
        });
        const sel = picked ? (Array.isArray(picked) ? picked : [picked]) : [];
        answers.push({ id: item.id, selected: sel.map((p) => p.label) });
      }
      await this.sessionClient.respond(msg.rpcId, {
        sessionId: frame.sessionId,
        answer: { answers },
      });
    } catch (e) {
      this.output.appendLine("[question] " + e.message);
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

module.exports = { NativeBridge, MirrorTerminal };
