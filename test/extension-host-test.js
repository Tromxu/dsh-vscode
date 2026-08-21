"use strict";
/**
 * extension-host-test.js — 在真实 VS Code 扩展宿主中激活 local.dsh-vscode 并校验。
 *
 * 注意：不要在本测试里 require 扩展主文件 src/extension.js——测试框架与 VS Code
 * 扩展加载器共用 require 缓存会导致 ext.exports 映射为 undefined（已知怪癖）。
 * 改为：诊断支撑模块加载 + 激活后校验 6 个命令真实注册（命令注册即 activate() 完整跑通）。
 *
 * 运行：
 *   code --user-data-dir=<隔离目录> --extensionDevelopmentPath=<项目> \
 *        --extensionTestsPath=<本项目 test/extension-host-test.js> <项目>
 * 结果写入 .smoke/host-test-result.json。
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const MARKER = path.join(__dirname, "..", ".smoke", "host-test-result.json");

async function run() {
  const result = { ok: false, error: null, cmds: [], debug: { loaded: [], loadErrors: [] } };
  try {
    // 1) 支撑模块加载诊断（不含主文件，避免导出映射怪癖）
    const extRoot = path.resolve(__dirname, "..");
    for (const mod of ["src/runtime.js", "src/webview.js", "src/chat-webview.js", "src/session-client.js", "src/bridge.js"]) {
      try {
        require(path.join(extRoot, mod));
        result.debug.loaded.push(mod);
      } catch (e) {
        result.debug.loadErrors.push({ mod, error: String((e && e.stack) || e) });
      }
    }
    assert.strictEqual(result.debug.loadErrors.length, 0, "支撑模块加载失败: " + JSON.stringify(result.debug.loadErrors));

    // 2) 激活扩展
    const ext = vscode.extensions.getExtension("local.dsh-vscode");
    assert.ok(ext, "local.dsh-vscode 未加载到扩展宿主");
    if (!ext.isActive) await ext.activate();
    assert.strictEqual(ext.isActive, true, "激活后 isActive 仍为 false");
    result.debug.activatedOk = true;

    // 3) 命令注册校验（activate() 完整执行的直接证据）
    const cmds = await vscode.commands.getCommands(true);
    result.cmds = cmds;
    for (const c of ["dsh.openChat", "dsh.setApiKey", "dsh.openPanel", "dsh.quickTask", "dsh.stop", "dsh.openLog"]) {
      assert.ok(cmds.includes(c), "命令未注册: " + c);
    }

    // 4) 视图容器声明
    assert.ok(
      ext.packageJSON.contributes.viewsContainers.activitybar.some((v) => v.id === "dsh"),
      "activity bar 容器缺失"
    );

    result.ok = true;
  } catch (e) {
    result.error = String((e && e.stack) || e);
  }
  fs.mkdirSync(path.dirname(MARKER), { recursive: true });
  fs.writeFileSync(MARKER, JSON.stringify(result, null, 2));
  console.log("[extension-host-test] " + (result.ok ? "PASS" : "FAIL"));
  if (!result.ok) throw new Error("extension-host-test FAILED: " + result.error);
}

module.exports = { run };
