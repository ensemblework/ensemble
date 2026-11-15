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
const host = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_HOST_AUTH_ENV_VAR", "CLAUDE_CODE_MESSAGING_TOKEN", "ANTHROPIC_BASE_URL"].filter((name) => process.env[name] !== undefined);
seen.push("host:" + (host.join(",") || "none"), "own:" + (process.env.CLAUDE_CODE_ATTRIBUTION_HEADER ?? "none"));
// A background sub-agent (Agent tool), as Claude Code 2.1.325 runs one under -p: its messages name the call that
// started it, and the run answers twice, the first time only to say it is waiting. Costs: the session's so far.
say({ type: "assistant", message: { content: [{ type: "tool_use", id: "a1", name: "Agent", input: { description: "Reply with PLUM", prompt: "Reply with PLUM." } }] } });
say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a1", content: "Async agent launched successfully." }] } });
say({ type: "assistant", parent_tool_use_id: "a1", message: { content: [{ type: "tool_use", id: "a2", name: "Read", input: { file_path: "notes.md" } }], usage: { input_tokens: 90000 } } });
say({ type: "user", parent_tool_use_id: "a1", message: { content: [{ type: "tool_result", tool_use_id: "a2", content: "notes" }] } });
say({ type: "assistant", parent_tool_use_id: "a1", message: { content: [{ type: "text", text: "PLUM" }], usage: { input_tokens: 90000 } } });
say({ type: "result", subtype: "success", is_error: false, num_turns: 2, result: "The sub-agent is still running.", total_cost_usd: 0.5, usage: { input_tokens: 60, output_tokens: 8 }, model_usage_since_last_result: { "claude-test": { inputTokens: 70, outputTokens: 12, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.004 } } });
say({ type: "system", subtype: "init", session_id: "s1", model: "claude-test", cwd: process.cwd() });
say({ type: "result", subtype: "success", is_error: false, num_turns: 3, result: seen.join(" "), total_cost_usd: 0.51, usage: { input_tokens: 100, output_tokens: 20 }, model_usage_since_last_result: { "claude-test": { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.006 } } });
`;

test("Claude Code as the engine: every tool call is judged by the run's rules", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ensemble-claude-engine-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(join(bin, "claude"), 0o755);
  const runtime = await startStubRuntime();
  // Started the way Claude in the Claude app's Code tab starts a runtime: with that session's own variables.
  const hostSession = {
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "claude-desktop-3p",
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    CLAUDE_CODE_HOST_AUTH_ENV_VAR: "ANTHROPIC_AUTH_TOKEN",
    CLAUDE_CODE_MESSAGING_TOKEN: "messaging-secret",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
  };
  const side = await bootSidecar(root, runtime.url, { PATH: `${bin}:${process.env.PATH ?? ""}`, ...hostSession, CLAUDE_CODE_ATTRIBUTION_HEADER: "0" });
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
    let job: { status: string; summary?: string | null; error?: string | null; folder?: string | null; runId?: string | null; tokensIn?: number; tokensOut?: number; turns?: number; costUsd?: number | null } = { status: "queued" };
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
    assert.match(summary, /host:none own:0/, "Claude Code signs in with the person's own settings, not the app session's");
    // A background sub-agent: the last answer is the summary, both stretches count (this run's cost, not the
    // session's so far), and the sub-agent's tool call is in the trace, marked, while its words are not the run's.
    assert.doesNotMatch(summary, /still running|PLUM/);
    assert.deepEqual([job.tokensIn, job.tokensOut, job.turns], [170, 32, 5]);
    assert.ok(Math.abs((job.costUsd ?? 0) - 0.01) < 1e-9, String(job.costUsd));
    const steps = (await side.api<{ run: { steps: Array<{ title: string; output: string | null }> } }>(`/api/runs/${job.runId}`)).body.run.steps;
    assert.ok(steps.some((step) => step.title === "Sub-agent: Read notes.md"), steps.map((step) => step.title).join(" | "));
    assert.ok(!steps.some((step) => step.title === "Message" && (step.output ?? "").includes("PLUM")), "the sub-agent's words are not a message of the run");

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
