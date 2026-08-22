"use strict";
/**
 * chat-webview.js — 侧边栏智能体会话 UI（软件交付工作台）。
 *
 * 内部消息协议（webview <-> 扩展宿主，经 postMessage）：
 *   宿主 -> webview: init | status | assistantDelta | assistantDone |
 *                    toolCall | toolResult | question | approval | error |
 *                    todos | currentAction | artifact | stage
 *   webview -> 宿主: send | stop | respond | openArtifact
 *
 * 进度面板：todo/write 事件 → 进度条 + 任务列表；tool/call → 当前动作；
 *           构建产物（.vsix/.exe/...）→ 可点击打开（打包预览）。
 */
const vscode = require("vscode");

const CSS = `
:root { --bg: var(--vscode-sideBar-background); --fg: var(--vscode-sideBar-foreground);
  --border: var(--vscode-panel-border, #333); --accent: var(--vscode-button-background, #1f6feb);
  --accent-fg: var(--vscode-button-foreground, #fff); --muted: var(--vscode-descriptionForeground, #999);
  --card: var(--vscode-editorWidget-background, #1c2128); --user: #0b3a5c;
  --ok: #3fb950; --run: #e3b341; --bad: #f85149; }
* { box-sizing: border-box; }
html,body { margin:0; height:100%; background:var(--bg); color:var(--fg); font-family:var(--vscode-font-family); font-size:13px; }
#root { display:flex; flex-direction:column; height:100%; }
header { display:flex; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid var(--border); flex:none; }
header .title { font-weight:600; font-size:12px; }
#statusDot { width:8px; height:8px; border-radius:50%; background:var(--run); flex:none; }
#statusDot.ok { background:var(--ok); } #statusDot.bad { background:var(--bad); }
#model { color:var(--muted); font-size:11px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#workspace { color:var(--muted); font-size:11px; max-width:40%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; flex:none; }
#workspace:hover { color:var(--fg); }
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

/* ---- 进度面板 ---- */
#progress { flex:none; border-bottom:1px solid var(--border); padding:8px 10px; display:flex; flex-direction:column; gap:6px; background:var(--card); }
#progress .p-row { display:flex; align-items:center; gap:8px; }
#progress .p-label { font-size:11px; color:var(--muted); flex:none; }
#progress .p-bar { flex:1; height:6px; border-radius:3px; background:var(--border); overflow:hidden; }
#progress .p-fill { height:100%; width:0; background:var(--accent); transition:width .25s ease; }
#progress .p-count { font-size:11px; color:var(--muted); flex:none; }
#progress .p-section { font-size:10px; color:var(--muted); letter-spacing:.5px; text-transform:uppercase; margin-top:4px; }
#todoList { display:flex; flex-direction:column; gap:2px; max-height:140px; overflow-y:auto; }
.todo { display:flex; align-items:center; gap:6px; font-size:12px; padding:2px 4px; border-radius:4px; }
.todo .ic { flex:none; width:14px; text-align:center; }
.todo .ic.pending { color:var(--muted); }
.todo .ic.running { color:var(--run); }
.todo .ic.done { color:var(--ok); }
.todo .txt { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.todo.running { background:rgba(227,179,65,.08); }
#actionRow { display:flex; align-items:center; gap:6px; font-size:12px; padding:2px 4px; }
#actionRow .spinner { flex:none; width:10px; height:10px; border-radius:50%; border:2px solid var(--border); border-top-color:var(--run); animation:spin .8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
#actionRow .act-path { color:var(--muted); font-family:var(--vscode-editor-font-family); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#artifactList { display:flex; flex-direction:column; gap:4px; }
.artifact { display:flex; align-items:center; gap:6px; border:1px solid var(--ok); border-radius:6px; padding:4px 8px; font-size:12px; }
.artifact .ic { flex:none; }
.artifact .a-path { flex:1; font-family:var(--vscode-editor-font-family); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--fg); }
.artifact button { flex:none; padding:2px 8px; font-size:11px; }
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
    <span id="workspace" title="工程位置（点击打开）"></span>
    <button id="stopBtn" class="ghost" disabled title="停止当前回合">停止</button>
  </header>
  <div id="progress" class="hidden">
    <div class="p-row">
      <span class="p-label">进度</span>
      <div class="p-bar"><div class="p-fill" id="pFill"></div></div>
      <span class="p-count" id="pCount"></span>
    </div>
    <div id="todoList"></div>
    <div class="p-section" id="actionTitle" class="hidden">当前动作</div>
    <div id="actionRow" class="hidden"><div class="spinner"></div><span id="actionText">…</span><span class="act-path" id="actionPath"></span></div>
    <div class="p-section" id="artifactTitle" class="hidden">打包产物</div>
    <div id="artifactList"></div>
  </div>
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
  const statusDot = $("statusDot"), model = $("model"), workspaceEl = $("workspace");
  let busy = false;
  const artifactSeen = new Set();

  workspaceEl.onclick = () => vscode.postMessage({ type: "openWorkspace" });

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

  // ---- 进度面板 ----
  function renderTodos(todos) {
    const list = $("todoList");
    list.innerHTML = "";
    if (!todos || !todos.length) { $("progress").classList.add("hidden"); return; }
    $("progress").classList.remove("hidden");
    const done = todos.filter((t) => t.status === "completed").length;
    $("pFill").style.width = Math.round((done / todos.length) * 100) + "%";
    $("pCount").textContent = done + "/" + todos.length;
    todos.forEach((t) => {
      const row = document.createElement("div");
      row.className = "todo" + (t.status === "in_progress" ? " running" : "");
      const ic = document.createElement("span"); ic.className = "ic " +
        (t.status === "completed" ? "done" : t.status === "in_progress" ? "running" : "pending");
      ic.textContent = t.status === "completed" ? "✓" : t.status === "in_progress" ? "▶" : "○";
      const txt = document.createElement("span"); txt.className = "txt";
      txt.textContent = t.content; txt.title = t.content;
      row.appendChild(ic); row.appendChild(txt);
      list.appendChild(row);
    });
  }
  function setCurrentAction(tool) {
    $("actionTitle").classList.remove("hidden");
    $("actionRow").classList.remove("hidden");
    $("actionText").textContent = (tool && tool.name) || "…";
    $("actionPath").textContent = (tool && tool.path) || "";
    $("actionRow").title = (tool && tool.path) || "";
  }
  function addArtifact(a) {
    if (artifactSeen.has(a.path)) return;
    artifactSeen.add(a.path);
    $("progress").classList.remove("hidden");
    $("artifactTitle").classList.remove("hidden");
    const row = document.createElement("div");
    row.className = "artifact";
    const ic = document.createElement("span"); ic.className = "ic"; ic.textContent = "📦";
    const p = document.createElement("span"); p.className = "a-path";
    p.textContent = (a.label ? a.label + " · " : "") + a.path; p.title = a.path;
    const btn = document.createElement("button");
    btn.textContent = "打开";
    btn.onclick = () => vscode.postMessage({ type: "openArtifact", path: a.path });
    row.appendChild(ic); row.appendChild(p); row.appendChild(btn);
    $("artifactList").appendChild(row);
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    switch (m.type) {
      case "init": setStatus(m.state || "", m.model || ""); break;
      case "status": setStatus(m.state, m.label || m.model); break;
      case "workspace": workspaceEl.textContent = m.path || ""; workspaceEl.title = "工程位置：" + (m.path || "") + "（点击打开）"; break;
      case "history": {
        // 恢复历史会话：清空当前消息区并重放
        messages.querySelectorAll(".msg, .card").forEach((el) => el.remove());
        $("empty") && $("empty").remove();
        (m.messages || []).forEach((msg) => {
          if (msg.role === "user") addUser(msg.text);
          else addAssistant(msg.text, false);
        });
        break;
      }
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
      case "todos": renderTodos(m.todos); break;
      case "currentAction": setCurrentAction(m.tool); break;
      case "artifact": addArtifact(m.artifact); break;
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
