"use strict";
/**
 * chat-webview.js — 侧边栏智能体会话 UI（Cline 风格）。
 *
 * 内部消息协议（webview <-> 扩展宿主，经 postMessage）：
 *   宿主 -> webview: init | status | assistantDelta | assistantDone |
 *                    toolCall | toolResult | question | approval | error | history
 *   webview -> 宿主: send | stop | respond | approve | deny
 *
 * 注意：这里只做 UI 与消息协议，DSH 会话事件如何映射到这些消息由 bridge.js 负责。
 */
const vscode = require("vscode");

const CSS = `
:root { --bg: var(--vscode-sideBar-background); --fg: var(--vscode-sideBar-foreground);
  --border: var(--vscode-panel-border, #333); --accent: var(--vscode-button-background, #1f6feb);
  --accent-fg: var(--vscode-button-foreground, #fff); --muted: var(--vscode-descriptionForeground, #999);
  --card: var(--vscode-editorWidget-background, #1c2128); --user: #0b3a5c; }
* { box-sizing: border-box; }
html,body { margin:0; height:100%; background:var(--bg); color:var(--fg); font-family:var(--vscode-font-family); font-size:13px; }
#root { display:flex; flex-direction:column; height:100%; }
header { display:flex; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid var(--border); flex:none; }
header .title { font-weight:600; font-size:12px; }
#statusDot { width:8px; height:8px; border-radius:50%; background:#e3b341; flex:none; }
#statusDot.ok { background:#3fb950; } #statusDot.bad { background:#f85149; }
#model { color:var(--muted); font-size:11px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
button { background:var(--accent); color:var(--accent-fg); border:0; border-radius:4px; padding:4px 10px; cursor:pointer; font-size:12px; }
button.ghost { background:transparent; border:1px solid var(--border); color:var(--fg); }
button:disabled { opacity:.5; cursor:default; }
#messages { flex:1; overflow-y:auto; padding:10px; display:flex; flex-direction:column; gap:8px; }
.msg { max-width:96%; padding:8px 10px; border-radius:8px; white-space:pre-wrap; word-break:break-word; line-height:1.5; }
.msg.user { align-self:flex-end; background:var(--user); color:#e6f3ff; }
.msg.assistant { align-self:flex-start; background:var(--card); border:1px solid var(--border); }
.msg .meta { font-size:10px; color:var(--muted); margin-bottom:4px; }
.card { border:1px solid var(--border); border-radius:8px; background:var(--card); overflow:hidden; }
.card .head { display:flex; align-items:center; gap:8px; padding:6px 10px; cursor:pointer; font-size:12px; }
.card .head .name { font-family:var(--vscode-editor-font-family); font-weight:600; }
.card .head .state { margin-left:auto; font-size:10px; color:var(--muted); }
.card .body { padding:8px 10px; border-top:1px solid var(--border); font-size:12px; white-space:pre-wrap; word-break:break-word; display:none; }
.card.open .body { display:block; }
.card .path { color:var(--muted); font-size:11px; font-family:var(--vscode-editor-font-family); }
.code { font-family:var(--vscode-editor-font-family); font-size:11px; background:#0d1117; color:#c9d1d9; border-radius:4px; padding:6px; margin-top:6px; overflow-x:auto; white-space:pre; }
.question-card { border:1px solid var(--accent); }
.question-card .actions { display:flex; gap:8px; padding:8px 10px; }
#composer { flex:none; border-top:1px solid var(--border); padding:8px; display:flex; gap:8px; align-items:flex-end; }
textarea { flex:1; resize:none; background:var(--card); color:var(--fg); border:1px solid var(--border); border-radius:6px; padding:8px; font-family:inherit; font-size:13px; min-height:38px; max-height:160px; }
#empty { color:var(--muted); text-align:center; padding:30px 16px; font-size:12px; line-height:1.8; }
.hidden { display:none !important; }
kbd { background:var(--card); border:1px solid var(--border); border-radius:3px; padding:0 4px; font-size:11px; }
`;

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function html() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: data:;">
<style>${CSS}</style></head><body>
<div id="root">
  <header>
    <div id="statusDot"></div>
    <span class="title">DSH Agent</span>
    <span id="model">未启动</span>
    <button id="stopBtn" class="ghost" disabled title="停止当前回合">停止</button>
  </header>
  <div id="messages"><div id="empty">在下方输入任务，DSH 智能体会在你的工作区里<br/>读代码 → 改文件 → 跑测试 → 修 bug，全程可见。<br/><br/>提示：<kbd>Enter</kbd> 发送，<kbd>Shift+Enter</kbd> 换行。</div></div>
  <div id="composer">
    <textarea id="input" placeholder="例如：修复 src 里的 bug 并运行测试直到通过" rows="1"></textarea>
    <button id="sendBtn">发送</button>
  </div>
</div>
<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const messages = $("messages"), input = $("input"), sendBtn = $("sendBtn"), stopBtn = $("stopBtn");
  const statusDot = $("statusDot"), model = $("model");
  let busy = false;

  function setStatus(state, label) {
    statusDot.className = state; // ok | bad | ''
    model.textContent = label || model.textContent;
  }
  function scrollDown() { messages.scrollTop = messages.scrollHeight; }
  function addUser(text) {
    $("empty") && $("empty").remove();
    const d = document.createElement("div");
    d.className = "msg user"; d.textContent = text;
    messages.appendChild(d); scrollDown();
  }
  function addAssistant(text, streaming) {
    $("empty") && $("empty").remove();
    let el = messages.lastElementChild;
    if (!streaming || !el || !el.classList.contains("assistant")) {
      el = document.createElement("div");
      el.className = "msg assistant"; el.dataset.meta = "DSH";
      const meta = document.createElement("div"); meta.className = "meta"; meta.textContent = "DSH";
      el.appendChild(meta); el.appendChild(document.createElement("span"));
      messages.appendChild(el);
    }
    el.lastElementChild.textContent = text;
    scrollDown();
  }
  function addToolCard(tool) {
    $("empty") && $("empty").remove();
    const card = document.createElement("div");
    card.className = "card";
    const head = document.createElement("div"); head.className = "head";
    head.innerHTML = '<span class="name">' + escapeHtml(tool.name || "tool") + '</span>' +
      (tool.path ? '<span class="path">' + escapeHtml(tool.path) + "</span>" : "") +
      '<span class="state">' + escapeHtml(tool.state || "…") + "</span>";
    const body = document.createElement("div"); body.className = "body";
    if (tool.detail) body.innerHTML = tool.detail; // 已转义或为代码块
    card.appendChild(head); card.appendChild(body);
    head.onclick = () => card.classList.toggle("open");
    messages.appendChild(card); scrollDown();
    return card;
  }
  function addQuestionCard(q) {
    const card = document.createElement("div");
    card.className = "card question-card";
    const head = document.createElement("div"); head.className = "head";
    head.innerHTML = '<span class="name">' + escapeHtml(q.title || "需要你确认") + "</span>";
    const body = document.createElement("div"); body.className = "body";
    body.innerHTML = escapeHtml(q.text || "").replace(/\\n/g, "<br>");
    if (q.detail) body.innerHTML += '<div class="code">' + escapeHtml(q.detail) + "</div>";
    const actions = document.createElement("div"); actions.className = "actions";
    (q.options || []).forEach((opt) => {
      const b = document.createElement("button");
      b.textContent = opt.label || opt;
      b.onclick = () => vscode.postMessage({ type: "respond", rpcId: q.rpcId, selected: opt.label || opt, custom: opt.custom || "" });
      actions.appendChild(b);
    });
    if (!q.options || !q.options.length) {
      const ok = document.createElement("button"); ok.textContent = "同意";
      ok.onclick = () => vscode.postMessage({ type: "respond", rpcId: q.rpcId, selected: "yes" });
      const no = document.createElement("button"); no.className = "ghost"; no.textContent = "拒绝";
      no.onclick = () => vscode.postMessage({ type: "respond", rpcId: q.rpcId, selected: "no" });
      actions.appendChild(ok); actions.appendChild(no);
    }
    card.appendChild(head); card.appendChild(body); card.appendChild(actions);
    messages.appendChild(card); scrollDown();
  }
  function setBusy(b) {
    busy = b; sendBtn.disabled = b; stopBtn.disabled = !b;
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    switch (m.type) {
      case "init": setStatus(m.state || "", m.model || ""); break;
      case "status": setStatus(m.state, m.label || m.model); break;
      case "assistantDelta": addAssistant(m.text, true); break;
      case "assistantDone": setBusy(false); setStatus("ok", m.model || model.textContent); break;
      case "toolCall": addToolCard(m.tool); break;
      case "toolResult": {
        const cards = messages.querySelectorAll(".card");
        const last = cards[cards.length - 1];
        if (last && last.querySelector(".head .name").textContent === (m.tool && m.tool.name)) {
          last.querySelector(".state").textContent = m.tool.state || "done";
        }
        break;
      }
      case "question": setBusy(true); addQuestionCard(m.question); break;
      case "error": setStatus("bad", "错误"); addAssistant("⚠ " + (m.message || "未知错误"), false); setBusy(false); break;
    }
  });

  sendBtn.onclick = send; stopBtn.onclick = () => vscode.postMessage({ type: "stop" });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px";
  });
  function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    addUser(text); input.value = ""; input.style.height = "auto";
    setBusy(true);
    vscode.postMessage({ type: "send", text });
  }
</script>
</body></html>`;
}

/** WebviewViewProvider：活动栏「会话」视图。 */
class ChatViewProvider {
  constructor() {
    this._view = null;
    this._pending = [];
  }
  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewView.webview.html = html();
    webviewView.webview.onDidReceiveMessage((m) => this._onMessage(m));
    // 把宿主侧排队的事件推给视图
    const pending = this._pending; this._pending = [];
    pending.forEach((m) => this.post(m));
    // 通知宿主：视图已打开（宿主据此自动启动运行时并推送连接状态）
    if (this._onViewOpen) this._onViewOpen();
  }
  _onMessage(m) {
    if (this._onHostMessage) this._onHostMessage(m);
  }
  /** 宿主 -> 视图 */
  post(msg) {
    if (this._view) this._view.webview.postMessage(msg);
    else this._pending.push(msg);
  }
  dispose() { this._view = null; }
}

module.exports = { ChatViewProvider };
