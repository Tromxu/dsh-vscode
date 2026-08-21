"use strict";
/**
 * session-client.js — DSH 会话客户端（完整实现）。
 *
 * 依据 docs/protocol-rpc.md 与 api 域契约（dsh-host-apiproxy/lib/types/api/*.d.ts）：
 *   - unary: POST /api/<method>，body = ClientRequest {type:'client-request', rpcId, method, payload}
 *            响应 = ServerResponse {type:'server-response', rpcId, result: RpcResult}
 *   - 应答:  POST /api/respond，body = ClientResponse {type:'client-response', rpcId, result}
 *            响应体 = RpcReceipt {accepted} | {accepted:false, reason}
 *   - 下行:  ws://127.0.0.1:<port>/api/events.mux 与 /api/events.host，每帧 = ServerRequest
 *            {type:'server-request', rpcId, method, payload}（JSON 文本帧，只下行）
 *   - 信任围栏: loopback Host 即通过；Node 客户端默认 Host 头即可，勿发 cross-site 标记
 */
const WebSocket = require("ws"); // vendored from DSH runtime（见 scripts/package.ps1）
const { randomUUID } = require("node:crypto");

class SessionClient {
  constructor(runtime) {
    this.runtime = runtime;
    this._onServerRequest = null; // cb(serverRequest) — mux + host 统一回调
    this._onLog = null;
    this._sockets = [];
  }

  get baseUrl() {
    return this.runtime.url.replace(/\/$/, "");
  }

  _log(line) {
    if (this._onLog) this._onLog(line);
  }

  _nextId() {
    return randomUUID();
  }

  /** unary RPC：POST /api/<method>，信封校验 + rpcId 回显校验，返回 result.value；业务错误抛 RpcError。 */
  async _rpc(method, payload) {
    const rpcId = this._nextId();
    const body = { type: "client-request", rpcId, method, payload };
    this._log("[rpc] -> " + method + " " + JSON.stringify(payload).slice(0, 200));
    const res = await fetch(this.baseUrl + "/api/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 415) throw new Error("415: /api 要求 Content-Type: application/json");
    if (res.status === 403) throw new Error("403: /api 信任围栏拒绝（需 loopback Host）");
    if (res.status === 404) throw new Error("404: 未知方法 " + method);
    if (!res.ok) throw new Error("HTTP " + res.status + " on /api/" + method);
    const env = await res.json();
    if (!env || env.type !== "server-response") throw new Error("响应信封异常: " + (env && env.type));
    if (env.rpcId !== rpcId) throw new Error("rpcId 回显不匹配: " + env.rpcId + " != " + rpcId);
    if (!env.result || !env.result.ok) {
      const err = (env.result && env.result.error) || {};
      const e = new Error((err.code || "error") + ": " + (err.message || "unknown"));
      e.code = err.code;
      e.details = err.details;
      throw e;
    }
    this._log("[rpc] <- " + method + " ok");
    return env.result.value;
  }

  /** 应答 ServerRequest（approval/question requested）：POST /api/respond，返回 RpcReceipt。 */
  async respond(rpcId, value) {
    const body = { type: "client-response", rpcId, result: { ok: true, value } };
    const res = await fetch(this.baseUrl + "/api/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("HTTP " + res.status + " on /api/respond");
    return res.json();
  }

  /** 打开两条 WebSocket 下行流。 */
  async connect() {
    const open = (path) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket("ws://127.0.0.1:" + this.runtime.port + path, { perMessageDeflate: false });
        this._sockets.push(ws);
        ws.on("open", () => {
          this._log("[ws open] " + path);
          resolve(ws);
        });
        ws.on("error", (e) => {
          this._log("[ws error " + path + "] " + e.message);
          reject(e);
        });
        ws.on("message", (data) => {
          const text = typeof data === "string" ? data : data.toString();
          let msg;
          try {
            msg = JSON.parse(text);
          } catch {
            this._log("[ws:" + path + "] 非 JSON 帧: " + text.slice(0, 200));
            return;
          }
          if (!msg || msg.type !== "server-request") {
            this._log("[ws:" + path + "] 非 server-request: " + text.slice(0, 200));
            return;
          }
          if (this._onServerRequest) this._onServerRequest(msg);
        });
        ws.on("close", () => this._log("[ws closed] " + path));
      });
    await open("/api/events.mux");
    await open("/api/events.host");
    this._log("WebSocket downlinks connected");
  }

  onServerRequest(cb) {
    this._onServerRequest = cb;
  }

  onLog(cb) {
    this._onLog = cb;
  }

  // ---- 域方法 ----
  hostDescribe() {
    return this._rpc("host.describe", {});
  }
  workspaceCreate(path) {
    return this._rpc("workspace.create", { path });
  }
  sessionCreate(args) {
    return this._rpc("session.create", args);
  }
  sessionPrompt(args) {
    return this._rpc("session.prompt", args);
  }
  sessionCancel(sessionId) {
    return this._rpc("session.cancel", { sessionId });
  }
  sessionHistory(args) {
    return this._rpc("session.history", args);
  }
  sessionList() {
    return this._rpc("session.list", {});
  }
  credentialsSet(ref, value) {
    return this._rpc("credentials.set", { ref, value });
  }
  credentialsDescribe(refs) {
    return this._rpc("credentials.describe", { refs });
  }

  dispose() {
    for (const ws of this._sockets) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this._sockets = [];
  }
}

module.exports = { SessionClient };
