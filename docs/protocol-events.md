# DSH 会话事件流协议逆向文档（/api/events.mux）

> 用途：为 VS Code 扩展提供「监听 dsh Web 会话事件 → 实时反映文件写入 / 原生提问审批对话框」所需的精确 JSON 结构。
> 数据来源：D:\AI\DeepSeek Harness\resources\dsh\vendor\node_modules\@deepseek-ai\ 下已安装 npm 包的类型声明与打包源码（只读，未修改任何 vendor 文件）。
> 本文所有结论均标注来源文件（包内相对路径）+ 行号。所有包路径前缀省略为 `@deepseek-ai/`。

---

## 0. 传输层：WebSocket /api/events.mux 的线格式

### 0.1 端点

| 端点 | 说明 |
|---|---|
| `WS /api/events.mux` | 浏览器 mux 帧流（会话事件聚合流） |
| `WS /api/events.host` | 浏览器 host 帧流（会话创建/删除、运行状态、workspace 事件等） |
| `GET /api/events.mux` / `GET /api/events.host` | 同一流量的 SSE 回退（`data: <JSON>\n\n` 行） |

来源：`dsh-client-connection/lib/types/api-path.d.ts:9-11`（`MUX_EVENTS_PATH = "/api/events.mux"`）。

### 0.2 每个 WebSocket 帧（下行，server → browser）

服务端把每个 mux 帧包装成「ServerRequest 全形」后 `JSON.stringify` 发送：

```json
{
  "type": "server-request",
  "rpcId": "2f0f5b96-…",
  "method": "session/event",     // = payload.type
  "payload": { "type": "session/event", "sessionId": "…", "event": { … } }
}
```

来源：`dsh-client-connection/lib/index.js:336-355`（`serverRequest()`/`send()`：`{ type: 'server-request', rpcId: frame.rpcId, method: frame.payload.type, payload: frame.payload }`）。
SSE 版本：`dsh-host-apiproxy/lib/types/fetch/handler.js:119-122,136-138`（`fullFrame()`，`data: JSON.stringify(fullFrame(narrow))`）。

### 0.3 上行（browser → server）

- 一元 RPC：`POST /api/<method>`，body = ClientRequest 全形；响应体 = ServerResponse 全形（业务错误也是 HTTP 200）。
  ```json
  { "type": "client-request", "rpcId": "…", "method": "session.prompt", "payload": { … } }
  ```
  → `{ "type": "server-response", "rpcId": "…", "result": { "ok": true, "value": { … } } | { "ok": false, "error": { code, message, details } } }`
- 应答交互（审批/提问的回复）：`POST /api/respond`，body = ClientResponse 全形；HTTP 响应体 = RpcReceipt。
  ```json
  { "type": "client-response", "rpcId": "<从 requested 帧回显>", "result": { "ok": true, "value": { … } } }
  ```
  → `{ "accepted": true }` 或 `{ "accepted": false, "reason": "not-pending" | "bad-response" }`

来源：`dsh-host-apiproxy/lib/types/api/rpc.d.ts:218-250`（四种消息全形）、`dsh-host-apiproxy/lib/types/fetch/handler.js:199-241`（POST 路由、`/api/respond` 分支 220-225）、`dsh-client-connection/lib/index.js:275-301`（`rpcFetchHandler`，ServerResponse 组装 322-329）、`dsh-host-apiproxy/lib/index.js:5466-5470`（客户端 `respond()` 走 `/api/respond`）。

> 注意：**没有** `session.respond` 这种一元方法。RpcMethodMap 里只有 client-request 方法（`dsh-host-apiproxy/lib/types/api/rpc-map.d.ts:1-5` 明确注释「respond is a client-response, so it is absent」）。应答永远走 `/api/respond` + 回显 `rpcId`。

### 0.4 连接握手与基线

打开 mux 流时，服务端会：
1. 为每个已挂接的 session 发一个 `session/subscribed` 控制帧；
2. 重放每个 session 仍 pending 的 `approval/requested` / `question/requested` 帧，**rpcId 原样复用**（重连恢复基线）。

来源：`dsh-host-apiproxy/lib/types/api/events.d.ts:44-55`（`mux()` 注释）。

---

## 1. 会话事件（SessionEvent）完整分类

### 1.1 事件外壳（envelope）

每个会话事件（`SessionEvent`）是一个以 `type` 为判别字段的可辨识联合：

```json
{
  "type": "tool/call",            // 判别字段
  "seq": 17,                      // 会话内单调递增序号（= 日志长度）
  "time": 1720000000000,          // Unix epoch 毫秒
  "data": { … },                  // 事件载荷
  "surfaceOp": "append",          // 仅 user/message、assistant/message、tool/result 三类有
  "sourceEventSeqs": [15, 16],    // 可选，仅上述三类有
  "ignorable": true               // 可选：true 表示未知类型可安全跳过（默认视为必需）
}
```

来源：`dsh-session/lib/types/types.d.ts:420-452`（`SessionEvent` 联合定义，含 seq/time/data/ignorable 及 surface 条件字段）；`dsh-session/lib/types/types.d.ts:223-354`（`SessionEventMap`，事件载荷）。

关键点：
- 事件是**判别联合**：`data` 的形状由 `type` 唯一决定（`types.d.ts:407-419` 注释「proper discriminated union over type」）。
- `surfaceOp`/`sourceEventSeqs` **只允许**出现在三类「消息产生事件」上：`user/message`、`assistant/message`、`tool/result`（`types.d.ts:358-362` `SurfaceEventType`；`surface.d.ts:318-322` 运行时校验）。
- `seq` 必须连续（`= log.length`，`dsh-session/lib/types/index.d.ts:175-176`）。

### 1.2 事件类型清单（核心 `SessionEventMap`）

| type | data 形状 | 是否 surface | 说明 |
|---|---|---|---|
| `turn/start` | `{ turn: number }` | 否 | 开启 turn（`types.d.ts:230-232`） |
| `turn/end` | `{ turn, reason: TurnEndReason }` | 否 | 关闭 turn；reason 判别字段 `kind`：`completed`/`aborted`/`blocked`/`error`/`max-tokens`/`interrupted`（`types.d.ts:241-244,135-169`） |
| `step/start` | `{ turn, step }` | 否 | 开启 step（一次模型调用 + 其工具执行）（`types.d.ts:246-249`） |
| `step/end` | `{ turn, step }` | 否 | 关闭 step（`types.d.ts:251-254`） |
| `user/message` | 完整 `UserMessage` | **是** | 用户消息（`types.d.ts:256-262`） |
| `assistant/chunk` | `{ turn, step, chunk: StreamChunk }` | 否 | 原始流式块（`types.d.ts:263-268`） |
| `assistant/message` | `{ turn, step, message: AssistantMessage, usage?: TokenUsage }` | **是** | 组装好的助手消息（`types.d.ts:269-280`） |
| `tool/call` | `{ turn, step, callId, name, arguments }` | 否 | 模型请求的一次工具调用；`arguments` 是**原始 JSON 字符串**（未解析）（`types.d.ts:282-292`） |
| `tool/result` | `{ turn, step, message: ToolResultMessage, error?: { name, code }, meta?: JsonValue }` | **是** | 工具结果；`meta` 是工具私有展示载荷（如 write/edit 的 diff）（`types.d.ts:294-313`） |
| `todo/write` | `{ todos: TodoItem[] }` | 否 | 整表快照（last-write-wins）（`types.d.ts:315-317`；`TodoItem` 定义 180-185） |
| `request/header` | `{ header: EpochHeader, reason: 'initial'\|'resume'\|'change' }` | 否 | 下次请求的完整 header（`types.d.ts:322-325,191-200,216`） |
| `request/context` | `RequestContext`（`{ provider, model, contextWindow? }`） | 否 | 路由元数据（`types.d.ts:330,202-209`） |
| `session/end-seed` | `{}` | 否 | 构造种子结束标记（`types.d.ts:353`） |

插件通过声明合并向 `SessionEventMap` 追加事件类型（`types.d.ts:355-356`「plugin-merged extensions included」；`KNOWN_SESSION_EVENT_TYPES` 由脚本生成，见 `dsh-session/lib/types/known-event-types.d.ts:7-18`）。已知的插件扩展事件：

| type | data 形状 | 来源 |
|---|---|---|
| `session/title` | `{ title: string, messageSeqs: number[], source: { kind: 'fallback'\|'provider', … } \| { kind: 'user' } }` | `dsh-session-title/lib/types/index.d.ts:38-45,68-75` |
| `approval/asked` | `{ id, toolName, callId?, reason? }` | `dsh-user-approval/lib/types/index.d.ts:37-42` |
| `approval/decided` | `{ id, outcome }` | `dsh-user-approval/lib/types/index.d.ts:48-51` |
| `approval/policy` | `{ policy: 'ask'\|'never', source?: 'delegation' }` | `dsh-user-approval/lib/types/index.d.ts:60-64` |
| `tool/code-dispatch-start` | `{ rootCallId, parentCallId, subCallId, name, arguments }` | `dsh-tools/lib/types/types.d.ts:36` |
| `tool/code-dispatch` | 同上 + `{ isError, content }` | `dsh-tools/lib/types/types.d.ts:52` |
| `tool-workflow/run-start` | `{ runId, name }` | `dsh-tool-workflow/lib/types/types.d.ts:39` |
| `tool-workflow/agent-start` | `{ runId, seq, label, phase?, childId }` | 同上 :44 |
| `tool-workflow/agent-end` | `{ runId, seq, outcome }` | 同上 :49 |
| `tool-workflow/run-end` | `{ runId, stopReason }` | 同上 :54 |

> 注意：`approval/asked`/`approval/decided` 是**日志审计事件**（log-only，非 surface），提问（question）没有对应的会话日志事件——提问/审批的**实时通知**走 mux 帧（见 §4），与日志事件是两套通道。

### 1.3 三个事件示例

```json
// turn/start
{ "type": "turn/start", "seq": 10, "time": 1720000000000, "data": { "turn": 3 } }

// tool/call（write）
{
  "type": "tool/call", "seq": 17, "time": 1720000000000,
  "data": {
    "turn": 3, "step": 1,
    "callId": "call_abc123",
    "name": "write",
    "arguments": "{\"file_path\":\"src/foo.ts\",\"content\":\"export const x = 1;\\n\"}"
  }
}

// tool/result（write 成功）
{
  "type": "tool/result", "seq": 18, "time": 1720000000001,
  "surfaceOp": "append", "sourceEventSeqs": [17],
  "data": {
    "turn": 3, "step": 1,
    "message": {
      "id": "msg-…", "role": "user",
      "source": { "kind": "tool", "callId": "call_abc123" },
      "content": [ { "type": "tool-result", "toolCallId": "call_abc123",
                     "content": [ { "type": "text",
                     "text": "<path>…</path>\n<type>file</type>\n<content>\nCreated file\n</content>" } ],
                     "isError": false } ]
    },
    "meta": { "diffs": [ { "path": "src/foo.ts", "oldText": null, "newText": "…" } ] }
  }
}
```

`tool/result` 的事件写入点（含 `meta` 透传与 `surfaceOp: "append"`、`sourceEventSeqs: [callSeq]`）：`dsh-agent-loop/lib/index.js:302-318`。
`tool/call` 写入点：`dsh-agent-loop/lib/index.js:292-300`。

---

## 2. 重点：write / edit 工具 —— tool/call 与 tool/result 的精确结构（diff 结论）

### 2.1 write 工具

**tool/call input（schema）**：`{ file_path: string (必填), content: string (必填), sandbox_permissions? , justification? }`
- `content` 允许为空串（写空文件合法）；`file_path` 非空。
来源：`dsh-tool-fs/lib/index.js:603-618`（工具注册参数 schema）、`dsh-tool-fs/lib/types/write.d.ts:16-22`（`parseWriteArgs`，参数为 `{ file_path, content }`）。

**tool/result**：
- `message.content[0]` 是渲染文本（**不回显文件内容**，只给确认信封）：
  ```
  <path>…显示路径…</path>
  <type>file</type>
  <content>
  Created file        ← 或 "Updated file"
  </content>
  ```
  来源：`dsh-tool-fs/lib/index.js:585-591`（`formatWriteOutput`）。
- **`meta.diffs` 是权威 diff 数据**：`{ diffs: FileDiff[] }`，其中
  ```json
  { "diffs": [ { "path": "src/foo.ts", "oldText": "…改动前的 hunk（含 3 行上下文）…", "newText": "…改动后的 hunk（含 3 行上下文）…" } ] }
  ```
  由 `presentationMeta` 在结果时从后端 `before`/`after` 文本计算：`dsh-tool-fs/lib/index.js:647-651`（`value.before === null ? [] : computeHunkDiffs(...)`）；`dsh-tool-fs/lib/types/diff.d.ts:16-18`（`FsDiffMeta = { diffs: FileDiff[] }`，注释明确「write/edit 工具的 tool/result meta 载荷」）。
- **create（新文件）时 `meta.diffs` 为空数组 `[]`**（`before === null`），UI 回退为整文件 diff（`oldText: null, newText: args.content`）：`dsh-tool-fs/lib/index.js:687-699`（`presentResult` fallback）。

**tool/result 里有没有旧内容？**
- 有，但以 **hunk 形式**（每 hunk 带 `DIFF_CONTEXT = 3` 行上下文），不是整文件。`FileDiff = { path, oldText: string|null, newText: string }`（`dsh-tools/lib/types/presentation.d.ts:30-36`）。
- 结构化完整值（`{ path, operation: 'create'|'update', before: string|null, after: string }`，`dsh-tool-fs/lib/index.js:619-642,668-673`）**只存在于执行期，不进事件**——`dsh-tools/lib/types/index.d.ts:391-392` 明确：`value` 是「Execution-local canonical value; deliberately omitted from durable events」。
- **结论**：
  1. **能直接算 diff**——用 `tool/result.meta.diffs`（新/旧 hunk 文本都在事件里，无需再读文件）；这是官方 Web UI 的做法（`dsh-client-ui-tool` 的 `diff-card-model` 只消费 `diffs`）。
  2. 对**创建文件**（`meta.diffs === []`），旧内容为 null（文件原本不存在），可直接用 `tool/call.data.arguments` 解析出的 `content` 作为新内容。
  3. 若要**整文件同步**到编辑器：`meta.diffs` 只覆盖改动区域（±3 行上下文），对大面积文件不足以重建全文——VS Code 扩展可直接读磁盘（事件到达时写入已完成），或自行用 `tool/call` 的 `content`（write）做整文件内容。
  4. `tool/call` 阶段（运行中）：diff 卡片由 `presentCall` 从参数推导，`oldText` 对覆盖写为 `null`（调用时拿不到旧内容）——`dsh-tools/lib/types/presentation.d.ts:26-29` 注释、`dsh-tool-fs/lib/index.js:675-686`。

### 2.2 edit 工具

**tool/call input**：`{ file_path: string (必填), old_string: string (非空必填), new_string: string (必填), replace_all?: boolean (默认 false) }`
来源：`dsh-tool-fs/lib/index.js:748-770`（schema）、`dsh-tool-fs/lib/types/edit.d.ts:23-28`（`parseEditArgs`，校验 `old_string !== new_string`）。

**tool/result**：
- 渲染文本：`The file <path> has been updated successfully.`（replaceAll 时 `All occurrences were successfully replaced.`）——`dsh-tool-fs/lib/index.js:734-736`（`formatEditOutput`）。
- **`meta.diffs` 同样携带真实 before/after hunk**（edit 的 before 恒为字符串，非 null）：`dsh-tool-fs/lib/index.js:796-800`（`presentationMeta: (args, value) => ({ diffs: computeHunkDiffs(...) })`）。
- 后端 `FsEditOutcome = { version, before: string, after: string }`（LF 归一化后的全文，仅供计算用，不进事件）：`dsh-fs/lib/types/types.d.ts:145-156`。
- `write` 的后端 `FsWriteOutcome = { operation, version, before: string|null, after: string }`：`dsh-fs/lib/types/types.d.ts:118-134`（注释 124-130 明确 before 是「diff basis，never a diff」）。

### 2.3 diff 计算细节

- `computeHunkDiffs(path, before, after)`：每 hunk 一个 `FileDiff`，纯插入用 `oldText: null`，`DIFF_CONTEXT = 3`，散落的多处替换保持独立 hunk：`dsh-tool-fs/lib/types/diff.d.ts:8,19-30`。
- 客户端 UI 侧的消费：`dsh-client-ui-tool/lib/client.js:232-288`（`narrowDiffs` 校验 + `diffCardModel`：运行中用 `callView.card === 'diff'` 的 `diffs`，完成后用 `resultView.card === 'diff'` 的 `diffs`——后者优先）；`dsh-client-ui-tool/lib/types/client/tool/models/diff-card-model.d.ts:36-57`。
- `diffsFromMeta(meta)` 防御性收窄：`dsh-tool-fs/lib/index.js:521-523`、`dsh-tool-fs/lib/types/diff.d.ts:32-37`。

### 2.4 mux 帧上的 `view` 槽（重要）

`session/event` 帧带可选的 `view?: ToolEventView`——主机在**派发时**用当前注册的 presenter 从 args/result 实时计算的渲染意图，**不持久化**（重放时同事件可能带不同 view 或没有）：
```json
{ "type": "session/event", "sessionId": "…", "event": { … }, "view": { "for": "call" | "result", "view": { … } } }
```
来源：`dsh-host-apiproxy/lib/types/api/events.d.ts:19-33`（`ToolEventView`）、:66-71（帧）。`view.view` 即 §2.5 的 `ToolCallView`/`ToolResultView`。

### 2.5 展示视图词汇（ToolCallView / ToolResultView）

工具用 `presentCall`/`presentResult` 声明「卡片式渲染意图」（`dsh-tools/lib/types/index.d.ts:155-171`），UI 按 `card` 判别：

- `ToolCallView = GenericCallView | TerminalCallView | DiffCallView`（`dsh-tools/lib/types/presentation.d.ts:41`）
- `ToolResultView = GenericResultView | TerminalResultView | DiffResultView | SearchResultView | ReadResultView | WebResultView`（:130）
- `DiffCallView = { card: 'diff', title, diffs: FileDiff[], locations? }`（:102-110）
- `DiffResultView = { card: 'diff', title?, diffs: FileDiff[] }`（:171-177）
- `TerminalCallView = { card: 'terminal', title, description?, cwd? }`（:77-93）
- `TerminalResultView = { card: 'terminal', title?, output?, exitCode?, signal? }`（:151-164）
- `ReadResultView = { card: 'read', title?, path, offset, lines: { number, text }[], totalLines, lang?, content? }`（:262-289）
- `SearchResultView`（`shape: 'matches'|'paths'` 两个变体，带 `truncated`/`total`）：:200-249
- `FileLocation = { path, line? }`（编辑器 follow-along 用，:20-23）；`ToolCallKind = 'read'|'edit'|'delete'|'move'|'search'|'execute'|'fetch'|'other'`（:13）

---

## 3. 其他工具：tool/call input 与 tool/result output 摘要

> 通用规律：`tool/result` 事件持久化的只有 `message.content`（渲染文本）+ `error` + `meta`；结构化 output 值只进 `meta`（通过 `presentationMeta`）或由主机 presenter 在派发时从文本/args 重新推导（view 槽）。**shell 类工具的结构化 stdout/stderr/exitCode 不进事件**。

### 3.1 read（dsh-tool-fs）

- input：`{ file_path: string, offset?: number (默认1), limit?: number (默认/上限 2000) }`（`dsh-tool-fs/lib/index.js:335-349`；`dsh-tool-fs/lib/types/read.d.ts:8,37-41`）。
- 渲染文本：`<path>…</path>\n<type>file</type>\n<content>\n<行号>…\n</content>` 信封（`dsh-tool-fs/lib/index.js:444` 的正则）。
- `meta`：`{ path, offset, lines: { number, text }[], totalLines, lang? }`（`dsh-tool-fs/lib/index.js:401-413`），供 `ReadResultView` 展示（`dsh-tools/lib/types/presentation.d.ts:255-261` 注释「read 工具通过 output.presentationMeta 投影」）。

### 3.2 glob / grep（dsh-tool-fs-search）

- glob input：`{ pattern: string, path?: string }`（`dsh-tool-fs-search/lib/types/glob.d.ts:48-51,60-63`）；默认上限 100 条（:18）。
- grep input：`{ pattern: string, path?: string, include?: string }`（`dsh-tool-fs-search/lib/types/grep.d.ts:47-51,61-65`）；默认上限 250 条、行预览 2000 字节（:23,28）。
- 两者 `presentResult` 都从结果的 `presentationMeta` 投影 `SearchResultView`（`shape:'paths'` 或 `shape:'matches'`，带 truncated/total）：`glob.d.ts:123-137`、`grep.d.ts:117-132`；形状见 `dsh-tools/lib/types/presentation.d.ts:179-249`。

### 3.3 bash / pwsh（dsh-tool-bash / dsh-tool-pwsh）

- input（bash 完整 schema）：`{ command: string(必填), description: string(必填), timeoutMs?: number, workdir?: string, run_in_background?: boolean, sandbox_permissions?: string, justification?: string }`（`dsh-tool-bash/lib/index.js:259-296`）。
- output（schema 两个分支）：
  - `{ kind: 'background', jobId: string }`（`dsh-tool-bash/lib/index.js:208-218,403-427`）
  - `{ kind: 'foreground', exitCode: number|null, signal: string|null, timedOut, aborted, timeoutMs, stdout: { text, truncated, spillPath? }, stderr: { text, truncated, spillPath? }, sandbox?: { mode, denied, enforcement?, runnerFailed? } }`（`dsh-tool-bash/lib/index.js:297-380`；`canonicalBashResult` 191-206）
- 但**事件里只有渲染文本**（`[exit code: N]` 标记、sandbox 标记等，见 `dsh-tool-bash/lib/index.js:381-384` render + `dsh-tool-pwsh/lib/types/render.d.ts:14-23`）。`presentBashResult` 从文本解析退出状态再生成 `TerminalResultView`（`dsh-tool-bash/lib/index.js:153-170`）。
- 后台任务运行状态通过 `session/jobs` 帧推送（§4.5）。

### 3.4 subagent（dsh-tool-subagent）

- input：`{ description: string(必填), prompt: string(必填), run_in_background?: boolean }`（`dsh-tool-subagent/lib/index.js:142-157`）。
- output 三个分支：`{ kind: 'background', jobId }` | `{ kind: 'continuable', subagentId }` | `{ kind: 'foreground', runId, output: json[] }`（`dsh-tool-subagent/lib/index.js:158-210`）。

### 3.5 goal（dsh-tool-goal）

- `get_goal`：`parameters: {}`（`dsh-tool-goal/lib/index.js:259-261`）。
- `create_goal`：`{ objective: string(必填), max_goal_rounds?: number }`（:270-290）。
- `update_goal`：`{ goal_id, revision, action: 'edit'|'pause'|'resume'|'complete'|'blocked', objective?, max_goal_rounds?, blocked_reason? }`（:296-368，校验规则见 333-351）。

### 3.6 workflow（dsh-tool-workflow）

- input：`{ script: string(必填), meta: { name(必填), description(必填), whenToUse?, phases?: [{title, detail?, provider?, model?}] }, args?: object }`（`dsh-tool-workflow/lib/index.js:144-206`）。
- output：`{ runId: string, agentsStarted: integer, result: json }`（:207-230）。运行记录另写 `tool-workflow/*` 会话事件（§1.2）。

### 3.7 ask_user_question（dsh-tool-ask-user）

- input：`{ questions: [{ id(必填), question(必填), header?, options?: [{ label(必填), description? }], multi_select? }] }`（`dsh-tool-ask-user/lib/index.js:18-65`）。
- output：`{ answers: [{ id, selected: string[], custom? }] }`（:66-95）。
- **这是「提问」的模型侧入口**：`execute` 调 `ctx.userQuestions.ask()` 阻塞等待人类回答（:96-112），而回答的到达路径见 §4.3。

---

## 4. 提问 / 审批：出现在事件流的哪里？

**答案：两者都不以会话日志事件（session/event）推送，而是 mux 流里的独立帧**（`approval/requested`、`approval/resolved`、`question/requested`、`question/resolved`）。它们是「可应答的 server-request」——`rpcId` 是稳定逻辑 id，客户端通过 `POST /api/respond` 回显 rpcId 应答。

### 4.1 审批（approval）机制

**触发点**：工具执行前的 `tools/pre-execute` 瀑布决定 `ask`（`dsh-tools/lib/types/index.d.ts:418-426` `PreToolDecision`），或 bash/pwsh 的 sandbox 升级（`dsh-tool-bash/lib/index.js:236-252` 调 `ctx.approval`）；审批服务 `request()` 在会话日志写审计对 `approval/asked` + `approval/decided`（`dsh-user-approval/lib/types/index.d.ts:37-51,141-171`）。

**mux 帧（下行）**：

```json
// approval/requested（可应答 server-request；rpcId 由主机现 mint，重连重放时复用）
{
  "type": "server-request", "rpcId": "…",
  "method": "approval/requested",
  "payload": {
    "type": "approval/requested",
    "sessionId": "session-1",
    "approvalId": "appr-…",          // ApprovalRequestId
    "toolName": "bash",              // 关联工具
    "callId": "call_abc123",         // 可选：关联的具体 tool/call
    "reason": "需要更宽沙箱权限"       // 可选：请求方的人类可读理由
  }
}

// approval/resolved（纯推送；outcome 是最终结果）
{
  "type": "server-request", "rpcId": "…",
  "method": "approval/resolved",
  "payload": {
    "type": "approval/resolved",
    "sessionId": "session-1",
    "approvalId": "appr-…",
    "outcome": "allowed-once" | "rejected" | "cancelled" | "unavailable"
  }
}
```

帧类型定义：`dsh-host-apiproxy/lib/types/api/events.d.ts:76-87`（`approval/requested` 76-82、`approval/resolved` 83-87）。`ApprovalOutcome = 'allowed-once'|'rejected'|'cancelled'|'unavailable'`：`dsh-user-approval/lib/types/types.d.ts:23`。主机侧 mint 逻辑（pending 表 + 广播 + rpcId）：`dsh-host-apiproxy/lib/index.js:1926-1978`。

**客户端应答（上行）**：`POST /api/respond`，body：
```json
{
  "type": "client-response",
  "rpcId": "<approval/requested 帧的 rpcId 原样回显>",
  "result": {
    "ok": true,
    "value": {
      "sessionId": "session-1",
      "approvalId": "appr-…",
      "outcome": "allowed-once" | "rejected"   // 客户端只能给这两个值
    }
  }
}
```
来源：`dsh-host-apiproxy/lib/types/api/approvals.d.ts:15-19`（`ApprovalResponsePayload`，注释「cancelled/unavailable 是主机侧 outcome」）；应答路由校验（`approvalId`/`sessionId` 必须与 pending 条目匹配）`dsh-host-apiproxy/lib/index.js:3760-3774`。应答成功后主机广播 `approval/resolved` 帧（:1953-1958），并放行/拒绝该工具调用（`'allowed-once'` 是唯一放行，`dsh-tools/lib/types/index.d.ts:784-794`）。

### 4.2 提问（question）机制

**触发点**：模型调用 `ask_user_question` 工具 → `ctx.userQuestions.ask()`（`dsh-tool-ask-user/lib/index.js:96-112`）→ 主机把 `AskUserQuestionRequest` 桥接为 mux 帧（`dsh-host-apiproxy/lib/index.js:1888-1913` 附近：`pendingQuestions` 表 + `question/requested` 帧，rpcId 为问题稳定 id）。

**mux 帧（下行）**：

```json
// question/requested（可应答 server-request；rpcId = 问题稳定逻辑 id）
{
  "type": "server-request", "rpcId": "…",
  "method": "question/requested",
  "payload": {
    "type": "question/requested",
    "sessionId": "session-1",
    "questions": [
      {
        "id": "q1",                    // 稳定问题 id，答案回显
        "question": "要执行 bash 命令？",
        "header": "Confirm",           // 可选
        "detail": "…",                 // 可选
        "options": [ { "label": "允许 (Recommended)", "description": "…" } ],  // 可选
        "multiSelect": false,          // 可选
        "intent": { "kind": "plan-review", "approve": "批准" }   // 可选
      }
    ]
  }
}

// question/resolved（纯推送）
{
  "type": "server-request", "rpcId": "…",
  "method": "question/resolved",
  "payload": {
    "type": "question/resolved",
    "sessionId": "session-1",
    "questionRpcId": "<原 requested 帧的 rpcId>",
    "outcome": "answered" | "cancelled"
  }
}
```

帧类型定义：`dsh-host-apiproxy/lib/types/api/events.d.ts:88-96`。问题条目结构 `AskUserQuestionItem`：`dsh-user-questions/lib/types/types.d.ts:32-47`（id/question/detail/header/options/multiSelect/intent）；`AskUserQuestionIntent` 目前只有 `plan-review`（:21-30）。schema（wire 校验）：`dsh-host-apiproxy/lib/types/api/events.schema.js:13-25`（`askUserQuestionItemSchema`，`questions` 数组非空 `min(1)` :42）。

**客户端应答（上行）**：`POST /api/respond`，body：
```json
{
  "type": "client-response",
  "rpcId": "<question/requested 帧的 rpcId 原样回显>",
  "result": {
    "ok": true,
    "value": {
      "sessionId": "session-1",
      "answer": {
        "answers": [
          { "id": "q1", "selected": ["允许 (Recommended)"], "custom": "可选自由文本" }
        ]
      }
    }
  }
}
```
来源：`dsh-host-apiproxy/lib/types/api/questions.d.ts:14-17`（`QuestionResponsePayload`，注释「一次回答整个 ask() 批次」）；应答路由：`dsh-host-apiproxy/lib/index.js:3775-3808`（校验 id/selected/custom、`matchesQuestions` 匹配、`claimQuestion(pending, "answered")`）。**取消**：`result.ok: false, error.code: 'cancelled'` 的 client-response 会把该问题标记为 cancelled（:3780-3787）。

**重连恢复**：打开 mux 时重放 pending 的 requested 帧（rpcId 原样）——`dsh-host-apiproxy/lib/types/api/events.d.ts:44-49`；所以 VS Code 扩展断线重连后要按 rpcId 去重/恢复对话框状态。

### 4.3 approval 与 question 是两套独立机制（对比）

| 维度 | approval（审批） | question（提问） |
|---|---|---|
| 模型侧入口 | `tools/pre-execute` 的 `ask` 决策 / sandbox 升级（无独立工具） | `ask_user_question` 工具 |
| 会话日志 | 有：`approval/asked` + `approval/decided` 审计对（`dsh-user-approval/lib/types/index.d.ts:37-51`） | 无对应日志事件 |
| mux 下行帧 | `approval/requested`（带 `approvalId`/`toolName`/`callId?`/`reason?`）→ `approval/resolved` | `question/requested`（带 `questions[]`）→ `question/resolved`（`outcome: answered\|cancelled`） |
| 应答载荷 | `{ sessionId, approvalId, outcome: 'allowed-once'\|'rejected' }` | `{ sessionId, answer: { answers: [{ id, selected, custom? }] } }` |
| 应答通道 | 均 `POST /api/respond` + 回显 rpcId（`dsh-host-apiproxy/lib/types/fetch/handler.js:220-225`） | 同左 |
| 客户端可给 outcome | `allowed-once` / `rejected`（`dsh-host-apiproxy/lib/types/api/approvals.d.ts:15-19`） | `answered`（ok）/ `cancelled`（error.code==='cancelled'） |
| resolved 帧 | 广播 4 值 outcome（含主机侧 `cancelled`/`unavailable`） | 广播 `answered`/`cancelled` |

---

## 5. assistant 文本如何流式到达

**两阶段：先逐块 `assistant/chunk`，收齐后一条 `assistant/message`。**

1. 每个流式块（`StreamChunk`）追加一条 `assistant/chunk` 事件（`seq` 连续，全部记录）：
   ```json
   { "type": "assistant/chunk", "seq": 14, "time": …,
     "data": { "turn": 3, "step": 1, "chunk": { "type": "text-delta", "index": 0, "text": "你" } } }
   ```
   `StreamChunk` 判别字段 `type`：`block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage | finish`（`dsh-llm/lib/types/types.d.ts:287-317`）。注意 `tool-call-delta` 带 `id`/`name?`/`argumentsDelta`——**工具调用的参数也是增量流式到达的**。
2. 组装完成后追加一条 `assistant/message`，`sourceEventSeqs` 列出全部 chunk seq：
   ```json
   { "type": "assistant/message", "seq": 15, "time": …,
     "surfaceOp": "append", "sourceEventSeqs": [14],
     "data": {
       "turn": 3, "step": 1,
       "message": {
         "id": "msg-…", "role": "assistant",
         "source": { "kind": "model", "provider": "deepseek", "model": "deepseek-chat" },
         "content": [ { "type": "text", "text": "你好" } ]
       },
       "usage": { "inputTokens": 120, "outputTokens": 42, "cacheReadTokens": 0 }   // adapter 报告时才有
     } }
   ```
   写入点：`dsh-agent-loop/lib/index.js:618-658`（`chunkSeqs.push(append("assistant/chunk", …))` :620-624；`append("assistant/message", …, { surfaceOp: "append", sourceEventSeqs: chunkSeqs })` :650-658）。

`Message` 形状：`dsh-llm/lib/types/message.d.ts:120-144`（`{ id, role, content: ContentBlock[], source }`）；`ContentBlock` 判别 `type`：`text | reasoning | image | tool-call | tool-result`（`dsh-llm/lib/types/types.d.ts:38-89`）；`TokenUsage = { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }`（:123-129）。

**对 VS Code 扩展的启示**：
- 若只要最终文本，订阅 `assistant/message`（`data.message.content` 里 `type==='text'` 的块，`reasoning` 块是思考内容）。
- 若要做流式打字机效果，订阅 `assistant/chunk` 并累积 `text-delta`/`reasoning-delta`（按 `index` 区分块）。
- `assistant/message` 的 `sourceEventSeqs` 与 `assistant/chunk` 的 seq 可互查。

---

## 6. 其他 mux 帧（session/queue、session/jobs、session/projection、session/subscribed、stream/error）

完整 `MuxFrame` 联合：`dsh-host-apiproxy/lib/types/api/events.d.ts:66-145`；wire schema：`dsh-host-apiproxy/lib/types/api/events.schema.js:34-58`。

### 6.1 session/subscribed（订阅基线）
```json
{ "type": "session/subscribed", "sessionId": "session-1", "lastSeq": 42 }
```
来源：`events.d.ts:72-75`。`lastSeq` 是已提交事件的最后一个 seq（空日志为 -1，与 history 投影的 `asOfSeq` 对齐，见 `sessions.d.ts:75-80`）。

### 6.2 session/queue（队列快照，全量替换）
```json
{ "type": "session/queue", "sessionId": "session-1",
  "items": [ { "id": "msg-…", "placement": "queued" | "steering" | "context",
               "message": { "id": "…", "role": "user", "content": [ { "type": "text", "text": "…" } ], "source": { "kind": "user" } } } ] }
```
- 每次入队/编辑/删除/认领/丢弃后推**全量快照**（无持久事件，重连靠它收敛）：`events.d.ts:34-42,98-109`；`QueuedInboxItem.placement` 语义 `events.d.ts:39`（queued 在 QueueDock、steering 在对话尾部、context 不可见直到被认领）。
- 消息入队：客户端 `POST /api/session.prompt`，payload `{ sessionId, mode: 'queue'|'steer', content: PromptContentPart[], clientTimeZone? }`（`sessions.d.ts:365-376`；`PromptContentPart` 81-90）。`/` 开头纯文本会走 slash 命令（:332-337）。
- 队列项编辑/删除/steer：`POST /api/session.updateQueue` `{ sessionId, itemId, action: { kind: 'edit', content } | { kind: 'remove' } | { kind: 'steer' } }`（`sessions.d.ts:389-395,164-171`）。

### 6.3 session/jobs（后台任务快照，全量替换）
```json
{ "type": "session/jobs", "sessionId": "session-1",
  "jobs": [ { "id": "bash-3", "kind": "bash", "label": "npm install",
              "status": "running" | "stopping" | "completed" | "killed" | "failed",
              "detail": "exit code: 3", "startedAt": 1720000000000, "finishedAt": 1720000000001 } ] }
```
- `JobView`：`dsh-host-apiproxy/lib/types/api/jobs.d.ts:15-34`（`id` 为 `<kind>-N`；kind 是裸字符串 `bash`/`pwsh`/`pty-send`/`subagent` 等）。全量快照语义：`events.d.ts:110-127`。

### 6.4 session/projection（投影值变化推送）
```json
{ "type": "session/projection", "sessionId": "session-1", "key": "title",
  "value": "修复登录 bug", "seq": 42 }
```
- 推状态（live push，不持久化；`seq` 是发射时的水位，客户端按「更高 seq 胜」维护每 session 值表）：`events.d.ts:128-141`；`value` 已通过所属域的 schema 校验（schema 里 `z.unknown()` :56）。
- 已知 projection key（各域声明合并进 `SessionProjectionMap`，`dsh-session-projection/lib/types/types.d.ts:16`）：
  - `title: string | null`（`dsh-session-title/lib/types/types.d.ts:12-19`）
  - `todos: TodoItem[] | null`（`dsh-tool-todo/lib/types/types.d.ts:12-21`）
  - `sessionStats: { turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }`（`dsh-session-stats/lib/types/types.d.ts:18-35,37-41`）
  - `goal: GoalProjection | null`（`{ goal: { goalId, objective, phase: 'active'|'paused'|'blocked'|'complete', blockedReason?, maxGoalRounds }, roundsStarted, createdAt, updatedAt }`）（`dsh-goal/lib/types/types.d.ts:59-68,75-94`）
  - `plan: { active: boolean, pending: boolean }`（`dsh-plan-mode/lib/types/types.d.ts:17-26`）
  - `sessionListMetadata: { blank: boolean, lastPromptAt: number|null }`、`imageLimits`（`dsh-host-apiproxy/lib/types/api/sessions.d.ts:34-39,15-31`）
  - 另有 `permission-presets`、`subagent`、`token-meter` 域（`dsh-permission-presets/lib/types/types.d.ts:32`、`dsh-subagent/lib/types/projection-types.d.ts:45`、`dsh-token-meter/lib/types/projection.d.ts:65`，未展开）。

### 6.5 stream/error
```json
{ "type": "stream/error", "error": { "code": "internal", "message": "…", "details": {} } }
```
来源：`events.d.ts:142-145`；客户端遇到该帧即断开重连（`dsh-client-connection/lib/client.js:130`）。`RpcError` 形状：`dsh-host-apiproxy/lib/types/api/rpc.d.ts:181-187`。

---

## 7. 附录：给 VS Code 扩展的实现要点

1. **连接**：WebSocket `ws://127.0.0.1:65164/api/events.mux`（或 SSE `GET`），帧即 §0.2 的 `server-request` 全形；上行全部走 HTTP（`POST /api/…`），WebSocket 只收不发（`dsh-client-connection/lib/index.js:429-431`「Client messages are a protocol violation」）。
2. **写文件实时反映**：监听 `method === 'session/event'` 且 `payload.event.type === 'tool/result'` 且 `payload.event.data.message.content[0].type === 'tool-result'` 的事件；若该事件属于 `write`/`edit`（需与 `tool/call` 按 `callId` 配对，或从 `payload.view` 判断），用 `payload.event.data.meta.diffs`（`FileDiff[]`，含 oldText/newText hunk）做 diff 展示；`meta.diffs === []` 且为 write 时整文件新建（新内容在 `tool/call` 的 `arguments.content`）。
   - 配对：`tool/call` 的 `callId` ↔ `tool/result` 的 `message.source.callId`（`dsh-llm/lib/types/message.d.ts:22-25` `ToolMessageSource`；`ToolResultBlock.toolCallId` 同值 `dsh-llm/lib/types/types.d.ts:69-74`）。
3. **提问 → VS Code 原生对话框**：收到 `method === 'question/requested'` 时用 `payload.questions[]`（id/question/options/…）弹输入框；用户确认后 `POST /api/respond`，body 为 §4.2 的 client-response（`rpcId` 回显帧的 rpcId，`result.value = { sessionId, answer: { answers: [{ id, selected, custom? }] } }`）。
4. **审批 → VS Code 原生确认框**：收到 `method === 'approval/requested'` 时展示 `payload.toolName`/`reason`；确认 → `POST /api/respond`（`result.value = { sessionId, approvalId, outcome: 'allowed-once' }`），拒绝 → `'rejected'`。随后会收到 `approval/resolved` 帧确认结果。
5. **断线重连**：重连后主机重放 pending 的 requested 帧（rpcId 不变）——对话框要按 rpcId 幂等（已处理的不要重复弹）。
6. **文件路径**：事件里 `file_path`/`path` 是模型面路径（相对或绝对，按会话 `header.cwd` 解析；`tool-call-model.d.ts:28-33` 注释「chat view resolves relative values against the session cwd」）。会话 cwd 可从 `session.list` 或 host 帧 `host/session-added.cwd` 获得（`events.d.ts:163-170`）。

---

## 8. 主要来源文件索引（全部位于 vendor\node_modules\@deepseek-ai\ 下）

| 主题 | 文件（相对包路径） |
|---|---|
| SessionEvent 联合 / SessionEventMap | `dsh-session/lib/types/types.d.ts` |
| session/event 事件钩子 / Session API | `dsh-session/lib/types/index.d.ts` |
| surface 机制（surfaceOp / sourceEventSeqs） | `dsh-session/lib/types/surface.d.ts` |
| 已知事件类型集合 | `dsh-session/lib/types/known-event-types.d.ts` |
| MuxFrame / HostFrame / ToolEventView | `dsh-host-apiproxy/lib/types/api/events.d.ts` |
| 帧 wire schema | `dsh-host-apiproxy/lib/types/api/events.schema.js` |
| RPC 消息模型 / RpcMethodMap | `dsh-host-apiproxy/lib/types/api/rpc.d.ts`、`rpc-map.d.ts` |
| HTTP 路由 / /api/respond | `dsh-host-apiproxy/lib/types/fetch/handler.js` |
| respond 路由实现（审批/提问应答） | `dsh-host-apiproxy/lib/index.js`（:3760-3809） |
| WebSocket 下行帧编码 | `dsh-client-connection/lib/index.js`（:336-355） |
| Message / UserMessage / AssistantMessage / ToolResultMessage | `dsh-llm/lib/types/message.d.ts` |
| ContentBlock / StreamChunk / TokenUsage / ToolSchema | `dsh-llm/lib/types/types.d.ts` |
| write/edit/read 工具注册与 schema | `dsh-tool-fs/lib/index.js` |
| FsDiffMeta / computeHunkDiffs | `dsh-tool-fs/lib/types/diff.d.ts` |
| FsWriteOutcome / FsEditOutcome | `dsh-fs/lib/types/types.d.ts` |
| ToolCallView / ToolResultView / FileDiff | `dsh-tools/lib/types/presentation.d.ts` |
| ToolDefinition / ToolResult / value 不进事件 | `dsh-tools/lib/types/index.d.ts` |
| bash 工具 schema/output | `dsh-tool-bash/lib/index.js` |
| glob / grep 工具 | `dsh-tool-fs-search/lib/types/glob.d.ts`、`grep.d.ts` |
| subagent / goal / workflow / ask_user_question | 各 `dsh-tool-*/lib/…` |
| 审批服务与审计事件 | `dsh-user-approval/lib/types/index.d.ts`、`types.d.ts` |
| 提问服务与 wire 类型 | `dsh-user-questions/lib/types/index.d.ts`、`types.d.ts` |
| 会话队列/历史/提示 API | `dsh-host-apiproxy/lib/types/api/sessions.d.ts` |
| JobView | `dsh-host-apiproxy/lib/types/api/jobs.d.ts` |
| 投影 key 声明 | `dsh-session-projection/lib/types/types.d.ts` + 各域 `types.d.ts` |
| assistant/chunk + assistant/message 写入 | `dsh-agent-loop/lib/index.js`（:618-658） |
| 客户端 diff 卡片消费 | `dsh-client-ui-tool/lib/client.js`（:232-288）、`lib/types/client/tool/models/diff-card-model.d.ts` |

> 未找到/未覆盖：`dsh-agent-tool-presentation` 只是「工具展示模式选择器」（native/code/both），不含事件结构（`dsh-agent-tool-presentation/lib/types/index.d.ts:1-50`）；`dsh-session-query` 是本地搜索库与事件流无关。若未来版本新增事件类型，以 `KNOWN_SESSION_EVENT_TYPES`（`dsh-session/lib/types/known-event-types.d.ts:18`）为准。
