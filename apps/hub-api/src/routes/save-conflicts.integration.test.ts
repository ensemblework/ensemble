import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { resolveSave, type SaveConflict } from "@ensemble/shared-types/save-merge";
import { createHttpHarness, type HttpHarness } from "../test/http.js";

let h: HttpHarness;
before(async () => { h = await createHttpHarness(); });
after(async () => { await h?.close(); });
const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

test("disjoint nested settings patches merge, including full sections containing unchanged values", async () => {
  const user = await h.asUser();
  const base = (await user.inject({ url: "/api/settings" })).json().settings;
  const save = (patch: object) => user.inject({ method: "PATCH", url: "/api/settings", payload: { ...patch, _base: base } });
  const results = await Promise.all([save({ quietHours: { from: "07:30" } }), save({ quietHours: { ...base.quietHours, until: "08:45" } })]);
  for (const result of results) assert.equal(result.statusCode, 200, result.body);
  const settings = (await user.inject({ url: "/api/settings" })).json().settings;
  assert.equal(settings.quietHours.from, "07:30");
  assert.equal(settings.quietHours.until, "08:45");
});

test("overlapping settings return both values, make no write and require a fresh guarded choice", async () => {
  const user = await h.asUser();
  const base = (await user.inject({ url: "/api/settings" })).json().settings;
  const first = await user.inject({ method: "PATCH", url: "/api/settings", payload: { quietHours: { from: "07:30" }, _base: base } });
  assert.equal(first.statusCode, 200, first.body);
  const second = await user.inject({ method: "PATCH", url: "/api/settings", payload: { quietHours: { from: "08:45", until: "09:30" }, _base: base } });
  assert.equal(second.statusCode, 409, second.body);
  const conflict = second.json<SaveConflict>();
  assert.deepEqual(conflict.conflicts, [{ path: ["quietHours", "from"], saved: "07:30", yours: "08:45" }]);
  assert.equal((await user.inject({ url: "/api/settings" })).json().settings.quietHours.until, base.quietHours.until);
  const choice = await user.inject({ method: "PATCH", url: "/api/settings", payload: { ...resolveSave(conflict, "saved"), _base: conflict.current } });
  assert.equal(choice.statusCode, 200, choice.body);
  assert.equal(choice.json().settings.quietHours.from, "07:30");
  assert.equal(choice.json().settings.quietHours.until, "09:30");
  const again = await user.inject({ method: "PATCH", url: "/api/settings", payload: { quietHours: { from: "10:00" }, _base: base } });
  assert.equal(again.statusCode, 409);
  const yours = again.json<SaveConflict>();
  const kept = await user.inject({ method: "PATCH", url: "/api/settings", payload: { ...resolveSave(yours, "yours"), _base: yours.current } });
  assert.equal(kept.json().settings.quietHours.from, "10:00");
});

test("two simultaneous saves of one setting cannot both overwrite the same baseline", async () => {
  const user = await h.asUser();
  const base = (await user.inject({ url: "/api/settings" })).json().settings;
  const answers = await Promise.all(["07:30", "08:45"].map((from) => user.inject({ method: "PATCH", url: "/api/settings", payload: { quietHours: { from }, _base: base } })));
  assert.deepEqual(answers.map((answer) => answer.statusCode).sort(), [200, 409]);
});

test("meeting document clashes preserve both versions; choosing the saved copy also keeps a disjoint title", async () => {
  const user = await h.asUser();
  const created = await user.inject({ method: "POST", url: "/api/meetings/sessions", payload: { title: "Planning" } });
  const id = created.json().session.id;
  const base = (await user.inject({ url: `/api/meetings/sessions/${id}` })).json().session;
  assert.equal((await user.inject({ method: "PATCH", url: `/api/meetings/sessions/${id}`, payload: { content: doc("First version"), _base: base } })).statusCode, 200);
  const rejected = await user.inject({ method: "PATCH", url: `/api/meetings/sessions/${id}`, payload: { content: doc("Second version"), title: "Release planning", _base: base } });
  assert.equal(rejected.statusCode, 409, rejected.body);
  const clash = rejected.json<SaveConflict>();
  assert.equal(clash.conflicts[0]!.path[0], "content");
  assert.match(JSON.stringify(clash.conflicts), /First version.*Second version/);
  const saved = await user.inject({ method: "PATCH", url: `/api/meetings/sessions/${id}`, payload: { ...resolveSave(clash, "saved"), _base: clash.current } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().session.title, "Release planning");
  assert.match(saved.json().session.notes, /First version/);
  assert.equal(saved.json().session.content.type, "doc");
});

test("project JSON saves keep their schema and stale task/people saves conflict without losing disjoint changes", async () => {
  const user = await h.asUser();
  const project = (await user.inject({ method: "POST", url: "/api/projects", payload: { name: "Launch" } })).json().project;
  const path = `/api/projects/${project.id}`;
  const first = await user.inject({ method: "PATCH", url: path, payload: { content: doc("Plan one"), _base: project } });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().project.content.type, "doc");
  const stale = await user.inject({ method: "PATCH", url: path, payload: { content: doc("Plan two"), _base: project } });
  assert.equal(stale.statusCode, 409, stale.body);
  const disjoint = await user.inject({ method: "PATCH", url: path, payload: { summary: "Ready", _base: project } });
  assert.equal(disjoint.statusCode, 200, disjoint.body);
  assert.equal(disjoint.json().project.content.type, "doc");
  const person = (await user.inject({ method: "POST", url: "/api/people", payload: { name: "Mira" } })).json().person;
  const updated = await user.inject({ method: "PATCH", url: `/api/people/${person.id}`, payload: { name: "Mira Chen", _base: person } });
  assert.equal(updated.statusCode, 200);
  const denied = await user.inject({ method: "PATCH", url: `/api/people/${person.id}`, payload: { name: "Mira C", _base: person } });
  assert.equal(denied.statusCode, 409, denied.body);
  const task = (await user.inject({ method: "POST", url: "/api/tasks", payload: { title: "Review" } })).json().task;
  const changed = await user.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, payload: { title: "Review launch", _base: task } });
  assert.equal(changed.statusCode, 200, changed.body);
  const conflict = await user.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, payload: { title: "Review release", _base: task } });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json().code, "SAVE_CONFLICT");
});

test("routine instructions, skill bodies, plot titles and preferences use the same guarded choice", async () => {
  const user = await h.asUser();
  const routine = (await user.inject({ method: "POST", url: "/api/routines", payload: { title: "Weekly review", instruction: "Read the board.", cadence: { every: "week", time: "09:00" } } })).json().routine;
  const skill = (await user.inject({ method: "POST", url: "/api/skills", payload: { name: "Review", body: "Read carefully." } })).json().skill;
  const plot = await h.prisma.plot.create({ data: { userId: user.id, title: "Forecast", config: {} } });
  for (const record of [
    { path: `/api/routines/${routine.id}`, base: routine, key: "instruction", first: "Read the release.", second: "Read the backlog." },
    { path: `/api/skills/${skill.id}`, base: skill, key: "body", first: "Review the release.", second: "Review the backlog." },
    { path: `/api/plots/${plot.id}`, base: plot, key: "title", first: "Release forecast", second: "Backlog forecast" },
  ]) {
    const first = await user.inject({ method: "PATCH", url: record.path, payload: { [record.key]: record.first, _base: record.base } });
    assert.equal(first.statusCode, 200, first.body);
    const second = await user.inject({ method: "PATCH", url: record.path, payload: { [record.key]: record.second, _base: record.base } });
    assert.equal(second.statusCode, 409, second.body);
    assert.equal(second.json().code, "SAVE_CONFLICT");
  }
  const prefPath = "/api/preferences/ui.example";
  const added = await user.inject({ method: "PUT", url: prefPath, payload: { value: { left: "one", right: "one" } } });
  assert.equal(added.statusCode, 200, added.body);
  const base = { value: added.json().preference.value };
  assert.equal((await user.inject({ method: "PUT", url: prefPath, payload: { value: { left: "two", right: "one" }, _base: base } })).statusCode, 200);
  const merged = await user.inject({ method: "PUT", url: prefPath, payload: { value: { left: "one", right: "two" }, _base: base } });
  assert.equal(merged.statusCode, 200, merged.body);
  assert.deepEqual(merged.json().preference.value, { left: "two", right: "two" });
});

test("plot-space saves compare the edited copy and return the actual chosen configuration", async () => {
  const user = await h.asUser();
  const initial = await user.inject({ url: "/api/plots/workspace" });
  assert.equal(initial.statusCode, 200, initial.body);
  const base = initial.json().workspace;
  const first = await user.inject({ method: "PUT", url: "/api/plots/workspace", payload: { id: base.id, config: base.config, code: "first()", _base: base } });
  assert.equal(first.statusCode, 200, first.body);
  const clash = await user.inject({ method: "PUT", url: "/api/plots/workspace", payload: { id: base.id, config: base.config, code: "second()", _base: base } });
  assert.equal(clash.statusCode, 409, clash.body);
  const conflict = clash.json<SaveConflict>();
  const saved = await user.inject({ method: "PUT", url: "/api/plots/workspace", payload: { id: base.id, config: base.config, ...resolveSave(conflict, "saved"), _base: conflict.current } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().workspace.code, "first()");
  assert.deepEqual(saved.json().workspace.config, base.config);
});
