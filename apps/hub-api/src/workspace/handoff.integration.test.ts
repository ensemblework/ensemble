import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHttpHarness } from "../test/http.js";

const harness = await createHttpHarness();
const a = await harness.asUser();
const b = await harness.asUser();
after(() => harness.close());

async function post(user: { inject: typeof a.inject }, url: string, payload: unknown) {
  const response = await user.inject({ method: "POST", url, payload: JSON.stringify(payload), headers: { "content-type": "application/json" } });
  return { status: response.statusCode, body: response.body ? response.json() : null };
}

async function handoff(user: typeof a, app: string, folder: string) {
  const task = await harness.prisma.task.create({ data: { userId: user.id, title: "Tidy the README" } });
  return harness.prisma.agentHandoff.create({ data: { userId: user.id, taskId: task.id, app, folder, marker: `ens-${Math.random().toString(16).slice(2, 12).padEnd(10, "0")}` } });
}

const permission = (session: string, command: string, cwd = "/elsewhere") => ({
  source: "claude",
  event: "PermissionRequest",
  payload: { session_id: session, cwd, tool_name: "Bash", tool_input: { command } },
  waitSeconds: 60,
});

test("a session Ensemble did not open is left to the tool's own prompt", async () => {
  const skipped = await post(a, "/api/decisions", permission("own-session", "rm -rf build"));
  assert.equal(skipped.status, 200);
  assert.equal(skipped.body.status, "skipped");
  assert.equal(await harness.prisma.agentDecision.count({ where: { userId: a.id } }), 0);
});

test("the prompt's marker links the session; its prompts reach Needs me; answered in Claude, the card closes", async () => {
  const row = await handoff(a, "claude", "/work/readme");
  const linked = await post(a, "/api/decisions/activity", { source: "claude", event: "UserPromptSubmit", payload: { session_id: "s1", cwd: "/work/readme", prompt: `Tidy it.\n\n(Ensemble task ${row.marker}.)` } });
  assert.deepEqual(linked.body, { linked: true, settled: 0 });
  assert.deepEqual((await harness.prisma.agentHandoff.findUnique({ where: { id: row.id } }))!.sessions, ["s1"]);

  const asked = await post(a, "/api/decisions", permission("s1", "npm test"));
  assert.equal(asked.status, 202);
  const other = await post(a, "/api/decisions", permission("s1", "npm run lint"));
  const card = await harness.prisma.agentDecision.findUnique({ where: { id: asked.body.id } });
  assert.equal((card!.detail as { handoffId?: string }).handoffId, row.id);

  // The person allowed `npm test` in Claude's own window; it ran.
  const ran = await post(a, "/api/decisions/activity", { source: "claude", event: "PostToolUse", payload: { session_id: "s1", tool_name: "Bash", tool_input: { command: "npm test" } } });
  assert.equal(ran.body.settled, 1);
  const waited = await a.inject({ method: "GET", url: `/api/decisions/${asked.body.id}/wait?timeout=1` });
  assert.equal(waited.json().status, "settled");
  const late = await post(a, `/api/decisions/${asked.body.id}/decide`, { decision: "allow" });
  assert.equal(late.status, 409);
  assert.match(late.body.error, /Answered in Claude Code/);
  assert.equal((await harness.prisma.agentDecision.findUnique({ where: { id: other.body.id } }))!.status, "pending", "a different call stays open");

  // The turn ended: nothing from it can still be waiting, and the task gets the agent's last words.
  const stopped = await post(a, "/api/decisions/activity", { source: "claude", event: "Stop", payload: { session_id: "s1", last_assistant_message: "Tidied the README." } });
  assert.equal(stopped.body.settled, 1);
  const finished = await harness.prisma.agentHandoff.findUnique({ where: { id: row.id } });
  assert.equal(finished!.status, "finished");
  assert.equal(finished!.summary, "Tidied the README.");
});

test("a tool whose hooks never see the prompt is linked by working in the hand-off's folder", async () => {
  const row = await handoff(a, "codex", "/work/api");
  const asked = await post(a, "/api/decisions", { source: "codex", event: "PermissionRequest", payload: { session_id: "c1", cwd: "/work/api/src", tool_name: "shell", tool_input: { command: "cargo test" } }, waitSeconds: 60 });
  assert.equal(asked.status, 202);
  assert.deepEqual((await harness.prisma.agentHandoff.findUnique({ where: { id: row.id } }))!.sessions, ["c1"]);
  // Claude working in the same folder is not Codex's hand-off.
  assert.equal((await post(a, "/api/decisions", permission("c2", "ls", "/work/api"))).body.status, "skipped");
});

test("someone else's marker or folder links nothing", async () => {
  const row = await handoff(a, "claude", "/work/private");
  const tried = await post(b, "/api/decisions/activity", { source: "claude", event: "UserPromptSubmit", payload: { session_id: "x1", cwd: "/work/private", prompt: row.marker } });
  assert.equal(tried.body.linked, false);
  assert.equal((await post(b, "/api/decisions", permission("x1", "cat secrets", "/work/private"))).body.status, "skipped");
});

test("a hooks key can ask and wait, never answer or read", async () => {
  await handoff(a, "claude", "/work/hooks");
  const key = await harness.asToken(a, "hooks");
  const asked = await post(key, "/api/decisions", permission("h1", "make", "/work/hooks"));
  assert.equal(asked.status, 202);
  assert.equal((await key.inject({ method: "GET", url: `/api/decisions/${asked.body.id}/wait?timeout=1` })).statusCode, 200);
  assert.equal((await post(key, `/api/decisions/${asked.body.id}/decide`, { decision: "allow" })).status, 403);
  assert.equal((await key.inject({ method: "GET", url: "/api/decisions" })).statusCode, 403);
  assert.equal((await key.inject({ method: "GET", url: "/api/tasks" })).statusCode, 403);
  assert.equal((await post(key, "/api/decisions/activity", { source: "claude", event: "Stop", payload: { session_id: "h1" } })).status, 200);
  assert.equal((await post(key, `/api/decisions/${asked.body.id}/cancel`, {})).status, 204);
});

test("hand-offs are listed for their owner and can be closed", async () => {
  const row = await handoff(a, "cursor", "/work/list");
  const listed = await a.inject({ method: "GET", url: "/api/agent/handoffs" });
  assert.ok(listed.json().handoffs.some((item: { id: string; appName: string }) => item.id === row.id && item.appName === "Cursor"));
  assert.ok(!(await b.inject({ method: "GET", url: "/api/agent/handoffs" })).json().handoffs.some((item: { id: string }) => item.id === row.id));
  assert.equal((await post(b, `/api/agent/handoffs/${row.id}/close`, {})).status, 404);
  assert.equal((await post(a, `/api/agent/handoffs/${row.id}/close`, {})).status, 204);
  // Opening an app is only for the runtime on the person's own computer.
  assert.equal((await post(a, "/api/agent/handoff", { taskId: row.taskId, app: "claude" })).status, 409);
});
