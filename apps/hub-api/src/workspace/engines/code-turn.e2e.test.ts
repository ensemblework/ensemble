/**
 * The Code tab's agent end to end, with stand-ins on PATH (`claude`, `codex`): the first turn gets the
 * whole turn packet with no turn limit of Ensemble's own, reports a check through report_result, and
 * Ensemble runs that check again (it fails, whatever the agent said); the next turn in the session is
 * the message alone; switching agent starts a new session that gets a handoff record, written to the
 * run's folder. The thread shows each turn's states apart (docs/16 §9).
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootSidecar, sleep, startStubRuntime } from "../../desktop/e2e-harness.js";

const FAKE_CLAUDE = `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { appendFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.999 (Claude Code)"); process.exit(0); }
const say = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const prompt = args[args.indexOf("-p") + 1];
const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null;
const session = resume || "code-session-1";
let tools = "";
if (!resume) {
  writeFileSync("export.csv", "a,b\\n");
  const mcp = JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers.ensemble;
  const reply = execFileSync(mcp.command, mcp.args, {
    input: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "report_result", arguments: { outcome: "pass", summary: "The export keeps the order.", checks: [{ id: "AC-1", name: "export test", verdict: "pass", rerun: { command: "node -e \\"process.exit(3)\\"", expects: "exit_0" } }] } } },
    ].map((line) => JSON.stringify(line)).join("\\n") + "\\n",
    encoding: "utf8",
    env: process.env,
  });
  const lines = reply.trim().split("\\n").map((line) => JSON.parse(line));
  tools = lines.find((line) => line.id === 2).result.tools.map((tool) => tool.name).join(",");
  const reported = lines.find((line) => line.id === 3);
  if (reported.error || reported.result.isError) tools += " report refused: " + JSON.stringify(reported);
}
appendFileSync(process.env.STANDIN_LOG, JSON.stringify({ agent: "claude", resume, maxTurns: args.includes("--max-turns"), first: prompt.split("\\n")[0], last: prompt.split("\\n").at(-1), tools }) + "\\n");
say({ type: "system", subtype: "init", session_id: session, model: "claude-test", cwd: process.cwd() });
say({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
say({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Done.", usage: { input_tokens: 10, output_tokens: 5 } });
`;

const FAKE_CODEX = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.162.0"); process.exit(0); }
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let thread = null;
let how = "";
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && !message.method) return;
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake/0.162.0" } });
  else if (message.method === "account/read") send({ id: message.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
  else if (message.method === "thread/start") { thread = "codex-thread-1"; how = "start"; send({ id: message.id, result: { thread: { id: thread }, model: "gpt-test" } }); }
  else if (message.method === "thread/resume") { thread = message.params.threadId; how = "resume"; send({ id: message.id, result: { thread: { id: thread }, model: "gpt-test" } }); }
  else if (message.method === "turn/start") {
    const prompt = message.params.input[0].text;
    const record = /Handoff record (hof_\\w+)/.exec(prompt);
    appendFileSync(process.env.STANDIN_LOG, JSON.stringify({ agent: "codex", how, handoff: record ? record[1] : null, failed: /AC-1 \\(failed\\)/.test(prompt), last: prompt.split("\\n").at(-1) }) + "\\n");
    send({ id: message.id, result: { turn: { id: "u1" } } });
    send({ method: "item/completed", params: { threadId: thread, turnId: "u1", item: { type: "agentMessage", id: "m1", text: "Codex here.", phase: "final_answer" } } });
    send({ method: "turn/completed", params: { threadId: thread, turn: { id: "u1", status: "completed", error: null } } });
  } else if (message.id !== undefined) send({ id: message.id, result: {} });
});
`;

type Job = { status: string; summary?: string | null; error?: string | null; folder?: string };
type Turn = {
  id: string;
  completion: { conversation: { state: string }; files: { state: string }; checks: { state: string; runs: Array<{ claimed: string; verdict: string }> }; accepted: { state: string } } | null;
  packet: { mode: string; operation: string | null } | null;
  handoff: { id: string; reason: string; from: string } | null;
};

test("a Code tab thread: the packet, checks run again, the message alone in the same session, and a handoff on switching agent", { timeout: 400_000 }, async () => {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ensemble-code-turn-e2e-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const [name, script] of [["claude", FAKE_CLAUDE], ["codex", FAKE_CODEX]] as const) {
    writeFileSync(join(bin, name), script);
    chmodSync(join(bin, name), 0o755);
  }
  const log = join(root, "standin.log");
  writeFileSync(log, "");
  const runtime = await startStubRuntime();
  const side = await bootSidecar(root, runtime.url, { PATH: `${bin}:${process.env.PATH ?? ""}`, STANDIN_LOG: log });
  const finished = async (jobId: string) => {
    let job: Job = { status: "queued" };
    for (let i = 0; i < 300 && !["succeeded", "failed", "blocked", "cancelled"].includes(job.status); i += 1) {
      await sleep(400);
      job = (await side.api<{ job: Job }>(`/api/agent/jobs/${jobId}`)).body.job;
    }
    assert.equal(job.status, "succeeded", `${job.error ?? ""}\n${side.logs().slice(-3000)}`);
    return job;
  };
  try {
    const thread = await side.api<{ thread: { id: string } }>("/api/agent/threads", { json: { message: "Keep the column order" } });
    const threadId = thread.body.thread.id;
    const turn = { taskId: threadId, kind: "code", mode: "review", sandbox: false, delivery: "local", markDone: false, chat: true, surface: "code", profileInstructions: "Run the tests first." };
    const first = await side.api<{ jobId?: string }>("/api/agent/assign", { json: { ...turn, engine: "claude-code", instructions: "Keep the column order.\nAC-1: the header row stays first" } });
    assert.ok(first.body.jobId, JSON.stringify(first.body));
    const one = await finished(first.body.jobId!);
    const second = await side.api<{ jobId?: string }>("/api/agent/assign", { json: { ...turn, engine: "claude-code", instructions: "Thanks, now tidy up.", continueFromJobId: first.body.jobId } });
    await finished(second.body.jobId!);
    const third = await side.api<{ jobId?: string }>("/api/agent/assign", { json: { ...turn, engine: "codex", instructions: "Codex, finish it.", continueFromJobId: second.body.jobId } });
    await finished(third.body.jobId!);

    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(calls.length, 3, JSON.stringify(calls));
    const [a, b, c] = calls as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    assert.equal(a.resume, null);
    assert.equal(a.maxTurns, false, "no turn limit of Ensemble's own");
    assert.match(String(a.first), /^You're the coding agent in .* Ensemble Code tab/);
    assert.match(String(a.tools), /report_result,attach_evidence/);
    assert.doesNotMatch(String(a.tools), /refused/);
    assert.equal(b.resume, "code-session-1");
    assert.equal(b.first, "Thanks, now tidy up.", "nothing changed: the message alone");
    assert.deepEqual([c.agent, c.how, c.failed], ["codex", "start", true], "a new session for the other agent, told the check failed");
    assert.match(String(c.handoff), /^hof_\d{8}_[a-z0-9]{6}$/);
    assert.ok(existsSync(join(one.folder ?? "", ".ensemble", "handoff", `${String(c.handoff)}.md`)), "the record is in the run's folder");

    const view = await side.api<{ turns: Turn[] }>(`/api/agent/threads/${threadId}`);
    const [t1, t2, t3] = view.body.turns as [Turn, Turn, Turn];
    assert.deepEqual([t1.completion?.conversation.state, t1.completion?.files.state, t1.completion?.checks.state, t1.completion?.accepted.state], ["finished", "changed", "failed", "pending"]);
    assert.deepEqual(t1.completion?.checks.runs.map((run) => [run.claimed, run.verdict]), [["pass", "fail"]], "the agent said pass; Ensemble's run failed");
    assert.deepEqual([t1.packet?.mode, t1.packet?.operation], ["full", "fresh"]);
    assert.deepEqual([t2.packet?.mode, t2.packet?.operation], ["none", "resume"]);
    assert.deepEqual([t3.packet?.mode, t3.packet?.operation, t3.handoff?.reason, t3.handoff?.from], ["full", "handoff", "agent", "claude-code"]);
  } finally {
    await side.stop();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
