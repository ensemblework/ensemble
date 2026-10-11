/**
 * Codex as the engine, end to end, with a stand-in `codex` on PATH that speaks app-server JSON
 * lines: Ensemble starts the thread with the run's sandbox and trust, answers Codex's approval
 * requests by the run's rules, answers its questions, and Codex's own call to Ensemble's
 * ask_person MCP server (from the thread's config) is real.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootSidecar, sleep, startStubRuntime } from "../../desktop/e2e-harness.js";

const FAKE_CODEX = `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.162.0"); process.exit(0); }
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const waiting = new Map();
let next = 100;
const ask = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); send({ id, method, params }); });
let thread = null;
const seen = [];
async function work(cwd) {
  const command = async (text) => (await ask("item/commandExecution/requestApproval", { kind: "command", threadId: "t1", turnId: "u1", itemId: "c" + next, startedAtMs: 0, environmentId: null, command: text, cwd })).decision;
  seen.push("ssh:" + (await command("cat " + join(homedir(), ".ssh", "id_rsa"))));
  seen.push("commit:" + (await command("git commit -am wip")));
  const file = join(cwd, "hello.txt");
  send({ method: "item/started", params: { threadId: "t1", turnId: "u1", startedAtMs: 0, item: { type: "fileChange", id: "f1", status: "inProgress", changes: [{ path: file, kind: { type: "add" }, diff: "" }] } } });
  const write = (await ask("item/fileChange/requestApproval", { threadId: "t1", turnId: "u1", itemId: "f1", startedAtMs: 0 })).decision;
  if (write === "accept") writeFileSync(file, "hi");
  seen.push("write:" + write);
  const user = await ask("item/tool/requestUserInput", { threadId: "t1", turnId: "u1", itemId: "q", isBlocking: true, autoResolutionMs: null, questions: [{ id: "q1", header: "Colour", question: "Which colour?", isOther: true, isSecret: false, options: [{ label: "Red", description: "" }, { label: "Blue (Recommended)", description: "" }] }] });
  seen.push("question:" + user.answers.q1.answers[0]);
  const mcp = thread.config.mcp_servers.ensemble;
  const reply = execFileSync(mcp.command, mcp.args, {
    input: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask_person", arguments: { question: "Which size?", options: ["Small", "Large"], recommended: "Large" } } },
    ].map((line) => JSON.stringify(line)).join("\\n") + "\\n",
    encoding: "utf8",
    env: { ...process.env, ...mcp.env },
  });
  seen.push("mcp:" + reply.trim().split("\\n").map((line) => JSON.parse(line)).find((line) => line.id === 2).result.content[0].text);
  seen.push("policy:" + thread.approvalPolicy, "sandbox:" + thread.sandbox, "trust:" + thread.config.projects[cwd].trust_level, "keys:" + (process.env.OPENAI_API_KEY ? "leaked" : "none"));
  send({ method: "thread/tokenUsage/updated", params: { threadId: "t1", turnId: "u1", tokenUsage: { total: { totalTokens: 150, inputTokens: 120, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 0 }, last: {}, modelContextWindow: null } } });
  send({ method: "item/completed", params: { threadId: "t1", turnId: "u1", completedAtMs: 0, item: { type: "agentMessage", id: "m1", text: seen.join(" "), phase: "final_answer" } } });
  send({ method: "turn/completed", params: { threadId: "t1", turn: { id: "u1", status: "completed", error: null, items: [] } } });
}
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && !message.method) { const resolve = waiting.get(message.id); waiting.delete(message.id); resolve && resolve(message.result); return; }
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake/0.162.0", codexHome: "/x", platformFamily: "unix", platformOs: "macos" } });
  else if (message.method === "account/read") send({ id: message.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
  else if (message.method === "thread/start") { thread = message.params; send({ id: message.id, result: { thread: { id: "t1" }, model: "gpt-test" } }); }
  else if (message.method === "turn/start") { send({ id: message.id, result: { turn: { id: "u1" } } }); work(thread.cwd).catch((error) => { console.error(error); process.exit(1); }); }
  else if (message.id !== undefined) send({ id: message.id, result: {} });
});
`;

test("Codex as the engine: approvals and questions are answered by the run's rules", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ensemble-codex-engine-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), FAKE_CODEX);
  chmodSync(join(bin, "codex"), 0o755);
  const runtime = await startStubRuntime();
  const side = await bootSidecar(root, runtime.url, { PATH: `${bin}:${process.env.PATH ?? ""}`, OPENAI_API_KEY: "sk-ensemble-own-key" });
  try {
    const task = await side.api<{ task: { id: string } }>("/api/tasks", { json: { title: "Codex run" } });
    assert.equal(task.status, 201, JSON.stringify(task.body));
    const assigned = await side.api<{ jobId?: string; error?: string }>("/api/agent/assign", {
      json: { taskId: task.body.task.id, kind: "code", engine: "codex", mode: "unattended", sandbox: false, delivery: "local" },
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
    assert.match(summary, /ssh:decline/, "keys are never readable");
    assert.match(summary, /commit:decline/, "Local only: the engine may not commit");
    assert.match(summary, /write:accept/);
    assert.match(summary, /question:Blue \(Recommended\)/, "unattended: Codex's recommended option");
    assert.match(summary, /mcp:The person answered: Large/, "ask_person through the thread's MCP config");
    assert.match(summary, /policy:untrusted/, "without its sandbox, Codex asks and the run's rules answer");
    assert.match(summary, /sandbox:danger-full-access/, "the sandbox was off for this run");
    assert.match(summary, /trust:untrusted/, "the folder's own .codex/ does not run");
    assert.match(summary, /keys:none/, "Ensemble's own keys are not handed to Codex");
    if (job.folder) assert.equal(existsSync(join(job.folder, "hello.txt")) ? readFileSync(join(job.folder, "hello.txt"), "utf8") : "", "hi");
  } finally {
    await side.stop();
    await runtime.close();
  }
});
