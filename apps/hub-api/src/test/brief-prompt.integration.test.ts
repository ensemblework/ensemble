import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { createHttpHarness } from "./http.js";
const h = await createHttpHarness();
after(() => h.close());
const { BRIEF_PROMPT_KEY } = await import("../cowork/brief-prompt.js");
async function ready() {
  const user = await h.asUser();
  await h.prisma.user.update({ where: { id: user.id }, data: { createdAt: new Date(Date.now() - 3 * 86_400_000) } });
  await h.prisma.notification.create({ data: { userId: user.id, kind: "morning_brief", title: "Your first brief" } });
  return user;
}
const open = (user: Awaited<ReturnType<typeof ready>>) => user.inject({ method: "POST", url: "/api/brief/prompt", payload: { action: "show" } });

test("first morning offer is claimed once across reloads, simultaneous tabs and spaces", async () => {
  const user = await ready(), other = await ready();
  assert.equal((await user.inject({ method: "GET", url: "/api/brief/skill" })).json().customize, true);
  const attempts = await Promise.all([open(user), open(user), open(user)]);
  assert.ok(attempts.every(row => row.statusCode === 200));
  assert.equal(attempts.filter(row => row.json().show).length, 1);
  for (let i = 0; i < 3; i++) {
    assert.equal((await open(user)).json().show, false);
    assert.equal((await user.inject({ method: "GET", url: "/api/brief/skill" })).json().customize, false);
  }
  const space = await h.prisma.user.create({ data: { ownerId: user.id, email: `space-${user.id}@example.test`, name: "Fieldnote", spaceName: "Work" } });
  assert.equal((await h.app.inject({ method: "POST", url: "/api/brief/prompt", headers: { cookie: `${user.cookie}; ensemble_space=${space.id}` }, payload: { action: "show" } })).json().show, false);
  assert.equal((await open(other)).json().show, true);
});

test("close, save or an interrupted first offer never makes the prompt eligible again", async () => {
  for (const action of ["dismiss", "save"] as const) {
    const user = await ready();
    const result = action === "dismiss"
      ? await user.inject({ method: "POST", url: "/api/brief/prompt", payload: { action } })
      : await user.inject({ method: "PATCH", url: "/api/brief/skill", payload: { instructions: "Keep it brief and focus on my deadlines." } });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal((await open(user)).json().show, false);
    await h.prisma.notification.create({ data: { userId: user.id, kind: "morning_brief", title: "A later brief" } });
    assert.equal((await user.inject({ method: "GET", url: "/api/brief/skill" })).json().customize, false);
  }
});

test("no offer at signup or before a first delivered brief; bad requests do not consume it", async () => {
  const user = await h.asUser();
  assert.equal((await open(user)).json().show, false);
  await h.prisma.notification.create({ data: { userId: user.id, kind: "morning_brief", title: "Fixture" } });
  assert.equal((await open(user)).json().show, false);
  await h.prisma.user.update({ where: { id: user.id }, data: { createdAt: new Date(Date.now() - 3 * 86_400_000) } });
  assert.equal((await user.inject({ method: "POST", url: "/api/brief/prompt", payload: { action: "reset" } })).statusCode, 400);
  assert.equal((await open(user)).json().show, true);
});

test("upgrade retires introductions for accounts that already received a brief", async () => {
  const legacy = await ready(), fresh = await h.asUser();
  const sql = await readFile(new URL("../../prisma/migrations/20261017110000_morning_brief_once/migration.sql", import.meta.url), "utf8");
  await h.prisma.$executeRawUnsafe(sql);
  assert.ok(await h.prisma.preference.findUnique({ where: { userId_key: { userId: legacy.id, key: BRIEF_PROMPT_KEY } } }));
  assert.equal((await open(legacy)).json().show, false);
  assert.equal(await h.prisma.preference.count({ where: { userId: fresh.id, key: BRIEF_PROMPT_KEY } }), 0);
});
