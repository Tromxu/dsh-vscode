"use strict";
/**
 * webview.js — 把 DSH Web GUI 嵌入 VS Code 面板。
 *
 * 做法：Webview 页面里放一个指向 http://127.0.0.1:<port>/ 的 iframe，
 * CSP 允许 frame-src http://127.0.0.1:*（本地回环被视为安全上下文）。
 * 面板顶部有一行状态条；服务未就绪时显示覆盖层，可「重新加载」或
 * 「在外部浏览器打开」（后者经由 postMessage 交给扩展宿主执行）。
 */
const vscode = require("vscode");

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createPanel(url, workspaceLabel, onOpenExternal) {
  const panel = vscode.window.createWebviewPanel(
    "dsh.agentPanel",
    "DSH Agent",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    }
  );

  const label = escapeHtml(workspaceLabel);
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: data:; frame-src http://127.0.0.1:*;">
<style>
  html,body{margin:0;height:100%;background:#101418;color:#cfd8e3;font-family:system-ui,sans-serif;}
  #wrap{position:fixed;inset:0;display:flex;flex-direction:column;}
  #bar{display:flex;align-items:center;gap:10px;padding:6px 12px;background:#161b22;border-bottom:1px solid #2a323c;font-size:12px;flex:none;}
  #bar .dot{width:8px;height:8px;border-radius:50%;background:#e3b341;flex:none;}
  #bar .dot.ok{background:#3fb950;}
  #bar .dot.bad{background:#f85149;}
  #bar span{color:#9aa7b4;}
  #frame-wrap{flex:1;position:relative;min-height:0;}
  iframe{position:absolute;inset:0;width:100%;height:100%;border:0;}
  #status{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:#101418;z-index:5;}
  #status.hidden{display:none;}
  button{background:#1f6feb;color:#fff;border:0;border-radius:6px;padding:8px 14px;cursor:pointer;font-size:13px;}
  button:hover{background:#388bfd;}
  button.ghost{background:transparent;border:1px solid #3d444d;}
  code{background:#1c2128;padding:2px 6px;border-radius:4px;color:#9ecbff;}
</style>
</head>
<body>
<div id="wrap">
  <div id="bar">
    <div class="dot" id="dot"></div>
    <span id="label">正在连接 DSH 服务…</span>
    <span style="flex:1"></span>
    <span>工作区: <code>${label}</code></span>
  </div>
  <div id="frame-wrap">
    <div id="status">
      <div>DSH 服务尚未就绪</div>
      <div style="display:flex;gap:10px;">
        <button id="reload">重新加载</button>
        <button id="open-ext" class="ghost">在外部浏览器打开</button>
      </div>
    </div>
    <iframe id="dsh" src="${escapeHtml(url)}" allow="clipboard-read; clipboard-write"></iframe>
  </div>
</div>
<script>
  const vscode = acquireVsCodeApi();
  const iframe = document.getElementById("dsh");
  const status = document.getElementById("status");
  const dot = document.getElementById("dot");
  const label = document.getElementById("label");
  iframe.addEventListener("load", () => {
    status.classList.add("hidden");
    dot.className = "dot ok";
    label.textContent = "DSH 已就绪";
  });
  iframe.addEventListener("error", () => {
    dot.className = "dot bad";
    label.textContent = "连接失败";
  });
  document.getElementById("reload").onclick = () => { iframe.src = iframe.src; };
  document.getElementById("open-ext").onclick = () => vscode.postMessage({ type: "openExternal" });
</script>
</body>
</html>`;

  panel.webview.html = html;
  panel.webview.onDidReceiveMessage((msg) => {
    if (msg && msg.type === "openExternal") onOpenExternal(url);
  });
  return panel;
}

module.exports = { createPanel };
