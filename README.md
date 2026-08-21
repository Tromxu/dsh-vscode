# DSH Agent for VS Code

A **native VS Code agent** that drives the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) runtime (MIT). Click the **DSH** icon in the activity bar, chat with the agent, and **watch it work in your editor**: files get edited live (undoable, shown in SCM diff), commands appear in an integrated terminal, permission requests use native dialogs — the Codex-style experience, powered by DeepSeek (or any model DSH supports).

> Not an official DeepSeek product — a community integration. Requires a locally installed DeepSeek Harness desktop app.

## Features

- **Sidebar chat UI** (activity bar icon) streaming assistant text token-by-token (`assistant/chunk`)
- **Progress panel** — always-visible status while the agent works: task list + progress bar (from `todo/write` events), the current action (latest tool call), and a **package preview** showing build artifacts (`.vsix`/`.exe`/`.zip`/…) with an *open* button
- **Full-pipeline team command** (`DSH: 全流程开发（产品→发布）`) — one command runs a complete software delivery flow: *product design → development → testing → packaging/release*, with the agent maintaining a visible todo checklist through all phases
- **Live editor integration**: file writes/edits from the agent are applied to the editor as `WorkspaceEdit`s (undoable, visible in Source Control) using the runtime's own diff payloads (`tool/result.meta.diffs`)
- **Integrated terminal mirror**: commands the agent runs are shown in a read-only "DSH 命令" terminal (execution stays inside the dsh sandbox — safer)
- **Native permission dialogs**: approval and question requests render as VS Code dialogs and answer back over the wire
- **Tool-call cards** in the chat (diff previews, terminal views, follow-along file opens)
- **Headless quick task** (`DSH: 快速任务`) for one-shot jobs without opening the panel

## Architecture

```
[Sidebar chat view] <-> [NativeBridge] <-> [SessionClient] <-> [dsh web runtime]
                                        (HTTP POST /api + WS events.mux / events.host)

NativeBridge maps session events to native VS Code actions:
  file diffs   -> WorkspaceEdit (editor)
  commands     -> read-only mirror terminal
  approvals    -> native dialog -> POST /api/respond
  questions    -> native QuickPick -> POST /api/respond
  assistant    -> token-level streaming (assistant/chunk text-delta)
```

The extension speaks the dsh web wire protocol directly (no embedded browser):
- Unary RPC: `POST /api/<method>` (`session.create`, `session.prompt`, `session.cancel`, `credentials.set`, …)
- Downlinks: `ws://127.0.0.1:<port>/api/events.mux` and `/api/events.host`
- Answers: `POST /api/respond` (RpcReceipt)

Detailed protocol documentation (reverse-engineered from the MIT-licensed DSH source):
- [`docs/protocol-rpc.md`](docs/protocol-rpc.md) — envelope, methods, trust fence
- [`docs/protocol-events.md`](docs/protocol-events.md) — session events, diffs, approvals/questions

## Requirements

- **DeepSeek Harness desktop** installed locally (the runtime this extension drives; the repo links it in the same way the desktop app does). The install location is auto-detected (env `DSH_HARNESS`, then standard install paths) or set via `dsh.harnessRoot`.
- VS Code ≥ 1.90
- Node.js ≥ 18 for building

## Install (build the .vsix yourself)

```powershell
npm install                 # fetches ws (or rely on the vendoring fallback)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package.ps1
code --install-extension dsh-vscode-0.3.0.vsix
```

## Quick start

1. Open your project folder in VS Code (the agent's file scope = this folder).
2. Click the **DSH** icon in the activity bar. The panel auto-starts the runtime and shows `已连接 · http://127.0.0.1:<port>/`.
3. First time: `Ctrl+Shift+P` → **`DSH: 配置 DeepSeek API Key`** and paste a key from [platform.deepseek.com](https://platform.deepseek.com) (stored in the DSH credential store).
4. Send a task, e.g. *"fix the bug in src and run the tests until they pass"* — or run the full pipeline:
   `Ctrl+Shift+P` → **`DSH: 全流程开发（产品→发布）`**, describe your software idea, and watch the four phases (design → dev → test → package) advance in the progress panel.

## Commands

| Command | Description |
|---|---|
| `DSH: 打开智能体会话` | Open/activate the sidebar chat (also the activity bar icon) |
| `DSH: 全流程开发（产品→发布）` | Run the full software delivery pipeline: product design → development → testing → packaging/release |
| `DSH: 配置 DeepSeek API Key` | Store `DEEPSEEK_API_KEY` into the DSH credential store |
| `DSH: 快速任务（无头模式）` | Run one headless task (`dsh --profile headless "…"`), output to the log panel |
| `DSH: 停止运行时` | Stop the embedded runtime |
| `DSH: 查看运行日志` | Show the runtime log |
| `DSH: 打开 Web 面板（旧版）` | Legacy embedded web GUI panel (fallback) |

## Settings

| Setting | Default | Description |
|---|---|---|
| `dsh.harnessRoot` | auto-detect | DeepSeek Harness install dir (env `DSH_HARNESS` wins) |
| `dsh.nodePath` | auto | Bundled `node.exe` path |
| `dsh.dshHome` | isolated | DSH data dir; set to the desktop app's `dsh-home` to reuse its config/keys (close the desktop app first) |
| `dsh.port` | `0` (free) | Web service port |
| `dsh.bootTimeoutSec` | `120` | Boot timeout |
| `dsh.approveCommands` | `true` | Ask via native dialog before privileged commands (auto-allow when off) |
| `dsh.autoOpen` | `false` | Auto-open the chat view on VS Code startup |

## Security notes

- The agent has full read/write/exec access to your workspace folder — use it on trusted projects and watch it.
- Commands execute inside the dsh sandbox; the terminal you see is a read-only mirror.
- API keys never leave the DSH credential store (`DSH_HOME`).

## Development & tests

- `test/bridge-test.js` — NativeBridge unit tests (9 cases, vscode stubbed)
- `test/extension-host-test.js` — real extension-host activation test (isolated `--user-data-dir`)
- `scripts/e2e-protocol-test.js` — protocol E2E against a real runtime (no API key needed; expects `model-unavailable`)
- `scripts/e2e-full-loop-test.js` — full agent loop with a real model (uses the desktop app's config via `DSH_REAL_HOME`)

## License

[MIT](LICENSE). Acknowledgments: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT), [`ws`](https://github.com/websockets/ws) (MIT).
