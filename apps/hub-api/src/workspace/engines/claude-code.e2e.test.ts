/**
 * Claude Code as the engine, end to end, with a stand-in `claude` on PATH.
 * The stand-in speaks Claude Code's stream-json and runs the real per-run
 * hook (scripts/ensemble-hook.mjs --engine) from the settings it was given,
 * so the whole chain is real: hook → /api/engine/ask → the run's rules → back.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootSidecar, sleep, startStubRuntime } from "../../desktop/e2e-harness.js";

const FAKE_CLAUDE = `#!/usr/bin/env node
const { execSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.999 (Claude Code)"); process.exit(0); }
const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
const hook = settings.hooks.PreToolUse[0].hooks[0].command;
const say = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const ask = (tool_name, tool_input) => {
  const out = execSync(hook, { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd: process.cwd() }), encoding: "utf8" });
  return JSON.parse(out).hookSpecificOutput;
};
say({ type: "system", subtype: "init", session_id: "s1", model: "claude-test", cwd: process.cwd() });
const seen = [];
const file = join(process.cwd(), "hello.txt");
const write = ask("Write", { file_path: file, content: "hi" });
if (write.permissionDecision === "allow") writeFileSync(file, "hi");
seen.push("write:" + write.permissionDecision);
if (write.permissionDecision !== "allow") seen.push("[" + write.permissionDecisionReason + "]");
say({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: file } }] } });
seen.push("commit:" + ask("Bash", { command: "git add -A && git commit -m wip" }).permissionDecision);
seen.push("ssh:" + ask("Read", { file_path: join(require("node:os").homedir(), ".ssh", "id_rsa") }).permissionDecision);
seen.push("sudo:" + ask("Bash", { command: "sudo rm -rf /" }).permissionDecision);
// Questions go through Ensemble's ask_person MCP tool: start the server from --mcp-config and call it.
const mcp = JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers.ensemble;
const allowed = ask("mcp__ensemble__ask_person", { question: "Which colour?" });
const reply = require("node:child_process").execFileSync(mcp.command, mcp.args, {
  input: [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask_person", arguments: { question: "Which colour?", options: ["Red", "Blue"], recommended: "Blue" } } },
  ].map((line) => JSON.stringify(line)).join("\\n") + "\\n",
  encoding: "utf8",
  env: process.env,
});
const answer = reply.trim().split("\\n").map((line) => JSON.parse(line)).find((line) => line.id === 2);
seen.push("question:" + allowed.permissionDecision + ":" + answer.result.content[0].text);
seen.push("sandbox:" + settings.sandbox.enabled, "effort:" + (args.includes("--effort") ? args[args.indexOf("--effort") + 1] : "none"), "sources:" + args[args.indexOf("--setting-sources") + 1]);
const prompt = args[args.indexOf("-p") + 1];
seen.push("resume:" + (args.includes("--resume") ? args[args.indexOf("--resume") + 1] : "none"), "insession:" + prompt.startsWith("(Ensemble: a new task, continuing in this session."));
seen.push("brief:" + (/^# Engine run\\n/.test(prompt) ? "title-first" : "other") + ":" + (prompt.includes("Weekly digest") ? "unpicked-skill" : "no-unpicked-skill") + ":" + (/You are working for|Internet: on/.test(prompt) ? "noise" : "lean"));
say({ type: "result", subtype: "success", is_error: false, num_turns: 3, result: seen.join(" "), total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 20 } });
`;

test("Claude Code as the engine: every tool call is judged by the run's rules", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ensemble-claude-engine-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(join(bin, "claude"), 0o755);
  const runtime = await startStubRuntime();
  const side = await bootSidecar(root, runtime.url, { PATH: `${bin}:${process.env.PATH ?? ""}` });
  try {
    const task = await side.api<{ task: { id: string } }>("/api/tasks", { json: { title: "Engine run" } });
    assert.equal(task.status, 201, JSON.stringify(task.body));
    // An enabled skill the task did not pick is for other work.
    const skill = await side.api("/api/skills", { json: { name: "Weekly digest", description: "How I like my weekly digest", body: "Weekly digest: three bullets." } });
    assert.ok(skill.status < 300, JSON.stringify(skill.body));
    const assigned = await side.api<{ jobId?: string; error?: string }>("/api/agent/assign", {
      json: { taskId: task.body.task.id, kind: "code", engine: "claude-code", reasoningEffort: "high", mode: "unattended", sandbox: false, delivery: "local" },
    });
    assert.ok(assigned.body.jobId, JSON.stringify(assigned.body));
    let job: { status: string; summary?: string | null; error?: string | null; folder?: string | null } = { status: "queued" };
    for (let i = 0; i < 240 && !["succeeded", "failed", "blocked", "cancelled"].includes(job.status); i += 1) {
      await sleep(500);
      job = (await side.api<{ job: typeof job }>(`/api/agent/jobs/${assigned.body.jobId}`)).body.job;
    }
    assert.equal(job.status, "succeeded", `${job.error ?? ""}\n${side.logs().slice(-3000)}`);
    const summary = job.summary ?? "";
    assert.match(summary, /write:allow/);
    assert.match(summary, /commit:deny/, "Local only: the engine may not commit");
    assert.match(summary, /ssh:deny/, "keys are never readable");
    assert.match(summary, /sudo:deny/);
    assert.match(summary, /question:allow:The person answered: Blue/, "unattended takes the recommended option through ask_person");
    assert.match(summary, /sandbox:false/);
    assert.match(summary, /effort:high/, "the thinking level chosen for the run reaches Claude Code");
    assert.match(summary, /sources:user(\s|$)/, "a folder the person did not trust: its own .claude/ settings stay out");
    assert.ok(job.folder && existsSync(join(job.folder, "hello.txt")));
    assert.equal(readFileSync(join(job.folder!, "hello.txt"), "utf8"), "hi");
    assert.match(summary, /resume:none insession:false/, "a new task starts a new session");
    assert.match(summary, /brief:title-first:no-unpicked-skill:lean/, "the brief opens with the task, carries only picked skills, and no noise");

    // Continuing it: the same folder, and Claude Code resumes its own session with the new task.
    const next = await side.api<{ task: { id: string } }>("/api/tasks", { json: { title: "Follow-up" } });
    const continued = await side.api<{ jobId?: string; error?: string }>("/api/agent/assign", {
      json: { taskId: next.body.task.id, kind: "code", engine: "claude-code", mode: "unattended", sandbox: false, delivery: "local", continueFromJobId: assigned.body.jobId },
    });
    assert.ok(continued.body.jobId, JSON.stringify(continued.body));
    let second: { status: string; summary?: string | null; error?: string | null; folder?: string | null; session?: { id: string; resumable: boolean } | null } = { status: "queued" };
    for (let i = 0; i < 240 && !["succeeded", "failed", "blocked", "cancelled"].includes(second.status); i += 1) {
      await sleep(500);
      second = (await side.api<{ job: typeof second }>(`/api/agent/jobs/${continued.body.jobId}`)).body.job;
    }
    assert.equal(second.status, "succeeded", `${second.error ?? ""}\n${side.logs().slice(-3000)}`);
    assert.equal(second.folder, job.folder);
    assert.match(second.summary ?? "", /resume:s1 insession:true/, "the agent's own session goes on, told it is a new task");
    assert.deepEqual(second.session, { id: assigned.body.jobId, resumable: true });
    const sessions = await side.api<{ sessions: Array<{ id: string; runs: number; latestTask: { title: string }; agent: string }> }>("/api/agent/sessions");
    assert.deepEqual(sessions.body.sessions.map((row) => [row.id, row.agent, row.runs, row.latestTask.title]), [[assigned.body.jobId, "claude-code", 2, "Follow-up"]]);
  } finally {
    await side.stop();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
