/**
 * GitHub Copilot as the engine, end to end, with a stand-in `copilot` on PATH that speaks ACP the
 * way Copilot CLI 1.0 does: Ensemble's ask_person server arrives through --additional-mcp-config
 * (Copilot's ACP takes only http servers from the client), the model and thinking level are
 * session config options, a refused call ends Copilot's turn, and permission requests are answered
 * once by the run's rules, never always.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootSidecar, sleep, startStubRuntime } from "../../desktop/e2e-harness.js";

const FAKE_COPILOT = `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("GitHub Copilot CLI 1.0.103."); process.exit(0); }
if (!args.includes("--acp")) process.exit(2);
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
const waiting = new Map();
let next = 100;
const ask = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); send({ id, method, params }); });
const OPTIONS = [{ optionId: "allow_once", kind: "allow_once", name: "Allow once" }, { optionId: "allow_always", kind: "allow_always", name: "Always allow" }, { optionId: "reject_once", kind: "reject_once", name: "Deny" }];
const seen = [];
const flag = (name) => args.includes(name);
seen.push("noask:" + flag("--no-ask-user"), "sandbox:" + flag("--sandbox"), "context:" + (args[args.indexOf("--context") + 1] || "none"), "allowensemble:" + (args[args.indexOf("--allow-tool") + 1] === "ensemble"));
seen.push("allowall:" + (process.env.COPILOT_ALLOW_ALL ? "leaked" : "none"), "ghtoken:" + (process.env.GH_TOKEN || process.env.GITHUB_TOKEN ? "leaked" : "none"));
const flagValue = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
// Like Copilot CLI: --model and --reasoning-effort pick the starting model and level; switching the
// model over ACP afterwards puts the session back on that model's standard context window.
const config = { model: ["auto", "claude-sonnet-5.5", "gpt-5.6-luna"].includes(flagValue("--model")) ? flagValue("--model") : "claude-sonnet-5.5", reasoning_effort: flagValue("--reasoning-effort") || "medium" };
let tier = flagValue("--context") || "default";
const options = () => [
  { id: "model", currentValue: config.model, options: [{ value: "auto" }, { value: "claude-sonnet-5.5" }, { value: "gpt-5.6-luna" }] },
  { id: "reasoning_effort", currentValue: config.reasoning_effort, options: ["none", "low", "medium", "high"].map((value) => ({ value })) },
];
let session = null;
let prompts = 0;
const permit = async (toolCall) => {
  const id = "call_" + next;
  send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "tool_call", toolCallId: id, status: "pending", ...toolCall } } });
  return (await ask("session/request_permission", { sessionId: "s1", toolCall: { toolCallId: id, status: "pending", ...toolCall }, options: OPTIONS })).outcome.optionId;
};
async function first(promptId) {
  const answer = await permit({ title: "Read key", kind: "execute", rawInput: { command: "cat " + join(homedir(), ".ssh", "id_rsa"), commands: ["cat " + join(homedir(), ".ssh", "id_rsa")] } });
  seen.push("ssh:" + answer);
  // Copilot ends its turn when a call is refused.
  send({ id: promptId, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 5 } } });
}
async function second(promptId, text) {
  seen.push("followup:" + /Ensemble refused/.test(text));
  const file = join(session.cwd, "hello.txt");
  const write = await permit({ title: "apply_patch", kind: "edit", rawInput: { fileName: file, diff: "+hi" }, locations: [{ path: file }] });
  if (write === "allow_once") writeFileSync(file, "hi");
  seen.push("write:" + write);
  const file2 = join(session.cwd, ".git", "hooks", "pre-commit");
  seen.push("githook:" + (await permit({ title: "Create file", kind: "edit", rawInput: { fileName: file2 }, locations: [{ path: file2 }] })));
  const mcpFile = args[args.indexOf("--additional-mcp-config") + 1].slice(1);
  const server = JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers.ensemble;
  const reply = execFileSync(server.command, server.args, {
    input: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask_person", arguments: { question: "Which size?", options: ["Small", "Large"], recommended: "Large" } } },
    ].map((line) => JSON.stringify(line)).join("\\n") + "\\n",
    encoding: "utf8",
    env: { ...process.env, ...server.env },
  });
  seen.push("mcp:" + reply.trim().split("\\n").map((line) => JSON.parse(line)).find((line) => line.id === 2).result.content[0].text);
  seen.push("model:" + config.model, "effort:" + config.reasoning_effort, "prompts:" + prompts);
  seen.push("window:" + tier);
  send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "usage_update", used: 1234, size: tier === "long_context" ? 922000 : 200000 } } });
  send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: seen.join(" ") } } } });
  send({ id: promptId, result: { stopReason: "end_turn", usage: { inputTokens: 200, outputTokens: 20 } } });
}
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && !message.method) { const resolve = waiting.get(message.id); waiting.delete(message.id); resolve && resolve(message.result); return; }
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } }, authMethods: [] } });
  else if (message.method === "session/new") { session = message.params; seen.push("mcpservers:" + message.params.mcpServers.length); send({ id: message.id, result: { sessionId: "s1", configOptions: options() } }); }
  else if (message.method === "session/set_config_option") { if (message.params.configId === "model") { tier = "default"; seen.push("modelswitch"); } config[message.params.configId] = message.params.value; send({ id: message.id, result: { configOptions: options() } }); }
  else if (message.method === "session/prompt") {
    prompts += 1;
    const text = message.params.prompt.map((part) => part.text || "").join("");
    (prompts === 1 ? first(message.id) : second(message.id, text)).catch((error) => { console.error(error); process.exit(1); });
  }
});
`;

test("GitHub Copilot as the engine: permissions, refusals, model, thinking and context follow the run", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ensemble-copilot-engine-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "copilot"), FAKE_COPILOT);
  chmodSync(join(bin, "copilot"), 0o755);
  const runtime = await startStubRuntime();
  // A home of its own: trust sharing would otherwise mark the test's workspace in the developer's own agents.
  const side = await bootSidecar(root, runtime.url, { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: root, COPILOT_ALLOW_ALL: "true", GH_TOKEN: "ensemble-own-token" });
  try {
    const task = await side.api<{ task: { id: string } }>("/api/tasks", { json: { title: "Copilot run" } });
    assert.equal(task.status, 201, JSON.stringify(task.body));
    const assigned = await side.api<{ jobId?: string; error?: string }>("/api/agent/assign", {
      json: { taskId: task.body.task.id, kind: "code", engine: "copilot-cli", model: "gpt-5.6-luna", reasoningEffort: "low", contextTier: "long_context", mode: "unattended", sandbox: false, delivery: "local" },
    });
    assert.ok(assigned.body.jobId, JSON.stringify(assigned.body));
    let job: { status: string; summary?: string | null; error?: string | null; folder?: string | null } = { status: "queued" };
    for (let i = 0; i < 240 && !["succeeded", "failed", "blocked", "cancelled"].includes(job.status); i += 1) {
      await sleep(500);
      const polled = await side.api<{ job: typeof job }>(`/api/agent/jobs/${assigned.body.jobId}`).catch((error: Error) => {
        throw new Error(`${error.message}\n${side.logs().slice(-4000)}`);
      });
      job = polled.body.job;
    }
    assert.equal(job.status, "succeeded", `${job.error ?? ""}\n${side.logs().slice(-3000)}`);
    const summary = job.summary ?? "";
    assert.match(summary, /noask:true/, "questions go through ask_person, not Copilot's own prompt");
    assert.match(summary, /sandbox:false/, "the sandbox was off for this run");
    assert.match(summary, /context:long_context/, "the long context window the task chose");
    assert.match(summary, /allowensemble:true/, "Ensemble's own MCP tools do not ask");
    assert.match(summary, /allowall:none/, "COPILOT_ALLOW_ALL never reaches Copilot");
    assert.match(summary, /ghtoken:none/, "a GitHub token in Ensemble's environment never reaches Copilot");
    assert.match(summary, /mcpservers:0/, "the MCP server comes from the config file, not session/new");
    assert.match(summary, /ssh:reject_once/, "keys are never readable");
    assert.match(summary, /followup:true/, "the refusal goes back as the next message");
    assert.match(summary, /write:allow_once/, "allowed once, never always");
    assert.match(summary, /githook:reject_once/, "files inside .git are refused");
    assert.match(summary, /mcp:The person answered: Large/, "unattended: ask_person returns the recommended option");
    assert.match(summary, /model:gpt-5\.6-luna/, "the task's model");
    assert.match(summary, /effort:low/, "the task's thinking level");
    assert.match(summary, /window:long_context/, "the long window holds: the model is chosen as Copilot starts");
    assert.doesNotMatch(summary, /modelswitch/, "no model switch over ACP, which would drop the long window");
    assert.match(summary, /prompts:2/, "one follow-up after the refused call");
    if (job.folder) assert.equal(existsSync(join(job.folder, "hello.txt")) ? readFileSync(join(job.folder, "hello.txt"), "utf8") : "", "hi");
  } finally {
    await side.stop();
    await runtime.close();
  }
});
