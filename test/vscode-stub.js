"use strict";
/**
 * vscode-stub.js — 最小 vscode 模块桩，用于在纯 Node 中单测 bridge.js。
 */
const path = require("node:path");

class EventEmitter {
  constructor() {
    this._handlers = [];
  }
  get event() {
    return (handler) => {
      this._handlers.push(handler);
      return () => {
        this._handlers = this._handlers.filter((h) => h !== handler);
      };
    };
  }
  fire(value) {
    for (const h of [...this._handlers]) h(value);
  }
  dispose() {}
}

class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

class WorkspaceEdit {
  constructor() {
    this._entries = [];
  }
  replace(uri, range, newText) {
    this._entries.push({ uri, range, newText });
  }
}

const state = {
  applyEditCalls: [],
  createdTerminals: [],
  openedDocuments: [],
  warningCalls: [],
  quickPickCalls: [],
  warningResult: "允许一次",
  quickPickResult: null,
  docContents: new Map(), // fsPath -> text
  workspaceFolders: [],
};

const Uri = {
  file(p) {
    return { fsPath: p, path: p, scheme: "file" };
  },
  joinPath(u, ...parts) {
    return Uri.file(path.join(u.fsPath, ...parts));
  },
};

const workspace = {
  workspaceFolders: null, // 由测试设置
  async openTextDocument(uri) {
    state.openedDocuments.push(uri);
    const key = uri.fsPath;
    return {
      uri,
      getText: () => state.docContents.get(key) || "",
      positionAt: (idx) => ({ idx, line: 0, character: idx }),
    };
  },
  async applyEdit(edit) {
    state.applyEditCalls.push(edit);
    return true;
  },
  getConfiguration() {
    return { get: (k, dflt) => (k === "approveCommands" ? true : dflt) };
  },
};

const window = {
  createTerminal(opts) {
    const term = {
      name: opts.name,
      show: () => {},
      dispose: () => {},
      pty: opts.pty,
      writes: [],
    };
    // 把 pty 的 onDidWrite 桥到 term.writes，便于断言
    if (opts.pty) {
      const ev = new EventEmitter();
      opts.pty.onDidWrite = ev.event;
      term._writeEmitter = ev;
    }
    state.createdTerminals.push(term);
    return term;
  },
  async showTextDocument(doc, opts) {
    state.openedDocuments.push({ doc, opts });
    return { document: doc };
  },
  showWarningMessage(message, opts, ...items) {
    state.warningCalls.push({ message, items });
    return Promise.resolve(state.warningResult);
  },
  showQuickPick(items, opts) {
    state.quickPickCalls.push({ items, opts });
    return Promise.resolve(state.quickPickResult);
  },
};

module.exports = { EventEmitter, Range, WorkspaceEdit, Uri, workspace, window, state };
