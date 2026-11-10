/** npm's Windows shims read as the script they run (workspace/policy.ts, hostLaunch), so ACP agents installed with npm start without a shell. */
import "../runtime/test-env.js";
import assert from "node:assert/strict";
import test from "node:test";

const { npmShimTarget } = await import("./policy.js");

test("an npm .cmd shim names the script beside it; anything else is not a shim", () => {
  const shim = [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@qwen-code\\qwen-code\\cli.js" %*',
  ].join("\r\n");
  assert.equal(npmShimTarget(shim, "/npm/qwen.cmd"), "/npm/node_modules/@qwen-code/qwen-code/cli.js");
  assert.equal(npmShimTarget('"%~dp0\\node_modules\\opencode-ai\\bin\\opencode.exe" %*', "/npm/opencode.cmd"), "/npm/node_modules/opencode-ai/bin/opencode.exe");
  assert.equal(npmShimTarget("@echo off\r\npython -m vibe %*", "/x/vibe.cmd"), null);
});
