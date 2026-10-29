/**
 * Chat with the person's own agent, end to end, with stand-ins on PATH (`claude`, `codex`,
 * `cursor-agent`) that speak each tool's own protocol: the first message starts a session with
 * Ensemble's board tools loaded, and the next one resumes that session instead of starting over
 * (`claude --resume`, Codex `thread/resume`, Cursor's ACP `session/load`).
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootSidecar, sleep, startStubRuntime } from "../../desktop/e2e-harness.js";

const FAKE_CLAUDE = `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.999 (Claude Code)"); process.exit(0); }
const say = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const prompt = args[args.indexOf("-p") + 1];
const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null;
const session = resume || "chat-session-1";
appendFileSync(process.env.STANDIN_LOG, JSON.stringify({ resume, first: prompt.split("\\n")[0], last: prompt.split("\\n").at(-1) }) + "\\n");
say({ type: "system", subtype: "init", session_id: session, model: "claude-test", cwd: process.cwd() });
let note = "";
if (!resume) {
  // The first message: the board tools are there, and one is used.
  const mcp = JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers.ensemble;
  const reply = execFileSync(mcp.command, mcp.args, {
    input: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ensemble_create_task", arguments: { title: "Buy milk", description: "From the chat" } } },
    ].map((line) => JSON.stringify(line)).join("\\n") + "\\n",
    encoding: "utf8",
    env: process.env,
  });
  const lines = reply.trim().split("\\n").map((line) => JSON.parse(line));
  note = " tools=" + lines.find((line) => line.id === 2).result.tools.map((tool) => tool.name).join(",") + " created=" + lines.find((line) => line.id === 3).result.content[0].text;
}
const text = (resume ? "Second reply, same session." : "First reply.") + note;
say({ type: "assistant", message: { content: [{ type: "text", text }] } });
say({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: text, usage: { input_tokens: 10, output_tokens: 5 } });
`;

type Job = { status: string; summary?: string | null; error?: string | null };

test("Chat with Claude Code: the next message resumes the same session, with Ensemble's board tools", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ensemble-chat-engine-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(join(bin, "claude"), 0o755);
  const log = join(root, "standin.log");
  writeFileSync(log, "");
  const runtime = await startStubRuntime();
  const side = await bootSidecar(root, runtime.url, { PATH: `${bin}:${process.env.PATH ?? ""}`, STANDIN_LOG: log });
  const finished = async (jobId: string) => {
    let job: Job = { status: "queued" };
    for (let i = 0; i < 240 && !["succeeded", "failed", "blocked", "cancelled"].includes(job.status); i += 1) {
      await sleep(400);
      job = (await side.api<{ job: Job }>(`/api/agent/jobs/${jobId}`)).body.job;
    }
    assert.equal(job.status, "succeeded", `${job.error ?? ""}\n${side.logs().slice(-3000)}`);
    return job;
  };
  try {
    const task = await side.api<{ task: { id: string } }>("/api/tasks", { json: { title: "Chat: hello", owner: "agent", status: "todo" } });
    const turn = { taskId: task.body.task.id, kind: "code", engine: "claude-code", mode: "review", sandbox: false, delivery: "local", markDone: false, chat: true };
    const first = await side.api<{ jobId?: string; error?: string }>("/api/agent/assign", { json: { ...turn, instructions: "hello there" } });
    assert.ok(first.body.jobId, JSON.stringify(first.body));
    const one = await finished(first.body.jobId!);
    assert.match(one.summary ?? "", /^First reply\./);
    assert.match(one.summary ?? "", /tools=ask_person,ensemble_list_tasks,ensemble_create_task,ensemble_search/);
    assert.match(one.summary ?? "", /created=Created the task “Buy milk” on the board/);
    const board = await side.api<{ tasks: Array<{ title: string; owner: string }> }>("/api/tasks");
    assert.ok(board.body.tasks.some((row) => row.title === "Buy milk" && row.owner === "me"), "the agent's task is on the person's board, for them");

    const second = await side.api<{ jobId?: string; error?: string }>("/api/agent/assign", { json: { ...turn, instructions: "and again", continueFromJobId: first.body.jobId } });
    assert.ok(second.body.jobId, JSON.stringify(second.body));
    const two = await finished(second.body.jobId!);
    assert.match(two.summary ?? "", /^Second reply, same session\./);

    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { resume: string | null; first: string; last: string });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.resume, null);
    assert.match(calls[0]!.first, /^You're chatting with the person in Ensemble's terminal chat/);
    assert.equal(calls[0]!.last, "hello there");
    assert.equal(calls[1]!.resume, "chat-session-1", "the second message resumes the first one's session");
    assert.equal(calls[1]!.first, "and again", "the session has the rules: the next message is just the message");
    assert.equal(calls[1]!.last, "and again");

    const after = await side.api<{ task: { status: string; notes?: string } }>(`/api/tasks/${task.body.task.id}`);
    assert.equal(after.body.task.status, "in_progress", "a chat stays open on the board");
  } finally {
    await side.stop();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

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
    appendFileSync(process.env.STANDIN_LOG, JSON.stringify({ how, thread, last: prompt.split("\\n").at(-1) }) + "\\n");
    send({ id: message.id, result: { turn: { id: "u1" } } });
    send({ method: "item/completed", params: { threadId: thread, turnId: "u1", item: { type: "agentMessage", id: "m1", text: how + " " + thread, phase: "final_answer" } } });
    send({ method: "turn/completed", params: { threadId: thread, turn: { id: "u1", status: "completed", error: null } } });
  } else if (message.id !== undefined) send({ id: message.id, result: {} });
});
`;

const FAKE_CURSOR = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
let session = null;
let how = "";
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && !message.method) return;
  const chunk = (text) => send({ method: "session/update", params: { sessionId: session, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (message.method === "session/new") { session = "cursor-session-1"; how = "new"; send({ id: message.id, result: { sessionId: session } }); }
  else if (message.method === "session/load") {
    session = message.params.sessionId; how = "load";
    // ACP replays the conversation so far before answering.
    chunk("OLD HISTORY");
    send({ id: message.id, result: {} });
  } else if (message.method === "session/prompt") {
    const prompt = message.params.prompt[0].text;
    appendFileSync(process.env.STANDIN_LOG, JSON.stringify({ how, session, last: prompt.split("\\n").at(-1) }) + "\\n");
    chunk(how + " " + session);
    send({ id: message.id, result: { stopReason: "end_turn" } });
  } else if (message.id !== undefined) send({ id: message.id, result: {} });
});
`;

for (const agent of [
  { engine: "codex", bin: "codex", script: FAKE_CODEX, session: "codex-thread-1", first: "start", next: "resume" },
  { engine: "cursor-agent", bin: "cursor-agent", script: FAKE_CURSOR, session: "cursor-session-1", first: "new", next: "load" },
] as const) {
  test(`Chat with ${agent.engine}: the next message continues the same ${agent.engine === "codex" ? "thread" : "session"}`, { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), `ensemble-chat-${agent.bin}-`));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, agent.bin), agent.script);
    chmodSync(join(bin, agent.bin), 0o755);
    const log = join(root, "standin.log");
    writeFileSync(log, "");
    const runtime = await startStubRuntime();
    const side = await bootSidecar(root, runtime.url, { PATH: `${bin}:${process.env.PATH ?? ""}`, STANDIN_LOG: log });
    const finished = async (jobId: string) => {
      let job: Job = { status: "queued" };
      for (let i = 0; i < 240 && !["succeeded", "failed", "blocked", "cancelled"].includes(job.status); i += 1) {
        await sleep(400);
        job = (await side.api<{ job: Job }>(`/api/agent/jobs/${jobId}`)).body.job;
      }
      assert.equal(job.status, "succeeded", `${job.error ?? ""}\n${side.logs().slice(-3000)}`);
      return job;
    };
    try {
      const task = await side.api<{ task: { id: string } }>("/api/tasks", { json: { title: "Chat: hi", owner: "agent", status: "todo" } });
      const turn = { taskId: task.body.task.id, kind: "code", engine: agent.engine, mode: "review", sandbox: false, delivery: "local", markDone: false, chat: true };
      const first = await side.api<{ jobId?: string }>("/api/agent/assign", { json: { ...turn, instructions: "hi" } });
      assert.ok(first.body.jobId, JSON.stringify(first.body));
      assert.equal((await finished(first.body.jobId!)).summary, `${agent.first} ${agent.session}`);
      const second = await side.api<{ jobId?: string }>("/api/agent/assign", { json: { ...turn, instructions: "again", continueFromJobId: first.body.jobId } });
      assert.ok(second.body.jobId, JSON.stringify(second.body));
      assert.equal((await finished(second.body.jobId!)).summary, `${agent.next} ${agent.session}`, "resumed, and the replayed history is not part of the reply");
      const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { how: string; last: string });
      assert.deepEqual(calls.map((call) => [call.how, call.last]), [[agent.first, "hi"], [agent.next, "again"]]);
    } finally {
      await side.stop();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
