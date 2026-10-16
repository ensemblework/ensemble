import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHttpHarness } from "./http.js";
const h = await createHttpHarness();
after(() => h.close());
async function page(user: Awaited<ReturnType<typeof h.asUser>>, title = "Design notes") {
  const res = await user.inject({ method: "POST", url: "/api/pages" }); assert.equal(res.statusCode, 201, res.body);
  const id = res.json().page.id;
  await user.inject({ method: "PATCH", url: `/api/pages/${id}`, payload: { title } }); return id as string;
}
const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

test("page checkpoints coalesce typing, preview is scoped, restore preserves current work", async () => {
  const owner = await h.asUser(), other = await h.asUser(); const id = await page(owner);
  for (let revision = 1; revision < 5; revision++) {
    const res = await owner.inject({ method: "PUT", url: `/api/pages/${id}`, payload: { revision, content: doc(`Draft ${revision}`) } }); assert.equal(res.statusCode, 200, res.body);
  }
  const listed = await owner.inject({ method: "GET", url: `/api/page-versions?id=${id}` }); assert.equal(listed.statusCode, 200, listed.body);
  const list = listed.json(); assert.equal(list.versions.length, 1); assert.ok(list.versions[0].createdAt); assert.ok(list.versions[0].author);
  const version = list.versions[0].id;
  assert.equal((await other.inject({ method: "GET", url: `/api/page-versions/${version}` })).statusCode, 404);
  const stale = await owner.inject({ method: "POST", url: `/api/page-versions/${version}/restore`, payload: { revision: 0, updatedAt: list.updatedAt } }); assert.equal(stale.statusCode, 409, stale.body);
  const restored = await owner.inject({ method: "POST", url: `/api/page-versions/${version}/restore`, payload: { revision: list.revision, updatedAt: list.updatedAt } }); assert.equal(restored.statusCode, 200, restored.body);
  assert.ok(await h.prisma.pageRevision.findFirst({ where: { pageId: id, content: { path: ["content", "0", "content", "0", "text"], equals: "Draft 4" } } }));
});

test("duplicate pages and private profile templates copy writing without copying shares", async () => {
  const owner = await h.asUser(), other = await h.asUser(); const id = await page(owner, "Field plan");
  await owner.inject({ method: "PUT", url: `/api/pages/${id}`, payload: { revision: 1, content: doc("Visit the field on Friday") } });
  const duplicate = await owner.inject({ method: "POST", url: `/api/pages/${id}/duplicate`, payload: {} }); assert.equal(duplicate.statusCode, 201, duplicate.body); assert.equal(duplicate.json().page.title, "Copy of Field plan");
  const saved = await owner.inject({ method: "POST", url: `/api/pages/${id}/template`, payload: { title: "Field visit" } }); assert.equal(saved.statusCode, 201, saved.body);
  const tid = saved.json().template.id;
  assert.equal((await other.inject({ method: "POST", url: `/api/page-templates/${tid}/create`, payload: {} })).statusCode, 404);
  const created = await owner.inject({ method: "POST", url: `/api/page-templates/${tid}/create`, payload: {} }); assert.equal(created.statusCode, 201, created.body);
  assert.match((await owner.inject({ method: "GET", url: `/api/pages/${created.json().page.id}` })).body, /Visit the field/);
  await h.prisma.user.update({ where: { id: owner.id }, data: { onboardingRole: "teacher" } });
  assert.deepEqual((await owner.inject({ method: "GET", url: "/api/page-templates" })).json().templates, []);
});

test("sharing reads live titles and first-line previews with the share date", async () => {
  const owner = await h.asUser(), other = await h.asUser(); const id = await page(owner, "Untitled");
  const share = await owner.inject({ method: "POST", url: "/api/sharing/items", payload: { kind: "page", resourceId: id, personId: other.id, role: "view" } }); assert.equal(share.statusCode, 201, share.body);
  await owner.inject({ method: "PATCH", url: `/api/pages/${id}`, payload: { title: "New title" } });
  await owner.inject({ method: "PUT", url: `/api/pages/${id}`, payload: { revision: 1, content: doc("A meaningful first line") } });
  const incoming = (await other.inject({ method: "GET", url: "/api/sharing/with-me" })).json().items[0];
  assert.equal(incoming.title, "New title"); assert.equal(incoming.excerpt, "A meaningful first line"); assert.ok(incoming.since);
});

test("version and template routes reject invalid targets and isolate every stored object", async () => {
  const owner = await h.asUser(), other = await h.asUser();
  const id = await page(owner), missing = "00000000-0000-4000-8000-000000000000";
  const listed = (await owner.inject({ method: "GET", url: `/api/page-versions?id=${id}` })).json();
  const vid = listed.versions[0].id;
  assert.equal((await owner.inject({ method: "GET", url: `/api/page-versions/${vid}` })).statusCode, 200);
  for (const method of ["GET", "POST"] as const) {
    const suffix = method === "POST" ? "/restore" : "";
    const payload = method === "POST" ? { revision: listed.revision, updatedAt: listed.updatedAt } : undefined;
    for (const target of [vid, missing]) assert.equal((await other.inject({ method, url: `/api/page-versions/${target}${suffix}`, payload })).statusCode, 404);
    assert.equal((await owner.inject({ method, url: `/api/page-versions/not-an-id${suffix}`, payload })).statusCode, 400);
  }
  assert.equal((await other.inject({ method: "GET", url: `/api/page-versions?id=${id}` })).statusCode, 404);
  assert.equal((await owner.inject({ method: "GET", url: `/api/page-versions?id=${missing}` })).statusCode, 404);
  assert.equal((await owner.inject({ method: "GET", url: "/api/page-versions?id=bad" })).statusCode, 400);
  assert.equal((await owner.inject({ method: "POST", url: `/api/page-versions/${vid}/restore`, payload: {} })).statusCode, 400);
  for (const action of ["duplicate", "template"]) {
    const payload = action === "template" ? { title: "Private template" } : {};
    for (const target of [id, missing]) assert.equal((await other.inject({ method: "POST", url: `/api/pages/${target}/${action}`, payload })).statusCode, 404);
    assert.equal((await owner.inject({ method: "POST", url: `/api/pages/bad/${action}`, payload })).statusCode, 400);
  }
  assert.equal((await owner.inject({ method: "POST", url: `/api/pages/${id}/template`, payload: { title: "" } })).statusCode, 400);
  const tid = (await owner.inject({ method: "POST", url: `/api/pages/${id}/template`, payload: { title: "Private template" } })).json().template.id;
  assert.equal((await other.inject({ method: "GET", url: "/api/page-templates" })).json().templates.length, 0);
  assert.ok((await owner.inject({ method: "GET", url: "/api/page-templates" })).json().templates.some((row: { id: string }) => row.id === tid));
  for (const target of [tid, missing]) {
    assert.equal((await other.inject({ method: "POST", url: `/api/page-templates/${target}/create`, payload: {} })).statusCode, 404);
    assert.equal((await other.inject({ method: "DELETE", url: `/api/page-templates/${target}` })).statusCode, 204);
  }
  assert.ok(await h.prisma.pageTemplate.findUnique({ where: { id: tid } }));
  assert.equal((await owner.inject({ method: "POST", url: "/api/page-templates/bad/create", payload: {} })).statusCode, 400);
  assert.equal((await owner.inject({ method: "DELETE", url: "/api/page-templates/bad" })).statusCode, 400);
  assert.equal((await owner.inject({ method: "DELETE", url: `/api/page-templates/${tid}` })).statusCode, 204);
  assert.equal((await owner.inject({ method: "GET", url: "/api/page-templates" })).json().templates.length, 0);
  const shared = (await owner.inject({ method: "POST", url: "/api/sharing/items", payload: { kind: "page", resourceId: id, personId: other.id, role: "edit" } })).json().shares.find((row: { person: { id: string } }) => row.person.id === other.id).id;
  for (const url of [`/api/page-versions?id=${id}`, `/api/page-versions/${vid}`, "/api/page-templates"]) {
    assert.equal((await h.app.inject({ method: "GET", url, headers: { cookie: other.cookie, "x-ensemble-share": shared } })).statusCode, 403);
  }
});

test("page checkpoints keep only thirty immutable snapshots with their authors", async () => {
  const owner = await h.asUser(), id = await page(owner);
  const { checkpointPage } = await import("../pages/history.js");
  await h.prisma.pageRevision.deleteMany({ where: { pageId: id } });
  for (let index = 0; index < 35; index++) {
    await h.prisma.$transaction(async tx => {
      const row = await tx.taskPage.update({ where: { id }, data: { content: doc(`Saved ${index}`), updatedAt: new Date(Date.UTC(2026, 9, 1, 0, index)), editorAccountId: owner.id } });
      await checkpointPage(tx, row, "History", true);
    });
  }
  const rows = await h.prisma.pageRevision.findMany({ where: { pageId: id }, orderBy: { createdAt: "asc" } });
  assert.equal(rows.length, 30); assert.match(JSON.stringify(rows[0].content), /Saved 5/); assert.ok(rows.every(row => row.authorAccountId === owner.id));
});

test("live editing records the authenticated editor, and restore survives an open editor", async () => {
  const owner = await h.asUser(), editor = await h.asUser(), id = await page(owner);
  const shared = (await owner.inject({ method: "POST", url: "/api/sharing/items", payload: { kind: "page", resourceId: id, personId: editor.id, role: "edit" } })).json().shares.find((row: { person: { id: string } }) => row.person.id === editor.id).id;
  const headers = { cookie: editor.cookie, "x-ensemble-share": shared };
  const url = `/api/pages/${id}/collab`, join = (await h.app.inject({ method: "GET", url, headers })).json();
  const response = await h.app.inject({ method: "POST", url, headers, payload: { epoch: join.epoch, version: join.version, clientID: join.clientID, token: join.token, flush: true, editorAccountId: owner.id, steps: [{ stepType: "replace", from: 1, to: 1, slice: { content: [{ type: "text", text: "Guest writing" }] } }] } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await h.prisma.taskPage.findUniqueOrThrow({ where: { id } })).editorAccountId, editor.id);
  const list = (await owner.inject({ method: "GET", url: `/api/page-versions?id=${id}` })).json();
  const restore = await owner.inject({ method: "POST", url: `/api/page-versions/${list.versions[0].id}/restore`, payload: { revision: list.revision, updatedAt: list.updatedAt } });
  assert.equal(restore.statusCode, 200, restore.body);
  const after = (await owner.inject({ method: "GET", url })).json();
  assert.doesNotMatch(JSON.stringify(after.doc), /Guest writing/);
  assert.match(JSON.stringify((await owner.inject({ method: "GET", url: `/api/page-versions?id=${id}` })).json().versions), /HTTP test user/);
});

test("spaces reject normalized duplicate names, and migration disambiguates old duplicates", async () => {
  const owner = await h.asUser();
  await h.prisma.user.update({ where: { id: owner.id }, data: { onboardingRole: "student", onboardingCompletedAt: new Date(), spaceName: "Notes" } });
  const refused = await owner.inject({ method: "POST", url: "/api/spaces", payload: { name: "Ｎｏｔｅｓ", templateId: "semester-desk", settings: { mode: "fresh" } } });
  assert.equal(refused.statusCode, 409, refused.body);
  const child = await h.prisma.user.create({ data: { ownerId: owner.id, name: "Student", email: `legacy-${owner.id}@example.test`, spaceName: " notes " } });
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(new URL("../../prisma/migrations/20261017100000_unique_space_names/migration.sql", import.meta.url), "utf8");
  await h.prisma.$executeRawUnsafe(sql);
  assert.equal((await h.prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).spaceName, "Notes");
  assert.match((await h.prisma.user.findUniqueOrThrow({ where: { id: child.id } })).spaceName!, /\(2\)$/);
});
