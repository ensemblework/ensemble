import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://x";
const { answerCodex, codexApprovalPolicy } = await import("./codex.js");
const { RpcConnection: AppServer } = await import("./rpc.js");

type Ctx = Parameters<typeof answerCodex>[0];
const ctx = (overrides: Record<string, unknown> = {}) =>
  ({ job: { unattended: false }, network: true, accessMode: "read-write", trusted: true, decisions: [], event: async () => undefined, progress: async () => undefined, ...overrides }) as unknown as Ctx;

/** A judge that allows everything except what it is told to refuse, and records what it saw. */
function judgeLike(refuse: (tool: string, input: Record<string, unknown>) => boolean) {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const judge = (async (_ctx: unknown, call: { tool: string; input: Record<string, unknown> }) => {
    calls.push(call);
    return refuse(call.tool, call.input) ? { decision: "deny" as const, message: "no" } : { decision: "allow" as const };
  }) as unknown as Parameters<typeof answerCodex>[4];
  return { judge, calls };
}

test("a command, a network host and a file change are judged as the run's own tools", async () => {
  const { judge, calls } = judgeLike((tool, input) => tool === "Bash" && String(input.command).includes(".ssh"));
  const files = new Map([["f1", ["/w/a.txt", "/w/b.txt"]]]);
  assert.deepEqual(await answerCodex(ctx(), "item/commandExecution/requestApproval", { kind: "command", command: "cat ~/.ssh/id_rsa" }, files, judge), { decision: "decline" });
  assert.deepEqual(await answerCodex(ctx(), "item/commandExecution/requestApproval", { kind: "command", command: "npm test" }, files, judge), { decision: "accept" });
  assert.deepEqual(await answerCodex(ctx(), "item/commandExecution/requestApproval", { kind: "command", networkApprovalContext: { host: "registry.npmjs.org" } }, files, judge), { decision: "accept" });
  assert.equal(calls.at(-1)!.tool, "WebFetch");
  assert.deepEqual(await answerCodex(ctx(), "item/fileChange/requestApproval", { itemId: "f1" }, files, judge), { decision: "accept" });
  assert.deepEqual(calls.slice(-2).map((call) => call.input.file_path), ["/w/a.txt", "/w/b.txt"]);
  // A change Ensemble never saw the files of is not allowed blind.
  assert.deepEqual(await answerCodex(ctx(), "item/fileChange/requestApproval", { itemId: "unknown" }, files, judge), { decision: "decline" });
  // The folder Codex runs a command in goes to the judge, so `cd`-free relative paths are judged where they are.
  await answerCodex(ctx(), "item/commandExecution/requestApproval", { kind: "command", command: "python3 scripts/search.py x", cwd: "/home/p/.agents/skills/ui" }, files, judge);
  assert.deepEqual(calls.at(-1), { tool: "Bash", input: { command: "python3 scripts/search.py x", cwd: "/home/p/.agents/skills/ui" } });
});

test("an MCP server's form inside Codex is the person's question; a bare approval is judged like a tool", async () => {
  const { judge, calls } = judgeLike(() => false);
  const ask = (async () => ({ decision: "allow", answer: "Staging" })) as unknown as Parameters<typeof answerCodex>[5];
  const form = { serverName: "deploy", threadId: "t", mode: "form", message: "Where to?", requestedSchema: { type: "object", properties: { target: { type: "string", enum: ["staging", "production"], enumNames: ["Staging", "Production"] } }, required: ["target"] } };
  assert.deepEqual(await answerCodex(ctx(), "mcpServer/elicitation/request", form, new Map(), judge, ask), { action: "accept", content: { target: "staging" }, _meta: null });
  assert.equal(calls.length, 0);
  assert.deepEqual(await answerCodex(ctx(), "mcpServer/elicitation/request", { serverName: "deploy", threadId: "t", mode: "form", message: "Run it?", requestedSchema: { type: "object", properties: {} } }, new Map(), judge, ask), { action: "accept", content: null, _meta: null });
  assert.equal(calls.at(-1)!.tool, "mcp__deploy");
});

test("more access is granted only as far as the run's rules allow", async () => {
  const { judge } = judgeLike((tool, input) => tool === "Write" && String(input.file_path).startsWith("/etc"));
  const granted = await answerCodex(ctx(), "item/permissions/requestApproval", { permissions: { network: { enabled: true }, fileSystem: { read: ["/data"], write: ["/etc/hosts", "/w/out"] } } }, new Map(), judge);
  assert.deepEqual(granted, { permissions: { network: { enabled: true }, fileSystem: { read: ["/data"], write: ["/w/out"] } }, scope: "turn" });
  const offline = await answerCodex(ctx({ network: false }), "item/permissions/requestApproval", { permissions: { network: { enabled: true }, fileSystem: null } }, new Map(), judge);
  assert.deepEqual(offline, { permissions: {}, scope: "turn" });
});

test("questions: the recommended option when nobody is watching, the person's answer otherwise", async () => {
  const { judge } = judgeLike(() => false);
  const questions = [{ id: "q1", question: "Which?", isOther: true, options: [{ label: "A" }, { label: "B (Recommended)" }] }];
  const unattended = ctx({ job: { unattended: true } });
  assert.deepEqual(await answerCodex(unattended, "item/tool/requestUserInput", { questions }, new Map(), judge), { answers: { q1: { answers: ["B (Recommended)"] } } });
  assert.equal((unattended as unknown as { decisions: unknown[] }).decisions.length, 1, "listed on the task summary");
  const asked: unknown[] = [];
  const ask = (async (_ctx: unknown, prompt: unknown) => {
    asked.push(prompt);
    return { decision: "allow", answer: "A" };
  }) as unknown as Parameters<typeof answerCodex>[5];
  assert.deepEqual(await answerCodex(ctx(), "item/tool/requestUserInput", { questions }, new Map(), judge, ask), { answers: { q1: { answers: ["A"] } } });
  assert.deepEqual((asked[0] as { options: string[]; recommended: string }).options, ["A", "B (Recommended)"]);
});

test("sign-in tokens and anything unknown are never handled", async () => {
  const { judge } = judgeLike(() => false);
  await assert.rejects(answerCodex(ctx(), "account/chatgptAuthTokens/refresh", {}, new Map(), judge), /not handled/);
  await assert.rejects(answerCodex(ctx(), "item/tool/call", {}, new Map(), judge), /not handled/);
});

test("Codex asks before commands in Ask mode in a folder that is not trusted, and always without its sandbox", () => {
  assert.equal(codexApprovalPolicy({ sandboxed: true, accessMode: "read-write", trusted: false, job: { unattended: false } }), "untrusted");
  assert.equal(codexApprovalPolicy({ sandboxed: true, accessMode: "read-write", trusted: true, job: { unattended: false } }), "on-request");
  assert.equal(codexApprovalPolicy({ sandboxed: true, accessMode: "auto", trusted: true, job: { unattended: false } }), "on-request");
  assert.equal(codexApprovalPolicy({ sandboxed: true, accessMode: "auto", trusted: true, job: { unattended: true } }), "on-request");
  // Without the sandbox nothing else would see its commands: the run's rules answer each one.
  assert.equal(codexApprovalPolicy({ sandboxed: false, accessMode: "auto", trusted: true, job: { unattended: true } }), "untrusted");
});

test("the app-server connection pairs responses, answers Codex's requests, and passes notifications on", async () => {
  const out: string[] = [];
  const server = new AppServer((line) => out.push(line));
  const notes: string[] = [];
  server.onNotification = (method) => notes.push(method);
  server.onRequest = async (method) => (method === "ok" ? { decision: "accept" } : Promise.reject(new Error("nope")));
  const pending = server.request("thread/start", { cwd: "/w" });
  assert.deepEqual(JSON.parse(out[0]!), { id: 1, method: "thread/start", params: { cwd: "/w" } });
  await server.receive(JSON.stringify({ id: 1, result: { thread: { id: "t" } } }));
  assert.deepEqual(await pending, { thread: { id: "t" } });
  await server.receive(JSON.stringify({ id: 7, method: "ok", params: {} }));
  assert.deepEqual(JSON.parse(out.at(-1)!), { id: 7, result: { decision: "accept" } });
  await server.receive(JSON.stringify({ id: 8, method: "bad", params: {} }));
  assert.equal(JSON.parse(out.at(-1)!).error.message, "nope");
  await server.receive(JSON.stringify({ method: "turn/completed", params: {} }));
  assert.deepEqual(notes, ["turn/completed"]);
  const failing = server.request("turn/start", {});
  await server.receive(JSON.stringify({ id: 2, error: { message: "bad turn" } }));
  await assert.rejects(failing, /bad turn/);
  const left = server.request("x", {});
  server.close("Codex stopped.");
  await assert.rejects(left, /Codex stopped/);
});
