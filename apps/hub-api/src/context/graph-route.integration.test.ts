import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHttpHarness, type HttpUser } from "../test/http.js";

const h = await createHttpHarness();
after(() => h.close());

type Edge = { source: string; target: string; kind: string; label?: string };

async function person(user: HttpUser, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const response = await user.inject({ method: "POST", url: "/api/people", payload: { name, ...extra } });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().person.id;
}

async function members(user: HttpUser, projectId: string) {
  const response = await user.inject({ method: "GET", url: `/api/projects/${projectId}` });
  assert.equal(response.statusCode, 200, response.body);
  const rows = response.json().project.people as Array<{ role: string | null; addedBy: string; person: { id: string } }>;
  return new Map(rows.map((row) => [row.person.id, { role: row.role, addedBy: row.addedBy }]));
}

test("project members keep their roles and who added them when the list changes; people[] sets roles", async () => {
  const user = await h.asUser();
  const project = (await user.inject({ method: "POST", url: "/api/projects", payload: { name: "Atlas" } })).json().project;
  const [priya, omar, lena] = [await person(user, "Priya Shah"), await person(user, "Omar Ruiz"), await person(user, "Lena Ito")];
  await h.prisma.projectPerson.create({ data: { projectId: project.id, personId: omar, role: "Reviewer", addedBy: "agent" } });

  const roles = await user.inject({ method: "PATCH", url: `/api/projects/${project.id}`, payload: { people: [{ id: priya, role: " Product lead " }, { id: omar }] } });
  assert.equal(roles.statusCode, 200, roles.body);
  let rows = await members(user, project.id);
  assert.deepEqual(rows.get(priya), { role: "Product lead", addedBy: "me" });
  assert.deepEqual(rows.get(omar), { role: "Reviewer", addedBy: "agent" }, "no role in the list keeps the saved one");

  const added = await user.inject({ method: "PATCH", url: `/api/projects/${project.id}`, payload: { personIds: [priya, omar, lena] } });
  assert.equal(added.statusCode, 200, added.body);
  rows = await members(user, project.id);
  assert.deepEqual(rows.get(priya), { role: "Product lead", addedBy: "me" });
  assert.deepEqual(rows.get(omar), { role: "Reviewer", addedBy: "agent" });
  assert.deepEqual(rows.get(lena), { role: null, addedBy: "me" });

  await user.inject({ method: "PATCH", url: `/api/projects/${project.id}`, payload: { people: [{ id: priya, role: "" }, { id: lena, role: "Design" }] } });
  rows = await members(user, project.id);
  assert.equal(rows.has(omar), false);
  assert.deepEqual(rows.get(priya), { role: null, addedBy: "me" });
  assert.deepEqual(rows.get(lena), { role: "Design", addedBy: "me" });

  const list = (await user.inject({ method: "GET", url: "/api/projects" })).json().projects.find((row: { id: string }) => row.id === project.id);
  assert.equal(list.people.find((row: { id: string }) => row.id === lena).role, "Design");

  const both = await user.inject({ method: "PATCH", url: `/api/projects/${project.id}`, payload: { personIds: [priya], people: [{ id: priya }] } });
  assert.equal(both.statusCode, 400);
  const stranger = await person(await h.asUser(), "Someone else");
  const foreign = await user.inject({ method: "PATCH", url: `/api/projects/${project.id}`, payload: { people: [{ id: stranger, role: "Lead" }] } });
  assert.equal(foreign.statusCode, 404);
});

test("a person's relationship to you saves, clears and shows in People", async () => {
  const user = await h.asUser();
  const priya = await person(user, "Priya Shah", { relationship: "my manager" });
  const read = async () => (await user.inject({ method: "GET", url: "/api/people" })).json().people.find((row: { id: string }) => row.id === priya);
  assert.equal((await read()).relationship, "my manager");
  const patched = await user.inject({ method: "PATCH", url: `/api/people/${priya}`, payload: { relationship: "  client " } });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal((await read()).relationship, "client");
  assert.equal((await user.inject({ method: "PATCH", url: `/api/people/${priya}`, payload: { relationship: "x".repeat(81) } })).statusCode, 400);
  await user.inject({ method: "PATCH", url: `/api/people/${priya}`, payload: { relationship: "" } });
  assert.equal((await read()).relationship, null);
});

test("the graph links meetings to their tasks, pages to what they mention, people we wait on, and focuses", async () => {
  const user = await h.asUser();
  const db = h.prisma;
  const userId = user.id;
  const project = await db.project.create({ data: { userId, name: "Atlas", createdBy: "me" } });
  const other = await db.project.create({ data: { userId, name: "Beacon", createdBy: "me" } });
  const priya = await db.person.create({ data: { userId, name: "Priya Shah", relationship: "my manager" } });
  const omar = await db.person.create({ data: { userId, name: "Omar Ruiz" } });
  await db.projectPerson.create({ data: { projectId: project.id, personId: priya.id, role: "Product lead", addedBy: "me" } });
  await db.projectPerson.create({ data: { projectId: other.id, personId: priya.id, addedBy: "me" } });
  const meeting = await db.meetingNote.create({ data: { userId, title: "Atlas weekly sync", projectId: project.id, personIds: [priya.id] } });
  const task = await db.task.create({ data: { userId, title: "Send the latency budget", status: "todo", projectId: project.id, meetingNoteId: meeting.id, people: [priya.id] } });
  const waiting = await db.task.create({ data: { userId, title: "Load-test numbers from Omar", status: "todo", people: [omar.id], labels: ["waiting-on"] } });
  const session = await db.meetingSession.create({ data: { userId, title: "Atlas design review", projectId: project.id, personIds: [omar.id] } });
  const page = await db.taskPage.create({ data: { userId, title: "Atlas launch plan", mentions: { create: [{ kind: "project", entityId: project.id, label: "Atlas" }] } } });
  await db.taskPage.create({ data: { userId, title: "Nothing here", mentions: { create: [{ kind: "project", entityId: "6f1d1e0a-0000-4000-8000-000000000000", label: "Gone" }] } } });

  const graph = await user.inject({ method: "GET", url: "/api/context/graph" });
  assert.equal(graph.statusCode, 200, graph.body);
  const { nodes, edges } = graph.json() as { nodes: Array<{ id: string; kind: string; sub: string }>; edges: Edge[] };
  const has = (source: string, target: string, kind: string) => edges.find((edge) => edge.source === source && edge.target === target && edge.kind === kind);
  assert.ok(has(meeting.id, task.id, "from_meeting"));
  assert.equal(has(priya.id, project.id, "member")?.label, "Product lead");
  assert.equal(has(priya.id, other.id, "member")?.label, undefined);
  assert.ok(has(omar.id, waiting.id, "waiting"));
  assert.equal(has(omar.id, waiting.id, "person"), undefined);
  assert.ok(has(priya.id, task.id, "person"));
  assert.equal(nodes.find((node) => node.id === session.id)?.kind, "note");
  assert.ok(has(project.id, session.id, "note"));
  assert.ok(has(omar.id, session.id, "attendee"));
  assert.equal(nodes.find((node) => node.id === page.id)?.kind, "page");
  assert.ok(has(page.id, project.id, "page"));
  assert.equal(nodes.filter((node) => node.kind === "page").length, 1, "a page that mentions nothing on the graph stays off it");
  assert.match(nodes.find((node) => node.id === priya.id)?.sub ?? "", /my manager/);
  assert.equal(new Set(edges.map((edge) => `${edge.source}|${edge.target}|${edge.kind}`)).size, edges.length);

  const near = await user.inject({ method: "GET", url: `/api/context/graph?focus=ensemble://project/${project.id}&depth=1` });
  assert.equal(near.statusCode, 200, near.body);
  const one = near.json() as { nodes: Array<{ id: string }>; edges: Edge[]; focus: { id: string; depth: number } };
  const ids = new Set(one.nodes.map((node) => node.id));
  assert.deepEqual(one.focus, { id: project.id, depth: 1 });
  for (const id of [project.id, priya.id, meeting.id, task.id, session.id, page.id]) assert.ok(ids.has(id), id);
  assert.equal(ids.has(other.id), false, "two links away");
  assert.equal(ids.has(waiting.id), false);
  assert.ok(one.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target)));

  const two = (await user.inject({ method: "GET", url: `/api/context/graph?focus=${project.id}&depth=2` })).json() as { nodes: Array<{ id: string }> };
  assert.ok(two.nodes.some((node) => node.id === other.id));
  assert.equal(two.nodes.some((node) => node.id === waiting.id), false);

  const missing = await user.inject({ method: "GET", url: `/api/context/graph?focus=ensemble://task/6f1d1e0a-0000-4000-8000-000000000000` });
  assert.equal(missing.statusCode, 404);
  const outsider = await h.asUser();
  assert.equal((await outsider.inject({ method: "GET", url: `/api/context/graph?focus=${project.id}` })).statusCode, 404);
  assert.equal((await user.inject({ method: "GET", url: `/api/context/graph?focus=${project.id}&depth=3` })).statusCode, 400);
});
