import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHttpHarness } from "./http.js";

const h = await createHttpHarness();
const { deleteAccountData } = await import("../lib/account-data.js");
const { shareItem } = await import("../sharing/store.js");
const { privateIdentifier } = await import("../lib/secrets.js");
after(() => h.close());

async function page(user: Awaited<ReturnType<typeof h.asUser>>) {
  const response = await user.inject({ method: "POST", url: "/api/pages" });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().page.id as string;
}

test("contact budget spans spaces and item types; existing contacts do not spend twice", async () => {
  const owner = await h.asUser();
  const people = await Promise.all(Array.from({ length: 6 }, () => h.asUser()));
  const id = await page(owner);
  for (const person of people.slice(0, 5)) {
    const res = await owner.inject({ method: "POST", url: "/api/sharing/items", payload: { kind: "page", resourceId: id, personId: person.id, role: "edit" } });
    assert.equal(res.statusCode, 201, res.body);
  }
  const space = await h.prisma.user.create({ data: { ownerId: owner.id, email: `${owner.id}@spaces.ensemble.invalid` } });
  const secondPage = await h.prisma.taskPage.create({ data: { userId: space.id, title: "Second-space note" } });
  await shareItem(h.prisma, owner.id, { spaceId: space.id, kind: "page", resourceId: secondPage.id, personId: people[0]!.id, role: "edit" });
  await assert.rejects(() => shareItem(h.prisma, owner.id, { spaceId: space.id, kind: "page", resourceId: secondPage.id, personId: people[5]!.id, role: "edit" }), /up to 5 people/);
  const second = await page(owner);
  const repeat = await owner.inject({ method: "POST", url: "/api/sharing/items", payload: { kind: "page", resourceId: second, personId: people[0]!.id, role: "view" } });
  assert.equal(repeat.statusCode, 201, repeat.body);
  const res = await owner.inject({ method: "POST", url: "/api/sharing/contacts", payload: { personId: people[5]!.id } });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().code, "CONTACT_LIMIT");
  const removed = await owner.inject({ method: "DELETE", url: `/api/sharing/contacts/${people[0]!.id}` });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(await h.prisma.share.count({ where: { recipientId: people[0]!.id, spaceId: owner.id } }), 0);
  const retry = await owner.inject({ method: "POST", url: "/api/sharing/contacts", payload: { personId: people[5]!.id } });
  assert.equal(retry.statusCode, 201, retry.body);
});

test("concurrent contact and public-link allocations respect account limits", async () => {
  const owner = await h.asUser();
  const people = await Promise.all(Array.from({ length: 6 }, () => h.asUser()));
  const attempts = await Promise.all(people.map(person => owner.inject({ method: "POST", url: "/api/sharing/contacts", payload: { personId: person.id } })));
  assert.equal(attempts.filter(row => row.statusCode === 201).length, 5, attempts.map(row => row.body).join("\n"));
  assert.equal(attempts.filter(row => row.statusCode === 409).length, 1);
  const ids = []; for (let i = 0; i < 4; i++) ids.push(await page(owner));
  const links = await Promise.all(ids.map(resourceId => owner.inject({ method: "POST", url: "/api/links", payload: { kind: "page", resourceId, role: "edit" } })));
  assert.equal(links.filter(row => row.statusCode === 201).length, 3, links.map(row => row.body).join("\n"));
  assert.equal(links.filter(row => row.json().code === "PUBLIC_LINK_LIMIT").length, 1);
});

test("deletion removes accounts and permits the same email; minimal log is overwritten", async () => {
  const first = await h.asUser();
  const key = privateIdentifier("account-deletion-log", first.email);
  const removed = await first.inject({ method: "DELETE", url: "/api/auth/account", payload: { confirmation: "DELETE" } });
  assert.equal(removed.statusCode, 204, removed.body);
  assert.equal(await h.prisma.user.findUnique({ where: { id: first.id } }), null);
  const logged = await h.prisma.accountDeletionLog.findUniqueOrThrow({ where: { emailKey: key } });
  assert.deepEqual(Object.keys(logged).sort(), ["deletedAt", "emailKey", "expiresAt"]);
  assert.equal(logged.expiresAt.getTime() - logged.deletedAt.getTime(), 90 * 86_400_000);
  const fresh = await h.asUser(first.email);
  assert.notEqual(fresh.id, first.id);
  await deleteAccountData(h.prisma, fresh.id);
  assert.equal(await h.prisma.accountDeletionLog.count({ where: { emailKey: key } }), 1);
  assert.ok((await h.prisma.accountDeletionLog.findUniqueOrThrow({ where: { emailKey: key } })).deletedAt >= logged.deletedAt);
});


test("active work blocks deletion before any owned space is erased", async () => {
  const owner = await h.asUser();
  const space = await h.prisma.user.create({ data: { ownerId: owner.id, email: `${owner.id}@spaces.ensemble.invalid` } });
  const note = await h.prisma.taskPage.create({ data: { userId: space.id, title: "Preserve this draft" } });
  const task = await h.prisma.task.create({ data: { userId: owner.id, title: "Active work" } });
  const job = await h.prisma.workspaceJob.create({ data: { userId: owner.id, taskId: task.id, executionMode: "local", model: "fixture", status: "running" } });
  try {
    await assert.rejects(() => deleteAccountData(h.prisma, owner.id), /Stop your active/);
    assert.ok(await h.prisma.taskPage.findUnique({ where: { id: note.id } }));
    assert.equal(await h.prisma.accountDeletionLog.count({ where: { emailKey: privateIdentifier("account-deletion-log", owner.email) } }), 0);
  } finally { await h.prisma.workspaceJob.update({ where: { id: job.id }, data: { status: "cancelled" } }); }
});


test("the floating assistant sees the selected meeting and cannot resolve another account's note", async () => {
  const owner = await h.asUser(), other = await h.asUser();
  const { loadOpenPage } = await import("../assistant/state.js");
  const note = await h.prisma.meetingSession.create({ data: { userId: owner.id, title: "Design review", notes: "Decision: test the smaller layout." } });
  const page = { path: "/meetings", meetingId: note.id };
  const own = await loadOpenPage(h.prisma, owner.id, page, "UTC", "2026-10-17", "Saturday");
  assert.equal(own?.open?.id, note.id);
  assert.match(own?.open?.excerpt ?? "", /smaller layout/);
  assert.equal((await loadOpenPage(h.prisma, other.id, page, "UTC", "2026-10-17", "Saturday"))?.open, undefined);
  await h.prisma.meetingSession.update({ where: { id: note.id }, data: { deletedAt: new Date() } });
  assert.equal((await loadOpenPage(h.prisma, owner.id, page, "UTC", "2026-10-17", "Saturday"))?.open, undefined);
});
