/**
 * An assistant turn run by a stand-in `claude` on PATH, end to end on this computer: the real
 * command line, Ensemble's MCP server started from the turn's config, its tools listed and called
 * through the loopback API with the turn's secret, a playbook's tools arriving with
 * `notifications/tools/list_changed`, the reply streamed and the result read. Needs a loopback
 * port (CI); sandboxes without local listening skip it.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { engineRoutes } from "../routes/engine.js";
import { setLocalPort } from "../workspace/engines/registry.js";
import { runAgentTurn } from "./agents.js";

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
    assert.deepEqual(result, { text: "Drew it.", model: "claude-haiku-test", tokensIn: 40, tokensOut: 4, costUsd: 0 });
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

test("Copilot streams its own JSON events and reports only the token usage for the Ensemble turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-copilot-output-"));
  const bin = join(root, "bin"); mkdirSync(bin);
  const program = join(bin, "copilot");
  writeFileSync(program, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('Copilot'); process.exit(0); }
if (args.includes('--version')) { console.log('1.0.89'); process.exit(0); }
if (args[args.indexOf('--output-format') + 1] !== 'json') process.exit(7);
const say = (type, data) => console.log(JSON.stringify({type, data}));
say('session.usage_info', {currentTokens:999999, tokenLimit:1000000});
say('assistant.message_delta', {deltaContent:'Plan '});
say('assistant.message_delta', {deltaContent:'ready.'});
say('assistant.message', {content:'Plan ready.'});
say('assistant.usage', {model:'gpt-copilot-test', inputTokens:123, outputTokens:12, cost:1});
say('assistant.usage', {model:'gpt-copilot-test', inputTokens:10, outputTokens:2, cost:1});
`);
  chmodSync(program, 0o755);
  const saved = { PATH: process.env.PATH, ENSEMBLE_DESKTOP: process.env.ENSEMBLE_DESKTOP };
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.ENSEMBLE_DESKTOP = "1";
  const deltas: string[] = [];
  try {
    const result = await runAgentTurn({ agent: "copilot-cli", model: "default", effort: null, system: "Ensemble", prompt: "Plan my task", tools: [], maxTurns: 8 }, { call: async () => ({ text: "{}" }), onDelta: text => deltas.push(text), signal: new AbortController().signal });
    assert.deepEqual(result, { text: "Plan ready.", model: "gpt-copilot-test", tokensIn: 133, tokensOut: 14, costUsd: null });
    assert.equal(deltas.join(""), "Plan ready.");
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
