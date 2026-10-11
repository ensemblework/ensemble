import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHttpHarness } from "../test/http.js";

const harness = await createHttpHarness();
after(() => harness.close());

test("workspace search finds deep page matches, scopes results, excludes Trash and never captures tasks", async () => {
  const owner = await harness.asUser(), outsider = await harness.asUser();
  const task = (await owner.inject({ method: "POST", url: "/api/tasks", payload: { title: "Search fixture" } })).json().task;
  const text = `${"A long introduction. ".repeat(100)}The team established a useful review process.`;
  const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
  await owner.inject({ method: "PUT", url: `/api/tasks/${task.id}/page`, payload: { revision: 0, content } });
  const page = (await owner.inject({ method: "POST", url: "/api/pages", payload: { title: "Established guidelines" } })).json().page;
  await owner.inject({ method: "PATCH", url: `/api/pages/${page.id}`, payload: { title: "Established guidelines" } });
  const meeting = (await owner.inject({ method: "POST", url: "/api/meetings/sessions", payload: { title: "Planning" } })).json().session;
  await owner.inject({ method: "PATCH", url: `/api/meetings/sessions/${meeting.id}`, payload: { notes: text } });
  const results = (await owner.inject({ method: "GET", url: "/api/context/search?q=established" })).json().results;
  assert.equal(results[0].label, "Established guidelines");
  assert.ok(results.some((hit: { path: string; excerpt: string }) => hit.path === `/tasks/${task.id}` && hit.excerpt.includes("established")));
  assert.ok(results.some((hit: { path: string; excerpt: string }) => hit.path === `/meetings?session=${meeting.id}` && hit.excerpt.includes("established")));
  assert.ok(results.every((hit: { excerpt: string }) => hit.excerpt.length < 200));
  assert.deepEqual((await outsider.inject({ method: "GET", url: "/api/context/search?q=established" })).json().results, []);
  await owner.inject({ method: "DELETE", url: `/api/pages/${page.id}` });
  await owner.inject({ method: "DELETE", url: `/api/tasks/${task.id}` });
  await owner.inject({ method: "DELETE", url: `/api/meetings/sessions/${meeting.id}` });
  assert.deepEqual((await owner.inject({ method: "GET", url: "/api/context/search?q=established" })).json().results, []);
  const before = await harness.prisma.task.count({ where: { userId: owner.id } });
  await owner.inject({ method: "GET", url: "/api/context/search?q=mock%207%2F10" });
  assert.equal(await harness.prisma.task.count({ where: { userId: owner.id } }), before);
});

test("workspace search rejects missing, blank and oversized queries", async () => {
  const owner = await harness.asUser();
  for (const suffix of ["", "?q=%20", `?q=${"a".repeat(501)}`]) assert.equal((await owner.inject({ method: "GET", url: `/api/context/search${suffix}` })).statusCode, 400);
  assert.equal((await harness.app.inject({ method: "GET", url: "/api/context/search?q=private" })).statusCode, 401);
});
