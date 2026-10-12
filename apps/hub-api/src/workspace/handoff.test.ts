import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://x";
const { bundledCodex, handoffOpen, handoffPrompt, newMarker, openLink } = await import("./handoff.js");

test("the prompt carries the task and the marker that links the agent's session", () => {
  const marker = newMarker();
  assert.match(marker, /^ens-[0-9a-f]{10}$/);
  const prompt = handoffPrompt({ title: "Fix the login bug", description: "Users see a 500.", instructions: "Keep the API stable.", marker });
  assert.ok(prompt.startsWith("Fix the login bug\n\nUsers see a 500.\n\nInstructions: Keep the API stable."));
  assert.ok(prompt.includes(`Ensemble task ${marker}`));
  // Long tasks are cut before the marker, never the marker itself (Claude's link holds about 14,000 characters).
  const long = handoffPrompt({ title: "x".repeat(20_000), marker }, 100);
  assert.ok(long.includes(marker) && long.length < 400);
});

test("each app is opened on the folder with the prompt", () => {
  const claude = handoffOpen("claude", "/work/my app", "Do it & check");
  assert.equal(claude.url, "claude://code/new?folder=%2Fwork%2Fmy%20app&q=Do%20it%20%26%20check");
  assert.match(handoffOpen("codex", "/w", "p").url!, /^codex:\/\/new\?path=%2Fw&prompt=p$/);
  const cursor = handoffOpen("cursor", "/w", "p");
  assert.deepEqual(cursor.commands, [["cursor", "/w"]], "Cursor's prompt link has no folder, so the folder opens first");
  const vscode = handoffOpen("vscode", "/w", "p");
  assert.equal(vscode.url, null);
  assert.deepEqual(vscode.commands, [["code", "-n", "/w"], ["code", "chat", "-r", "-m", "agent", "p"]]);
});

test("links open with the system's own handler", { skip: process.platform === "linux" ? "xdg-open may not be installed" : false }, async () => {
  const calls: Array<[string, string[]]> = [];
  await openLink({ url: "claude://code/new?q=x", commands: [] }, async (command, args) => void calls.push([command, args]));
  const [command, args] = calls[0]!;
  if (process.platform === "darwin") assert.equal(command, "/usr/bin/open");
  if (process.platform === "win32") assert.equal(command, "rundll32.exe");
  assert.equal(args.at(-1), "claude://code/new?q=x");
});

test("the Codex the ChatGPT app ships is found where the app keeps it", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  assert.equal(bundledCodex("darwin", home, {}), existsOnThisMac() ? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex" : null);
  const local = join(home, "AppData", "Local");
  const exe = join(local, "OpenAI", "Codex", "bin", "0123abcd", "codex.exe");
  mkdirSync(join(exe, ".."), { recursive: true });
  writeFileSync(exe, "");
  assert.equal(bundledCodex("win32", home, { LOCALAPPDATA: local }), exe);
  assert.equal(bundledCodex("win32", mkdtempSync(join(tmpdir(), "codex-empty-")), {}), null);
});

function existsOnThisMac(): boolean {
  return existsSync("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex");
}

test("a command-line tool starts in a terminal on the folder, with the prompt passed literally", { skip: process.platform === "win32" }, async () => {
  const { handoffOpen, terminalScript, handoffTargets } = await import("./handoff.js");
  const { execFileSync } = await import("node:child_process");
  const prompt = `Fix it's "bug" $(rm -rf ~) \`x\`\nsecond line`;
  const open = handoffOpen("copilot-cli", "/tmp", prompt, "/bin/echo");
  assert.deepEqual(open.terminal, { folder: "/tmp", program: "/bin/echo", args: ["-i", prompt] });
  const dir = mkdtempSync(join(tmpdir(), "handoff-script-"));
  const script = join(dir, "task.sh");
  writeFileSync(script, terminalScript("darwin", { folder: dir, program: "/bin/echo", args: [prompt] }), { mode: 0o700 });
  assert.equal(execFileSync("/bin/sh", [script], { encoding: "utf8" }), `${prompt}\n`, "nothing in the prompt is run by the shell");
  assert.equal(terminalScript("win32", { folder: "C:\\work\\it's", program: "C:\\bin\\claude.exe", args: ["say 'hi'"] }), "Set-Location -LiteralPath 'C:\\work\\it''s'; & 'C:\\bin\\claude.exe' 'say ''hi'''");
  const targets = handoffTargets(
    [
      { id: "claude", name: "Claude", app: true, cli: null },
      { id: "codex", name: "Codex", app: false, cli: null },
      { id: "cursor", name: "Cursor", app: false, cli: "/bin/cursor-agent" },
      { id: "vscode", name: "VS Code", app: false, cli: null },
      { id: "copilot", name: "Copilot", app: false, cli: "/bin/copilot" },
    ],
    true,
  );
  assert.deepEqual(targets.map((target) => target.id), ["claude", "codex-cli", "cursor-cli", "copilot-cli"], "the ChatGPT app's codex runs in a terminal too");
});
