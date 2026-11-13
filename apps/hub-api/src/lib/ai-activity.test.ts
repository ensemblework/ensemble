import assert from "node:assert/strict";
import test from "node:test";
import "../config.js";
import { runInScope } from "../sharing/context.js";
import { bindAiContext, captureLogLine, flushAiActivity, logAi, newMessages, saveAiActivityForTests, setAiActivitySink, storeDeviceActivity, withAiContext, type AiActivityRow } from "./ai-activity.js";

process.env.ENSEMBLE_AI_ACTIVITY = "on";
const saved: AiActivityRow[] = [];
saveAiActivityForTests(async (rows) => void saved.push(...rows));
const taken = async () => {
  await flushAiActivity();
  return saved.splice(0);
};

test("an entry keeps what was sent and answered, without keys, pictures or files", async () => {
  logAi({
    kind: "model.call",
    userId: "user-1",
    input: { messages: [{ role: "user", content: [{ type: "text", text: "Summarize this with key sk-abcdefghijklmnop1234" }, { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(4_000)}` } }] }], apiKey: "plain-value" },
    output: "word ".repeat(4_000),
  });
  const [row] = await taken();
  const input = JSON.stringify(row!.input);
  assert.match(input, /Summarize this with key \[redacted\]/);
  assert.match(input, /\[image\/png, 4022 characters\]/);
  assert.match(input, /"apiKey":"\[redacted\]"/);
  assert.equal(row!.output, `${"word ".repeat(3_200)}… [4000 more characters]`);
});

test("a turn's steps each log only the messages added since the last", () => {
  const messages: unknown[] = [{ role: "system" }, { role: "user" }];
  assert.deepEqual(newMessages(messages), { messages: [{ role: "system" }, { role: "user" }] });
  messages.push({ role: "assistant" }, { role: "tool" });
  assert.deepEqual(newMessages(messages), { from: 2, messages: [{ role: "assistant" }, { role: "tool" }] });
});

test("entries carry their work's account, purpose and refs, also when a call comes back as another request", async () => {
  const later = withAiContext({ userId: "user-2", purpose: "Hub chat", refs: { conversation: "c1" } }, () => {
    logAi({ kind: "tool.call", name: "hub_list_tasks" });
    return bindAiContext(() => logAi({ kind: "tool.call", name: "hub_get_page" }));
  });
  later();
  const rows = await taken();
  assert.deepEqual(rows.map((row) => [row.userId, row.purpose, row.refs, row.name]), [
    ["user-2", "Hub chat", { conversation: "c1" }, "hub_list_tasks"],
    ["user-2", "Hub chat", { conversation: "c1" }, "hub_get_page"],
  ]);
});

test("the server's warnings are kept for the account they were logged for; the same line again is counted, not stored", async () => {
  const scope = { spaceId: "user-3", accountId: "user-3", access: { kind: "owner" as const } };
  runInScope(scope, () => {
    captureLogLine(50, [{ err: new Error("socket hang up") }, "request failed"], { reqId: "r1" });
    captureLogLine(50, [{ err: new Error("socket hang up") }, "request failed"], { reqId: "r2" });
    captureLogLine(30, ["incoming request"]);
  });
  captureLogLine(40, ["nobody's line"]);
  captureLogLine(40, [{ userId: "user-4" }, "skill mining failed"]);
  const rows = await taken();
  assert.deepEqual(rows.map((row) => [row.userId, row.kind, row.name, row.output, row.error]), [
    ["user-3", "server.log", "error", "request failed", "socket hang up"],
    ["user-4", "server.log", "warn", "skill mining failed", undefined],
  ]);
  assert.match(rows[0]!.stack ?? "", /socket hang up/);
});

test("a paired computer's entries go to the web; a server without the route leaves them on the computer", async () => {
  const sent: AiActivityRow[] = [];
  setAiActivitySink(async (rows) => (sent.push(...rows), true));
  logAi({ kind: "agent.tool", userId: "user-5", name: "Bash" });
  assert.equal((await taken()).length, 0);
  assert.equal(sent.length, 1);
  setAiActivitySink(async () => false);
  logAi({ kind: "agent.tool", userId: "user-5", name: "Bash" });
  assert.equal((await taken()).length, 1);
  setAiActivitySink(null);
});

test("the web keeps a computer's entries on its owner, with only that owner's jobs", async () => {
  const created: unknown[] = [];
  const db = {
    workspaceJob: { findMany: async () => [{ id: "job-own", taskId: "task-1" }] },
    aiActivity: { createMany: async ({ data }: { data: unknown[] }) => (created.push(...data), { count: data.length }) },
  };
  const device = { id: "device-1", userId: "owner-1", name: "MacBook" };
  const stored = await storeDeviceActivity(db as never, device, [
    { ts: new Date().toISOString(), kind: "agent.tool", name: "Bash", refs: { job: "job-own" } },
    { ts: "2000-01-01T00:00:00.000Z", kind: "runner.log", refs: { job: "job-someone-else", device: "spoofed" } },
  ]);
  assert.equal(stored, 2);
  const [own, other] = created as AiActivityRow[];
  assert.deepEqual([own!.userId, own!.refs], ["owner-1", { job: "job-own", task: "task-1", device: "device-1" }]);
  assert.deepEqual(other!.refs, { device: "device-1" });
  assert.ok(Date.now() - other!.ts.getTime() <= 30 * 86_400_000 + 1_000, "an entry is never older than the log keeps");
  assert.deepEqual(own!.meta, { computer: "MacBook" });
});
