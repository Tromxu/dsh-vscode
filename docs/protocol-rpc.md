# dsh web 线协议规范（HTTP / WebSocket RPC）

> 适用范围：以独立 Node.js 客户端（如 VS Code 扩展）直接调用 dsh web 本地服务（`http://127.0.0.1:<port>/`）的会话 API。
> 本文内容全部逆向自 `D:\AI\DeepSeek Harness\resources\dsh\vendor\node_modules\@deepseek-ai\` 下已安装 npm 包的 `.d.ts` 类型声明与对应 `.js` 实现（纯阅读，未修改任何 vendor 文件）。每条结论都标注来源文件与行号。
>
> 速查：unary 调用 = `POST /api/<method>`，body 为 ClientRequest，响应为 ServerResponse（rpcId 回显）；问题/审批应答 = `POST /api/respond`，body 为 ClientResponse；两条只下行 WebSocket：`/api/events.mux`、`/api/events.host`，每帧是一个 ServerRequest 的 JSON 文本帧。

---

## 1. 总览：四象限 RPC 消息模型

信道（HTTP、WebSocket）与逻辑消息是解耦的：逻辑消息只有四种，构成一个按 `type` 判别的封闭联合（discriminated union），与物理信道无关。

| 消息 | `type` | 发起方 | 物理载体 | 说明 |
|---|---|---|---|---|
| `ClientRequest` | `client-request` | 客户端 | `POST /api/<method>` 的请求体 | unary 调用 |
| `ServerResponse` | `server-response` | 宿主 | 该 POST 的响应体 | 回显请求的 rpcId |
| `ServerRequest` | `server-request` | 宿主 | 下行流（WebSocket）帧 | 事件/审批/问题推送 |
| `ClientResponse` | `client-response` | 客户端 | `POST /api/respond` 的请求体 | 对可应答 ServerRequest 的答复 |

- 来源：`dsh-host-apiproxy/lib/types/api/rpc.d.ts:1-6`（“Channels and messages are decoupled: HTTP, WebSocket, and in-process SSE are physical carriers, while logical messages are channel-independent and form a four-member discriminated union”）；`rpc.d.ts:250`（`RpcMessage` 联合）。

```ts
// rpc.d.ts:218-224 / 226-230 / 237-242 / 244-248
export interface ClientRequest  { type: 'client-request';  rpcId: RpcId; method: string; payload: unknown; }
export interface ServerResponse { type: 'server-response'; rpcId: RpcId; result: RpcResult<unknown>; }
export interface ServerRequest  { type: 'server-request';  rpcId: RpcId; method: string; payload: unknown; }
export interface ClientResponse { type: 'client-response'; rpcId: RpcId; result: RpcResult<unknown>; }
```

- 签名层窄形式（域接口视角）：`RpcRequest<P> = { rpcId, payload }`，`RpcResponse<T> = { rpcId, result }`（`rpc.d.ts:209-217`）。rpcId 永远不混进业务 payload。
- 四条 wire 全形式都有 zod schema 校验：`clientRequestSchema` / `serverResponseSchema` / `serverRequestSchema` / `clientResponseSchema` / `rpcMessageSchema`（`dsh-host-apiproxy/lib/types/api/rpc.schema.d.ts:36-52`）。payload 槽位在“全形式”层保持 `unknown`，业务 payload 由第二层解析按 method 分发（两级解析纪律，`rpc.schema.d.ts:3-4`、`fetch/handler.js:1-6`）。

---

## 2. 信封结构（JSON）逐字段

### 2.1 ClientRequest（unary 请求体）

```jsonc
{
  "type": "client-request",   // 常量
  "rpcId": "8f7c…-uuid",      // 字符串，客户端铸币（UUID v4），见 2.4
  "method": "session.prompt", // 字符串，必须与 URL 路径段一致（见 3.3）
  "payload": { /* 业务参数，见第 7 章 */ }
}
```

- 类型声明：`rpc.d.ts:219-224`。
- 客户端实现（`dsh-host-apiproxy/lib/types/fetch/client.js:171-174`）：

```js
const message = { type: 'client-request', rpcId: this.mintRpcId(), method, payload };
const response = await this.postJson(`/api/${method}`, message, signal, timeoutPolicy);
```

### 2.2 ServerResponse（unary 响应体）

```jsonc
{
  "type": "server-response",  // 常量
  "rpcId": "<回显请求的 rpcId>",
  "result": {                 // RpcResult<T>
    "ok": true,
    "value": { /* 业务返回值 */ }
  }
  // 或：
  // "result": { "ok": false, "error": { "code": "session-not-found", "message": "…", "details": { "sessionId": "…" } } }
}
```

- 类型声明：`rpc.d.ts:226-230`；`RpcResult`：`rpc.d.ts:189-195`。
- 业务错误永远是 HTTP 200 + `result.ok:false`；HTTP 状态码只表达载波层问题（见 3.4）。来源：`fetch/handler.js:5-6`（“HTTP status expresses only the carrier … business errors are always 200 + ServerResponse”）。

### 2.3 ClientResponse（respond 请求体）

```jsonc
{
  "type": "client-response",  // 常量
  "rpcId": "<回显 ServerRequest 的 rpcId，绝不新铸>",
  "result": {
    "ok": true,
    "value": { /* 应答 payload：见 7.6（question）与 7.7（approval） */ }
  }
}
```

- 类型声明：`rpc.d.ts:244-248`（“rpcId echoed, never minted anew”）；`fetch/client.js:325-329`（`respond` 直接 POST `/api/respond`）。
- HTTP 响应体是载波收据 `RpcReceipt`，不是 ServerResponse：

```jsonc
{ "accepted": true }
// 或
{ "accepted": false, "reason": "not-pending" | "bad-response" }
```

- `RpcReceipt` 类型：`rpc.d.ts:256-261`；schema：`rpc.schema.d.ts:54-59`。`not-pending` = 迟到/重复应答；`bad-response` = 信封形状不合 schema（`fetch/handler.js:220-225`：`clientResponseSchema.safeParse` 失败即返回 `{accepted:false, reason:'bad-response'}`）。

### 2.4 rpcId 规则（重点）

- `RpcId` 是 `Branded<'rpc-id'>` 字符串（`rpc.d.ts:16`），运行时就是普通字符串（`rpc.js:14-16`，`RpcId(id) { return id; }`）。**无最小长度**——它是不透明回显令牌，schema 不拒绝任何字符串（`rpc.schema.d.ts:20-26`）。
- 铸币方：**client-request → 客户端铸币**（实现用 `crypto.randomUUID()`，`fetch/client.js:142-145`）；**server-request → 宿主铸币**（`rpc.d.ts:18-24`）。
- 宿主铸币分两种：
  - **可应答帧**（`approval/requested`、`question/requested`）使用**稳定逻辑 id**，重放（reconnect 时补发仍挂起的审批/问题帧）时**原样复用**，客户端以它关联应答；`events.d.ts:45-49`（mux 打开时“replays each session's still-pending approval/question requested frames (rpcId reused verbatim — the refresh-recovery baseline)”）。
  - **纯推送帧**（事件等）每次铸币新的 UUID（`rpc.d.ts:19-21`）。
- 应答回显：`ServerResponse.rpcId` 回显对应 ClientRequest（`rpc.d.ts:213-217` 注释“rpcId always echoes the matching request”；`fetch/client.js:177-178` 客户端校验 `full.rpcId !== message.rpcId` 即抛传输错误）；`ClientResponse.rpcId` 回显对应 ServerRequest。
- 哨兵值：请求 rpcId 不可读（不是字符串）时，错误响应使用固定 `'invalid-request'`，保证响应仍是合法 ServerResponse（`fetch/handler.js:85`、`fetch/handler.js:230-236`）。

### 2.5 RpcError（错误结构）

```ts
// rpc.d.ts:181-187（details 必填；code 是判别字段）
export type RpcError = {
  [C in RpcErrorCode]: {
    code: C;
    message: string;
    details: RpcErrorDetailsMap[C];
  };
}[RpcErrorCode];
```

- 错误码全集 = `RpcErrorDetailsMap` 的键（`rpc.d.ts:26-174`），关闭联合，枚举如下（`details` 结构一并列出）：

| code | details | 典型触发 |
|---|---|---|
| `bad-request` | `{ issues: ZodIssue[] }` | payload 校验失败 / method 与路径不符（`fetch/handler.js:107-110, 238-240`） |
| `cancelled` | `{}` | 请求被取消 |
| `session-not-found` | `{ sessionId }` | 会话不存在 |
| `model-unavailable` | `{ provider, model }` | 模型不可用 |
| `session-conflict` | `{ sessionId, requestedCwd, existingCwd? }` | 预分配 sessionId 但 cwd 不同 |
| `invalid-time-zone` | `{ value }` | clientTimeZone 非法 |
| `workspace-attach-failed` | `{ sessionId, workspaceId }` | 建会话后挂 workspace 失败 |
| `workspace-not-found` | `{ workspaceId }` | workspace 不存在 |
| `workspace-invalid-path` | `{ path }` | 路径不存在/非目录 |
| `workspace-name-conflict` | `{ name }` | 标题撞名 |
| `workspace-move-invalid` | `{ workspaceId, sessionId, beforeSessionId? }` | 移动会话不合法 |
| `directory-unreadable` / `directory-exists` / `directory-create-failed` | `{ path }` | host.listDirectory / createDirectory |
| `directory-picker-unavailable` | `{ capability }` | 无原生目录选择能力 |
| `agent-preset-*` | 见 `rpc.d.ts:76-96` | agentPreset 只读/锁定/冲突/未找到/非法 |
| `agent-busy` | `{ reason }` | 会话被占用（子代理/其他调用中） |
| `attachment-error` | `{ reason }` | 附件处理失败 |
| `queue-item-not-found` | `{ itemId }` | 队列项不存在 |
| `steer-unavailable` | `{ itemId }` | 不能 steer |
| `command-error` / `unknown-command` | `{}` | 斜杠命令用法/状态错误 / 未注册命令 |
| `settings-rejected` / `settings-conflict` / `credential-rejected` / `model-discovery-failed` | 见 `rpc.d.ts:117-145` | 设置/凭据域 |
| `title-invalid` / `fork-unavailable` | `{ sessionId }` | rename / fork |
| `subagent-*` | 见 `rpc.d.ts:152-172` | 子代理域 |
| `internal` | `{}` | 兜底（含传输异常折叠，`rpc.js:24-29`） |

---

## 3. HTTP unary 调用（C→S）

### 3.1 请求格式

- **URL**：`POST http://<authority>/api/<method>`，`<method>` 是 `RpcMethodMap` 键（如 `session.create`）。来源：`fetch/client.js:174`（`postJson(`/api/${method}`, …)`）；方法注册表 `rpc-map.d.ts:22-75`。
- **Header**：仅需 `Content-Type: application/json`（`fetch/client.js:156-160`）。服务端只接受 `application/json`，否则 415（`fetch/handler.js:208-211`）——这本身是跨站写防护（浏览器“简单 POST”不会带 JSON 媒体类型，从而强制 preflight；见 `fetch/handler.js:202-207`）。
- **Body**：`JSON.stringify(ClientRequest)`，见 2.1。
- **超时**：客户端默认 30s（`DEFAULT_TIMEOUT_MS = 30_000`，`fetch/client.js:79, 97`），`host.pickDirectory` 是唯一例外（用户节奏操作，`'caller-signal-only'`，`fetch/client.js:264-266`）。
- **Base URL**：浏览器用 `location.origin`；无 `location` 的环境（Node）用假 authority `http://dsh.internal`——这**只**用于进程内注入，真实 Node 客户端必须用 `http://127.0.0.1:<port>`（`fetch/client.js:138-141`、`fetch/client.js:81`）。

### 3.2 响应

- HTTP 200 + body = `ServerResponse` JSON（成功与业务失败都如此）。
- 客户端校验：rpcId 回显一致（`fetch/client.js:177-178`）→ 用 method 对应的 value schema 做第二层解析（`fetch/client.js:179-184`，schema 表 `fetch/client.js:24-77`）。

### 3.3 路径 = method 校验

服务端要求 body 里的 `message.method === 路径段`，否则 200 + `bad-request`（`fetch/handler.js:238-240`）。所以 `POST /api/session.list` 的 body 中 `method` 必须是 `"session.list"`。

### 3.4 HTTP 状态码语义（载波层）

| 状态码 | 含义 | 来源 |
|---|---|---|
| `200` | 正常，含业务错误（ServerResponse） | `fetch/handler.js:5-6, 88-95` |
| `400` | body 不是合法 JSON | `fetch/handler.js:213-219` |
| `404` | 非 POST 或路径不在 `/api/` 下、或 method 未注册 | `fetch/handler.js:199-201, 226-228` |
| `415` | Content-Type 不是 `application/json` | `fetch/handler.js:208-211` |
| `500` | 处理器实现崩溃（业务层不抛业务错误，抛了就是实现 bug） | `fetch/handler.js:114-117` |
| `403` | 未通过信任围栏（见第 6 章） | `dsh-client-connection/lib/index.js:554-558` |
| `413` | body 超过上限（默认 160 MiB） | `dsh-client-connection/lib/index.js:29, 43-49, 55-60` |

> 客户端侧对非 2xx 的处理：`throw new Error('transport failure for <path>: HTTP <status>')`（`fetch/client.js:162-163`），与业务错误（result.ok=false）区分开。

### 3.5 最小 unary 示例

请求（`POST /api/host.describe`，`Content-Type: application/json`）：

```json
{ "type": "client-request", "rpcId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890", "method": "host.describe", "payload": {} }
```

响应：

```json
{
  "type": "server-response",
  "rpcId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "result": { "ok": true, "value": { "version": "1.2.3", "cwd": "D:\\AI\\Hermess", "attachedSessions": 1, "canOpenPath": true } }
}
```

---

## 4. respond 端点（C→S，应答 ServerRequest）

- **URL**：`POST /api/respond`（固定路径，无 method 段）。来源：`fetch/client.js:325-329`；服务端 `fetch/handler.js:220-225`。
- body = `ClientResponse`（2.3）；响应 body = `RpcReceipt`。
- 该端点不在 `RpcMethodMap` 里（`rpc-map.d.ts:3-4`：map 只注册 client-request 方法，“respond is a client-response, so it is absent”）。**注意：不存在 `session.respond` 这样的 unary 方法**，应答统一走顶层 `/api/respond`。
- 可应答的 ServerRequest 只有两类（按 method 静态判别，无第三种）：`approval/requested` 与 `question/requested`（`rpc.d.ts:231-236`）。具体应答 payload 见 7.6、7.7。

---

## 5. WebSocket 下行流（S→C 事件）

### 5.1 两条流

| 流 | 路径 | 内容 |
|---|---|---|
| mux | `ws://<authority>/api/events.mux` | 会话事件聚合流（session/event 等 MuxFrame） |
| host | `ws://<authority>/api/events.host` | 宿主级信息流（HostFrame） |

- 常量：`dsh-client-connection/lib/types/api-path.d.ts:7-11`（`API_PATH='/api'`、`MUX_EVENTS_PATH='/api/events.mux'`、`HOST_EVENTS_PATH='/api/events.host'`）。

### 5.2 握手要求

- 浏览器客户端：`new WebSocket(url)`，**无任何自定义 header**（浏览器 WebSocket API 无法附加 header）；URL 由 base origin 构造并把协议换成 `ws:`/`wss:`（`dsh-client-connection/lib/client.js:10013-10016`）：

```js
const url = new URL('/api/events.mux', base);       // base = location.origin
url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(url);
```

- **服务端信任围栏同样适用于 WebSocket 升级**：升级前先过 `isTrustedApiRequest(req, trustedHosts)`，不过则 `rejectWebSocketUpgrade(socket)`（裸 HTTP 403 响应）；通过才 `handleUpgrade`（`dsh-client-connection/lib/index.js:566-576, 456-465`）。所以 Node 客户端只要连 loopback 且 Host 头正确（`ws` 库自动带），无需特殊 header。
- 服务端在每条 socket 上铸币一个**新 rpcId**，然后调用 `api.events.mux({ rpcId, payload: {} }, signal)`（`index.js:388-405`）。`since` 参数 v1 未实现（忽略），重连 = 重开流 + 重取历史（`events.d.ts:50-52`）。
- 对 `/api/events.mux`、`/api/events.host` 发普通 HTTP GET 会得到 **426 Upgrade Required**（带 `Connection: Upgrade`、`Upgrade: websocket` 头；`index.js:539-545`）——真实部署下这两条流**只走 WebSocket**。

### 5.3 帧格式（收到的每一帧）

每帧 = 一个 WebSocket **文本帧**，内容为 `ServerRequest` 全形式的 JSON（`index.js:336-343, 350`）：

```js
// 服务端发送（index.js:336-343）：method = frame.payload.type
{ type: 'server-request', rpcId: frame.rpcId, method: frame.payload.type, payload: frame.payload }
```

```jsonc
// 实例：一条 mux 帧
{
  "type": "server-request",
  "rpcId": "c9…uuid…",              // 纯推送：每帧新 UUID；可应答帧：稳定逻辑 id
  "method": "session/event",         // = payload.type
  "payload": {
    "type": "session/event",
    "sessionId": "…",
    "event": { "type": "user/message", "seq": 3, "time": 1710000000000, "data": { /* … */ } },
    "view": { "for": "call", "view": { /* ToolCallView */ } }   // 仅 tool/call、tool/result 事件可能有
  }
}
```

- 客户端解析：`JSON.parse(event.data)` → `serverRequestSchema` 校验 → 再按 `payload.type` 用 mux/host 帧 schema 校验（`client.js:10027-10046`）。二进制帧/坏帧被丢弃并告警，不杀流（`client.js:10031-10037`）。
- **客户端→服务端消息是协议违规**：服务端收到任何 message 即 `websocket.close(1008, 'downlink only')`（`index.js:429-431`）。
- 流中途实现崩溃：发一帧 `stream/error` 后关闭（`index.js:356-368, 439-450`）：

```jsonc
{ "type": "server-request", "rpcId": "<新 UUID>", "method": "stream/error",
  "payload": { "type": "stream/error", "error": { "code": "internal", "message": "…", "details": {} } } }
```

- 客户端收到 `stream/error` 帧后应断开（连接控制器视其为流结束，`client.js:130`）。

### 5.4 SSE 变体（仅进程内/同构路径，真实服务器上不可用）

纯 fetch handler `toFetchHandler` 对同路径提供 **SSE**（`text/event-stream`、`cache-control: no-cache`）：首行注释 `: connected\n\n`，之后每帧 `data: <ServerRequest JSON>\n\n`，客户端按 `\n\n` 分帧、取 `data: ` 前缀行（`fetch/handler.js:127-164`、`fetch/client.js:201-240`）。它供 `InProcessApiClient`（`fetch/client.js:336-360`）与测试注入使用；真实 HTTP 服务器上这两条 GET 已被 426 拦截（5.2）。**写 Node 客户端时不要依赖 SSE 变体。**

---

## 6. `/api` 信任围栏（对 Node 客户端的要求）

### 6.1 判定规则（`isTrustedApiRequest`，`dsh-client-connection/lib/index.js:184-198`；类型声明 `dsh-client-connection/lib/types/api-request-trust.d.ts:36-41`）

对**每个** `/api` 请求（含 WebSocket 升级）按序判定：

1. **必须有 `Host` 头**，且能被解析为 authority（`http://<host>` 形式）——缺失/不可解析 → 拒绝（`index.js:185-188`）。
2. Host 的 hostname 必须是 **loopback**（`localhost`、`[::1]`、127/8 任意 IPv4；`index.js:100-104`，声明 `loopback-hostname.d.ts:7-11`）**或**命中部署配置的 `trustedHosts`（精确 `host:port`，或无端口 `host` 匹配任意端口；`index.js:171-177`）——否则拒绝（`index.js:189`）。
3. `sec-fetch-site: cross-site` → 拒绝（`index.js:190`）。
4. `Origin` 头**缺失** → 通过（`index.js:191-192`）。
5. `Origin` 存在 → `new URL(origin).host` 必须等于 Host authority 的 host（`index.js:193-197`）。

> 注释原文（`index.js:106-119`）：非浏览器与远程客户端同样靠 loopback、部署导出的 LAN IP 字面量或声明的 `trustedHosts` 通过围栏。**该围栏不是认证层**。

### 6.2 Node 客户端的具体做法

- 连接 `http://127.0.0.1:<port>`（或 `localhost`）；Node 的 `http`/`ws` 客户端会按 URL 自动设置 `Host: 127.0.0.1:<port>`，天然满足 6.1 第 1、2 条。
- **不要发送 `Origin` 头**（缺失即通过）；若要发，必须与 Host 完全一致（含端口）。
- **不要发送 `sec-fetch-site: cross-site`**（不发即可；Node 客户端不会自动带 Fetch-Metadata 头）。
- 若用 `host: '0.0.0.0'` 部署并从 LAN 访问，需要部署侧配置 `trustedHosts`（`dsh-client-connection` 插件 Config：`trustedHosts: string[]`，默认 `[]`，`index.js:480-483, 531`）；本规范按 loopback 场景编写。

### 6.3 特权方法：仅限 loopback

以下方法即使部署了 `trustedHosts`，围栏也以**空信任列表**再跑一遍，即钉死 loopback（`index.js:504-520, 537-538`）：

`agentPreset.read`、`agentPreset.copy`、`agentPreset.openDocument`、`agentPreset.remove`、`host.pickDirectory`、`host.openPath`、`settings.describe`、`settings.openDocument`、`settings.update`、`settings.replace`、`settings.mutate`、`credentials.describe`、`credentials.set`、`credentials.unset`、`llm.discoverModels`。

### 6.4 围栏在整条链路上的落点

- `/api` 前缀路由处理器（`index.js:550-561`）。
- WebSocket 升级（`index.js:566-576`）。
- 通用 RPC channel 的 interceptor（`index.js:237`；`/api` 共享 channel，`index.js:260`）。
- 特权方法二次检查（`index.js:537-538`）。

---

## 7. 业务方法契约（精确调用格式）

方法注册表（wire 路径 = 键）：`rpc-map.d.ts:22-75`。以下给出任务要求的全部方法，其余方法类型可在 `sessions.d.ts` / `workspace.d.ts` / `host.d.ts` 中查（第 10 章有完整表）。

### 7.1 session.create

- 契约：`sessions.d.ts:259-267`；schema：`sessions.schema.js:68-78`。
- payload（**`workspaceId` 与 `cwd` 至多其一**，同时出现 → `bad-request`）：

```json
{ "workspaceId": "ws-1", "sessionId": "s-abc", "agentPreset": "general" }
```

或省略 workspace：`{ "cwd": "D:\\workspace" }`（省略项目用宿主 cwd）。
- 响应 value：

```json
{ "sessionId": "s-abc", "agentPreset": "general" }
```

- 语义要点：预分配 `sessionId` 时，同 id 同 cwd 重试返回同一会话；不同 cwd → `session-conflict`；workspace 挂接失败 → `workspace-attach-failed`（带已发布 sessionId）；未知 `agentPreset` → `agent-preset-not-found`（`sessions.d.ts:244-258`）。

### 7.2 session.prompt

- 契约：`sessions.d.ts:365-376`；schema：`sessions.schema.js:225-238`。
- payload：

```json
{
  "sessionId": "s-abc",
  "mode": "queue",
  "content": [ { "type": "text", "text": "列出当前目录" } ],
  "clientTimeZone": "Asia/Shanghai"
}
```

  - `mode`: `'queue' | 'steer'`（queue=排队发送，steer=抢占转向）。
  - `content`: `PromptContentPart[]`（`sessions.d.ts:82-90`）：`{type:'text', text}` 或 `{type:'image', mediaType, data(base64), name?}`。
  - `clientTimeZone` 可选，浏览器调用方附带；宿主校验/规范化后记在该条用户消息上，非浏览器调用方可省略（`sessions.d.ts:358-364`）。
- 响应 value：

```json
{ "accepted": true }
```

  - 若 content 恰好是一个以 `/` 开头的文本块 → 按斜杠命令执行（不进模型），成功时返回 `{ "accepted": true, "command": { "kind": "success", "text": "…" } }`；用法/状态错误 → `command-error`，未注册 → `unknown-command`（`sessions.d.ts:330-337`）。
- 事件关联：prompt 的 rpcId 会透传进对应 `user/message` 事件的 `source`（`sessions.d.ts:40-54`，`'user-rpc': { kind:'user', rpcId, clientTimeZone? }`），客户端用它把乐观回显与事件流对账。

### 7.3 session.history

- 契约：`sessions.d.ts:286-294`；schema：`sessions.schema.js:99-103`。
- payload：

```json
{ "sessionId": "s-abc", "beforeSeq": 100, "maxMessages": 50 }
```

（`beforeSeq`/`maxMessages` 均可选；省略 = 窗口尾页，尾页额外带 in-flight 部分与 `projections`。）
- 响应 value：

```json
{
  "events": [
    { "event": { "type": "turn/start", "seq": 1, "time": 1710000000000, "data": { "turn": 1 } },
      "view": { "for": "call", "view": { /* 宿主计算的工具调用渲染，仅 tool 事件有 */ } } }
  ],
  "hasMore": false,
  "projections": { "asOfSeq": 12, "values": { /* 注册的投影单元 */ } }
}
```

- `HistoryEntry = { event: SessionEvent, view?: ToolEventView }`（`sessions.d.ts:61-64`）。
- `SessionEvent` 信封（`dsh-session/lib/types/types.d.ts:420-452`）：

```ts
{ type: string; seq: number; time: number /* Unix epoch ms */; data: object;
  ignorable?: true; sourceEventSeqs?: number[]; surfaceOp?: object }
```

- 常用事件 `data` 形状（`types.d.ts:223-299` 等）：`turn/start {turn}`、`turn/end {turn, reason}`、`step/start|end {turn, step}`、`user/message`（UserMessage）、`assistant/chunk {turn, step, chunk}`、`assistant/message {turn, step, message, usage?}`、`tool/call {turn, step, callId, name, arguments(原始JSON串)}`、`tool/result`（见 `types.d.ts:293-299` 注释）。

### 7.4 session.cancel

- 契约：`sessions.d.ts:401-405`；schema：`sessions.schema.js:275-277`。
- payload：`{ "sessionId": "s-abc" }`；响应 value：`{ "accepted": true }`。
- 语义：停掉活跃回合，保留挂起 inbox 工作（取消落定后 FIFO 继续，`sessions.d.ts:396-400`）。会话型子代理用 `subagent.interrupt`（`sessions.d.ts:397-398`）。

### 7.5 session.respond —— 不存在；应答走顶层 `/api/respond`（见第 4 章）

### 7.6 应答 question（`question/requested` 帧）

- 帧（`events.d.ts:88-91`）：`{ type:'question/requested', sessionId, questions: AskUserQuestionItem[] }`；`AskUserQuestionItem`（`dsh-user-questions/lib/types/types.d.ts:32-47`）：`{ id, question, detail?, header?, options?: [{label, description?}], multiSelect?, intent? }`。
- 应答（`questions.d.ts:14-17`）——ClientResponse 的 `result.value`：

```json
{
  "sessionId": "s-abc",
  "answer": { "answers": [ { "id": "q1", "selected": ["是"], "custom": "可选自由文本" } ] }
}
```

- `AskUserQuestionAnswer = { answers: AskUserQuestionAnswerItem[] }`，`AnswerItem = { id, selected: string[], custom?: string }`（`dsh-user-questions/lib/types/types.d.ts:49-61`）。一次应答覆盖该 ask() 的整批问题，绝不按问题拆分（`questions.d.ts:10-13`）。
- 结果帧：`question/resolved` `{ sessionId, questionRpcId, outcome: 'answered'|'cancelled' }`（`events.d.ts:92-96`）。

### 7.7 应答 approval（`approval/requested` 帧）

- 帧（`events.d.ts:76-82`）：`{ type:'approval/requested', sessionId, approvalId, toolName, callId?, reason? }`。
- 应答（`approvals.d.ts:15-19`）——ClientResponse 的 `result.value`：

```json
{
  "sessionId": "s-abc",
  "approvalId": "ap-1",
  "outcome": "allowed-once"
}
```

  - `outcome` 只接受客户端能给的两种：`'allowed-once' | 'rejected'`（`cancelled`/`unavailable` 是宿主侧结局；`dsh-user-approval/lib/types/types.d.ts:23`）。
- 结果帧：`approval/resolved` `{ sessionId, approvalId, outcome: ApprovalOutcome }`（`events.d.ts:83-87`）。

### 7.8 workspace.create / workspace.list

- `workspace.create`（`workspace.d.ts:54-59`）——**目录必须已存在**（不 mkdir，不存在/非目录 → `workspace-invalid-path`）；已归属某 workspace 的路径返回该 workspace 且 `created:false`：

```json
// POST /api/workspace.create
{ "type": "client-request", "rpcId": "…", "method": "workspace.create", "payload": { "path": "D:\\proj" } }
// 响应 value：
{ "workspace": { "workspaceId": "ws-1", "path": "D:\\proj", "title": "proj", "sessionIds": [], "createdAt": "2026-…", "updatedAt": "2026-…" }, "created": true }
```

- `workspace.list`（`workspace.d.ts:42-45`）：payload `{}`；value `{ items: WorkspaceView[], archivedSessionIds: SessionId[] }`。
- `WorkspaceView`（`workspace.d.ts:18-33`）：`{ workspaceId, path, title, sessionIds, createdAt, updatedAt }`（均为 ISO-8601 时间串）。
- 其余：`workspace.rename {workspaceId,title}`、`workspace.delete {workspaceId}`、`workspace.insertBefore {workspaceId,beforeWorkspaceId?}`、`workspace.insertSessionBefore {workspaceId,sessionId,beforeSessionId?}`、`workspace.archiveSession {sessionId}`（`workspace.d.ts:66-119`）。

### 7.9 host.describe

- 契约：`host.d.ts:42-49`；schema：`host.schema.js:6`（空 payload `{}`）。
- 响应 value：

```json
{ "version": "1.2.3", "cwd": "D:\\AI\\Hermess", "attachedSessions": 2, "canOpenPath": true }
```

  - `version` = 宿主 app 的 package.json 版本；`cwd` = 宿主进程工作目录；`provider`/`model` 可选（无显式默认时缺省）；`attachedSessions` = 当前挂载（有活 agent）会话数。

---

## 8. 事件帧详细（MuxFrame / HostFrame）

### 8.1 MuxFrame（`events.d.ts:66-145`）——按 `type` 判别

| type | 字段 | 可应答？ |
|---|---|---|
| `session/event` | `sessionId, event: SessionEvent, view?: ToolEventView` | 否（推送） |
| `session/subscribed` | `sessionId, lastSeq: number`（mux 打开时对每个挂载会话先发一帧；`events.d.ts:45-49`） | 否 |
| `approval/requested` | `sessionId, approvalId, toolName, callId?, reason?` | **是**（稳定 rpcId） |
| `approval/resolved` | `sessionId, approvalId, outcome: 'allowed-once'\|'rejected'\|'cancelled'\|'unavailable'` | 否 |
| `question/requested` | `sessionId, questions: AskUserQuestionItem[]` | **是**（稳定 rpcId） |
| `question/resolved` | `sessionId, questionRpcId, outcome: 'answered'\|'cancelled'` | 否 |
| `session/queue` | `sessionId, items: QueuedInboxItem[]`（`{id: MessageId, placement:'queued'\|'steering'\|'context', message: Message}`，`events.d.ts:35-42, 106-109`） | 否 |
| `session/jobs` | `sessionId, jobs: JobView[]` | 否 |
| `session/projection` | `sessionId, key, value, seq` | 否 |
| `stream/error` | `error: RpcError` | 否（流结束信号） |

- `ToolEventView = {for:'call', view: ToolCallView} | {for:'result', view: ToolResultView}`（`events.d.ts:27-33`）；`view` 是宿主在发出时刻计算的渲染意图，**不持久化**，同一事件再次投递可能没有 view（客户端按默认通用 JSON 卡片兜底，`events.d.ts:19-26`）。

### 8.2 HostFrame（`events.d.ts:163-212`）

| type | 字段 |
|---|---|
| `host/session-added` | `sessionId, blank: boolean, parentSessionId?, origin?: 'subagent', cwd?, agentPreset?` |
| `host/session-removed` | `sessionId` |
| `host/session-status` | `sessionId, running: boolean` |
| `host/agent-error` | `sessionId, message` |
| `host/workspace-changed` | `workspace: WorkspaceView`（完整新快照） |
| `host/workspace-removed` | `workspaceId` |
| `host/workspace-order-changed` | `workspaceIds: string[]` |
| `host/archived-sessions-changed` | `archivedSessionIds: SessionId[]` |
| `host/remote-event` | `event: string, args: JsonValue[]`（白名单转发的宿主 cordis 事件，`events.d.ts:195-204`） |
| `stream/error` | `error: RpcError` |

### 8.3 重连基线

mux 打开时：先发各挂载会话的 `session/subscribed`（lastSeq），再重放仍挂起的 `approval/requested` / `question/requested`（rpcId 原样复用）。重连策略 = 重开流 + 重取历史（`events.d.ts:47-52`）；`since` 参数 v1 忽略。

---

## 9. 最小完整会话：调用序列伪代码

```js
const BASE = 'http://127.0.0.1:PORT';   // PORT 由部署决定；webserver 绑定 127.0.0.1 或 0.0.0.0
                                        // （dsh-host-webserver/lib/types/index.d.ts:37-41，port 0 = OS 分配）

// 0) 健康检查（可选）：host.describe —— 围栏：Host 自动带，不发 Origin
const desc = await rpc(BASE, 'host.describe', {});
if (!desc.result.ok) throw new Error(desc.result.error.message);

// 1) 打开事件下行流（先开，避免错过事件）
const mux = new WebSocket(`ws://127.0.0.1:PORT/api/events.mux`);
const host = new WebSocket(`ws://127.0.0.1:PORT/api/events.host`);
// 不要向 WS 发任何消息（服务端会 1008 关闭）
// 收到帧：JSON.parse → 断言 type==='server-request' → 按 payload.type 分派
mux.onmessage = (ev) => {
  const env = JSON.parse(ev.data);              // ServerRequest 全形式
  const f = env.payload;                        // MuxFrame
  switch (f.type) {
    case 'session/event':        // f.event 是 SessionEvent，渲染/累积
    case 'approval/requested':   // 见第 4 章 + 7.7 → POST /api/respond
    case 'question/requested':   // 见第 4 章 + 7.6 → POST /api/respond
    case 'stream/error':         // 关闭 mux，走重连
  }
};

// 2) 创建会话（可预分配 sessionId 以便重试幂等）
const created = await rpc(BASE, 'session.create', { cwd: 'D:\\proj', sessionId: 's-abc' });
const sessionId = created.result.ok ? created.result.value.sessionId : /* 处理错误 */;

// 3) 发 prompt（mode: 'queue'）
const sent = await rpc(BASE, 'session.prompt',
  { sessionId, mode: 'queue', content: [{ type: 'text', text: '列出当前目录' }] });
// sent.result.value = { accepted: true }；若为斜杠命令则带 command 槽

// 4) 通过 mux 的 session/event 收事件：
//    turn/start → user/message → assistant/chunk* → tool/call* → tool/result* → assistant/message → turn/end
//    （部分会话会中途发 question/requested / approval/requested）

// 4a) 应答 question（如有）——rpcId 必须回显帧的 rpcId
const answer = {
  type: 'client-response',
  rpcId: frameRpcId,                     // = question/requested 帧的 rpcId
  result: { ok: true, value: { sessionId, answer: { answers: [{ id: 'q1', selected: ['是'] }] } } }
};
const receipt = await respond(BASE, answer);   // receipt = { accepted: true }
// 随后会收到 question/resolved

// 4b) 应答 approval（如有）——outcome: 'allowed-once' | 'rejected'
const answerA = {
  type: 'client-response',
  rpcId: approvalFrameRpcId,
  result: { ok: true, value: { sessionId, approvalId: f.approvalId, outcome: 'allowed-once' } }
};
await respond(BASE, answerA);                 // 随后收到 approval/resolved

// 5) 结束/取历史：等 turn/end 后拉一次 history 作为权威快照
const hist = await rpc(BASE, 'session.history', { sessionId });
// hist.result.value.events: HistoryEntry[]（SessionEvent + 可选 view）

// —— 辅助函数 ——
async function rpc(base, method, payload) {
  const rpcId = crypto.randomUUID();                    // 客户端铸币
  const res = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },    // 围栏 + 415 要求
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  });
  if (!res.ok) throw new Error(`transport failure: HTTP ${res.status}`);
  const body = await res.json();                        // ServerResponse
  if (body.rpcId !== rpcId) throw new Error('rpcId mismatch');
  return body;                                          // { type, rpcId, result }
}
async function respond(base, message) {
  const res = await fetch(`${base}/api/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),                      // ClientResponse
  });
  if (!res.ok) throw new Error(`transport failure: HTTP ${res.status}`);
  return res.json();                                    // RpcReceipt
}
```

---

## 10. 完整方法注册表（RpcMethodMap，`rpc-map.d.ts:22-75`）

wire 路径 = 键 = `POST /api/<key>`。请求 payload / 响应 value 均由此表签名推导（`rpc-map.d.ts:77-79`）。

| 键 | 域接口 | 键 | 域接口 |
|---|---|---|---|
| session.list / search / create / history / models / selectModel / rename / fork / prompt / attachment / updateQueue / cancel | `SessionsApi`（`sessions.d.ts:226-406`） | goal.create / edit / pause / resume / complete / clear | `GoalsApi` |
| subagent.list / history / prompt / interrupt | `SubagentsApi` | settings.describe / openDocument / update / replace / mutate | `SettingsApi` |
| host.describe / pickDirectory / listDirectory / createDirectory / openPath | `HostApi`（`host.d.ts:32-90`） | credentials.describe / set / unset | `CredentialsApi` |
| workspace.list / create / rename / delete / insertBefore / insertSessionBefore / archiveSession | `WorkspaceApi`（`workspace.d.ts:35-120`） | llm.providers / models / discoverModels | `LlmApi` |
| skill.list | `SkillsApi` | | |
| agentPreset.list / select / read / copy / openDocument / remove | `AgentPresetsApi` | | |

（各方法参数/返回的精确 JSON 形状：`sessions.d.ts`、`workspace.d.ts`、`host.d.ts` 以及同名 `*.schema.js` 的 zod schema；`agentPreset.*`、`goal.*`、`settings.*`、`credentials.*`、`llm.*`、`subagent.*`、`skill.*` 见各自 `api/<domain>.d.ts`。）

另外：`GET /api/session.export?sessionId=…` 是唯一无信封的 GET（宿主下载面，`index.d.ts:32-33`、`fetch/handler.js:186-198`），不在 RpcMethodMap 内。

---

## 11. 连接生命周期（供参考，浏览器控制器行为）

- 握手：两条流（mux+host）建立（onOpen）+ `host.describe({})` 成功 → `connected`（`client.js:84-108`）；流打开有超时上限（`streamOpenTimeoutMs`，超时仍按已连接推进，`connection.d.ts:11-15`）。
- 重连：任何一条流结束或 describe 失败 → `reconnecting` → 指数退避抖动：`cap = min(backoffMaxMs, backoffBaseMs * backoffFactor^(attempt-1))`，实际延迟 `cap/2..cap` 随机（`client.js:61-65, 109-119`）。
- 断开时把 `session/queue`、`session/jobs` 等全量快照帧作为收敛信号（`events.d.ts:97-109, 110-127` 注释）。

---

## 12. 来源文件清单（全部位于 `D:\AI\DeepSeek Harness\resources\dsh\vendor\node_modules\@deepseek-ai\` 下）

| 文件 | 内容 |
|---|---|
| `dsh-host-apiproxy/lib/types/api/rpc.d.ts` / `rpc.js` / `rpc.schema.d.ts` | 四象限消息模型、RpcError、RpcReceipt、zod schema、rpcId 语义 |
| `dsh-host-apiproxy/lib/types/api/rpc-map.d.ts` | 方法注册表（wire 路径=键） |
| `dsh-host-apiproxy/lib/types/api/{sessions,workspace,host,events,questions,approvals,index}.d.ts` | 业务契约 |
| `dsh-host-apiproxy/lib/types/api/*.schema.js` | 各方法请求/响应 value 的 zod schema（精确字段） |
| `dsh-host-apiproxy/lib/types/fetch/client.js` / `handler.js` | 客户端载体（mint rpcId、POST、回显校验、SSE 解析）与宿主 fetch 载体（路径=method、两级解析、SSE 输出） |
| `dsh-client-connection/lib/types/api-path.d.ts` | `/api`、`/api/events.mux`、`/api/events.host` 常量 |
| `dsh-client-connection/lib/types/api-request-trust.d.ts` | 信任围栏接口 |
| `dsh-client-connection/lib/types/loopback-hostname.d.ts` | loopback 判定接口 |
| `dsh-client-connection/lib/index.js` | 宿主实现：围栏、HTTP 桥、WebSocket 下行、特权方法、426/403 |
| `dsh-client-connection/lib/client.js` | 浏览器实现：WebApiClient（WS 帧解析）、连接控制器（握手/退避） |
| `dsh-client-connection/lib/types/client/*.d.ts` | IApiClient / WebApiClient / ConnectionController 类型 |
| `dsh-api-gateway/lib/types/types.d.ts` | Typert 网关（通用 RPC channel 机制，本规范未展开） |
| `dsh-user-questions/lib/types/types.d.ts`、`dsh-user-approval/lib/types/types.d.ts` | 问题项/答案、审批结局词表 |
| `dsh-session/lib/types/types.d.ts` | SessionEvent 信封与事件表 |
| `dsh-host-webserver/lib/types/index.d.ts` | 监听地址（`127.0.0.1`/`0.0.0.0`，port 0 = OS 分配） |

---

## 13. 附注：未找到 / 需实测确认的点

- **session.respond 作为 unary 方法：未找到**——不存在该注册方法；应答统一为顶层 `POST /api/respond`（`rpc-map.d.ts:3-4` 明确说明 respond 不在 map 内）。
- **握手所需的自定义 header：未找到任何要求**。浏览器实现是裸 `new WebSocket(url)`（`client.js:10016`）；服务端围栏只读 Host / Origin / sec-fetch-site（`index.js:184-198`）。Node 客户端无需自定义 header。
- **SSE 变体在真实服务器上不可用**（GET 返回 426，`index.js:539-545`）；`toFetchHandler` 的 SSE 仅用于进程内/测试（见 5.4）。
- **`session.list` 的 cursor 分页：v1 未实现**（`sessions.d.ts:227-228`，cursor 是预留席位）。
- **mux 的 `since` 恢复参数：v1 忽略**（`events.d.ts:50-52`）。
- 端口发现机制（如 CLI 输出/日志中的 URL）未在本规范所读类型文件中展开；VS Code 扩展需要从部署侧获取 `<port>`（或请求 `port:0` 时的 OS 分配端口，见 `dsh-host-webserver/lib/types/index.d.ts:40-41, 62-63`）。
- 各方法在真实宿主上的具体行为（如 `session.create` 的 agent 启动、标题生成）由实现决定，本规范只保证线格式。
