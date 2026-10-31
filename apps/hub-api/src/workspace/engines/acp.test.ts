import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://ensemble@127.0.0.1:1/ensemble_desktop";
const { acpCalls, OPENCODE_PERMISSIONS, pickOption } = await import("./acp.js");
const { acpModels } = await import("../../subscriptions/acp-probe.js");

test("ACP tool calls in the judge's terms, however each agent names them", () => {
  assert.deepEqual(acpCalls({ kind: "execute", rawInput: { command: ["git", "status"] } }), [{ tool: "Bash", input: { command: "git status" } }]);
  assert.deepEqual(acpCalls({ kind: "execute", title: "`npm test`" }), [{ tool: "Bash", input: { command: "npm test" } }]);
  assert.deepEqual(
    acpCalls({ kind: "edit", locations: [{ path: "/w/a.ts" }], content: [{ type: "diff", path: "/w/b.ts" }], rawInput: { filePath: "/w/a.ts" } }).map((call) => call.input.file_path),
    ["/w/a.ts", "/w/b.ts"],
  );
  assert.deepEqual(acpCalls({ kind: "read", rawInput: { absolute_path: "/etc/hosts" } }), [{ tool: "Read", input: { file_path: "/etc/hosts" } }]);
  assert.deepEqual(acpCalls({ kind: "fetch", rawInput: { url: "https://example.com" } }), [{ tool: "WebFetch", input: { url: "https://example.com" } }]);
  for (const title of ["ensemble: ask_person", "ensemble-ask_person", "mcp__ensemble__ask_person", "ensemble/ask_person"]) {
    assert.equal(acpCalls({ kind: "other", title })[0]!.tool, "mcp__ensemble__ask_person", title);
  }
  assert.equal(acpCalls({ kind: "other", title: "github: create_issue" })[0]!.tool, "mcp__github__create_issue");
  const options = [{ optionId: "allow-always", kind: "allow_always" }, { optionId: "allow-once", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }];
  assert.equal(pickOption(options, true), "allow-once", "once, never always");
  assert.equal(pickOption(options, false), "reject");
});

test("OpenCode asks before every edit, command, fetch and outside path, so each reaches the judge", () => {
  for (const key of ["*", "bash", "edit", "webfetch", "external_directory", "task"] as const) assert.equal(OPENCODE_PERMISSIONS[key], "ask", key);
  assert.equal(OPENCODE_PERMISSIONS.grep, "allow");
});

test("an ACP agent's models and thinking levels from its session options", () => {
  const models = acpModels([
    { id: "model", category: "model", currentValue: "gemini-3-pro", options: [{ options: [{ value: "gemini-3-pro", name: "Gemini 3 Pro" }, { value: "gemini-3-flash", name: "Gemini 3 Flash" }] } as never] },
    { id: "thinking", category: "thought_level", options: [{ value: "high" }, { value: "low" }, { value: "turbo" }] },
  ]);
  assert.deepEqual(models, [
    { id: "gemini-3-pro", label: "Gemini 3 Pro", isDefault: true, efforts: ["low", "high"] },
    { id: "gemini-3-flash", label: "Gemini 3 Flash" },
  ]);
  assert.deepEqual(acpModels([], { availableModels: [{ modelId: "a", name: "A" }], currentModelId: "a" }), [{ id: "a", label: "A", isDefault: true }]);
});

test("an agent's form question (elicitation) reaches the person field by field; secrets and links are declined", async () => {
  const { answerElicitation } = await import("./elicitation.js");
  type Ask = NonNullable<Parameters<typeof answerElicitation>[2]>;
  const asked: Array<{ title: string; options?: string[]; allowCustom?: boolean }> = [];
  const answering = (...answers: string[]) => (async (_ctx: unknown, input: { title: string; options?: string[]; allowCustom?: boolean }) => (asked.push(input), { decision: "allow" as const, answer: answers.shift() ?? null })) as unknown as Ask;
  const ctx = (unattended = false) => ({ job: { unattended }, decisions: [] as unknown[], event: async () => undefined, progress: async () => undefined }) as never;
  const strategy = { type: "object", properties: { strategy: { type: "string", title: "Strategy", oneOf: [{ const: "safe", title: "Conservative" }, { const: "fast", title: "Aggressive" }] } }, required: ["strategy"] };
  assert.deepEqual(await answerElicitation(ctx(), { mode: "form", message: "How should I refactor?", requestedSchema: strategy }, answering("Aggressive")), { action: "accept", content: { strategy: "fast" } });
  assert.deepEqual(asked[0], { event: "question", toolName: "question", title: "How should I refactor? (Strategy)", options: ["Conservative", "Aggressive"], allowCustom: false, recommended: "Conservative" });
  const both = { type: "object", properties: { tests: { type: "boolean", title: "Add tests" }, name: { type: "string", title: "Branch name" } }, required: ["tests"] };
  assert.deepEqual(await answerElicitation(ctx(), { mode: "form", message: "Set up the branch", requestedSchema: both }, answering("Yes", "feature/x")), { action: "accept", content: { tests: true, name: "feature/x" } });
  assert.deepEqual(await answerElicitation(ctx(), { mode: "form", message: "Set up the branch", requestedSchema: both }, answering()), { action: "decline" }, "a required field left unanswered declines the form");
  const unattended = ctx(true) as { decisions: unknown[] };
  assert.deepEqual(await answerElicitation(unattended as never, { mode: "form", message: "How should I refactor?", requestedSchema: strategy }, answering()), { action: "accept", content: { strategy: "safe" } });
  assert.equal(unattended.decisions.length, 1, "an unattended run takes the first choice and lists it");
  const before = asked.length;
  const secret = { type: "object", properties: { token: { type: "string", title: "GitHub token" } } };
  assert.deepEqual(await answerElicitation(ctx(), { mode: "form", message: "Paste it", requestedSchema: secret }, answering("x")), { action: "decline" });
  assert.deepEqual(await answerElicitation(ctx(), { mode: "url", message: "Sign in", url: "https://example.com" }, answering("x")), { action: "decline" });
  assert.equal(asked.length, before, "nobody is asked for a secret or to open a link");
});
