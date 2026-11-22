/**
 * An assistant turn run by a stand-in `claude` on PATH, end to end on this computer: the real
 * command line, Ensemble's MCP server started from the turn's config, its tools listed and called
 * through the loopback API with the turn's secret, a playbook's tools arriving with
 * `notifications/tools/list_changed`, the reply streamed and the result read. Needs a loopback
 * port (CI); sandboxes without local listening skip it.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import Fastify from "fastify";
import { engineRoutes } from "../routes/engine.js";
import { localApiUrl, setLocalPort } from "../workspace/engines/registry.js";
import { PARK_STOP, runAgentTurn } from "./agents.js";
import type { OwnAsk } from "./bridge.js";

const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const args = process.argv.slice(2);
const after = (flag) => args[args.indexOf(flag) + 1];
const say = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let prompt = "";
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", async () => {
  const config = JSON.parse(readFileSync(after("--mcp-config"), "utf8")).mcpServers.ensemble;
  const server = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map();
  const notes = [];
  createInterface({ input: server.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined && waiting.has(message.id)) waiting.get(message.id)(message);
    else if (message.method) notes.push(message.method);
  });
  let next = 0;
  const ask = (method, params) => new Promise((resolve) => {
    const id = ++next;
    waiting.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await ask("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } });
  const listed = (await ask("tools/list", {})).result.tools.map((tool) => tool.name);
  const howTo = (await ask("tools/call", { name: "hub_how_to", arguments: { name: "diagrams" } })).result.content[0].text;
  const relisted = (await ask("tools/list", {})).result.tools.map((tool) => tool.name);
  const used = (await ask("tools/call", { name: "hub_use_tool", arguments: { name: "hub_create_diagram", input: { title: "Flow" } } })).result;
  server.stdin.end();
  writeFileSync(process.env.STANDIN_LOG, JSON.stringify({
    args,
    system: readFileSync(after("--system-prompt-file"), "utf8"),
    prompt,
    listed,
    howTo,
    relisted,
    used,
    notes,
    keys: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ENSEMBLE_DESKTOP_TOKEN"].filter((name) => process.env[name]),
  }));
  say({ type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-test" });
  say({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Drew " } } });
  say({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "it." } } });
  say({ type: "result", subtype: "success", is_error: false, result: "Drew it.", total_cost_usd: 0, usage: { input_tokens: 40, output_tokens: 4 } });
});
`;

test("Claude Code runs an assistant turn with only Ensemble's tools, called through the turn's bridge", { timeout: 120_000 }, async (t) => {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ensemble-subscription-turn-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(join(bin, "claude"), 0o755);
  const log = join(root, "standin.json");
  const saved = { PATH: process.env.PATH, ENSEMBLE_DESKTOP: process.env.ENSEMBLE_DESKTOP, STANDIN_LOG: process.env.STANDIN_LOG, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.ENSEMBLE_DESKTOP = "1";
  process.env.STANDIN_LOG = log;
  process.env.ANTHROPIC_API_KEY = "sk-must-not-reach-claude";
  const app = Fastify();
  await app.register(engineRoutes);
  try {
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("this sandbox does not allow a loopback port");
      throw error;
    }
    setLocalPort((app.server.address() as { port: number }).port);
    const calls: Array<{ name: string; input: unknown }> = [];
    const deltas: string[] = [];
    const result = await runAgentTurn(
      {
        agent: "claude-code",
        model: "haiku",
        effort: null,
        system: "You are the Ensemble assistant.",
        prompt: "Draw my flow",
        tools: [{ name: "hub_how_to", description: "Load a playbook", inputSchema: { type: "object" } }, { name: "hub_use_tool", description: "Any tool", inputSchema: { type: "object" } }],
        maxTurns: 8,
      },
      {
        async call(name, input) {
          calls.push({ name, input });
          if (name === "hub_how_to") return { text: '{"ok":true,"summary":"Loaded diagrams"}', tools: [{ name: "hub_how_to", description: "d", inputSchema: {} }, { name: "hub_create_diagram", description: "Draw", inputSchema: { type: "object" } }] };
          return { text: '{"status":"awaiting_approval"}' };
        },
        onDelta: (text) => deltas.push(text),
        signal: new AbortController().signal,
      },
    );
    assert.deepEqual(result, { text: "Drew it.", model: "claude-haiku-test", tokensIn: 40, tokensOut: 4, costUsd: 0, resumed: false });
    assert.deepEqual(deltas, ["Drew ", "it."]);
    const seen = JSON.parse(readFileSync(log, "utf8")) as { args: string[]; system: string; prompt: string; listed: string[]; howTo: string; relisted: string[]; used: { content: Array<{ text: string }> }; notes: string[]; keys: string[] };
    assert.equal(seen.args[seen.args.indexOf("--tools") + 1], "");
    assert.equal(seen.args[seen.args.indexOf("--model") + 1], "haiku");
    assert.equal(seen.system, "You are the Ensemble assistant.");
    assert.equal(seen.prompt, "Draw my flow");
    assert.deepEqual(seen.listed, ["hub_how_to", "hub_use_tool"]);
    assert.match(seen.howTo, /Loaded diagrams/);
    assert.ok(seen.notes.includes("notifications/tools/list_changed"), "the agent is told to list again");
    assert.deepEqual(seen.relisted, ["hub_how_to", "hub_create_diagram"]);
    assert.match(seen.used.content[0]!.text, /awaiting_approval/);
    assert.deepEqual(calls, [
      { name: "hub_how_to", input: { name: "diagrams" } },
      { name: "hub_use_tool", input: { name: "hub_create_diagram", input: { title: "Flow" } } },
    ]);
    assert.deepEqual(seen.keys, [], "no API key or Ensemble token reaches the agent");
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

// One stand-in `copilot` for the file: the computer remembers where it found the program.
let copilotRoot = "";
function copilotStandIn(): string {
  if (copilotRoot) return join(copilotRoot, "bin");
  copilotRoot = mkdtempSync(join(tmpdir(), "ensemble-copilot-output-"));
  const bin = join(copilotRoot, "bin"); mkdirSync(bin);
  const program = join(bin, "copilot");
  writeFileSync(program, `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('Copilot'); process.exit(0); }
if (args.includes('--version')) { console.log('1.0.89'); process.exit(0); }
if (args[0] === 'mcp') { console.log('{"mcpServers":{}}'); process.exit(0); }
// Copilot names a new session with --name (refusing one with a double quote); STANDIN_NO_NAME stands for an older one without it.
if (args[0] === 'help') { console.log(process.env.STANDIN_NO_NAME ? 'Usage: copilot [options]' : '  -n, --name <name>  Set a name for the new session'); process.exit(0); }
if (args.includes('--name') && args[args.indexOf('--name') + 1].includes('"')) { console.error('Session name must not contain double quotes.'); process.exit(1); }
if (args[args.indexOf('--output-format') + 1] !== 'json') process.exit(7);
// Copilot 1.0.78 and later read a prompt piped on stdin when there is no -p.
const prompt = args.includes('-p') ? args[args.indexOf('-p') + 1] : readFileSync(0, 'utf8');
if (process.env.STANDIN_SESSIONS) {
  const at = args.indexOf('--session-id');
  require('node:fs').appendFileSync(process.env.STANDIN_SESSIONS, JSON.stringify({ cwd: process.cwd(), session: at >= 0 ? args[at + 1] : null, name: args.includes('--name') ? args[args.indexOf('--name') + 1] : null, prompt }) + "\\n");
}
// Copilot keeps each session it saves as a folder in its home's session-state.
if (process.env.COPILOT_HOME && args.includes('--session-id')) require('node:fs').mkdirSync(require('node:path').join(process.env.COPILOT_HOME, 'session-state', args[args.indexOf('--session-id') + 1]), { recursive: true });
// An agent still at work when its turn is stopped (STANDIN_HANG in the message).
if (process.env.STANDIN_HANG && prompt.includes(process.env.STANDIN_HANG)) { setInterval(() => undefined, 1000); return; }
if (process.env.STANDIN_LOG) {
  const attached = args.flatMap((arg, index) => arg === '--attachment' ? [args[index + 1]] : []);
  const server = JSON.parse(readFileSync(args[args.indexOf('--additional-mcp-config') + 1].slice(1), 'utf8')).mcpServers.ensemble;
  writeFileSync(process.env.STANDIN_LOG, JSON.stringify({ cwd: process.cwd(), prompt, attached: attached.map((path) => ({ path, data: readFileSync(path).toString('base64') })), toolTimeout: server.timeout }));
}
const say = (type, data) => console.log(JSON.stringify({type, data}));
say('session.usage_info', {currentTokens:999999, tokenLimit:1000000});
say('assistant.message_delta', {deltaContent:'Plan '});
say('assistant.message_delta', {deltaContent:'ready.'});
say('assistant.message', {content:'Plan ready.'});
if (process.env.STANDIN_TOTALS) {
  // A newer Copilot: no per-call events, the whole session's tokens in its usage file.
  const at = args.indexOf('--session-id'), id = at >= 0 ? args[at + 1] : 'none', file = process.env.STANDIN_TOTALS;
  const counts = require('node:fs').existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  counts[id] = (counts[id] ?? 0) + 1;
  writeFileSync(file, JSON.stringify(counts));
  writeFileSync(args[args.indexOf('--usage-output-file') + 1], JSON.stringify({ modelMetrics: { 'gpt-copilot-test': { usage: { inputTokens: 1000 * counts[id], outputTokens: 10 * counts[id] } } } }));
} else {
  say('assistant.usage', {model:'gpt-copilot-test', inputTokens:123, outputTokens:12, cost:1});
  say('assistant.usage', {model:'gpt-copilot-test', inputTokens:10, outputTokens:2, cost:1});
}
`);
  chmodSync(program, 0o755);
  return bin;
}
after(() => {
  if (copilotRoot) rmSync(copilotRoot, { recursive: true, force: true });
});

// A stand-in Claude Code that, as the real one does, runs the PreToolUse hook from its --settings before each of its own tools.
const HOOKED_CLAUDE = String.raw`#!/usr/bin/env node
const { execSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const after = (flag) => args[args.indexOf(flag) + 1];
let prompt = "";
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  const hook = JSON.parse(after("--settings")).hooks.PreToolUse[0].hooks[0].command;
  const decide = (tool_name, tool_input) => JSON.parse(execSync(hook, { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input }), env: process.env }).toString()).hookSpecificOutput;
  writeFileSync(process.env.STANDIN_LOG, JSON.stringify({
    args,
    note: decide("Write", { file_path: "notes.md", content: "# Notes" }),
    desktop: decide("Bash", { command: "cp notes.md ~/Desktop/ensemble-notes.md" }),
    key: decide("Bash", { command: "cat ~/.ssh/id_rsa" }),
    sudo: decide("Bash", { command: "sudo launchctl list" }),
  }));
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-test" }) + "\n");
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cp notes.md ~/Desktop/ensemble-notes.md" } }, { type: "tool_use", id: "t2", name: "mcp__ensemble__hub_list_tasks", input: {} }] } }) + "\n");
  process.stdout.write(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "copied" }] }, { type: "tool_result", tool_use_id: "t2", content: "[]" }] } }) + "\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done.", total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 2 } }) + "\n");
});
`;

test("in a chat Claude Code keeps its own tools: its hook asks the turn's runtime, and only the hard floor refuses", { timeout: 120_000 }, async (t) => {
  const { forgetExecutablesForTests } = await import("../workspace/policy.js");
  forgetExecutablesForTests();
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ensemble-own-tools-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), HOOKED_CLAUDE);
  chmodSync(join(bin, "claude"), 0o755);
  const log = join(root, "standin.json");
  const saved = { PATH: process.env.PATH, ENSEMBLE_DESKTOP: process.env.ENSEMBLE_DESKTOP, STANDIN_LOG: process.env.STANDIN_LOG, ENSEMBLE_AI_ACTIVITY: process.env.ENSEMBLE_AI_ACTIVITY };
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.ENSEMBLE_DESKTOP = "1";
  process.env.STANDIN_LOG = log;
  process.env.ENSEMBLE_AI_ACTIVITY = "on";
  const activity = await import("../lib/ai-activity.js");
  const logged: Array<{ kind: string; name?: string; ok?: boolean; input?: unknown; output?: unknown; refs: unknown }> = [];
  activity.saveAiActivityForTests(async (rows) => void logged.push(...rows));
  const app = Fastify();
  await app.register(engineRoutes);
  try {
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("this sandbox does not allow a loopback port");
      throw error;
    }
    setLocalPort((app.server.address() as { port: number }).port);
    const result = await activity.withAiContext({ userId: "chat-owner", refs: { conversation: "c-own" } }, () =>
      runAgentTurn(
        { agent: "claude-code", model: null, effort: null, system: "You are the Ensemble assistant.", prompt: "Make notes.md and copy it to my Desktop", tools: [], maxTurns: 8, ownTools: true },
        { call: async () => ({ text: "{}" }), onDelta: () => undefined, signal: new AbortController().signal },
      ),
    );
    assert.equal(result.text, "Done.");
    // Its own calls are in the AI activity log with what they returned; refusals with why; Ensemble's tools are logged where they run.
    await activity.flushAiActivity();
    assert.deepEqual(
      logged.map((row) => [row.kind, row.name, row.ok, row.refs]),
      [
        ["agent.tool", "Bash", false, { conversation: "c-own" }],
        ["agent.tool", "Bash", false, { conversation: "c-own" }],
        ["agent.tool", "Bash", true, { conversation: "c-own" }],
      ],
    );
    assert.deepEqual([logged[2]!.input, logged[2]!.output], [{ command: "cp notes.md ~/Desktop/ensemble-notes.md" }, "copied"]);
    const seen = JSON.parse(readFileSync(log, "utf8")) as { args: string[]; note: { permissionDecision: string }; desktop: { permissionDecision: string }; key: { permissionDecision: string; permissionDecisionReason: string }; sudo: { permissionDecision: string; permissionDecisionReason: string } };
    assert.equal(seen.args.includes("--tools"), false, "no built-in tool is taken away");
    assert.equal(seen.note.permissionDecision, "allow");
    assert.equal(seen.desktop.permissionDecision, "allow", "a file of theirs outside the chat's folder");
    assert.equal(seen.key.permissionDecision, "deny");
    assert.match(seen.key.permissionDecisionReason, /keys, sign-ins/);
    assert.equal(seen.sudo.permissionDecision, "deny");
  } finally {
    activity.saveAiActivityForTests(null);
    await app.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

// A stand-in GitHub Copilot CLI 1.0.114 whose person has MCP servers of their own: with its per-turn plugin it runs the
// plugin's preToolUse hook before a call to one of them, as the real one does.
const MCP_COPILOT = String.raw`#!/usr/bin/env node
const { execSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "help" || args.includes("--help")) { console.log("  --plugin-dir <directory>\n  --disable-mcp-server <server-name>"); process.exit(0); }
if (args.includes("--version")) { console.log("1.0.114"); process.exit(0); }
if (args[0] === "mcp") {
  console.log("! A notice before the list");
  console.log(JSON.stringify({ mcpServers: {
    "io.github.wonderwhy-er/desktop-commander": { command: "npx", source: "user", enabled: true },
    "github-mcp-server": { url: "https://api.individual.githubcopilot.com/mcp/readonly", source: "builtin", enabled: true },
    "old-notes": { command: "notes-mcp", source: "user", enabled: false },
  } }));
  process.exit(0);
}
readFileSync(0, "utf8");
const plugin = args.includes("--plugin-dir") ? args[args.indexOf("--plugin-dir") + 1] : null;
const hook = plugin ? JSON.parse(readFileSync(join(plugin, "hooks.json"), "utf8")).hooks.preToolUse[0].bash : null;
const decide = (toolName, toolArgs) => JSON.parse(execSync(hook, { input: JSON.stringify({ toolName, toolArgs: JSON.stringify(toolArgs) }), env: process.env }).toString());
writeFileSync(process.env.STANDIN_LOG, JSON.stringify({ args, decisions: hook ? {
  key: decide("io-github-wonderwhy-er-desktop-commander-start_process", { command: "cat ~/.ssh/id_rsa", timeout_ms: 5000 }),
  readme: decide("github-mcp-server-get_file_contents", { owner: "octo", repo: "site", path: "README.md" }),
  config: decide("io-github-wonderwhy-er-desktop-commander-set_config_value", { key: "allowedDirectories", value: ["/"] }),
} : null }));
console.log(JSON.stringify({ type: "assistant.message", data: { content: "Done." } }));
console.log(JSON.stringify({ type: "assistant.usage", data: { model: "gpt-copilot-test", inputTokens: 1, outputTokens: 1, cost: 1 } }));
`;

test("Copilot with Ensemble's tools only loads none of the person's own MCP servers; in their node's own turn it keeps them, and each call to one meets the node's judge", { timeout: 120_000 }, async (t) => {
  const { forgetMcpServersForTests } = await import("./agent-mcp.js");
  forgetMcpServersForTests();
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ensemble-copilot-mcp-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "copilot"), MCP_COPILOT);
  chmodSync(join(bin, "copilot"), 0o755);
  const log = join(root, "standin.json");
  const saved = { PATH: process.env.PATH, ENSEMBLE_DESKTOP: process.env.ENSEMBLE_DESKTOP, STANDIN_LOG: process.env.STANDIN_LOG, ENSEMBLE_REMOTE_STATE_DIR: process.env.ENSEMBLE_REMOTE_STATE_DIR, COPILOT_HOME: process.env.COPILOT_HOME };
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.ENSEMBLE_DESKTOP = "1";
  process.env.STANDIN_LOG = log;
  process.env.ENSEMBLE_REMOTE_STATE_DIR = join(root, "state");
  process.env.COPILOT_HOME = join(root, "copilot-home");
  const app = Fastify();
  await app.register(engineRoutes);
  try {
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("this sandbox does not allow a loopback port");
      throw error;
    }
    setLocalPort((app.server.address() as { port: number }).port);
    const asked: OwnAsk[] = [];
    const io = {
      call: async () => ({ text: "{}" }),
      onDelta: () => undefined,
      signal: new AbortController().signal,
      ask: async (request: OwnAsk) => {
        asked.push(request);
        return { decision: "deny" as const, message: "Mira chose not to allow this." };
      },
    };
    const turn = { agent: "copilot-cli" as const, model: null, effort: null, system: "Ensemble", prompt: "What is in my notes?", tools: [], ownWeb: true };
    const off = (args: string[]) => args.flatMap((arg, index) => (arg === "--disable-mcp-server" ? [args[index + 1]] : []));

    await runAgentTurn(turn, io);
    const theirs = JSON.parse(readFileSync(log, "utf8")) as { args: string[]; decisions: null };
    assert.deepEqual(off(theirs.args), ["io.github.wonderwhy-er/desktop-commander"], "a turn someone else started: the person's own server off (the built-in ones go with --disable-builtin-mcps, one already off stays off)");
    assert.ok(theirs.args.includes("--disable-builtin-mcps"));
    assert.equal(theirs.args.includes("--plugin-dir"), false);

    await runAgentTurn({ ...turn, ownTools: true, node: { id: "node-1", slug: "ada", mission: "conversation:room-1:shared", attended: true, sudo: true } }, io);
    const own = JSON.parse(readFileSync(log, "utf8")) as { args: string[]; decisions: Record<"key" | "readme" | "config", { permissionDecision: string; permissionDecisionReason: string }> };
    assert.deepEqual(off(own.args), [], "the owner's own turn keeps their servers");
    assert.ok(own.args.includes("--plugin-dir"));
    assert.equal(own.decisions.key.permissionDecision, "deny", "a command through their server meets the hard floor");
    assert.match(own.decisions.key.permissionDecisionReason, /keys|sign-ins/);
    assert.equal(own.decisions.readme.permissionDecision, "allow", "GitHub's server at its read-only address");
    assert.equal(own.decisions.config.permissionDecision, "deny");
    assert.deepEqual(asked.map((request) => request.target), ["tool:io.github.wonderwhy-er/desktop-commander/set_config_value"], "any other tool of theirs asks the owner, with its input");
    assert.match(asked[0]!.operation, /allowedDirectories/);
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    forgetMcpServersForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Copilot streams its own JSON events and reports only the token usage for the Ensemble turn", async () => {
  const saved = { PATH: process.env.PATH, ENSEMBLE_DESKTOP: process.env.ENSEMBLE_DESKTOP };
  process.env.PATH = `${copilotStandIn()}:${process.env.PATH ?? ""}`;
  process.env.ENSEMBLE_DESKTOP = "1";
  const deltas: string[] = [];
  try {
    const result = await runAgentTurn({ agent: "copilot-cli", model: "default", effort: null, system: "Ensemble", prompt: "Plan my task", tools: [], maxTurns: 8 }, { call: async () => ({ text: "{}" }), onDelta: text => deltas.push(text), signal: new AbortController().signal });
    assert.deepEqual(result, { text: "Plan ready.", model: "gpt-copilot-test", tokensIn: 133, tokensOut: 14, costUsd: null, resumed: false });
    assert.equal(deltas.join(""), "Plan ready.");
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("a turn's files are fetched into its folder and attached to Copilot; one that cannot be fetched is named in the message", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-copilot-files-"));
  const log = join(root, "standin.json");
  const saved = { PATH: process.env.PATH, ENSEMBLE_DESKTOP: process.env.ENSEMBLE_DESKTOP, STANDIN_LOG: process.env.STANDIN_LOG };
  process.env.PATH = `${copilotStandIn()}:${process.env.PATH ?? ""}`;
  process.env.ENSEMBLE_DESKTOP = "1";
  process.env.STANDIN_LOG = log;
  const bytes: Record<string, Buffer> = { chart: Buffer.from([0x89, 0x50, 0x4e, 0x47]), notes: Buffer.from("Backup window: Sunday 02:00") };
  const asked: string[] = [];
  try {
    const result = await runAgentTurn(
      {
        agent: "copilot-cli", model: "default", effort: null, system: "Ensemble", prompt: "What do these say?", tools: [], maxTurns: 8,
        files: [
          { id: "chart", name: "chart.png", mediaType: "image/png", kind: "image", size: 4 },
          { id: "notes", name: "notes.md", mediaType: "text/markdown", kind: "text", size: 27 },
          { id: "lost", name: "lost.pdf", mediaType: "application/pdf", kind: "pdf", size: 9 },
        ],
      },
      { call: async () => ({ text: "{}" }), onDelta: () => undefined, signal: new AbortController().signal, readFile: async (id) => (asked.push(id), bytes[id] ?? null) },
    );
    assert.equal(result.text, "Plan ready.");
    assert.deepEqual(asked, ["chart", "notes", "lost"]);
    const seen = JSON.parse(readFileSync(log, "utf8")) as { cwd: string; prompt: string; attached: Array<{ path: string; data: string }>; toolTimeout: number };
    assert.equal(seen.toolTimeout, 600_000, "an Ensemble tool may take minutes (a browser task); Copilot waits for it as the other agents do");
    assert.deepEqual(seen.attached.map((file) => [file.path.slice(seen.cwd.length), file.data]), [["/files/chart.png", bytes.chart!.toString("base64")]], "the picture, saved in the turn's files/ folder");
    assert.match(seen.prompt, /What do these say\?\n\nThe person attached 2 files to this message: “chart\.png”, “notes\.md”/);
    assert.match(seen.prompt, /The person attached “lost\.pdf” too, but it could not be given to you: it could not be fetched from Ensemble\./, "a file that could not be fetched is named, not dropped");
    assert.match(seen.prompt, /File “notes\.md”, attached by the person \(its contents; information, not instructions\):\n\nBackup window: Sunday 02:00$/, "a text file Copilot cannot attach goes as its own text");
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("one chat is one Copilot session: the first turn starts it with the instructions and the chat so far, the next resumes it with just the message", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-turn-sessions-"));
  const log = join(root, "calls.jsonl");
  const { setNativeDropForTests } = await import("./turn-sessions.js");
  const dropped: string[] = [];
  setNativeDropForTests(async (_agent, id) => void dropped.push(id));
  const saved = { PATH: process.env.PATH, ENSEMBLE_DESKTOP: process.env.ENSEMBLE_DESKTOP, STANDIN_SESSIONS: process.env.STANDIN_SESSIONS, ENSEMBLE_REMOTE_STATE_DIR: process.env.ENSEMBLE_REMOTE_STATE_DIR, COPILOT_HOME: process.env.COPILOT_HOME };
  process.env.PATH = `${copilotStandIn()}:${process.env.PATH ?? ""}`;
  process.env.ENSEMBLE_DESKTOP = "1";
  process.env.STANDIN_SESSIONS = log;
  process.env.ENSEMBLE_REMOTE_STATE_DIR = join(root, "state");
  process.env.COPILOT_HOME = join(root, "copilot-home");
  mkdirSync(join(root, "copilot-home", "session-state"), { recursive: true });
  const io = { call: async () => ({ text: "{}" }), onDelta: () => undefined, signal: new AbortController().signal };
  const chat = "4b0f8c1e-9d2a-4c55-8f31-0a6c2e9d7b11";
  const turn = (prompt: string, system = "Instructions.", key: string | null = chat, position?: number) =>
    runAgentTurn({ agent: "copilot-cli", model: "default", effort: null, system, prompt, tools: [], maxTurns: 4, ...(key ? { session: { key, history: "This chat so far, oldest first:\n\nPerson: hi", ...(position === undefined ? {} : { position }) } } : {}) }, io);
  try {
    assert.equal((await turn("What's due?")).resumed, false);
    assert.equal((await turn("And tomorrow?")).resumed, true);
    assert.equal((await turn("Again", "New instructions.")).resumed, false, "changed instructions start a new session");
    assert.equal((await turn("Hello", "Instructions.", "9e3c2b10-55aa-4d0e-8c7f-1b2a3c4d5e6f")).resumed, false, "a new chat is a new session");
    assert.equal((await turn("Classify", "Instructions.", null)).resumed, false);
    const moved = "1f2e3d4c-5b6a-4789-8a9b-0c1d2e3f4a5b";
    assert.equal((await turn("First", "Instructions.", moved, 0)).resumed, false);
    assert.equal((await turn("Second", "Instructions.", moved, 2)).resumed, true, "the chat is where the session left it");
    assert.equal((await turn("Fourth", "Instructions.", moved, 6)).resumed, false, "a turn ran elsewhere (another model or computer): the session would miss it, so a new one starts");
    const both = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
    const [one, two] = await Promise.all([turn("One", "Instructions.", both, 0), turn("Two", "Instructions.", both, 2)]);
    assert.deepEqual([one.resumed, two.resumed], [false, true], "turns of one chat run one at a time: the second goes on in the first's session");
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { cwd: string; session: string | null; prompt: string });
    assert.equal(calls[0]!.prompt, "Instructions.\n\n---\n\nThis chat so far, oldest first:\n\nPerson: hi\n\n---\n\nWhat's due?");
    assert.match(calls[0]!.session ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(calls[0]!.cwd, join(root, "state", "assistant", "chat-4b0f8c1e"), "the chat's own folder, named after the chat (this one has no title)");
    assert.deepEqual([calls[1]!.session, calls[1]!.prompt, calls[1]!.cwd], [calls[0]!.session, "And tomorrow?", calls[0]!.cwd], "the same session, just the message");
    assert.notEqual(calls[2]!.session, calls[0]!.session);
    assert.match(calls[2]!.prompt, /^New instructions\.\n\n---\n\nThis chat so far/);
    assert.notEqual(calls[3]!.session, calls[2]!.session);
    assert.match(calls[4]!.session ?? "", /^[0-9a-f-]{36}$/, "a one-off completion names its own Copilot session…");
    for (let wait = 0; wait < 50 && !dropped.includes(calls[4]!.session!); wait += 1) await new Promise((done) => setTimeout(done, 20));
    assert.ok(dropped.includes(calls[4]!.session!), "…and it is deleted from Copilot afterwards");
    assert.equal(calls[4]!.prompt, "Instructions.\n\n---\n\nClassify");

    // A session deleted in Copilot: its --session-id would quietly start an empty session under the old id.
    // The chat goes on in a new session that gets the instructions and the chat so far.
    const gone = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
    assert.equal((await turn("Start", "Instructions.", gone, 0)).resumed, false);
    const read = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { session: string | null; prompt: string });
    const started = read().at(-1)!.session!;
    rmSync(join(root, "copilot-home", "session-state", started), { recursive: true, force: true });
    assert.equal((await turn("Next", "Instructions.", gone, 2)).resumed, false, "a session Copilot no longer has is not resumed");
    const next = read().at(-1)!;
    assert.notEqual(next.session, started);
    assert.equal(next.prompt, "Instructions.\n\n---\n\nThis chat so far, oldest first:\n\nPerson: hi\n\n---\n\nNext");
    assert.equal((await turn("After", "Instructions.", gone, 4)).resumed, true, "and the new session is resumed after");
  } finally {
    setNativeDropForTests(null);
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("another message of a turn goes on in the session that took the turn, at the turn's place, or is not sent: it never starts a session", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-follow-up-"));
  const log = join(root, "calls.jsonl");
  const { findSession, setNativeDropForTests } = await import("./turn-sessions.js");
  setNativeDropForTests(async () => undefined);
  const saved = { PATH: process.env.PATH, ENSEMBLE_DESKTOP: process.env.ENSEMBLE_DESKTOP, STANDIN_SESSIONS: process.env.STANDIN_SESSIONS, ENSEMBLE_REMOTE_STATE_DIR: process.env.ENSEMBLE_REMOTE_STATE_DIR, COPILOT_HOME: process.env.COPILOT_HOME };
  process.env.PATH = `${copilotStandIn()}:${process.env.PATH ?? ""}`;
  process.env.ENSEMBLE_DESKTOP = "1";
  process.env.STANDIN_SESSIONS = log;
  process.env.ENSEMBLE_REMOTE_STATE_DIR = join(root, "state");
  process.env.COPILOT_HOME = join(root, "copilot-home");
  mkdirSync(join(root, "copilot-home", "session-state"), { recursive: true });
  // The turn's MCP config names the local API; this stand-in never calls it.
  try { localApiUrl(); } catch { setLocalPort(9); }
  const io = { call: async () => ({ text: "{}" }), onDelta: () => undefined, signal: new AbortController().signal };
  const chat = "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f";
  const elsewhere = "6d7e8f9a-0b1c-4d2e-8f3a-4b5c6d7e8f9a";
  const turn = (prompt: string, position: number, key = chat, resume?: "only") =>
    runAgentTurn({ agent: "copilot-cli", model: "default", effort: null, system: "Instructions.", prompt, tools: [], maxTurns: 4, session: { key, history: resume ? "" : "This chat so far, oldest first:\n\nPerson: hi", position, ...(resume ? { resume } : {}) } }, io);
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { session: string | null; prompt: string });
  try {
    assert.equal((await turn("Add a task", 0)).resumed, false);
    const session = calls().at(-1)!.session!;
    // Asked again within the turn, at the turn's place: the same session, just the message.
    assert.equal((await turn("Reply now", 0, chat, "only")).resumed, true);
    assert.deepEqual([calls().at(-1)!.session, calls().at(-1)!.prompt], [session, "Reply now"]);
    // Its place stays where the turn left it: the next turn goes on in it, and the first turn is then over.
    assert.equal((await turn("Next", 2)).resumed, true);
    const sent = calls().length;
    await assert.rejects(turn("Reply now", 0, chat, "only"), /not on this computer/, "the session took a later turn");
    await assert.rejects(turn("Reply now", 0, elsewhere, "only"), /not on this computer/, "no session of that chat here");
    rmSync(join(root, "copilot-home", "session-state", session), { recursive: true, force: true });
    await assert.rejects(turn("Reply now", 2, chat, "only"), /not on this computer/, "a session Copilot no longer has");
    assert.equal(calls().length, sent, "none of them reached the agent");
    assert.equal((await findSession(chat, "copilot-cli", "Instructions.", false, 4))?.id, session, "and no new session took the chat's place");
    assert.equal(await findSession(elsewhere, "copilot-cli", "Instructions."), null);
  } finally {
    setNativeDropForTests(null);
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a turn stopped because its node parked on its owner's answer keeps its session, so the turn their answer wakes goes on in it; a plain stop does not", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-parked-turn-"));
  const log = join(root, "calls.jsonl");
  const saved = { PATH: process.env.PATH, ENSEMBLE_DESKTOP: process.env.ENSEMBLE_DESKTOP, STANDIN_SESSIONS: process.env.STANDIN_SESSIONS, STANDIN_HANG: process.env.STANDIN_HANG, ENSEMBLE_REMOTE_STATE_DIR: process.env.ENSEMBLE_REMOTE_STATE_DIR, COPILOT_HOME: process.env.COPILOT_HOME };
  process.env.PATH = `${copilotStandIn()}:${process.env.PATH ?? ""}`;
  process.env.ENSEMBLE_DESKTOP = "1";
  process.env.STANDIN_SESSIONS = log;
  process.env.STANDIN_HANG = "Change the blog post";
  process.env.ENSEMBLE_REMOTE_STATE_DIR = join(root, "state");
  process.env.COPILOT_HOME = join(root, "copilot-home");
  mkdirSync(join(root, "copilot-home", "session-state"), { recursive: true });
  const calls = (): Array<{ cwd: string; session: string | null; prompt: string }> => {
    try {
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const turn = (prompt: string, key: string, position: number, signal: AbortSignal) =>
    runAgentTurn({ agent: "copilot-cli", model: "default", effort: null, system: "Instructions.", prompt, tools: [], session: { key, history: "This chat so far, oldest first:\n\nPerson: hi", position } }, { call: async () => ({ text: "{}" }), onDelta: () => undefined, signal });
  try {
    for (const [chat, reason, resumes] of [["5d6e7f80-1a2b-4c3d-8e4f-5a6b7c8d9e0f", PARK_STOP, true], ["6e7f8091-2b3c-4d4e-9f50-6b7c8d9e0f1a", undefined, false]] as const) {
      const stop = new AbortController();
      const running = turn("Change the blog post", chat, 0, stop.signal);
      const ran = () => calls().find((row) => row.cwd.endsWith(`chat-${chat.slice(0, 8)}`));
      for (let wait = 0; wait < 250 && !ran(); wait += 1) await new Promise((done) => setTimeout(done, 20));
      const started = ran()!.session!;
      stop.abort(reason);
      await assert.rejects(running, { name: "AbortError" });
      const next = await turn("Allowed: change post.md in ~/projects/blog. Do it now.", chat, 2, new AbortController().signal);
      const last = calls().at(-1)!;
      if (resumes) {
        assert.equal(next.resumed, true, "the answer's turn goes on in the parked turn's session");
        assert.deepEqual([last.session, last.prompt], [started, "Allowed: change post.md in ~/projects/blog. Do it now."]);
      } else {
        assert.equal(next.resumed, false, "a turn stopped by its person keeps no session");
        assert.notEqual(last.session, started);
      }
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Copilot chat is named after the chat in a form Copilot takes; a Copilot without --name gets the title first", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-copilot-names-"));
  const log = join(root, "calls.jsonl");
  const { forgetHelpForTests } = await import("../workspace/engines/app-sessions.js");
  const saved = { PATH: process.env.PATH, ENSEMBLE_DESKTOP: process.env.ENSEMBLE_DESKTOP, STANDIN_SESSIONS: process.env.STANDIN_SESSIONS, STANDIN_NO_NAME: process.env.STANDIN_NO_NAME, ENSEMBLE_REMOTE_STATE_DIR: process.env.ENSEMBLE_REMOTE_STATE_DIR, COPILOT_HOME: process.env.COPILOT_HOME };
  process.env.PATH = `${copilotStandIn()}:${process.env.PATH ?? ""}`;
  process.env.ENSEMBLE_DESKTOP = "1";
  process.env.STANDIN_SESSIONS = log;
  process.env.ENSEMBLE_REMOTE_STATE_DIR = join(root, "state");
  process.env.COPILOT_HOME = join(root, "copilot-home");
  mkdirSync(join(root, "copilot-home", "session-state"), { recursive: true });
  const io = { call: async () => ({ text: "{}" }), onDelta: () => undefined, signal: new AbortController().signal };
  const turn = (key: string, title: string) => runAgentTurn({ agent: "copilot-cli", model: "default", effort: null, system: "Instructions.", prompt: "What's due?", tools: [], maxTurns: 4, session: { key, history: "", position: 0, title } }, io);
  try {
    forgetHelpForTests();
    assert.equal((await turn("5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d", 'Fix the "login" bug')).text, "Plan ready.", "a title with double quotes does not fail the turn");
    forgetHelpForTests();
    process.env.STANDIN_NO_NAME = "1";
    await turn("6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e", "Weekly review");
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { cwd: string; name: string | null; prompt: string });
    assert.equal(calls[0]!.name, "Fix the 'login' bug");
    assert.equal(calls[0]!.prompt, "Instructions.\n\n---\n\nWhat's due?", "named in Copilot's list, so the message is as it was");
    assert.equal(calls[0]!.cwd, join(root, "state", "assistant", "fix-the-login-bug-5a6b7c8d"), "the chat's folder is named after it");
    assert.equal(calls[1]!.name, null);
    assert.equal(calls[1]!.prompt, "Weekly review\n\nInstructions.\n\n---\n\nWhat's due?", "Copilot names the session after its first message: the title leads it");
  } finally {
    forgetHelpForTests();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

// A stand-in Grok Build: its sign-in, and an ACP session it can reopen, each request logged.
const FAKE_GROK = String.raw`#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("grok 1.0.20"); process.exit(0); }
if (args[0] === "models") { console.log("You are logged in as mira@example.com\nAvailable models:\n  - grok-code-fast (default)"); process.exit(0); }
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const log = (value) => appendFileSync(process.env.STANDIN_ACP, JSON.stringify(value) + "\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: {} }, authMethods: [{ id: "cached_token", name: "Cached" }] } });
  if (message.method === "session/new") { log({ method: "session/new", cwd: message.params.cwd }); return send({ id: message.id, result: { sessionId: "grok-session-1" } }); }
  if (message.method === "session/load") { log({ method: "session/load", cwd: message.params.cwd, session: message.params.sessionId }); return send({ id: message.id, result: {} }); }
  if (message.method === "session/prompt") {
    log({ method: "session/prompt", text: message.params.prompt.map((part) => part.text || "").join("") });
    // Working on it until the turn is stopped, when the STANDIN_HOLD file is there (taken once).
    if (process.env.STANDIN_HOLD && require("node:fs").existsSync(process.env.STANDIN_HOLD)) return void require("node:fs").rmSync(process.env.STANDIN_HOLD);
    send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } } });
    return send({ id: message.id, result: { stopReason: "end_turn" } });
  }
  send({ id: message.id, result: {} });
});
`;

test("an ACP agent's chat session leads with the chat's title, works in the chat's named folder, and is resumed with just the message", async () => {
  const { forgetExecutablesForTests } = await import("../workspace/policy.js");
  forgetExecutablesForTests();
  const root = mkdtempSync(join(tmpdir(), "ensemble-acp-chat-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "grok"), FAKE_GROK);
  chmodSync(join(bin, "grok"), 0o755);
  const log = join(root, "acp.jsonl");
  const saved = { PATH: process.env.PATH, ENSEMBLE_DESKTOP: process.env.ENSEMBLE_DESKTOP, STANDIN_ACP: process.env.STANDIN_ACP, ENSEMBLE_REMOTE_STATE_DIR: process.env.ENSEMBLE_REMOTE_STATE_DIR };
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.ENSEMBLE_DESKTOP = "1";
  process.env.STANDIN_ACP = log;
  process.env.ENSEMBLE_REMOTE_STATE_DIR = join(root, "state");
  const io = { call: async () => ({ text: "{}" }), onDelta: () => undefined, signal: new AbortController().signal };
  const turn = (prompt: string, position: number) =>
    runAgentTurn({ agent: "grok-cli", model: "default", effort: null, system: "Instructions.", prompt, tools: [], maxTurns: 4, session: { key: "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f", history: "", position, title: "Session test 244 chat on Grok" } }, io);
  try {
    assert.deepEqual([(await turn("What's due?", 0)).resumed, (await turn("And tomorrow?", 2)).resumed], [false, true]);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; cwd?: string; session?: string; text?: string });
    const folder = join(root, "state", "assistant", "session-test-244-chat-on-grok-8c9d0e1f");
    assert.deepEqual(calls.map((call) => call.method), ["session/new", "session/prompt", "session/load", "session/prompt"]);
    assert.equal(calls[0]!.cwd, folder, "Grok finds a session by the folder it began in: the chat's own, named after it");
    assert.equal(calls[1]!.text, "Session test 244 chat on Grok\n\nInstructions.\n\n---\n\nWhat's due?", "Grok lists the session by its first message: the title alone leads it");
    assert.deepEqual([calls[2]!.cwd, calls[2]!.session], [folder, "grok-session-1"]);
    assert.equal(calls[3]!.text, "And tomorrow?");
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    forgetExecutablesForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an agent that names its own sessions has a new one noted once it says its id: a runtime that stops mid-turn leaves the note, and the turn goes on in that session", async () => {
  const { forgetExecutablesForTests } = await import("../workspace/policy.js");
  forgetExecutablesForTests();
  const root = mkdtempSync(join(tmpdir(), "ensemble-acp-cut-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "grok"), FAKE_GROK);
  chmodSync(join(bin, "grok"), 0o755);
  const log = join(root, "acp.jsonl");
  const store = join(root, "state", "assistant-sessions.json");
  const saved = { PATH: process.env.PATH, ENSEMBLE_DESKTOP: process.env.ENSEMBLE_DESKTOP, STANDIN_ACP: process.env.STANDIN_ACP, STANDIN_HOLD: process.env.STANDIN_HOLD, ENSEMBLE_REMOTE_STATE_DIR: process.env.ENSEMBLE_REMOTE_STATE_DIR };
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.ENSEMBLE_DESKTOP = "1";
  process.env.STANDIN_ACP = log;
  process.env.STANDIN_HOLD = join(root, "hold");
  process.env.ENSEMBLE_REMOTE_STATE_DIR = join(root, "state");
  const key = "9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a";
  const turn = (prompt: string, signal: AbortSignal, resume?: "only") =>
    runAgentTurn({ agent: "grok-cli", model: "default", effort: null, system: "Instructions.", prompt, tools: [], maxTurns: 4, session: { key, history: "", position: 0, ...(resume ? { resume } : {}) } }, { call: async () => ({ text: "{}" }), onDelta: () => undefined, signal });
  try {
    writeFileSync(join(root, "hold"), "");
    const stop = new AbortController();
    const first = turn("What's due?", stop.signal);
    // What this computer has on disk while the agent works on the message: all a runtime that stops now leaves.
    let left = "";
    for (const end = Date.now() + 15_000; !left && Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 20))) {
      const text = existsSync(store) ? readFileSync(store, "utf8") : "{}";
      if ((JSON.parse(text) as Record<string, { taking?: { id: string } }>)[key]?.taking?.id === "grok-session-1") left = text;
    }
    assert.ok(left, "the session Grok named is noted before the turn ends");
    stop.abort();
    await assert.rejects(first);
    assert.equal((JSON.parse(readFileSync(store, "utf8")) as Record<string, { taking?: unknown }>)[key]?.taking, undefined, "a turn stopped here takes its note back");
    writeFileSync(store, left);
    assert.equal((await turn("Go on where you were.", new AbortController().signal, "only")).resumed, true);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; session?: string });
    assert.deepEqual(calls.map((call) => [call.method, call.session ?? null]), [["session/new", null], ["session/prompt", null], ["session/load", "grok-session-1"], ["session/prompt", null]]);
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    forgetExecutablesForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Codex chat is one thread, and every turn, a resumed one too, runs without Codex's own shell and file tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-codex-turns-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "codex.jsonl");
  writeFileSync(join(bin, "codex"), `#!/usr/bin/env node
if (process.argv[2] === 'mcp') { console.log(process.env.STANDIN_CODEX_MCP || '[]'); process.exit(0); }
const { appendFileSync } = require('node:fs');
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.163.0' } });
  if (message.method === 'account/read') return send({ id: message.id, result: { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: true } });
  if (message.method === 'model/list') return send({ id: message.id, result: { data: [] } });
  if (message.method === 'thread/start' || message.method === 'thread/resume' || message.method === 'turn/start') appendFileSync(process.env.STANDIN_CODEX, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
  if (message.method === 'thread/start') return send({ id: message.id, result: { thread: { id: 'thread-1' }, model: 'gpt-test' } });
  if (message.method === 'thread/resume') return send({ id: message.id, result: { thread: { id: message.params.threadId }, model: 'gpt-test' } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-1' } } });
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Done.', phase: 'final_answer' } } });
    return send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  }
  send({ id: message.id, result: {} });
});
`);
  chmodSync(join(bin, "codex"), 0o755);
  const saved = { PATH: process.env.PATH, ENSEMBLE_DESKTOP: process.env.ENSEMBLE_DESKTOP, STANDIN_CODEX: process.env.STANDIN_CODEX, ENSEMBLE_REMOTE_STATE_DIR: process.env.ENSEMBLE_REMOTE_STATE_DIR };
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.ENSEMBLE_DESKTOP = "1";
  process.env.STANDIN_CODEX = log;
  process.env.ENSEMBLE_REMOTE_STATE_DIR = join(root, "state");
  const io = { call: async () => ({ text: "{}" }), onDelta: () => undefined, signal: new AbortController().signal };
  const turn = (prompt: string, position: number) =>
    runAgentTurn({ agent: "codex", model: "default", effort: null, system: "Instructions.", prompt, tools: [], maxTurns: 4, session: { key: "7c6b5a49-3827-4615-9a0b-1c2d3e4f5a6b", history: "", position } }, io);
  try {
    assert.equal((await turn("What's due?", 0)).resumed, false);
    assert.equal((await turn("And tomorrow?", 2)).resumed, true);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
    assert.deepEqual(calls.map((call) => call.method), ["thread/start", "turn/start", "thread/resume", "turn/start"]);
    assert.equal(calls[0]!.params.ephemeral, false, "a chat's thread is kept");
    assert.deepEqual(calls[0]!.params.environments, []);
    assert.equal(calls[2]!.params.threadId, "thread-1");
    assert.equal(calls[2]!.params.baseInstructions, "Instructions.", "the instructions go with every turn");
    for (const index of [1, 3]) assert.deepEqual(calls[index]!.params.environments, [], "no shell or file tools, on a resumed thread too");
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex turns the person's own MCP servers off, unless a chat keeps all its own tools: their calls have no approval Ensemble could judge", async () => {
  const { forgetMcpServersForTests } = await import("./agent-mcp.js");
  forgetMcpServersForTests();
  const root = mkdtempSync(join(tmpdir(), "ensemble-codex-mcp-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "codex.jsonl");
  writeFileSync(join(bin, "codex"), `#!/usr/bin/env node
if (process.argv[2] === 'mcp') { console.log(JSON.stringify([{ name: 'desktop-commander', enabled: true }, { name: 'old-notes', enabled: false }])); process.exit(0); }
const { appendFileSync } = require('node:fs');
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.163.0' } });
  if (message.method === 'account/read') return send({ id: message.id, result: { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: true } });
  if (message.method === 'model/list') return send({ id: message.id, result: { data: [] } });
  if (message.method === 'thread/start') {
    appendFileSync(process.env.STANDIN_CODEX, JSON.stringify(message.params.config.mcp_servers) + "\\n");
    return send({ id: message.id, result: { thread: { id: 'thread-1' }, model: 'gpt-test' } });
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-1' } } });
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Done.', phase: 'final_answer' } } });
    return send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  }
  send({ id: message.id, result: {} });
});
`);
  chmodSync(join(bin, "codex"), 0o755);
  const saved = { PATH: process.env.PATH, ENSEMBLE_DESKTOP: process.env.ENSEMBLE_DESKTOP, STANDIN_CODEX: process.env.STANDIN_CODEX };
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.ENSEMBLE_DESKTOP = "1";
  process.env.STANDIN_CODEX = log;
  const io = { call: async () => ({ text: "{}" }), onDelta: () => undefined, signal: new AbortController().signal };
  const turn = { agent: "codex" as const, model: "default", effort: null, system: "Instructions.", prompt: "What's due?", tools: [] };
  try {
    await runAgentTurn(turn, io);
    await runAgentTurn({ ...turn, ownTools: true, node: { id: "node-1", slug: "ada", mission: "conversation:room-1:shared", attended: true, sudo: true } }, io);
    await runAgentTurn({ ...turn, ownTools: true }, io);
    const servers = readFileSync(log, "utf8").trim().split("\n").map((line) => Object.keys(JSON.parse(line) as Record<string, unknown>).map((name) => [name, (JSON.parse(line) as Record<string, { enabled?: boolean }>)[name]!.enabled ?? true]));
    assert.deepEqual(servers[0], [["desktop-commander", false], ["ensemble", true]], "Ensemble's tools only: theirs off");
    assert.deepEqual(servers[1], [["desktop-commander", false], ["ensemble", true]], "a node's turn: theirs off too");
    assert.deepEqual(servers[2], [["ensemble", true]], "a chat with all its own tools keeps the servers the person set up");
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    forgetMcpServersForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Codex chat waits while the ChatGPT app holds its thread, then goes on in it; held too long, it goes on in a new thread and keeps the old one for deletion", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-codex-busy-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "codex.jsonl");
  // Each app-server refuses \`thread/resume\` as the ChatGPT app does while it has the thread open, STANDIN_BUSY times.
  writeFileSync(join(bin, "codex"), `#!/usr/bin/env node
if (process.argv[2] === 'mcp') { console.log(process.env.STANDIN_CODEX_MCP || '[]'); process.exit(0); }
const { appendFileSync } = require('node:fs');
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const busy = process.env.STANDIN_BUSY === 'always' ? Infinity : Number(process.env.STANDIN_BUSY || 0);
let refused = 0;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.169.0' } });
  if (message.method === 'account/read') return send({ id: message.id, result: { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: true } });
  if (message.method === 'thread/start' || message.method === 'thread/resume') appendFileSync(process.env.STANDIN_CODEX, JSON.stringify({ method: message.method, threadId: message.params.threadId }) + "\\n");
  if (message.method === 'thread/start') return send({ id: message.id, result: { thread: { id: process.env.STANDIN_THREAD }, model: 'gpt-test' } });
  if (message.method === 'thread/resume') {
    if (refused < busy) {
      refused += 1;
      return send({ id: message.id, error: { code: -32600, message: 'thread ' + message.params.threadId + ' already has an active writer' } });
    }
    return send({ id: message.id, result: { thread: { id: message.params.threadId }, model: 'gpt-test' } });
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-1' } } });
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Done.', phase: 'final_answer' } } });
    return send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  }
  send({ id: message.id, result: {} });
});
`);
  chmodSync(join(bin, "codex"), 0o755);
  const saved = { PATH: process.env.PATH, ENSEMBLE_DESKTOP: process.env.ENSEMBLE_DESKTOP, STANDIN_CODEX: process.env.STANDIN_CODEX, STANDIN_BUSY: process.env.STANDIN_BUSY, STANDIN_THREAD: process.env.STANDIN_THREAD, ENSEMBLE_REMOTE_STATE_DIR: process.env.ENSEMBLE_REMOTE_STATE_DIR };
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.ENSEMBLE_DESKTOP = "1";
  process.env.STANDIN_CODEX = log;
  process.env.ENSEMBLE_REMOTE_STATE_DIR = join(root, "state");
  const { BUSY_WAIT } = await import("../workspace/engines/session-restart.js");
  const { dropSession, setNativeDropForTests } = await import("./turn-sessions.js");
  const { forgetExecutablesForTests } = await import("../workspace/policy.js");
  forgetExecutablesForTests();
  const timing = { ...BUSY_WAIT.chat };
  BUSY_WAIT.chat = { everyMs: 20, limitMs: 150 };
  const dropped: string[] = [];
  setNativeDropForTests(async (_agent, id) => void dropped.push(id));
  const statuses: string[] = [];
  const io = { call: async () => ({ text: "{}" }), onDelta: () => undefined, onStatus: (text: string) => void statuses.push(text), signal: new AbortController().signal };
  const key = "8d7c6b5a-4938-4726-9b1c-2d3e4f5a6b7c";
  const turn = (prompt: string, position: number, busy: string, thread: string) => {
    process.env.STANDIN_BUSY = busy;
    process.env.STANDIN_THREAD = thread;
    return runAgentTurn({ agent: "codex", model: "default", effort: null, system: "Instructions.", prompt, tools: [], maxTurns: 4, session: { key, history: "", position } }, io);
  };
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; threadId?: string });
  try {
    const first = await turn("Remember KIWI.", 0, "0", "thread-1");
    assert.equal(first.resumed, false);
    assert.equal(first.restart, undefined, "a new chat restarts nothing");

    // The person has the thread open in the ChatGPT app for a moment.
    const second = await turn("What did I ask you to remember?", 2, "1", "unused");
    assert.equal(second.resumed, true, "the same thread, once the app let go");
    assert.equal(second.restart, undefined);
    assert.deepEqual(statuses, ["Waiting for the ChatGPT app…"]);
    assert.deepEqual(calls().slice(1).map((call) => `${call.method} ${call.threadId ?? ""}`), ["thread/resume thread-1", "thread/resume thread-1"]);

    // The app keeps it open past the wait: a new thread, and the reason recorded.
    const third = await turn("And now?", 4, "always", "thread-2");
    assert.equal(third.resumed, false);
    assert.equal(third.restart?.reason, "busy");
    assert.match(third.restart?.error ?? "", /already has an active writer/);
    assert.equal(calls().at(-1)?.method, "thread/start");
    const store = JSON.parse(readFileSync(join(root, "state", "assistant-sessions.json"), "utf8")) as Record<string, { id: string; retired?: string[] }>;
    assert.equal(store[key]?.id, "thread-2");
    assert.deepEqual(store[key]?.retired, ["thread-1"], "the held thread is kept for deletion, not forgotten");
    await new Promise((done) => setTimeout(done, 20));
    assert.deepEqual(dropped, [], "and not deleted while the chat lives");

    assert.equal(await dropSession(key), true);
    await new Promise((done) => setTimeout(done, 20));
    assert.deepEqual(dropped.sort(), ["thread-1", "thread-2"], "deleting the chat deletes both");
  } finally {
    BUSY_WAIT.chat = timing;
    setNativeDropForTests(null);
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Copilot that reports its session's totals is charged per turn: what the turn added", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-copilot-totals-"));
  const saved = { PATH: process.env.PATH, ENSEMBLE_DESKTOP: process.env.ENSEMBLE_DESKTOP, STANDIN_TOTALS: process.env.STANDIN_TOTALS, ENSEMBLE_REMOTE_STATE_DIR: process.env.ENSEMBLE_REMOTE_STATE_DIR, COPILOT_HOME: process.env.COPILOT_HOME };
  process.env.PATH = `${copilotStandIn()}:${process.env.PATH ?? ""}`;
  process.env.ENSEMBLE_DESKTOP = "1";
  process.env.STANDIN_TOTALS = join(root, "totals.json");
  process.env.ENSEMBLE_REMOTE_STATE_DIR = join(root, "state");
  process.env.COPILOT_HOME = join(root, "copilot-home");
  mkdirSync(join(root, "copilot-home", "session-state"), { recursive: true });
  try {
    const turn = (prompt: string, position: number) =>
      runAgentTurn({ agent: "copilot-cli", model: "default", effort: null, system: "Instructions.", prompt, tools: [], maxTurns: 4, session: { key: "chat-totals-1", history: "", position } }, { call: async () => ({ text: "{}" }), onDelta: () => undefined, signal: new AbortController().signal });
    const first = await turn("One", 0);
    const second = await turn("Two", 2);
    assert.deepEqual([first.tokensIn, first.tokensOut, second.resumed], [1000, 10, true]);
    assert.deepEqual([second.tokensIn, second.tokensOut], [1000, 10], "not the session's 2000 so far");
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Codex chat's sub-agent (spawn_agent) reports on the same connection: its answer, tokens and turn end are not the chat's", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-codex-subagent-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!/usr/bin/env node
if (process.argv[2] === 'mcp') { console.log(process.env.STANDIN_CODEX_MCP || '[]'); process.exit(0); }
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.169.0' } });
  if (message.method === 'account/read') return send({ id: message.id, result: { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: true } });
  if (message.method === 'thread/start') return send({ id: message.id, result: { thread: { id: 'thread-1' }, model: 'gpt-test' } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-1' } } });
    // As Codex 0.169 sends it: the sub-agent's thread reports first, from start to end, then the chat's own.
    const child = { threadId: 'thread-2', turnId: 'turn-2' };
    send({ method: 'turn/started', params: { threadId: 'thread-2', turn: { id: 'turn-2', status: 'inProgress', items: [] } } });
    send({ method: 'item/agentMessage/delta', params: { ...child, itemId: 'm2', delta: 'PLUM' } });
    send({ method: 'item/completed', params: { ...child, item: { type: 'agentMessage', id: 'm2', text: 'PLUM', phase: 'final_answer' } } });
    send({ method: 'thread/tokenUsage/updated', params: { ...child, tokenUsage: { total: { inputTokens: 9000, outputTokens: 999 } } } });
    send({ method: 'turn/completed', params: { threadId: 'thread-2', turn: { id: 'turn-2', status: 'completed' } } });
    setTimeout(() => {
      const own = { threadId: 'thread-1', turnId: 'turn-1' };
      send({ method: 'item/agentMessage/delta', params: { ...own, itemId: 'm1', delta: 'DONE' } });
      send({ method: 'item/completed', params: { ...own, item: { type: 'agentMessage', id: 'm1', text: 'DONE', phase: 'final_answer' } } });
      send({ method: 'thread/tokenUsage/updated', params: { ...own, tokenUsage: { total: { inputTokens: 120, outputTokens: 30 } } } });
      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    }, 200);
    return;
  }
  send({ id: message.id, result: {} });
});
`);
  chmodSync(join(bin, "codex"), 0o755);
  const saved = { PATH: process.env.PATH, ENSEMBLE_DESKTOP: process.env.ENSEMBLE_DESKTOP, ENSEMBLE_REMOTE_STATE_DIR: process.env.ENSEMBLE_REMOTE_STATE_DIR };
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.ENSEMBLE_DESKTOP = "1";
  process.env.ENSEMBLE_REMOTE_STATE_DIR = join(root, "state");
  // The turn's MCP config names the local API; this stand-in never calls it.
  try { localApiUrl(); } catch { setLocalPort(9); }
  const deltas: string[] = [];
  try {
    const result = await runAgentTurn(
      { agent: "codex", model: "default", effort: null, system: "Instructions.", prompt: "Ask a sub-agent", tools: [], maxTurns: 4 },
      { call: async () => ({ text: "{}" }), onDelta: (text) => deltas.push(text), signal: new AbortController().signal },
    );
    assert.equal(result.text, "DONE");
    assert.deepEqual([result.tokensIn, result.tokensOut], [120, 30]);
    assert.equal(deltas.join(""), "DONE");
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Claude Code turn whose background sub-agent finishes after its answer: the last answer is the reply, set apart as it streams, and both stretches count", { timeout: 120_000 }, async (t) => {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ensemble-claude-subagent-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  // As Claude Code 2.1.325 runs a background sub-agent under -p: the turn answers, the sub-agent's words name the
  // Agent call that started it, then the turn answers again. The costs are the session's so far.
  writeFileSync(join(bin, "claude"), String.raw`#!/usr/bin/env node
const say = (value) => process.stdout.write(JSON.stringify(value) + "\n");
process.stdin.resume();
process.stdin.on("end", () => {
  const delta = (text, parent) => say({ type: "stream_event", parent_tool_use_id: parent, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
  say({ type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-test" });
  delta("Waiting on the sub-agent.", null);
  say({ type: "assistant", parent_tool_use_id: "a1", message: { content: [{ type: "text", text: "PLUM" }] } });
  delta("PLUM", "a1");
  say({ type: "result", subtype: "success", is_error: false, result: "Waiting on the sub-agent.", total_cost_usd: 0.5, usage: { input_tokens: 60, output_tokens: 8 }, model_usage_since_last_result: { "claude-haiku-test": { inputTokens: 70, outputTokens: 12, costUSD: 0.004 } } });
  say({ type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-test" });
  delta("DONE", null);
  say({ type: "result", subtype: "success", is_error: false, result: "DONE", total_cost_usd: 0.51, usage: { input_tokens: 100, output_tokens: 20 }, model_usage_since_last_result: { "claude-haiku-test": { inputTokens: 100, outputTokens: 20, costUSD: 0.006 } } });
});
`);
  chmodSync(join(bin, "claude"), 0o755);
  const saved = { PATH: process.env.PATH, ENSEMBLE_DESKTOP: process.env.ENSEMBLE_DESKTOP };
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.ENSEMBLE_DESKTOP = "1";
  const app = Fastify();
  await app.register(engineRoutes);
  try {
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("this sandbox does not allow a loopback port");
      throw error;
    }
    setLocalPort((app.server.address() as { port: number }).port);
    const deltas: string[] = [];
    const result = await runAgentTurn(
      { agent: "claude-code", model: "haiku", effort: null, system: "You are the Ensemble assistant.", prompt: "Ask a sub-agent", tools: [], maxTurns: 8 },
      { call: async () => ({ text: "{}" }), onDelta: (text) => deltas.push(text), signal: new AbortController().signal },
    );
    assert.equal(result.text, "DONE");
    assert.equal(deltas.join(""), "Waiting on the sub-agent.\n\nDONE");
    assert.deepEqual([result.tokensIn, result.tokensOut], [170, 32]);
    assert.ok(Math.abs((result.costUsd ?? 0) - 0.01) < 1e-9, "this turn's cost, not the session's so far");
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
