import assert from "node:assert/strict";
import test from "node:test";
import { getTool } from "../registry.js";

test("reminder tool rejects non-ISO dates", () => {
  const tool = getTool("hub_create_reminder");
  assert.ok(tool);
  assert.throws(() => tool.input.parse({ title: "Call", dueDate: "tomorrow" }));
  assert.throws(() => tool.input.parse({ title: "Call", dueDate: "2026-09-29", dueTime: "5pm" }));
  const parsed = tool.input.parse({ title: "Call", dueDate: "2026-09-29", dueTime: "09:30" });
  assert.equal(parsed.dueDate, "2026-09-29");
  assert.equal(parsed.dueTime, "09:30");
});

test("task drafts reject unknown fields and keep priority codes", () => {
  const tool = getTool("hub_create_tasks");
  assert.ok(tool);
  assert.throws(() => tool.input.parse({ tasks: [{ title: "File it", madeUp: true }] }));
  const withId = tool.input.parse({ tasks: [{ title: "File it", taskId: "11111111-1111-4111-8111-111111111111" }] });
  assert.equal(withId.tasks[0]?.title, "File it");
  const parsed = tool.input.parse({ tasks: [{ title: "File it", priority: "p0", projectName: "Clinic matter" }] });
  assert.equal(parsed.tasks[0]?.priority, "p0");
  assert.equal(parsed.tasks[0]?.projectName, "Clinic matter");
});

test("diagram tools are registered and writes wait for a preview", () => {
  const validate = getTool("hub_validate_diagram");
  const create = getTool("hub_create_diagram");
  const update = getTool("hub_update_diagram");
  const list = getTool("hub_list_diagrams");
  assert.equal(validate?.isWrite, false);
  assert.equal(list?.isWrite, false);
  assert.equal(create?.isWrite, true);
  assert.equal(create?.area, "context");
  assert.equal(typeof create?.preview, "function");
  assert.equal(update?.isWrite, true);
  const parsed = create?.input.parse({
    title: "Login",
    text: "node a \"A\" shape rectangle\n",
    links: [{ kind: "repo", id: "33333333-3333-4333-8333-333333333333" }],
  });
  assert.equal(parsed?.title, "Login");
  assert.throws(() => update?.input.parse({ diagramId: "not-a-uuid", text: "x" }));
});

test("repo read tools are registered and do not write", () => {
  const overview = getTool("hub_repo_overview");
  const file = getTool("hub_repo_read_file");
  assert.equal(overview?.isWrite, false);
  assert.equal(overview?.area, "context");
  assert.equal(file?.isWrite, false);
  assert.equal(file?.area, "context");
  assert.throws(() => overview?.input.parse({ repoId: "not-a-uuid" }));
  const parsed = file?.input.parse({ repoId: "33333333-3333-4333-8333-333333333333", path: "README.md" });
  assert.equal(parsed?.path, "README.md");
});

test("tasks may name a project proposed earlier in the same batch", async () => {
  const tool = getTool("hub_create_tasks");
  const preview = tool?.preview;
  assert.ok(preview);
  const ctx = {
    prisma: { project: { findFirst: async () => null } },
    userId: "user",
    pendingProjectNames: ["Launch"],
  };
  const text = await preview(ctx as never, { tasks: [{ title: "Write the brief", projectName: "Launch" }] });
  assert.match(text, /in Launch/);
  await assert.rejects(
    () => Promise.resolve(preview({ ...ctx, pendingProjectNames: [] } as never, { tasks: [{ title: "Write the brief", projectName: "Missing" }] })),
    /No project named “Missing”/,
  );
});

test("what's due and web search are registered reads", () => {
  const due = getTool("hub_list_due");
  const search = getTool("hub_web_search");
  assert.equal(due?.isWrite, false);
  assert.equal(search?.isWrite, false);
  assert.throws(() => search?.input.parse({}));
});
