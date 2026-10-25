import "../runtime/test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { DEFAULT_SETTINGS, type AssistantRef, type AssistantStreamFrame } from "@ensemble/shared-types";
import { setAskRuntimeStreamForTests, type RuntimeTurn } from "../lib/model-turn.js";
import { runAssistantTurn } from "./agent.js";
import { defineTool, toolOk } from "./types.js";
import { historyEntries } from "./cutoff.js";
import { historyRefs, mergeRefs, readablePreview, refsFromResult, refsNote, stateRefs, titleList, toolKind } from "./refs.js";
import { updateSummary } from "./tools/tasks.js";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const BRIEF = "3f2a9c1e-7b44-4d2a-9a51-0c8f5e6d7b10";
const CALL = "8d1b2c3e-4f50-4a61-8b72-9c83d4e5f601";
const LAUNCH = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const MIRA = "11111111-2222-4333-8444-555555555555";

test("a tool result's records come with their kind, title and a qualifier", () => {
  const refs = refsFromResult("hub_create_tasks", { tasks: [{ id: BRIEF, title: "Draft brief", projectId: LAUNCH, due: "2026-10-30" }, { id: CALL, title: "Call Mira" }] });
  assert.deepEqual(refs, [
    { kind: "task", id: BRIEF, label: "Draft brief", detail: "due 2026-10-30" },
    { kind: "task", id: CALL, label: "Call Mira" },
  ]);
  assert.deepEqual(refsFromResult("hub_create_project", { project: { id: LAUNCH, name: "Launch" } }), [{ kind: "project", id: LAUNCH, label: "Launch" }]);
  assert.deepEqual(refsFromResult("hub_create_person", { person: { id: MIRA, name: "Mira Chen", email: "mira@fieldnote.example" } })[0]?.detail, "mira@fieldnote.example");
  assert.deepEqual(refsFromResult("hub_update_page", { id: BRIEF, taskId: CALL, title: "Call Mira" }).map((ref) => ref.kind), ["task", "page"], "a task's page is also its task");
  assert.deepEqual(refsFromResult("hub_update_deliverable", { id: LAUNCH }, "Updated “Spec v2”."), [{ kind: "deliverable", id: LAUNCH, label: "Spec v2" }], "an id-only result takes the summary's one title");
  assert.deepEqual(refsFromResult("hub_search_context", { results: [{ id: BRIEF, title: "Standup notes" }] }), [{ kind: "item", id: BRIEF, label: "Standup notes" }]);
  assert.deepEqual(refsFromResult("hub_list_tasks", { tasks: [{ id: "not-a-uuid", title: "x" }] }), [], "only real ids");
  assert.equal(refsFromResult("hub_list_tasks", { tasks: Array.from({ length: 80 }, (_, index) => ({ id: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`, title: `T${index}` })) }).length, 50);
  assert.equal(toolKind("hub_list_repos"), "repo");
  assert.equal(toolKind("hub_read_task_page"), "task");
});

test("summaries list titles and counts, and keep same-named tasks apart", () => {
  assert.equal(titleList([{ title: "Draft brief" }]), "“Draft brief”");
  assert.equal(titleList([{ title: "Draft brief" }, { title: "Call Mira" }]), "“Draft brief” and “Call Mira”");
  assert.equal(titleList(["A", "B", "C", "D", "E", "F", "G"].map((title) => ({ title }))), "“A”, “B”, “C”, “D”, “E” and 2 more");
  assert.equal(titleList([{ title: "Review", detail: "due 2026-10-30" }, { title: "Review" }]), "“Review” (due 2026-10-30) and “Review” (2)");
  assert.equal(updateSummary("Draft brief", "Draft brief", { status: "done" }, false), "Marked “Draft brief” done.");
  assert.equal(updateSummary("Draft brief", "Draft brief", { priority: "p0", due: "2026-10-30", owner: undefined }, true), "Updated “Draft brief”: priority, due date and page.");
  assert.equal(updateSummary("Draft brief", "Final brief", { title: "Final brief", status: "todo" }, false), "Renamed “Draft brief” to “Final brief”; changed status.");
});

test("a write without its own preview reads as fields, with known titles for ids", () => {
  const known = new Map<string, AssistantRef>([[LAUNCH, { kind: "project", id: LAUNCH, label: "Launch" }]]);
  const text = readablePreview("hub_update_project", { projectId: LAUNCH, personIds: [MIRA, BRIEF], status: "done", notes: "Line one\nline two" }, known);
  assert.equal(text, "Update project:\n- project: “Launch”\n- people: 2 people\n- status: done\n- notes: Line one line two");
  assert.doesNotMatch(readablePreview("mcp_linear_create_issue", { teamId: BRIEF, title: "Fix login", labels: ["bug"] }, new Map()), UUID);
  assert.doesNotMatch(text, /```|\{/);
});

test("records the model saw: the snapshot, earlier replies, and receipts written for the next turn", () => {
  const snapshot = stateRefs({ todo: [{ id: BRIEF, title: "Draft brief", status: "in_progress" }], projects: [{ id: LAUNCH, name: "Launch" }], people: [{ id: MIRA, name: "Mira Chen" }] }, { id: CALL, title: "Call Mira", status: "todo" });
  assert.deepEqual(snapshot.map((ref) => [ref.kind, ref.label]), [["task", "Call Mira"], ["task", "Draft brief"], ["project", "Launch"], ["people", "Mira Chen"]]);
  const rows = [
    { role: "user", content: "Add the brief", toolCalls: [] },
    {
      role: "assistant",
      content: "Added it.",
      toolCalls: [{ name: "hub_create_tasks", state: "ok", isWrite: true, summary: "Added “Draft brief”.", refs: [{ kind: "task", id: BRIEF, label: "Draft brief" }] }],
      mentions: [{ kind: "project", id: LAUNCH, label: "Launch" }],
    },
  ];
  assert.deepEqual(historyRefs(rows).map((ref) => ref.id), [BRIEF, LAUNCH]);
  const history = historyEntries(rows);
  assert.equal(history[1]?.content, `Added it.\n\n(You did: Added “Draft brief”. Records: [Draft brief](ensemble://task/${BRIEF}).)`);
  assert.equal(refsNote([]), "");
  assert.equal(mergeRefs([[{ kind: "task", id: BRIEF, label: "New" }], [{ kind: "task", id: BRIEF.toUpperCase(), label: "Old" }]]).length, 1);
});

function fakeApp(): FastifyInstance {
  const empty = () => ({ findMany: async () => [], findFirst: async () => null, findUnique: async () => null, count: async () => 0, create: async () => ({}) });
  const prisma = new Proxy({}, { get: (_target, prop) => (prop === "user" ? { findUnique: async () => ({ name: "Mira Chen", onboardingRole: null, spaceName: null, ownerId: null }) } : empty()) });
  return {
    prisma,
    redis: { get: async () => null, set: async () => "OK", del: async () => 1, mget: async (...keys: string[]) => keys.map(() => null), sadd: async () => 1, srem: async () => 1, smembers: async () => [], expire: async () => 1 },
    log: { error() {}, info() {}, warn() {} },
  } as unknown as FastifyInstance;
}

test("a turn tells the display which records it named, and receipts and previews carry titles", async () => {
  const added = defineTool({
    name: "node_test_add",
    area: "tasks",
    description: "Add a task.",
    input: z.object({ title: z.string() }),
    isWrite: true,
    risk: "low",
    async run(_ctx, input) {
      return toolOk(`Added “${input.title}” (${BRIEF}).`, { tasks: [{ id: BRIEF, title: input.title }] });
    },
  });
  const held = defineTool({ name: "node_test_update", area: "tasks", description: "Update a project.", input: z.object({ projectId: z.string().uuid() }), isWrite: true, risk: "low", alwaysHold: true, async run() { return toolOk("Updated."); } });
  let step = 0;
  setAskRuntimeStreamForTests(async (args) => {
    step += 1;
    const text = step === 1 ? "" : `Added Draft brief (${BRIEF}) to the plan for ${LAUNCH}.`;
    const turn: RuntimeTurn = {
      text,
      toolCalls: step === 1 ? [{ id: "call-add", name: "node_test_add", arguments: JSON.stringify({ title: "Draft brief" }) }, { id: "call-held", name: "node_test_update", arguments: JSON.stringify({ projectId: LAUNCH }) }] : [],
      model: "test-model", credits: 0, tokensIn: 1, tokensOut: 1, reasoning: "", raw: {}, finishReason: "stop", cutOff: false,
    };
    if (text) args.onDelta?.(text);
    return turn;
  });
  const frames: AssistantStreamFrame[] = [];
  try {
    const result = await runAssistantTurn({
      app: fakeApp(),
      userId: "space-refs",
      conversationId: "conv-refs",
      message: "Add the brief to @project:Launch",
      mentions: [{ kind: "project", id: LAUNCH, label: "Launch" }],
      settings: DEFAULT_SETTINGS,
      model: "test-model",
      extraTools: [added, held],
      emit: (frame) => frames.push(frame),
    });
    assert.equal(frames[0]?.type, "refs", "records the model was shown arrive before any text");
    assert.deepEqual(frames[0]?.type === "refs" ? frames[0].refs : [], [{ kind: "project", id: LAUNCH, label: "Launch" }]);
    const tool = frames.find((frame) => frame.type === "tool");
    assert.equal(tool?.type === "tool" ? tool.call.summary : "", "Added “Draft brief”.", "a known id in a receipt shows as its title");
    assert.deepEqual(tool?.type === "tool" ? tool.call.refs : [], [{ kind: "task", id: BRIEF, label: "Draft brief" }]);
    const pending = frames.find((frame) => frame.type === "pending");
    assert.equal(pending?.type === "pending" ? pending.preview : "", "Test update:\n- project: “Launch”", "a held write reads as fields, never raw JSON");
    assert.match(result.content, /Proposed, not applied yet: Test update/, "the held write stays a proposal");
    assert.ok(result.content.includes(BRIEF), "the saved reply keeps the model's words");
    assert.deepEqual(result.refs?.map((ref) => ref.id).sort(), [BRIEF, LAUNCH].sort(), "and names the records whose titles it shows");
  } finally {
    setAskRuntimeStreamForTests(null);
  }
});
