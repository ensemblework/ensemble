/**
 * What the person said in the agent's own app comes into the chat the next time Ensemble uses the session,
 * and the session goes on (subscriptions/outside.ts, docs/41 §5): end to end through `runAgentTurn`, with
 * stand-ins for Claude Code (a transcript file), Codex (`thread/read`) and an ACP agent (OpenCode's
 * `session/load` replay). Each stand-in keeps the session's history where the real agent does, and the test
 * adds the person's own exchanges there between Ensemble's turns.
 */
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setLocalPort } from "../workspace/engines/registry.js";
import { forgetExecutablesForTests } from "../workspace/policy.js";
import { runAgentTurn } from "./agents.js";

// The stand-ins never call Ensemble's tools.
setLocalPort(1);

const io = { call: async () => ({ text: "{}" }), onDelta: () => undefined, signal: new AbortController().signal };
const turnOf = (agent: "claude-code" | "codex" | "opencode", key: string) => (prompt: string, position: number) =>
  runAgentTurn({ agent, model: "default", effort: null, system: "Instructions.", prompt, tools: [], maxTurns: 4, session: { key, history: "", position } }, io);

/** A folder with a stand-in program on PATH and this computer's state, set for the test and put back after. */
function place(name: string, program: string, script: string, extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), `ensemble-outside-${name}-`));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, program), script);
  chmodSync(join(bin, program), 0o755);
  const vars = { PATH: `${bin}:${process.env.PATH ?? ""}`, ENSEMBLE_DESKTOP: "1", ENSEMBLE_REMOTE_STATE_DIR: join(root, "state"), ...extra };
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

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
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
  line({ type: 'user', entrypoint: 'sdk-cli', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } });
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] } });
  const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  say({ type: 'system', subtype: 'init', session_id: id, model: 'claude-haiku-test' });
  say({ type: 'result', subtype: 'success', is_error: false, result: 'Noted.', total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 2 } });
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
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const file = (id) => path.join(process.env.STANDIN_THREADS, id + '.json');
const turnsOf = (id) => { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; } };
let thread = null;
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
    turns.push({ items: [{ type: 'userMessage', content: [{ type: 'text', text }] }, { type: 'agentMessage', text: 'Noted.', phase: 'final_answer' }] });
    fs.writeFileSync(file(thread), JSON.stringify(turns));
    send({ id: message.id, result: { turn: { id: 'turn-' + turns.length } } });
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Noted.', phase: 'final_answer' } } });
    return send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
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

const FAKE_OPENCODE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === 'auth') { process.stdout.write('1 credentials\\n'); process.exit(0); }
if (process.argv[2] === 'models') { process.stdout.write('opencode/test-model\\n'); process.exit(0); }
if (process.argv[2] !== 'acp') { process.stdout.write('1.0.0\\n'); process.exit(0); }
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + "\\n");
const file = (id) => path.join(process.env.STANDIN_ACP, id + '.json');
const historyOf = (id) => { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; } };
let made = 0;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const params = message.params || {};
  if (message.method === 'initialize') return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (message.method === 'session/new') { const id = 'ses_' + Date.now() + '_' + (made += 1); fs.writeFileSync(file(id), '[]'); return send({ id: message.id, result: { sessionId: id } }); }
  if (message.method === 'session/load') {
    const history = historyOf(params.sessionId);
    if (!history) return send({ id: message.id, error: { code: -32002, message: 'Session not found: ' + params.sessionId } });
    for (const update of history) send({ method: 'session/update', params: { sessionId: params.sessionId, update } });
    return send({ id: message.id, result: {} });
  }
  if (message.method === 'session/prompt') {
    const history = historyOf(params.sessionId) || [];
    history.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: (params.prompt || []).map((block) => block.text || '').join('') } });
    history.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Noted.' } });
    fs.writeFileSync(file(params.sessionId), JSON.stringify(history));
    send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Noted.' } } } });
    return send({ id: message.id, result: { stopReason: 'end_turn' } });
  }
  send({ id: message.id, result: {} });
});
`;

test("an ACP agent's chat reads what the person added from the session's replay, once, and goes on in the same session", async () => {
  const where = place("acp", "opencode", FAKE_OPENCODE);
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
