"use strict";
/**
 * session-client.js — DSH 会话客户端（双模：适配新旧两种 dsh 协议）。
 *
 * 新版（dsh 0.1.2-rc.1+，Typert gateway 架构）：
 *   - 认证：RuntimeProcess 用启动令牌换取 Cookie，HTTP/WS 都需带上
 *   - unary：POST /api/<命名空间>/<方法>，body = {type:'client-request', rpcId, method, payload:{args:{具名参数}}}
 *   - 流：单条 mux ws://…/api/remote.mux，发 {type:'open', streamId, endpoint, payload:{args}}
 *         接收 {type:'item'|'error', streamId, …}
 *   - 会话事件流：endpoint `session/follow`（先 snapshot 快照，随后逐条 event）
 *
 * 旧版（0.1.0-rc.7 及以前）：
 *   - unary：POST /api/<方法>，payload = 业务参数
 *   - 双 WebSocket：/api/events.mux、/api/events.host
 *
 * connect() 时自动探测，两种都能用。
 */
const WebSocket = require("ws");
const { randomUUID } = require("node:crypto");

class SessionClient {
  constructor(runtime) {
    this.runtime = runtime;
    this.mode = null; // "new" | "old"
    this._onServerRequest = null;
    this._onLog = null;
    this._sockets = [];
    this._mux = null;
    this._streams = new Map(); // streamId -> { onItem, onError }
  }

  get baseUrl() {
    return this.runtime.url.replace(/\/$/, "");
  }

  _log(line) {
    if (this._onLog) this._onLog(line);
  }

  _authHeaders(extra) {
    const h = { ...(extra || {}) };
    if (this.runtime && this.runtime.cookie) h.cookie = this.runtime.cookie;
    return h;
  }

  // ---------- unary ----------

  /** 新版：POST /api/<ns>/<method>，payload = {args:{…}}。 */
  async _rpcNew(endpoint, args) {
    const rpcId = randomUUID();
    const body = { type: "client-request", rpcId, method: endpoint, payload: { args: args || {} } };
    const res = await fetch(this.baseUrl + "/api/" + endpoint, {
      method: "POST",
      headers: this._authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (res.status === 401) throw new Error("401: /api 需要认证（令牌/Cookie 未生效）");
    if (res.status === 404) throw new Error("404: 未知方法 " + endpoint);
    if (!res.ok) throw new Error("HTTP " + res.status + " on /api/" + endpoint);
    const env = await res.json();
    if (!env || env.type !== "server-response") throw new Error("响应信封异常: " + (env && env.type));
    return this._unwrap(env, rpcId, endpoint);
  }

  /** 旧版：POST /api/<method>，payload = 业务参数。 */
  async _rpcOld(method, payload) {
    const rpcId = randomUUID();
    const body = { type: "client-request", rpcId, method, payload };
    const res = await fetch(this.baseUrl + "/api/" + method, {
      method: "POST",
      headers: this._authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (res.status === 401) throw new Error("401: /api 需要认证（令牌/Cookie 未生效）");
    if (res.status === 415) throw new Error("415: /api 要求 Content-Type: application/json");
    if (res.status === 403) throw new Error("403: /api 信任围栏拒绝（需 loopback Host）");
    if (res.status === 404) throw new Error("404: 未知方法 " + method);
    if (!res.ok) throw new Error("HTTP " + res.status + " on /api/" + method);
    const env = await res.json();
    if (!env || env.type !== "server-response") throw new Error("响应信封异常: " + (env && env.type));
    return this._unwrap(env, rpcId, method);
  }

  _unwrap(env, rpcId, label) {
    if (env.rpcId !== rpcId) throw new Error("rpcId 回显不匹配: " + env.rpcId + " != " + rpcId);
    if (!env.result || !env.result.ok) {
      const err = (env.result && env.result.error) || {};
      const e = new Error((err.code || "error") + ": " + (err.message || "unknown"));
      e.code = err.code;
      e.details = err.details;
      throw e;
    }
    return env.result.value;
  }

  /** 应答 ServerRequest（旧版审批/提问用）：POST /api/respond。 */
  async respond(rpcId, value) {
    const body = { type: "client-response", rpcId, result: { ok: true, value } };
    const res = await fetch(this.baseUrl + "/api/respond", {
      method: "POST",
      headers: this._authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (res.status === 401) throw new Error("401: /api/respond 需要认证");
    if (!res.ok) throw new Error("HTTP " + res.status + " on /api/respond");
    return res.json();
  }

  // ---------- 连接与探测 ----------

  /** 先按新版连 mux 并探测；失败则退回旧版双 WebSocket。 */
  async connect() {
    try {
      await this._connectMux();
      // 探测新版权限/端点：session/list
      await this._rpcNew("session/list", { _request: {} });
      this.mode = "new";
      this._log("协议：新版（Typert gateway / session.follow）");
      return;
    } catch (e) {
      this._log("新版探测未通过（" + e.message + "），回退旧版协议");
      try { this._closeMux(); } catch { /* ignore */ }
    }
    await this._connectOldStreams();
    this.mode = "old";
    this._log("协议：旧版（/api/events.mux + events.host）");
  }

  _connectMux() {
    return new Promise((resolve, reject) => {
      const opts = { perMessageDeflate: false };
      if (this.runtime.cookie) opts.headers = { cookie: this.runtime.cookie };
      const ws = new WebSocket("ws://127.0.0.1:" + this.runtime.port + "/api/remote.mux", opts);
      this._sockets.push(ws);
      this._mux = ws;
      const timer = setTimeout(() => reject(new Error("mux 连接超时")), 8000);
      ws.on("open", () => {
        clearTimeout(timer);
        this._log("[ws open] /api/remote.mux");
        resolve(ws);
      });
      ws.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      ws.on("unexpected-response", (_q, r) => {
        clearTimeout(timer);
        reject(new Error("mux 升级被拒 HTTP " + r.statusCode));
      });
      ws.on("message", (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        const entry = this._streams.get(msg.streamId);
        if (!entry) return;
        if (msg.type === "error") {
          if (entry.onError) entry.onError(msg.error || {});
        } else if (entry.onItem) {
          entry.onItem(msg);
        }
      });
      ws.on("close", () => this._log("[ws closed] /api/remote.mux"));
    });
  }

  _closeMux() {
    if (this._mux) {
      try { this._mux.close(); } catch { /* ignore */ }
      this._mux = null;
    }
  }

  /** 旧版双下行流。 */
  async _connectOldStreams() {
    const open = (path) =>
      new Promise((resolve, reject) => {
        const opts = { perMessageDeflate: false };
        if (this.runtime.cookie) opts.headers = { cookie: this.runtime.cookie };
        const ws = new WebSocket("ws://127.0.0.1:" + this.runtime.port + path, opts);
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
          let msg;
          try {
            msg = JSON.parse(data.toString());
          } catch {
            return;
          }
          if (msg && msg.type === "server-request" && this._onServerRequest) this._onServerRequest(msg);
        });
        ws.on("close", () => this._log("[ws closed] " + path));
      });
    await open("/api/events.mux");
    await open("/api/events.host");
  }

  // ---------- 新版流 ----------

  /** 打开一条 mux 逻辑流。 */
  openStream(endpoint, args, handlers) {
    if (!this._mux || this._mux.readyState !== WebSocket.OPEN) throw new Error("mux 未连接");
    const streamId = "st-" + randomUUID();
    this._streams.set(streamId, handlers || {});
    this._mux.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args: args || {} } }));
    return {
      streamId,
      close: () => {
        this._streams.delete(streamId);
        try {
          if (this._mux && this._mux.readyState === WebSocket.OPEN) {
            this._mux.send(JSON.stringify({ type: "cancel", streamId }));
          }
        } catch { /* ignore */ }
      },
    };
  }

  /**
   * 跟随一个会话：先收到 snapshot（含历史记录），随后逐条收到新事件。
   * @returns {{streamId:string, close:Function}}
   */
  followSession(sessionId, { onSnapshot, onEvent, onError, maxMessages = 200 } = {}) {
    const address = { kind: "session", sessionId };
    return this.openStream("session/follow", { request: { address, maxMessages } }, {
      onItem: (msg) => {
        const frame = msg.value !== undefined ? msg.value : msg.item;
        if (!frame || typeof frame !== "object") return;
        if (frame.type === "snapshot") {
          if (onSnapshot) onSnapshot(frame);
        } else if (frame.type === "event") {
          if (onEvent) onEvent(frame.event);
        }
      },
      onError: (err) => {
        if (onError) onError(err);
      },
    });
  }

  // ---------- 业务方法（双模） ----------

  async sessionList() {
    if (this.mode === "new") return this._rpcNew("session/list", { _request: {} });
    return this._rpcOld("session.list", {});
  }

  async sessionCreate(args) {
    if (this.mode === "new") return this._rpcNew("session/create", { request: args || {} });
    return this._rpcOld("session.create", args || {});
  }

  async sessionPrompt({ sessionId, content, mode = "queue" }) {
    if (this.mode === "new") {
      return this._rpcNew("session/prompt", {
        request: { requestId: randomUUID(), sessionId, mode, content },
      });
    }
    return this._rpcOld("session.prompt", { sessionId, mode, content });
  }

  async sessionCancel(sessionId) {
    if (this.mode === "new") return this._rpcNew("session/cancel", { request: { sessionId } });
    return this._rpcOld("session.cancel", { sessionId });
  }

  /** 读取历史（新版走 session/page；旧版走 session.history）。 */
  async sessionHistory({ sessionId, maxMessages = 100, throughSeq, beforeSeq } = {}) {
    if (this.mode === "new") {
      const request = { address: { kind: "session", sessionId }, throughSeq: throughSeq === undefined ? 1e15 : throughSeq, maxMessages };
      if (beforeSeq !== undefined) request.beforeSeq = beforeSeq;
      return this._rpcNew("session/page", { request });
    }
    return this._rpcOld("session.history", { sessionId, maxMessages });
  }

  async credentialsSet(ref, value) {
    if (this.mode === "new") return this._rpcNew("credentials/set", { request: { ref, value } });
    return this._rpcOld("credentials.set", { ref, value });
  }

  async credentialsDescribe(refs) {
    if (this.mode === "new") return this._rpcNew("credentials/describe", { request: { refs } });
    return this._rpcOld("credentials.describe", { refs });
  }

  // ---------- 事件回调（旧版用） ----------

  onServerRequest(cb) {
    this._onServerRequest = cb;
  }

  onLog(cb) {
    this._onLog = cb;
  }

  dispose() {
    for (const ws of this._sockets) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this._sockets = [];
    this._mux = null;
    this._streams.clear();
  }
}

module.exports = { SessionClient };
