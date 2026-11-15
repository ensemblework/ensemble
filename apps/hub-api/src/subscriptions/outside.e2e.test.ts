/**
 * What the person said in the agent's own app comes into the chat the next time Ensemble uses the session,
 * and the session goes on (subscriptions/outside.ts, docs/41 §5): end to end through `runAgentTurn`, with
 * stand-ins for Claude Code (a transcript file), GitHub Copilot (`events.jsonl`), Codex (`thread/read`) and the
 * ACP agents (OpenCode's and Cursor's `session/load` replay). Each stand-in keeps the session's history where the
 * real agent does, and the test adds the person's own exchanges there between Ensemble's turns. It can also take a
 * message into the session and then fail, work on it until the turn is stopped, or refuse it before it is in the
 * session (`fail-<session>`, `hold-<session>` and `refuse-<session>` in `STANDIN_SWITCH`).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SubscriptionProvider } from "@ensemble/shared-types";
import { setLocalPort } from "../workspace/engines/registry.js";
import { forgetExecutablesForTests } from "../workspace/policy.js";
import { AgentTurnError, chatSettled, runAgentTurn } from "./agents.js";

// The stand-ins never call Ensemble's tools.
setLocalPort(1);

const io = { call: async () => ({ text: "{}" }), onDelta: () => undefined, signal: new AbortController().signal };
const turnOf = (agent: SubscriptionProvider, key: string) => (prompt: string, position: number) =>
  runAgentTurn({ agent, model: "default", effort: null, system: "Instructions.", prompt, tools: [], maxTurns: 4, session: { key, history: "", position } }, io);

/** A folder with a stand-in program on PATH and this computer's state, set for the test and put back after. */
function place(name: string, program: string, script: string, extra: Record<string, string> | ((root: string) => Record<string, string>) = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), `ensemble-outside-${name}-`));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "switch"));
  writeFileSync(join(bin, program), script);
  chmodSync(join(bin, program), 0o755);
  const vars = { PATH: `${bin}:${process.env.PATH ?? ""}`, ENSEMBLE_DESKTOP: "1", ENSEMBLE_REMOTE_STATE_DIR: join(root, "state"), STANDIN_SWITCH: join(root, "switch"), ...(typeof extra === "function" ? extra(root) : extra) };
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  forgetExecutablesForTests();
  return {
    root,
    store: () => JSON.parse(readFileSync(join(root, "state", "assistant-sessions.json"), "utf8")) as Record<string, { id: string; prompts?: number }>,
    done: () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The test's switch for the session's next message, taken once: `fail`, `hold` or `refuse` (see `failNext`, `holdNext`, `refuseNext`). */
const SWITCH = `const flip = (name, id) => {
  const file = require('node:path').join(process.env.STANDIN_SWITCH || '', name + '-' + id);
  if (!process.env.STANDIN_SWITCH || !require('node:fs').existsSync(file)) return false;
  require('node:fs').rmSync(file);
  return true;
};`;

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
${SWITCH}
const args = process.argv.slice(2);
const after = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
if (args.includes('--version')) { process.stdout.write('2.1.0 (Claude Code)\\n'); process.exit(0); }
if (!args.includes('--system-prompt-file')) process.exit(0);
let prompt = '';
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  const id = after('--session-id') || after('--resume');
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'standin');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.jsonl');
  if (args.includes('--resume') && !fs.existsSync(file)) { process.stderr.write('No conversation found with session ID: ' + id + '\\n'); process.exit(1); }
  const line = (value) => fs.appendFileSync(file, JSON.stringify(value) + '\\n');
  const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  // Taken before the message is in the session: the test stops the turn as soon as it sees the message there.
  const failing = flip('fail', id);
  const holding = !failing && flip('hold', id);
  if (!failing && !holding && flip('refuse', id)) {
    say({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 400 model not found', total_cost_usd: 0, usage: {} });
    process.exitCode = 1;
    return;
  }
  line({ type: 'user', entrypoint: 'sdk-cli', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } });
  say({ type: 'system', subtype: 'init', session_id: id, model: 'claude-haiku-test' });
  if (failing) {
    say({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 500 Internal server error', total_cost_usd: 0, usage: {} });
    process.exitCode = 1;
  } else if (holding) setTimeout(() => undefined, 120_000);
  else {
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] } });
    say({ type: 'result', subtype: 'success', is_error: false, result: 'Noted.', total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 2 } });
  }
});
`;

test("a Claude Code chat brings in what the person said in the Claude app since its last turn, once, and goes on in the same session", async () => {
  const where = place("claude", "claude", FAKE_CLAUDE);
  process.env.CLAUDE_CONFIG_DIR = join(where.root, "claude");
  try {
    const turn = turnOf("claude-code", "9e8d7c6b-5a49-4382-9716-1a2b3c4d5e6f");
    assert.equal((await turn("Remember KIWI.", 0)).resumed, false);
    const id = where.store()["9e8d7c6b-5a49-4382-9716-1a2b3c4d5e6f"]!.id;
    // The person opens the session in the Claude app and says two things there.
    const transcript = join(where.root, "claude", "projects", "standin", `${id}.jsonl`);
    for (const [said, answer] of [["Also remember MANGO", "Noted MANGO."], ["And PEAR", "PEAR too."]]) {
      appendFileSync(transcript, `${JSON.stringify({ type: "user", entrypoint: "claude-desktop-3p", timestamp: "2026-11-15T07:05:00.000Z", message: { role: "user", content: said } })}\n`);
      appendFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: answer }] } })}\n`);
    }
    const second = await turn("What do you remember?", 2);
    assert.equal(second.resumed, true, "the same session, not a new one");
    assert.equal(second.restart, undefined);
    assert.equal(second.outside?.app, "the Claude app");
    assert.deepEqual(second.outside?.turns.map((one) => [one.prompt, one.answer]), [["Also remember MANGO", "Noted MANGO."], ["And PEAR", "PEAR too."]]);
    assert.equal(where.store()["9e8d7c6b-5a49-4382-9716-1a2b3c4d5e6f"]!.prompts, 4, "Ensemble's two, the person's two");

    const third = await turn("Thanks.", 4);
    assert.equal(third.resumed, true);
    assert.equal(third.outside, undefined, "brought in once");
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    where.done();
  }
});

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
${SWITCH}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const file = (id) => path.join(process.env.STANDIN_THREADS, id + '.json');
const turnsOf = (id) => { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; } };
let thread = null;
/** A turn Codex works on until Ensemble interrupts it. */
let held = null;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const params = message.params || {};
  if (message.method === 'initialize') return send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.169.0' } });
  if (message.method === 'account/read') return send({ id: message.id, result: { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: true } });
  if (message.method === 'thread/start') { thread = 'thread-' + Date.now(); fs.writeFileSync(file(thread), '[]'); return send({ id: message.id, result: { thread: { id: thread }, model: 'gpt-test' } }); }
  if (message.method === 'thread/read') { const turns = turnsOf(params.threadId); return turns ? send({ id: message.id, result: { thread: { id: params.threadId, turns } } }) : send({ id: message.id, error: { code: -32600, message: 'thread not found: ' + params.threadId } }); }
  if (message.method === 'thread/resume') { thread = params.threadId; return send({ id: message.id, result: { thread: { id: thread }, model: 'gpt-test' } }); }
  if (message.method === 'turn/start') {
    const text = (params.input || []).map((item) => item.text || '').join('');
    const turns = turnsOf(thread) || [];
    const asked = { type: 'userMessage', content: [{ type: 'text', text }] };
    const failing = flip('fail', thread);
    const holding = !failing && flip('hold', thread);
    if (!failing && !holding && flip('refuse', thread)) return send({ id: message.id, error: { code: -32600, message: 'model is not supported' } });
    turns.push({ items: failing || holding ? [asked] : [asked, { type: 'agentMessage', text: 'Noted.', phase: 'final_answer' }] });
    fs.writeFileSync(file(thread), JSON.stringify(turns));
    send({ id: message.id, result: { turn: { id: 'turn-' + turns.length } } });
    if (holding) return void (held = 'turn-' + turns.length);
    if (failing) {
      send({ method: 'error', params: { error: { message: 'Internal server error' } } });
      return send({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'Internal server error' } } } });
    }
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Noted.', phase: 'final_answer' } } });
    return send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  }
  if (message.method === 'turn/interrupt' && held) {
    held = null;
    send({ id: message.id, result: {} });
    return send({ method: 'turn/completed', params: { turn: { status: 'interrupted' } } });
  }
  send({ id: message.id, result: {} });
});
`;

test("a Codex chat brings in the turns the person had in Codex since its last turn, read with thread/read, and goes on in the same thread", async () => {
  const where = place("codex", "codex", FAKE_CODEX);
  const threads = join(where.root, "threads");
  mkdirSync(threads);
  process.env.STANDIN_THREADS = threads;
  try {
    const turn = turnOf("codex", "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d");
    assert.equal((await turn("Remember KIWI.", 0)).resumed, false);
    const [file] = readdirSync(threads);
    const turns = JSON.parse(readFileSync(join(threads, file!), "utf8")) as unknown[];
    turns.push({ startedAt: 1_792_000_000, items: [{ type: "userMessage", content: [{ type: "text", text: "Also remember MANGO" }] }, { type: "commandExecution" }, { type: "agentMessage", text: "Noted MANGO.", phase: "final_answer" }] });
    writeFileSync(join(threads, file!), JSON.stringify(turns));

    const second = await turn("What do you remember?", 2);
    assert.equal(second.resumed, true);
    assert.deepEqual(second.outside, { app: "Codex", turns: [{ prompt: "Also remember MANGO", answer: "Noted MANGO.", tools: "Ran 1 command", at: new Date(1_792_000_000_000).toISOString() }], earlier: 0 });
    assert.equal(where.store()["1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"]!.prompts, 3);
    assert.equal((await turn("Thanks.", 4)).outside, undefined, "brought in once");
  } finally {
    delete process.env.STANDIN_THREADS;
    where.done();
  }
});

/** An ACP agent: OpenCode, or Cursor's agent (`cursor-agent … acp`). */
const FAKE_ACP = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
${SWITCH}
const args = process.argv.slice(2);
if (!args.includes('acp')) {
  // What the computer's agent check asks: OpenCode's sign-in and models, any agent's version and status.
  process.stdout.write(args[0] === 'auth' ? '1 credentials\\n' : args[0] === 'models' ? 'opencode/test-model\\n' : '1.0.0\\n');
  process.exit(0);
}
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + "\\n");
const file = (id) => path.join(process.env.STANDIN_ACP, id + '.json');
const historyOf = (id) => { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; } };
let made = 0;
/** A prompt the agent works on until Ensemble cancels it. */
let held = null;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'session/cancel' && held !== null) {
    send({ id: held, result: { stopReason: 'cancelled' } });
    held = null;
    return;
  }
  if (message.id === undefined) return;
  const params = message.params || {};
  if (message.method === 'initialize') return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (message.method === 'session/new') { const id = 'ses_' + Date.now() + '_' + process.pid + '_' + (made += 1); fs.writeFileSync(file(id), '[]'); return send({ id: message.id, result: { sessionId: id } }); }
  if (message.method === 'session/load') {
    const history = historyOf(params.sessionId);
    if (!history) return send({ id: message.id, error: { code: -32002, message: 'Session not found: ' + params.sessionId } });
    for (const update of history) send({ method: 'session/update', params: { sessionId: params.sessionId, update } });
    return send({ id: message.id, result: {} });
  }
  if (message.method === 'session/prompt') {
    const history = historyOf(params.sessionId) || [];
    history.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: (params.prompt || []).map((block) => block.text || '').join('') } });
    const failing = flip('fail', params.sessionId);
    const holding = !failing && flip('hold', params.sessionId);
    if (failing || holding) {
      fs.writeFileSync(file(params.sessionId), JSON.stringify(history));
      if (holding) return void (held = message.id);
      return send({ id: message.id, error: { code: -32603, message: 'The stand-in agent failed on purpose.' } });
    }
    history.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Noted.' } });
    fs.writeFileSync(file(params.sessionId), JSON.stringify(history));
    send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Noted.' } } } });
    return send({ id: message.id, result: { stopReason: 'end_turn' } });
  }
  send({ id: message.id, result: {} });
});
`;

test("an ACP agent's chat reads what the person added from the session's replay, once, and goes on in the same session", async () => {
  const where = place("acp", "opencode", FAKE_ACP);
  const sessions = join(where.root, "acp");
  mkdirSync(sessions);
  process.env.STANDIN_ACP = sessions;
  try {
    const turn = turnOf("opencode", "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e");
    assert.equal((await turn("Remember KIWI.", 0)).resumed, false);
    const [file] = readdirSync(sessions).filter((name) => JSON.parse(readFileSync(join(sessions, name), "utf8")).length);
    const history = JSON.parse(readFileSync(join(sessions, file!), "utf8")) as unknown[];
    history.push(
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Also remember " } },
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "MANGO" } },
      { sessionUpdate: "tool_call", kind: "edit", locations: [{ path: "/w/notes.md" }] },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Noted MANGO." } },
    );
    writeFileSync(join(sessions, file!), JSON.stringify(history));

    const second = await turn("What do you remember?", 2);
    assert.equal(second.resumed, true);
    assert.deepEqual(second.outside, { app: "OpenCode", turns: [{ prompt: "Also remember MANGO", answer: "Noted MANGO.", tools: "Edited 1 file", files: ["/w/notes.md"] }], earlier: 0 });
    assert.equal(where.store()["2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e"]!.prompts, 3);
    assert.equal((await turn("Thanks.", 4)).outside, undefined, "read once, not again on the next turn");
  } finally {
    delete process.env.STANDIN_ACP;
    where.done();
  }
});

const FAKE_COPILOT = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
${SWITCH}
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('1.0.89\\n'); process.exit(0); }
// Its help, and the headless server the computer's agent check asks first (this one has none).
if (!args.includes('--output-format')) { process.stdout.write('Copilot\\n'); process.exit(0); }
// Copilot 1.0.78 and later read a prompt piped on stdin when there is no -p.
const prompt = args.includes('-p') ? args[args.indexOf('-p') + 1] : fs.readFileSync(0, 'utf8');
const id = args[args.indexOf('--session-id') + 1];
const dir = path.join(process.env.COPILOT_HOME, 'session-state', id);
fs.mkdirSync(dir, { recursive: true });
const event = (type, data) => fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ type, data, timestamp: new Date().toISOString() }) + '\\n');
// Taken before the message is in the session: the test stops the turn as soon as it sees the message there.
const failing = flip('fail', id);
const holding = !failing && flip('hold', id);
const refused = !failing && !holding && flip('refuse', id);
if (!refused) event('user.message', { content: prompt });
if (failing || refused) {
  process.stderr.write(refused ? 'Error: Model not available\\n' : 'Error: Internal server error\\n');
  process.exitCode = 1;
} else if (holding) setTimeout(() => undefined, 120_000);
else {
  event('assistant.message', { content: 'Noted.' });
  process.stdout.write(JSON.stringify({ type: 'assistant.message', data: { content: 'Noted.' } }) + '\\n');
}
`;

/**
 * Each stand-in agent for the tests below: its program, where it keeps a session's history (`history`), and how
 * the person's own exchange in the agent's app is added there (`sayInApp`: "Also remember MANGO", "Noted MANGO.").
 */
type StandIn = { agent: SubscriptionProvider; label: string; app: string; program: string; script: string; env: (root: string) => Record<string, string>; history: (root: string, id: string) => string; sayInApp: (root: string, id: string) => void };

const STAND_INS: StandIn[] = [
  {
    agent: "claude-code",
    label: "Claude Code",
    app: "the Claude app",
    program: "claude",
    script: FAKE_CLAUDE,
    env: (root) => ({ CLAUDE_CONFIG_DIR: join(root, "claude") }),
    history: (root, id) => join(root, "claude", "projects", "standin", `${id}.jsonl`),
    sayInApp: (root, id) => {
      const file = join(root, "claude", "projects", "standin", `${id}.jsonl`);
      appendFileSync(file, `${JSON.stringify({ type: "user", entrypoint: "claude-desktop", timestamp: "2026-11-15T07:05:00.000Z", message: { role: "user", content: "Also remember MANGO" } })}\n`);
      appendFileSync(file, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Noted MANGO." }] } })}\n`);
    },
  },
  {
    agent: "copilot-cli",
    label: "GitHub Copilot",
    app: "GitHub Copilot",
    program: "copilot",
    script: FAKE_COPILOT,
    env: (root) => {
      mkdirSync(join(root, "copilot", "session-state"), { recursive: true });
      return { COPILOT_HOME: join(root, "copilot") };
    },
    history: (root, id) => join(root, "copilot", "session-state", id, "events.jsonl"),
    sayInApp: (root, id) => {
      const file = join(root, "copilot", "session-state", id, "events.jsonl");
      appendFileSync(file, `${JSON.stringify({ type: "user.message", data: { content: "Also remember MANGO" }, timestamp: "2026-11-15T07:05:00.000Z" })}\n`);
      appendFileSync(file, `${JSON.stringify({ type: "assistant.message", data: { content: "Noted MANGO." } })}\n`);
    },
  },
  {
    agent: "codex",
    label: "Codex",
    app: "Codex",
    program: "codex",
    script: FAKE_CODEX,
    env: (root) => {
      mkdirSync(join(root, "threads"));
      return { STANDIN_THREADS: join(root, "threads") };
    },
    history: (root, id) => join(root, "threads", `${id}.json`),
    sayInApp: (root, id) => {
      const file = join(root, "threads", `${id}.json`);
      const turns = JSON.parse(readFileSync(file, "utf8")) as unknown[];
      turns.push({ items: [{ type: "userMessage", content: [{ type: "text", text: "Also remember MANGO" }] }, { type: "agentMessage", text: "Noted MANGO.", phase: "final_answer" }] });
      writeFileSync(file, JSON.stringify(turns));
    },
  },
  ...(["opencode", "cursor-agent"] as const).map(
    (agent): StandIn => ({
      agent,
      label: agent === "opencode" ? "OpenCode" : "Cursor's agent",
      app: agent === "opencode" ? "OpenCode" : "Cursor",
      program: agent,
      script: FAKE_ACP,
      env: (root) => {
        mkdirSync(join(root, "acp"));
        return { STANDIN_ACP: join(root, "acp") };
      },
      history: (root, id) => join(root, "acp", `${id}.json`),
      sayInApp: (root, id) => {
        const file = join(root, "acp", `${id}.json`);
        const history = JSON.parse(readFileSync(file, "utf8")) as unknown[];
        history.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Also remember MANGO" } }, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Noted MANGO." } });
        writeFileSync(file, JSON.stringify(history));
      },
    }),
  ),
];

/** The agent takes the session's next message into its history, then fails before it answers. */
const failNext = (root: string, id: string) => writeFileSync(join(root, "switch", `fail-${id}`), "");
/** The agent takes the session's next message into its history and works on it until Ensemble stops the turn. */
const holdNext = (root: string, id: string) => writeFileSync(join(root, "switch", `hold-${id}`), "");
/** The agent fails on the session's next message before it is in the session (Codex: `turn/start` refused). */
const refuseNext = (root: string, id: string) => writeFileSync(join(root, "switch", `refuse-${id}`), "");
const holds = (file: string, text: string) => existsSync(file) && readFileSync(file, "utf8").includes(text);

for (const standIn of STAND_INS) {
  const { agent, label, app } = standIn;

  test(`a chat turn on ${label} that fails after the agent took the message: the next message brings nothing in, and what the person says in the app after that comes in alone`, { timeout: 60_000 }, async () => {
    const where = place(`failed-${agent}`, standIn.program, standIn.script, standIn.env);
    try {
      const key = randomUUID();
      const turn = turnOf(agent, key);
      assert.equal((await turn("Remember KIWI.", 0)).resumed, false);
      const id = where.store()[key]!.id;

      failNext(where.root, id);
      await assert.rejects(turn("Answer the pricing question.", 2), AgentTurnError);
      assert.ok(holds(standIn.history(where.root, id), "Answer the pricing question."), "the agent has the message in its session");
      await chatSettled(key);
      const noted = where.store()[key]!.prompts;

      // A failed exchange does not move the chat on (assistant/agent.ts sessionPosition): the next message goes on from there.
      const next = await turn("Answer the refund question.", 2);
      assert.equal(next.resumed, true, "the same session goes on");
      assert.equal(next.restart, undefined);
      assert.equal(next.outside, undefined, "the failed message is not brought in as something the person said in the agent's app");
      assert.equal(noted, 2, "the failed turn noted the session's prompts, its message included");
      // An ACP agent replays the message it left unanswered and the next one as one exchange (outside.ts acpPrompts).
      const acp = agent === "opencode" || agent === "cursor-agent";
      assert.equal(where.store()[key]!.prompts, acp ? 2 : 3);

      standIn.sayInApp(where.root, id);
      const later = await turn("What do you remember?", 4);
      assert.equal(later.resumed, true);
      assert.equal(later.outside?.app, app);
      assert.deepEqual(later.outside?.turns.map((one) => [one.prompt, one.answer]), [["Also remember MANGO", "Noted MANGO."]], "only what the person said there");
      assert.equal(where.store()[key]!.prompts, acp ? 4 : 5);
    } finally {
      where.done();
    }
  });

  test(`an ask on ${label} stopped while the agent works on it: the next ask brings nothing in`, { timeout: 60_000 }, async () => {
    const where = place(`stopped-${agent}`, standIn.program, standIn.script, standIn.env);
    try {
      const key = randomUUID();
      // An ask's session (Ask Ensemble) carries no position: it goes on after a stopped answer as after any other.
      const ask = (prompt: string, signal = io.signal) => runAgentTurn({ agent, model: "default", effort: null, system: "Instructions.", prompt, tools: [], maxTurns: 4, session: { key, history: "" } }, { ...io, signal });
      assert.equal((await ask("Remember KIWI.")).resumed, false);
      const id = where.store()[key]!.id;

      holdNext(where.root, id);
      const stop = new AbortController();
      const stopped = ask("Summarize the page.", stop.signal);
      for (let wait = 0; wait < 400 && !holds(standIn.history(where.root, id), "Summarize the page."); wait += 1) await new Promise((done) => setTimeout(done, 25));
      assert.ok(holds(standIn.history(where.root, id), "Summarize the page."), "the agent has the message in its session");
      stop.abort();
      await assert.rejects(stopped, { name: "AbortError" });

      const next = await ask("Shorter, please.");
      assert.equal(next.resumed, true, "the same session goes on");
      assert.equal(next.outside, undefined, "the stopped ask is not brought in as something the person said in the agent's app");
    } finally {
      where.done();
    }
  });
}

for (const standIn of STAND_INS.filter((one) => one.agent === "claude-code" || one.agent === "copilot-cli" || one.agent === "codex")) {
  const { agent, label, app } = standIn;

  test(`a chat turn on ${label} that fails before the agent takes the message leaves the session's count: what the person said in the app before it comes in with the next message`, { timeout: 60_000 }, async () => {
    const where = place(`refused-${agent}`, standIn.program, standIn.script, standIn.env);
    try {
      const key = randomUUID();
      const turn = turnOf(agent, key);
      assert.equal((await turn("Remember KIWI.", 0)).resumed, false);
      const id = where.store()[key]!.id;

      standIn.sayInApp(where.root, id);
      refuseNext(where.root, id);
      await assert.rejects(turn("Answer the pricing question.", 2), AgentTurnError);
      assert.ok(!holds(standIn.history(where.root, id), "Answer the pricing question."), "the agent never had the message");
      await chatSettled(key);
      assert.equal(where.store()[key]!.prompts, 1, "the count stays where Ensemble's last answered turn left it");

      // The person sends it again.
      const next = await turn("Answer the pricing question.", 2);
      assert.equal(next.resumed, true);
      assert.equal(next.outside?.app, app);
      assert.deepEqual(next.outside?.turns.map((one) => [one.prompt, one.answer]), [["Also remember MANGO", "Noted MANGO."]], "what the person said in the app still comes in, once");
      assert.equal(where.store()[key]!.prompts, 3);
    } finally {
      where.done();
    }
  });
}
