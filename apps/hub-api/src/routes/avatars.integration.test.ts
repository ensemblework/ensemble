import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { isAvatarId } from "@ensemble/shared-types";
import { createHttpHarness } from "../test/http.js";

const harness = await createHttpHarness();
after(() => harness.close());

test("account avatar updates persist all choices and stay scoped to the signed-in person", async () => {
  const me = await harness.asUser();
  const other = await harness.asUser();
  const { createSpaceUser } = await import("../spaces/store.js");
  const space = await createSpaceUser(harness.prisma as never, me.id, { name: "Research", icon: null });
  for (const avatar of ["dots.9.blue.grove", "dots.3.apricot.none", "dots.12.moss.valley"]) {
    const reply = await me.inject({ method: "PATCH", url: "/api/auth/me", payload: { avatar } });
    assert.equal(reply.statusCode, 200, reply.body);
    assert.equal(reply.json().user.avatar, avatar);
    assert.equal((await me.inject({ method: "GET", url: "/api/auth/me" })).json().user.avatar, avatar);
    assert.equal((await harness.prisma.user.findUniqueOrThrow({ where: { id: space } })).avatar, avatar);
    assert.equal((await harness.prisma.user.findUniqueOrThrow({ where: { id: other.id } })).avatar, null);
  }
  for (const avatar of ["dots.13.blue.grove", "dots.9.blue.unknown", "dots.9.unknown.hills", "dots.9.blue.grove.extra"]) assert.equal((await me.inject({ method: "PATCH", url: "/api/auth/me", payload: { avatar } })).statusCode, 400);
  assert.equal((await me.inject({ method: "PATCH", url: "/api/auth/me", payload: { avatar: null } })).statusCode, 200);
  assert.equal((await harness.prisma.user.findUniqueOrThrow({ where: { id: me.id } })).avatar, null);
});

test("the migration replaces every existing portrait or initial selection and mirrors owned spaces", async () => {
  const first = await harness.asUser();
  const second = await harness.asUser();
  const chosen = await harness.asUser();
  await harness.prisma.user.update({ where: { id: first.id }, data: { avatar: "engineer.m.3", profession: "Engineer", gender: "Man" } });
  await harness.prisma.user.update({ where: { id: second.id }, data: { avatar: null, profession: "Student", gender: "Woman" } });
  await harness.prisma.user.update({ where: { id: chosen.id }, data: { avatar: "dots.11.teal.garden" } });
  const { createSpaceUser } = await import("../spaces/store.js");
  const space = await createSpaceUser(harness.prisma as never, first.id, { name: "Studio", icon: null });
  const sql = await readFile(new URL("../../prisma/migrations/20261112190000_pixel_avatars/migration.sql", import.meta.url), "utf8");
  for (const statement of sql.split(";").map(part => part.trim()).filter(Boolean)) await harness.prisma.$executeRawUnsafe(statement);
  const rows = await harness.prisma.user.findMany({ where: { id: { in: [first.id, second.id, chosen.id, space] } } });
  const value = (id: string) => rows.find(row => row.id === id)!;
  assert.ok(isAvatarId(value(first.id).avatar));
  assert.match(value(first.id).avatar!, /^dots\./);
  assert.match(value(second.id).avatar!, /^dots\./);
  assert.notEqual(value(first.id).avatar, value(second.id).avatar);
  assert.equal(value(space).avatar, value(first.id).avatar);
  assert.equal(value(chosen.id).avatar, "dots.11.teal.garden");
  assert.equal(value(first.id).profession, "Engineer");
  assert.equal(value(second.id).gender, "Woman");
  assert.equal(await harness.prisma.user.count({ where: { avatar: { not: { startsWith: "dots." } } } }), 0);
});
