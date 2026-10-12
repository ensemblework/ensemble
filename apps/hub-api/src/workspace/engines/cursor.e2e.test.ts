/**
 * Cursor's agent as the engine, end to end, with a stand-in `cursor-agent` on PATH that speaks
 * ACP (JSON-RPC 2.0 lines): Ensemble authenticates with the login the agent already has, opens a
 * session with its ask_person MCP server, answers permission requests by the run's rules (once,
 * never always), and answers Cursor's questions.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootSidecar, sleep, startStubRuntime } from "../../desktop/e2e-harness.js";

const FAKE_CURSOR = `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2026.09.26"); process.exit(0); }
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
const waiting = new Map();
let next = 100;
const ask = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); send({ id, method, params }); });
const OPTIONS = [{ optionId: "allow-once", kind: "allow_once", name: "Allow once" }, { optionId: "allow-always", kind: "allow_always", name: "Always" }, { optionId: "reject-once", kind: "reject_once", name: "Reject" }];
let session = null;
let authenticated = false;
const seen = ["sandbox:" + args[args.indexOf("--sandbox") + 1]];
async function work(promptId) {
  const cwd = session.cwd;
  const permit = async (toolCall) => (await ask("session/request_permission", { sessionId: "s1", toolCall: { toolCallId: "t" + next, status: "pending", ...toolCall }, options: OPTIONS })).outcome.optionId;
  seen.push("ssh:" + (await permit({ kind: "execute", title: "\`cat " + join(homedir(), ".ssh", "id_rsa") + "\`" })));
  seen.push("commit:" + (await permit({ kind: "execute", title: "\`git commit -am wip\`" })));
  const file = join(cwd, "hello.txt");
  const write = await permit({ kind: "edit", title: "Write " + file, content: [{ type: "diff", path: file, oldText: null, newText: "hi" }] });
  if (write === "allow-once") writeFileSync(file, "hi");
  seen.push("write:" + write);
  const question = await ask("cursor/ask_question", { toolCallId: "q", questions: [{ id: "q1", prompt: "Which colour?", options: [{ id: "red", label: "Red" }, { id: "blue", label: "Blue (Recommended)" }] }] });
  seen.push("question:" + question.outcome.answers[0].selectedOptionIds[0]);
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
  seen.push("auth:" + authenticated, "keys:" + (process.env.CURSOR_API_KEY ? "leaked" : "none"));
  send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "tool_call", toolCallId: "x", title: "Read README.md", kind: "read", status: "completed" } } });
  send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: seen.join(" ") } } } });
  send({ id: promptId, result: { stopReason: "end_turn" } });
}
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && !message.method) { const resolve = waiting.get(message.id); waiting.delete(message.id); resolve && resolve(message.result); return; }
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "cursor_login", name: "Cursor Login" }] } });
  else if (message.method === "authenticate") { authenticated = message.params.methodId === "cursor_login"; send({ id: message.id, result: {} }); }
  else if (message.method === "session/new") { session = message.params; send({ id: message.id, result: { sessionId: "s1" } }); }
  else if (message.method === "session/prompt") work(message.id).catch((error) => { console.error(error); process.exit(1); });
});
`;

test("Cursor's agent as the engine: permissions and questions are answered by the run's rules", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ensemble-cursor-engine-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "cursor-agent"), FAKE_CURSOR);
  chmodSync(join(bin, "cursor-agent"), 0o755);
  const runtime = await startStubRuntime();
  const side = await bootSidecar(root, runtime.url, { PATH: `${bin}:${process.env.PATH ?? ""}`, CURSOR_API_KEY: "ensemble-own-key" });
  try {
    const task = await side.api<{ task: { id: string } }>("/api/tasks", { json: { title: "Cursor run" } });
    assert.equal(task.status, 201, JSON.stringify(task.body));
    const assigned = await side.api<{ jobId?: string; error?: string }>("/api/agent/assign", {
      json: { taskId: task.body.task.id, kind: "code", engine: "cursor-agent", mode: "unattended", sandbox: false, delivery: "local" },
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
    assert.match(summary, /sandbox:disabled/, "the sandbox was off for this run");
    assert.match(summary, /ssh:reject-once/, "keys are never readable");
    assert.match(summary, /commit:reject-once/, "Local only: the engine may not commit");
    assert.match(summary, /write:allow-once/, "allowed once, never always");
    assert.match(summary, /question:blue/, "unattended: Cursor's recommended option");
    assert.match(summary, /mcp:The person answered: Large/, "ask_person through the session's MCP servers");
    assert.match(summary, /auth:true/, "the login the agent already has");
    assert.match(summary, /keys:none/, "Ensemble's own keys are not handed to Cursor");
    if (job.folder) assert.equal(existsSync(join(job.folder, "hello.txt")) ? readFileSync(join(job.folder, "hello.txt"), "utf8") : "", "hi");
  } finally {
    await side.stop();
    await runtime.close();
  }
});
