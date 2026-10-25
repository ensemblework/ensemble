/**
 * The ACP agents (Grok Build, OpenCode, Gemini CLI, Antigravity) as the engine, end to end, with a
 * stand-in `grok` on PATH that speaks ACP: Ensemble starts it with its own permission prompts on,
 * signs in with the login it already has, sets the run's model and thinking level from the
 * session's options, judges every permission by the run's rules (once, never always), carries
 * refusals back as the next message, and finds the agent's sign-in and models for Settings.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootSidecar, sleep, startStubRuntime } from "../../desktop/e2e-harness.js";

const FAKE_GROK = `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("grok 1.0.20"); process.exit(0); }
if (args[0] === "models") { console.log("You are logged in as mira@example.com\\nAvailable models:\\n  - grok-code-fast (default)\\n  - grok-4"); process.exit(0); }
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
const waiting = new Map();
let next = 100;
const ask = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); send({ id, method, params }); });
const OPTIONS = [{ optionId: "allow-once", kind: "allow_once", name: "Allow once" }, { optionId: "allow-always", kind: "allow_always", name: "Always" }, { optionId: "reject-once", kind: "reject_once", name: "Reject" }];
const CONFIG = [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "grok-code-fast", options: [{ value: "grok-code-fast", name: "Grok Code Fast" }, { value: "grok-4", name: "Grok 4" }] },
  { id: "reasoning", name: "Reasoning", category: "thought_level", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
];
let session = null;
let prompts = 0;
const seen = ["mode:" + args[args.indexOf("--permission-mode") + 1]];
async function work(promptId) {
  prompts += 1;
  if (prompts > 1) {
    send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " followed-up" } } } });
    send({ id: promptId, result: { stopReason: "end_turn" } });
    return;
  }
  const cwd = session.cwd;
  const permit = async (toolCall) => (await ask("session/request_permission", { sessionId: "s1", toolCall: { toolCallId: "t" + next, status: "pending", ...toolCall }, options: OPTIONS })).outcome.optionId;
  seen.push("ssh:" + (await permit({ kind: "execute", title: "Run cat", rawInput: { command: ["cat", join(homedir(), ".ssh", "id_rsa")] } })));
  seen.push("commit:" + (await permit({ kind: "execute", title: "\`git commit -am wip\`" })));
  const file = join(cwd, "hello.txt");
  const write = await permit({ kind: "edit", title: "Write hello.txt", locations: [{ path: file }] });
  if (write === "allow-once") writeFileSync(file, "hi");
  seen.push("write:" + write);
  seen.push("tool:" + (await permit({ kind: "other", title: "ensemble: ask_person" })));
  const mcp = session.mcpServers.find((server) => server.name === "ensemble");
  const env = Object.fromEntries(mcp.env.map((item) => [item.name, item.value]));
  const reply = execFileSync(mcp.command, mcp.args, {
    input: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask_person", arguments: { question: "Which size?", options: ["Small", "Large"], recommended: "Large" } } },
    ].map((line) => JSON.stringify(line)).join("\\n") + "\\n",
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  seen.push("mcp:" + reply.trim().split("\\n").map((line) => JSON.parse(line)).find((line) => line.id === 2).result.content[0].text);
  seen.push("model:" + CONFIG[0].currentValue, "effort:" + CONFIG[1].currentValue, "keys:" + (process.env.XAI_API_KEY ? "leaked" : "none"));
  send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "tool_call", toolCallId: "x", title: "Read README.md", kind: "read", status: "completed" } } });
  send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: seen.join(" ") } } } });
  send({ id: promptId, result: { stopReason: "end_turn" } });
}
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && !message.method) { const resolve = waiting.get(message.id); waiting.delete(message.id); resolve && resolve(message.result); return; }
  if (message.method === "initialize") { seen.push("client:" + (message.params._meta && message.params._meta.clientType)); send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "cached_token", name: "Cached" }] } }); }
  else if (message.method === "authenticate") { seen.push("auth:" + message.params.methodId); send({ id: message.id, result: {} }); }
  else if (message.method === "session/new") { session = message.params; send({ id: message.id, result: { sessionId: "s1", configOptions: CONFIG } }); }
  else if (message.method === "session/set_config_option") { const option = CONFIG.find((row) => row.id === message.params.configId); option.currentValue = message.params.value; send({ id: message.id, result: { configOptions: CONFIG } }); }
  else if (message.method === "session/prompt") work(message.id).catch((error) => { console.error(error); process.exit(1); });
});
`;

test("an ACP agent as the engine: its own prompts on, model and thinking set, every permission judged, refusals carried back", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ensemble-acp-engine-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "grok"), FAKE_GROK);
  chmodSync(join(bin, "grok"), 0o755);
  const runtime = await startStubRuntime();
  const side = await bootSidecar(root, runtime.url, { PATH: `${bin}:${process.env.PATH ?? ""}`, XAI_API_KEY: "ensemble-own-key" });
  const run = async (body: Record<string, unknown>) => {
    const task = await side.api<{ task: { id: string } }>("/api/tasks", { json: { title: "Grok run" } });
    const assigned = await side.api<{ jobId?: string; error?: string }>("/api/agent/assign", { json: { taskId: task.body.task.id, kind: "code", engine: "grok-cli", mode: "unattended", delivery: "local", ...body } });
    assert.ok(assigned.body.jobId, JSON.stringify(assigned.body));
    let job: { status: string; summary?: string | null; error?: string | null; folder?: string | null } = { status: "queued" };
    for (let i = 0; i < 240 && !["succeeded", "failed", "blocked", "cancelled"].includes(job.status); i += 1) {
      await sleep(500);
      job = (await side.api<{ job: typeof job }>(`/api/agent/jobs/${assigned.body.jobId}`)).body.job;
    }
    return job;
  };
  try {
    const job = await run({ sandbox: false, model: "grok-4", reasoningEffort: "high" });
    assert.equal(job.status, "succeeded", `${job.error ?? ""}\n${side.logs().slice(-3000)}`);
    const summary = job.summary ?? "";
    assert.match(summary, /mode:default/, "Grok's own prompts stay on, whatever its saved setting");
    assert.match(summary, /client:extension/);
    assert.match(summary, /auth:cached_token/, "the login the agent already has");
    assert.match(summary, /ssh:reject-once/, "keys are never readable, whatever form the command takes");
    assert.match(summary, /commit:reject-once/, "Local only: the engine may not commit");
    assert.match(summary, /write:allow-once/, "allowed once, never always");
    assert.match(summary, /tool:allow-once/, "Ensemble's own tools go ahead");
    assert.match(summary, /mcp:The person answered: Large/, "ask_person through the session's MCP servers");
    assert.match(summary, /model:grok-4/, "the run's model, set from the session's options");
    assert.match(summary, /effort:high/, "the run's thinking level, set from the session's options");
    assert.match(summary, /keys:none/, "Ensemble's own keys are not handed to Grok");
    assert.match(summary, /followed-up/, "refusals go back as the next message");
    if (job.folder) assert.equal(existsSync(join(job.folder, "hello.txt")) ? readFileSync(join(job.folder, "hello.txt"), "utf8") : "", "hi");

    const sandboxed = await run({ sandbox: true });
    assert.equal(sandboxed.status, "failed");
    assert.match(sandboxed.error ?? "", /Grok Build has no OS sandbox Ensemble can turn on here/);

    const found = await side.api<{ computers: Array<{ agents: Array<{ id: string; signedIn: boolean | null; models: Array<{ id: string; isDefault?: boolean }> }> }> }>("/api/subscriptions");
    const grok = found.body.computers[0]!.agents.find((agent) => agent.id === "grok-cli");
    assert.equal(grok?.signedIn, true);
    assert.deepEqual(grok?.models.map((model) => [model.id, model.isDefault ?? false]), [["grok-code-fast", true], ["grok-4", false]]);
  } finally {
    await side.stop();
    await runtime.close();
  }
});
