/**
 * A coding run on Cursor's agent or an ACP agent brings in what the person said in the agent's own app since
 * Ensemble's last run in the session, and the session goes on (workspace/outside-runs.ts, docs/41 §1): end to
 * end through the runtime, with a stand-in agent installed as `opencode` (the ACP engine) and `cursor-agent`
 * (Cursor's engine). It keeps each session's history in a file and replays it on `session/load`, as the real
 * agents do; the test adds the person's own exchange there between Ensemble's runs.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { bootSidecar, sleep, startStubRuntime, type Sidecar, type StubRuntime } from "../desktop/e2e-harness.js";

const STAND_IN = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (!args.includes('acp')) {
  // What the computer's agent check asks: OpenCode's sign-in and models, any agent's version.
  process.stdout.write(args[0] === 'auth' ? '1 credentials\\n' : args[0] === 'models' ? 'opencode/test-model\\n' : '1.0.0\\n');
  process.exit(0);
}
const program = path.basename(process.argv[1]);
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const file = (id) => path.join(process.env.STANDIN_ACP, id + '.json');
const historyOf = (id) => { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; } };
const log = (entry) => fs.appendFileSync(process.env.STANDIN_LOG, JSON.stringify({ program, ...entry }) + '\\n');
let made = 0;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined || !message.method) return;
  const params = message.params || {};
  if (message.method === 'initialize') return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  if (message.method === 'session/new') {
    const id = program + '-' + process.pid + '-' + (made += 1);
    fs.writeFileSync(file(id), '[]');
    log({ how: 'new', session: id });
    return send({ id: message.id, result: { sessionId: id } });
  }
  if (message.method === 'session/load') {
    const history = historyOf(params.sessionId);
    if (!history) return send({ id: message.id, error: { code: -32002, message: 'Session not found: ' + params.sessionId } });
    log({ how: 'load', session: params.sessionId });
    for (const update of history) send({ method: 'session/update', params: { sessionId: params.sessionId, update } });
    return send({ id: message.id, result: {} });
  }
  if (message.method === 'session/prompt') {
    const text = (params.prompt || []).map((block) => block.text || '').join('');
    const history = historyOf(params.sessionId) || [];
    history.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
    fs.writeFileSync(file(params.sessionId), JSON.stringify(history));
    log({ how: 'prompt', session: params.sessionId, text });
    send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } } });
    return send({ id: message.id, result: { stopReason: 'end_turn' } });
  }
  send({ id: message.id, result: {} });
});
`;

type Logged = { program: string; how: "new" | "load" | "prompt"; session: string; text?: string };
type Ran = { id: string; session: string | null; prompts: unknown; outside: Array<{ title: string; output: string | null }>; logged: Logged[] };

let root = "";
let runtime: StubRuntime;
let side: Sidecar;

before(async () => {
  root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ensemble-outside-runs-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "acp"));
  for (const program of ["opencode", "cursor-agent"]) {
    writeFileSync(join(bin, program), STAND_IN);
    chmodSync(join(bin, program), 0o755);
  }
  runtime = await startStubRuntime();
  side = await bootSidecar(root, runtime.url, { PATH: `${bin}:${process.env.PATH ?? ""}`, STANDIN_ACP: join(root, "acp"), STANDIN_LOG: join(root, "agent.log") });
});

after(async () => {
  await side?.stop();
  await runtime?.close();
  rmSync(root, { recursive: true, force: true });
});

const logged = (): Logged[] => {
  const file = join(root, "agent.log");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Logged) : [];
};

/**
 * A coding task on `engine`, run to the end: its agent session, the prompts it noted, its steps from the agent's
 * app, and what the agent did in that session (a one-off, such as naming the task's folder, has its own).
 */
async function run(engine: string, title: string, continueFrom?: string): Promise<Ran> {
  const seen = logged().length;
  const task = await side.api<{ task: { id: string } }>("/api/tasks", { json: { title } });
  const assigned = await side.api<{ jobId?: string; error?: string }>("/api/agent/assign", {
    json: { taskId: task.body.task.id, kind: "code", engine, mode: "unattended", sandbox: false, delivery: "local", ...(continueFrom ? { continueFromJobId: continueFrom } : {}) },
  });
  assert.ok(assigned.body.jobId, JSON.stringify(assigned.body));
  type Detail = { job: { status: string; error?: string | null; runId?: string | null }; events: Array<{ kind: string; data: Record<string, unknown> }> };
  let detail: Detail = { job: { status: "queued" }, events: [] };
  for (let i = 0; i < 240 && !["succeeded", "failed", "blocked", "cancelled"].includes(detail.job.status); i += 1) {
    await sleep(500);
    detail = (await side.api<Detail>(`/api/agent/jobs/${assigned.body.jobId}`)).body;
  }
  assert.equal(detail.job.status, "succeeded", `${detail.job.error ?? ""}\n${side.logs().slice(-3000)}`);
  const steps = (await side.api<{ run: { steps: Array<{ title: string; output: string | null }> } }>(`/api/runs/${detail.job.runId}`)).body.run.steps;
  const started = detail.events.filter((event) => event.kind === "engine").at(-1)?.data.session;
  const session = typeof started === "string" ? started : null;
  return {
    id: assigned.body.jobId!,
    session,
    prompts: detail.events.filter((event) => event.kind === "session_prompts").at(-1)?.data ?? null,
    outside: steps.filter((step) => step.title.startsWith("From ")),
    logged: logged()
      .slice(seen)
      .filter((entry) => entry.session === session),
  };
}

/** The person's own exchange in the agent's app, added to the session's history where the agent keeps it. */
function sayInApp(session: string): void {
  const file = join(root, "acp", `${session}.json`);
  const history = JSON.parse(readFileSync(file, "utf8")) as unknown[];
  history.push(
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Also remember " } },
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "MANGO" } },
    { sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit notes.md", kind: "edit", locations: [{ path: "/w/notes.md" }] },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Noted MANGO." } },
  );
  writeFileSync(file, JSON.stringify(history));
}

for (const agent of [
  { engine: "opencode", app: "OpenCode" },
  { engine: "cursor-agent", app: "Cursor" },
]) {
  test(`a run continuing ${agent.app}'s session brings in what the person said in ${agent.app} from its replay, once, and goes on in the same session`, { timeout: 300_000 }, async () => {
    const first = await run(agent.engine, `Plan the launch with ${agent.app}`);
    assert.ok(first.session, "the run recorded its agent session");
    assert.deepEqual(first.logged.map((entry) => entry.how), ["new", "prompt"]);
    assert.deepEqual(first.prompts, { session: first.session, prompts: 1 }, "a new session holds the run's one prompt");
    assert.deepEqual(first.outside, []);

    // The person opens the session in the agent's own app and says something there.
    sayInApp(first.session!);

    const second = await run(agent.engine, "Write the launch post", first.id);
    assert.equal(second.session, first.session, "the same session goes on, not a new one");
    assert.deepEqual(second.logged.map((entry) => [entry.how, entry.session]), [["load", first.session], ["prompt", first.session]]);
    const sent = second.logged.find((entry) => entry.how === "prompt")!.text ?? "";
    assert.match(sent, new RegExp(`^\\(Since the last Ensemble run, .+ said in ${agent.app}:\\n- "Also remember MANGO" \\(you edited 1 file\\)\\nThat is part of this conversation already`), "the note leads the prompt");
    assert.match(sent, /Write the launch post/, "then the task");
    assert.equal(second.outside.length, 1, "one step from the agent's app");
    assert.equal(second.outside[0]!.title, `From ${agent.app}`);
    assert.match(second.outside[0]!.output ?? "", /: Also remember MANGO\nAgent: Noted MANGO\. \(Edited 1 file\)/);
    assert.deepEqual(second.prompts, { session: first.session, prompts: 3 }, "Ensemble's two and the person's one");

    const third = await run(agent.engine, "Polish the post", second.id);
    assert.equal(third.session, first.session);
    assert.deepEqual(third.logged.map((entry) => entry.how), ["load", "prompt"]);
    assert.doesNotMatch(third.logged.find((entry) => entry.how === "prompt")!.text ?? "", /Since the last Ensemble run/, "brought in once");
    assert.deepEqual(third.outside, [], "brought in once");
    assert.deepEqual(third.prompts, { session: first.session, prompts: 4 });
  });
}
