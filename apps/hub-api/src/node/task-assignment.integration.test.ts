/**
 * Tasks given to a node or a crew (docs/35 §6.6), against an in-memory database with the model scripted:
 * the migration, the owner field's API (only the person's own nodes and crews), the one turn a node or a
 * crew's lead gets when a task becomes theirs or is taken away, and a node and a lead that answer once and
 * start the work (an agent session with the owner's profile; a plan that gives a testing task to the tester).
 */
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { randomBytes } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { OPTIONAL_MODULES, serializeModules } from "@ensemble/shared-types";
import { createHttpHarness, type HttpUser } from "../test/http.js";
import type { RuntimeTurn } from "../lib/model-turn.js";

const h = await createHttpHarness();
const { setAskRuntimeStreamForTests } = await import("../lib/model-turn.js");
const { settleTurns } = await import("./queue.js");
const { saveSettings } = await import("../lib/settings.js");
const { RunProfile } = await import("@ensemble/shared-types");
const { createSpaceUser, SPACE_COOKIE } = await import("../spaces/store.js");
after(() => h.close());

type Call = { name: string; arguments: Record<string, unknown> };
type Step = { calls?: Call[]; text?: string; then?: string };
type Seen = { slug: string; transcript: string };
let script: (turn: Seen) => Step = () => ({ text: "(no reply)" });
const seen: Seen[] = [];

setAskRuntimeStreamForTests(async (args) => {
  const messages = args.messages as Array<{ role?: string; content?: unknown }>;
  const system = messages.filter((row) => row.role === "system").map((row) => String(row.content)).join("\n");
  const slug = /You are .+? \(@([a-z0-9-]+)\), (?:an Ensemble Node|a temporary helper)/.exec(system)?.[1] ?? "?";
  const last = messages.filter((row) => row.role === "user").at(-1)?.content;
  const transcript = Array.isArray(last) ? last.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : String(last ?? "");
  const second = messages.at(-1)?.role === "tool";
  const current: Seen = { slug, transcript };
  if (!second) seen.push(current);
  const step = script(current);
  const calls = second ? [] : (step.calls ?? []);
  const text = second ? (step.then ?? "(no reply)") : calls.length ? "" : (step.text ?? "(no reply)");
  const turn: RuntimeTurn = {
    text,
    toolCalls: calls.map((call, index) => ({ id: `call-${randomBytes(4).toString("hex")}-${index}`, name: call.name, arguments: JSON.stringify(call.arguments) })),
    model: "test-model",
    credits: 0,
    tokensIn: 10,
    tokensOut: 5,
    reasoning: "",
    raw: {},
    finishReason: "stop",
    cutOff: false,
  };
  if (text) args.onDelta?.(text);
  return turn;
});

afterEach(async () => {
  await settleTurns();
  seen.length = 0;
  script = () => ({ text: "(no reply)" });
});

const json = (response: LightMyRequestResponse) => response.json() as any;

async function person(name: string): Promise<HttpUser> {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { name, emailVerifiedAt: new Date() } });
  return user;
}

async function createNode(user: HttpUser, templateId: string) {
  const response = await user.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId } });
  assert.equal(response.statusCode, 201, response.body);
  return json(response) as { node: { id: string; slug: string; name: string }; room: { id: string } };
}

async function crewOf(user: HttpUser, templates: string[], title = `Crew ${randomBytes(3).toString("hex")}`) {
  const ids: string[] = [];
  for (const template of templates) ids.push((await createNode(user, template)).node.id);
  const made = await user.inject({ method: "POST", url: "/api/node/crews", payload: { title, nodeIds: ids, leadNodeId: ids[0] } });
  assert.equal(made.statusCode, 201, made.body);
  return { ids, crew: json(made).room as { id: string; title: string } };
}

/** A request in a space `user` can open (their own account when none). */
const inSpace = (user: HttpUser, spaceId?: string) => (spaceId ? { cookie: `${user.cookie}; ${SPACE_COOKIE}=${spaceId}` } : { cookie: user.cookie });

async function newTask(user: HttpUser, payload: Record<string, unknown>, spaceId?: string) {
  const response = await h.app.inject({ method: "POST", url: "/api/tasks", headers: inSpace(user, spaceId), payload });
  assert.equal(response.statusCode, 201, response.body);
  return json(response).task as { id: string; owner: string; assigneeNodeId: string | null; assigneeRoomId: string | null; nodeAssignee?: any };
}

async function patch(user: HttpUser, id: string, payload: Record<string, unknown>, spaceId?: string) {
  const response = await h.app.inject({ method: "PATCH", url: `/api/tasks/${id}`, headers: inSpace(user, spaceId), payload });
  return { status: response.statusCode, body: json(response) };
}

const taskTurns = (taskId: string) => h.prisma.nodeTurn.findMany({ where: { reason: "task", operationId: { startsWith: `task:${taskId}:` } }, orderBy: { createdAt: "asc" } });

async function read(user: HttpUser, roomId: string) {
  const response = await user.inject({ method: "GET", url: `/api/node/rooms/${roomId}/messages` });
  assert.equal(response.statusCode, 200, response.body);
  return json(response).messages as Array<{ id: string; kind: string; body: string; authorKind: string; authorNodeId: string | null; data: any }>;
}

test("the migration adds the node owner, the node and crew columns and their indexes (PGlite)", async () => {
  const values = await h.prisma.$queryRaw<Array<{ value: string }>>`SELECT unnest(enum_range(NULL::"TaskOwner"))::text AS value`;
  assert.deepEqual(values.map((row) => row.value), ["me", "agent", "unassigned", "node"]);
  const columns = await h.prisma.$queryRaw<Array<{ column_name: string; is_nullable: string }>>`
    SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'tasks' AND column_name IN ('assignee_node_id', 'assignee_room_id') ORDER BY column_name`;
  assert.deepEqual(columns.map((row) => [row.column_name, row.is_nullable]), [["assignee_node_id", "YES"], ["assignee_room_id", "YES"]]);
  const indexes = await h.prisma.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes WHERE tablename = 'tasks' AND indexname IN ('tasks_assignee_node_id_idx', 'tasks_assignee_room_id_idx') ORDER BY indexname`;
  assert.deepEqual(indexes.map((row) => row.indexname), ["tasks_assignee_node_id_idx", "tasks_assignee_room_id_idx"]);
  // Tasks made before keep their owner: nothing is rewritten.
  const mira = await person("Mira");
  const old = await newTask(mira, { title: "Before nodes", owner: "me" });
  assert.deepEqual([old.owner, old.assigneeNodeId, old.assigneeRoomId], ["me", null, null]);
});

test("the owner field takes only my own nodes and crews, in my space and in a space shared with me; clearing and reassigning work", async () => {
  const akash = await person("Akash");
  const ben = await person("Ben");
  const carol = await person("Carol");
  const { node: assistant } = await createNode(akash, "assistant");
  const { crew } = await crewOf(akash, ["manager", "tester"], "Software team");
  const { node: bens } = await createNode(ben, "researcher");
  const { crew: benCrew } = await crewOf(ben, ["manager"], "Ben's desk");

  const mine = json(await akash.inject({ method: "GET", url: "/api/node/assignable" }));
  assert.deepEqual(mine.nodes.map((row: { slug: string }) => row.slug), ["assistant", "manager", "tester"]);
  assert.deepEqual(Object.keys(mine.nodes[0]).sort(), ["id", "name", "role", "slug"]);
  assert.deepEqual(mine.crews, [{ roomId: crew.id, title: "Software team", lead: { id: mine.nodes[1].id, slug: "manager", name: mine.nodes[1].name }, members: 2 }]);
  assert.deepEqual(json(await carol.inject({ method: "GET", url: "/api/node/assignable" })), { nodes: [], crews: [] }, "no nodes, nothing to offer");
  assert.ok(!JSON.stringify(json(await ben.inject({ method: "GET", url: "/api/node/assignable" }))).includes(assistant.id), "never another person's nodes");

  const task = await newTask(akash, { title: "Write the launch notes" });
  for (const [payload, status] of [
    [{ owner: "node", assigneeNodeId: bens.id }, 404],
    [{ owner: "node", assigneeRoomId: benCrew.id }, 404],
    [{ owner: "node", assigneeRoomId: assistant.id }, 404],
    [{ owner: "node" }, 400],
    [{ owner: "node", assigneeNodeId: assistant.id, assigneeRoomId: crew.id }, 400],
    [{ owner: "me", assigneeNodeId: assistant.id }, 400],
    [{ assignee: akash.id, assigneeNodeId: assistant.id }, 400],
    [{ owner: "node", assigneeNodeId: "not-a-uuid" }, 400],
  ] as const) {
    const result = await patch(akash, task.id, payload);
    assert.equal(result.status, status, `${JSON.stringify(payload)}: ${JSON.stringify(result.body)}`);
  }
  assert.equal((await h.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).owner, "unassigned", "a refused change changes nothing");

  const toNode = await patch(akash, task.id, { owner: "node", assigneeNodeId: assistant.id });
  assert.equal(toNode.status, 200, JSON.stringify(toNode.body));
  assert.deepEqual([toNode.body.task.owner, toNode.body.task.assigneeNodeId, toNode.body.task.assigneeRoomId], ["node", assistant.id, null]);
  assert.deepEqual(toNode.body.task.nodeAssignee, { kind: "node", id: assistant.id, name: assistant.name, handle: "assistant", accountId: akash.id });
  const toCrew = await patch(akash, task.id, { assigneeRoomId: crew.id });
  assert.deepEqual([toCrew.body.task.owner, toCrew.body.task.assigneeNodeId, toCrew.body.task.assigneeRoomId, toCrew.body.task.nodeAssignee.name], ["node", null, crew.id, "Software team"], "naming a crew alone means owner node");
  const listed = json(await akash.inject({ method: "GET", url: "/api/tasks" })).tasks.find((row: { id: string }) => row.id === task.id);
  assert.equal(listed.nodeAssignee.kind, "crew", "the board's list names it too");
  const back = await patch(akash, task.id, { owner: "me" });
  assert.deepEqual([back.body.task.owner, back.body.task.assigneeNodeId, back.body.task.assigneeRoomId, back.body.task.nodeAssignee], ["me", null, null, undefined]);
  const made = await newTask(akash, { title: "Made for a node", owner: "node", assigneeNodeId: assistant.id });
  assert.deepEqual([made.owner, made.assigneeNodeId], ["node", assistant.id], "a new task can start with a node");
  assert.equal((await patch(akash, made.id, { owner: "agent" })).body.task.assigneeNodeId, null, "another owner clears the node");

  // A space Akash shares with Ben: each gives tasks there only to their own nodes; everyone sees whose node has it.
  const fieldnote = await createSpaceUser(h.prisma, akash.id, { name: "Fieldnote", icon: null });
  await h.prisma.user.update({ where: { id: fieldnote }, data: { moduleSet: serializeModules(OPTIONAL_MODULES) } });
  assert.equal((await akash.inject({ method: "POST", url: `/api/sharing/spaces/${fieldnote}/members`, payload: { personId: ben.id, role: "editor" } })).statusCode, 201);
  const shared = await newTask(ben, { title: "Survey the field" }, fieldnote);
  assert.equal((await patch(ben, shared.id, { owner: "node", assigneeNodeId: assistant.id }, fieldnote)).status, 404, "Ben cannot give it to Akash's node");
  const bensOwn = await patch(ben, shared.id, { owner: "node", assigneeNodeId: bens.id }, fieldnote);
  assert.equal(bensOwn.status, 200, JSON.stringify(bensOwn.body));
  assert.equal((await patch(akash, shared.id, { owner: "node", assigneeNodeId: bens.id }, fieldnote)).status, 404, "the space's owner cannot give it to Ben's node either");
  const seenByAkash = json(await h.app.inject({ method: "GET", url: `/api/tasks/${shared.id}`, headers: inSpace(akash, fieldnote) })).task;
  assert.deepEqual(seenByAkash.nodeAssignee, { kind: "node", id: bens.id, name: bens.name, handle: bens.slug, accountId: ben.id });
  assert.equal((await patch(ben, shared.id, { assigneeRoomId: benCrew.id }, fieldnote)).status, 200);
  assert.equal(json(await h.app.inject({ method: "GET", url: `/api/tasks/${shared.id}`, headers: inSpace(akash, fieldnote) })).task.nodeAssignee.name, "Crew", "another person's crew title stays theirs");
  const taken = await patch(akash, shared.id, { owner: "me" }, fieldnote);
  assert.deepEqual([taken.status, taken.body.task.owner, taken.body.task.assigneeRoomId], [200, "me", null], "anyone who can edit the task can take it back");
  assert.equal((await patch(akash, shared.id, { owner: "node", assigneeNodeId: assistant.id }, fieldnote)).status, 200, "Akash gives it to his own node there");
});

test("a node hears once in its DM, a crew's lead in the crew's room; taking the task away tells whoever was told to stop", async () => {
  const akash = await person("Akash");
  const { node: assistant, room: dm } = await createNode(akash, "assistant");
  const { ids, crew } = await crewOf(akash, ["manager", "tester"], "Software team");
  const project = await h.prisma.project.create({ data: { userId: akash.id, name: "Website" } });
  const task = await newTask(akash, { title: "Fix the flaky login test", description: "It fails one run in five on CI.", due: "2026-11-03T00:00:00.000Z", projectId: project.id, labels: ["testing", "ci"], status: "todo" });

  await patch(akash, task.id, { owner: "node", assigneeNodeId: assistant.id });
  await settleTurns();
  let turns = await taskTurns(task.id);
  assert.equal(turns.length, 1, "exactly one turn");
  assert.deepEqual([turns[0]!.nodeId, turns[0]!.roomId, turns[0]!.spaceId, turns[0]!.status], [assistant.id, dm.id, akash.id, "done"]);
  const note = turns[0]!.note!;
  for (const part of ["Your owner gave you an Ensemble task: [Fix the flaky login test](ensemble://task/", "Due: 2026-11-03", "Project: “Website”", "Labels: testing, ci", "It fails one run in five on CI.", "Decide how, as your charter, your memory and your owner's instructions say", `node_session_start with taskId ${task.id}`, "Reply once, in a line or two", "hub_update_task"]) {
    assert.ok(note.includes(part), `the note says ${part}:\n${note}`);
  }
  assert.ok(seen.some((row) => row.slug === "assistant" && row.transcript.includes("Update for you: Your owner gave you an Ensemble task")), "the node reads it in its DM turn");
  assert.equal((await h.prisma.auditLedger.count({ where: { userId: akash.id, action: "node.task_assigned", taskId: task.id } })), 1);

  await patch(akash, task.id, { priority: "p0", status: "in_progress" });
  await settleTurns();
  assert.equal((await taskTurns(task.id)).length, 1, "other changes tell nobody");

  await patch(akash, task.id, { assigneeRoomId: crew.id });
  await settleTurns();
  turns = await taskTurns(task.id);
  assert.equal(turns.length, 3);
  const [off, on] = [turns.find((row) => row.operationId!.includes(":off:"))!, turns.filter((row) => row.operationId!.includes(":on:")).at(-1)!];
  assert.deepEqual([off.nodeId, off.roomId], [assistant.id, dm.id], "the node that had it hears in its DM");
  assert.match(off.note!, /no longer yours: your owner gave it to the crew “Software team”/);
  assert.deepEqual([on.nodeId, on.roomId], [ids[0], crew.id], "the crew's lead hears in the crew's room");
  assert.match(on.note!, /Your owner gave your crew “Software team” an Ensemble task/);
  assert.match(on.note!, /a testing task to the tester/);

  await patch(akash, task.id, { owner: "me" });
  await settleTurns();
  turns = await taskTurns(task.id);
  assert.equal(turns.length, 4);
  assert.deepEqual([turns.at(-1)!.nodeId, turns.at(-1)!.roomId], [ids[0], crew.id], "taking it away tells the lead that was told");
  assert.match(turns.at(-1)!.note!, /no longer yours: your owner gave it to your owner/);
  await patch(akash, task.id, { owner: "unassigned" });
  await settleTurns();
  assert.equal((await taskTurns(task.id)).length, 4, "nobody had it: nobody hears");

  // A node whose DM is gone gets a new one.
  await h.prisma.nodeRoom.update({ where: { id: dm.id }, data: { archivedAt: new Date() } });
  const given = await patch(akash, task.id, { owner: "node", assigneeNodeId: assistant.id });
  await settleTurns();
  const fresh = (await taskTurns(task.id)).at(-1)!;
  assert.notEqual(fresh.roomId, dm.id);
  assert.equal((await h.prisma.nodeRoom.findUniqueOrThrow({ where: { id: fresh.roomId! } })).kind, "dm");

  // Undo puts the owner back, and the node hears it is no longer its task.
  const undone = await akash.inject({ method: "POST", url: "/api/undo", payload: { entryId: given.body.undoEntryId } });
  assert.equal(undone.statusCode, 200, undone.body);
  await settleTurns();
  assert.equal((await h.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).owner, "unassigned");
  const unDone = (await taskTurns(task.id)).at(-1)!;
  assert.deepEqual([unDone.nodeId, unDone.roomId, unDone.operationId!.includes(":off:")], [assistant.id, fresh.roomId, true]);
  await patch(akash, task.id, { owner: "node", assigneeNodeId: assistant.id });

  // Deleting the node leaves the task with nobody.
  assert.equal((await akash.inject({ method: "DELETE", url: `/api/node/nodes/${assistant.id}` })).statusCode, 204);
  const left = await h.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.deepEqual([left.owner, left.assigneeNodeId], ["unassigned", null]);
});

async function laptopFor(user: HttpUser) {
  const key = await h.asToken(user, "device");
  const laptop = await h.prisma.device.create({
    data: { userId: user.id, name: "Laptop", platform: "linux", tokenId: key.id, capabilities: { folders: ["ensemble"], engines: ["copilot-cli", "claude-code"] }, lastSeenAt: new Date() },
  });
  await saveSettings(h.prisma, user.id, {
    runProfiles: [
      RunProfile.parse({ id: "copilot", name: "Copilot", engine: "copilot-cli", model: "gpt-6.1-sol", effort: "medium", mode: "review", delivery: "local", deviceId: laptop.id }),
      RunProfile.parse({ id: "claude", name: "Claude", engine: "claude-code", model: "claude-opus-4.8", effort: "high", mode: "review", delivery: "local", deviceId: laptop.id }),
    ],
    defaultRunProfileId: "copilot",
  });
  return laptop;
}

test("scripted: a node answers once and runs the task in an agent session with the profile its owner told it to use; the task stays with it", async () => {
  const akash = await person("Akash");
  await laptopFor(akash);
  const { node, room } = await createNode(akash, "feature-engineer");
  assert.equal((await akash.inject({ method: "POST", url: `/api/node/nodes/${node.id}/memory`, payload: { content: "Always run coding work with the Claude run profile (claude-opus-4.8, high)." } })).statusCode, 201);
  const task = await newTask(akash, { title: "Add dark mode to settings", status: "todo" });
  script = (turn) => {
    if (turn.slug === node.slug && turn.transcript.includes("Your owner gave you an Ensemble task")) {
      return {
        calls: [{ name: "node_session_start", arguments: { title: "Dark mode", prompt: "Add dark mode to the settings page; run the tests.", taskId: task.id, folder: "ensemble", agent: "claude-code", model: "claude-opus-4.8", effort: "high" } }],
        then: "I'll build it in a Claude Code session on your laptop (your Claude profile).",
      };
    }
    return { text: "(no reply)" };
  };
  await patch(akash, task.id, { owner: "node", assigneeNodeId: node.id });
  await settleTurns();

  const messages = (await read(akash, room.id)).filter((row) => row.authorNodeId === node.id);
  const replies = messages.filter((row) => row.kind === "text");
  assert.equal(replies.length, 1, "one line, once");
  assert.match(replies[0]!.body, /Claude Code session/);
  assert.deepEqual(replies[0]!.data.task, { id: task.id, title: "Add dark mode to settings", status: "todo", due: null }, "Node web shows the task under the reply");
  assert.ok(replies[0]!.data.refs.some((ref: { kind: string; id: string }) => ref.kind === "task" && ref.id === task.id));
  assert.equal(messages.filter((row) => row.kind === "run").length, 1, "and the run card");
  const job = await h.prisma.workspaceJob.findFirstOrThrow({ where: { userId: akash.id } });
  assert.deepEqual([job.taskId, job.provider, job.model, job.reasoningEffort], [task.id, "claude-code", "claude-opus-4.8", "high"]);
  const held = await h.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.deepEqual([held.owner, held.assigneeNodeId], ["node", node.id], "its own run keeps the task with the node");

  // Its work board lists the task on its next turn.
  script = () => ({ text: "Going: the session is building it." });
  const asked = await akash.inject({ method: "POST", url: `/api/node/rooms/${room.id}/messages`, payload: { body: "how is it going?" } });
  assert.equal(asked.statusCode, 201);
  await settleTurns();
  const board = seen.filter((row) => row.slug === node.slug).at(-1)!.transcript;
  assert.match(board, /Tasks your owner gave you \(move them with hub_update_task as work goes\):\n {2}- \[Add dark mode to settings\]\(ensemble:\/\/task\/[0-9a-f-]+\) To do/);

  // A person who runs it with the agent instead takes it from the node, which is told to stop.
  const before = (await taskTurns(task.id)).length;
  const laptop = await h.prisma.device.findFirstOrThrow({ where: { userId: akash.id } });
  const assigned = await akash.inject({ method: "POST", url: "/api/agent/assign", payload: { taskId: task.id, kind: "code", engine: "claude-code", deviceId: laptop.id, folderLabel: "ensemble" } });
  assert.equal(assigned.statusCode, 201, assigned.body);
  await settleTurns();
  const moved = await h.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.deepEqual([moved.owner, moved.assigneeNodeId], ["agent", null]);
  const turns = await taskTurns(task.id);
  assert.equal(turns.length, before + 1);
  assert.match(turns.at(-1)!.note!, /no longer yours: your owner gave it to the agent\.\nStop your work on it now: the agent session [^\n]+ \(node_session_stop\)/);
});

test("scripted: a crew's lead gives a testing task to its tester in one plan; the crew stays quiet; a node that gives a task back is not told", async () => {
  const akash = await person("Akash");
  const { ids, crew } = await crewOf(akash, ["manager", "feature-engineer", "tester"], "Software team");
  const task = await newTask(akash, { title: "Test the checkout flow", labels: ["testing"], status: "todo" });
  script = (turn) => {
    if (turn.slug === "manager" && turn.transcript.includes("Your owner gave your crew")) {
      return {
        calls: [{
          name: "node_plan",
          arguments: {
            goal: "Test the checkout flow",
            requirements: [{ id: "checkout", text: "The checkout flow is tested end to end" }],
            steps: [{ id: "t1", to: "tester", kind: "research", requirementIds: ["checkout"], brief: "Test the checkout flow end to end and report what fails." }],
          },
        }],
        then: "@tester tests the checkout flow; I'll report when it is done.",
      };
    }
    if (turn.slug === "tester") return { calls: [{ name: "node_step_report", arguments: { outcome: "done", summary: "Checkout works; one slow page noted." } }], then: "(no reply)" };
    if (turn.slug === "manager") return { text: "Done: the checkout flow passes; one slow page noted." };
    return { text: "(no reply)" };
  };
  await patch(akash, task.id, { owner: "node", assigneeRoomId: crew.id });
  await settleTurns();
  const mission = await h.prisma.nodeMission.findFirstOrThrow({ where: { userId: akash.id, leadNodeId: ids[0] }, include: { steps: true } });
  assert.deepEqual(mission.steps.map((step) => [step.nodeId, step.kind]), [[ids[2], "research"]], "the tester does it");
  const fromNodes = (await read(akash, crew.id)).filter((row) => row.authorKind === "node" && (row.kind === "text" || row.kind === "plan"));
  assert.ok(fromNodes.length >= 1 && fromNodes.length <= 3, `quiet: ${fromNodes.length} messages`);
  assert.ok(!fromNodes.some((row) => row.authorNodeId === ids[1]), "the builder never posts");

  // The lead gives it back itself (its own Ensemble call): nobody needs telling.
  const told = (await taskTurns(task.id)).length;
  script = (turn) => (turn.slug === "manager" && turn.transcript.includes("give it back")
    ? { calls: [{ name: "hub_update_task", arguments: { taskId: task.id, matchTitle: "Test the checkout flow", owner: "me" } }], then: "Gave it back to you." }
    : { text: "(no reply)" });
  const asked = await akash.inject({ method: "POST", url: `/api/node/rooms/${crew.id}/messages`, payload: { body: "give it back to me please" } });
  assert.equal(asked.statusCode, 201);
  await settleTurns();
  assert.equal((await h.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).owner, "me");
  assert.equal((await taskTurns(task.id)).length, told, "no stop notice for the node that did it");
});
