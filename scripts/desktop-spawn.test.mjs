import assert from "node:assert/strict";
import { test } from "node:test";
import { quoteForCmd, resolveCommand, run, windowsCommandLine } from "./desktop-spawn.mjs";

test("windows resolves a PATH shim before guessing .cmd", () => {
  const program = resolveCommand("pnpm", {
    platform: "win32",
    path: "C:\\tools;C:\\pnpm",
    exists(candidate) {
      return candidate === "C:\\pnpm\\pnpm.cmd";
    },
  });
  assert.equal(program, "C:\\pnpm\\pnpm.cmd");
});

test("windows prefers an exe over a cmd shim", () => {
  const program = resolveCommand("pnpm", {
    platform: "win32",
    path: "C:\\pnpm",
    exists(candidate) {
      return candidate.endsWith("pnpm.exe") || candidate.endsWith("pnpm.cmd");
    },
  });
  assert.equal(program, "C:\\pnpm\\pnpm.exe");
});

test("cmd quoting keeps spaces, quotes, percents, and a trailing slash", () => {
  assert.equal(quoteForCmd("C:\\Program Files\\pnpm.cmd"), '"C:\\Program Files\\pnpm.cmd"');
  assert.equal(quoteForCmd('say "hi"'), '"say ""hi"""');
  assert.equal(quoteForCmd("100%"), '"100%%"');
  assert.equal(quoteForCmd("C:\\tools\\"), '"C:\\tools\\\\"');
  assert.equal(
    windowsCommandLine("C:\\Program Files\\pnpm.cmd", ["--filter", "@ensemble/hub-web", "deploy", "D:\\a\\ensemble app"]),
    '"C:\\Program Files\\pnpm.cmd" "--filter" "@ensemble/hub-web" "deploy" "D:\\a\\ensemble app"',
  );
});

test("windows keeps an explicit executable", () => {
  assert.equal(resolveCommand("C:\\node\\node.exe", { platform: "win32", exists: () => false }), "C:\\node\\node.exe");
});

test("other platforms leave the command alone", () => {
  assert.equal(resolveCommand("pnpm", { platform: "linux", exists: () => true }), "pnpm");
});

test("a missing command prints the spawn error", () => {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const code = run("ensemble-no-such-command-xyz", [], { stdio: "pipe" });
    assert.notEqual(code, 0);
  } finally {
    console.error = original;
  }
  assert.match(lines.join("\n"), /Could not start ensemble-no-such-command-xyz/);
});
