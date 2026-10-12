/**
 * Typed mentions (`@people:Mira Chen`) resolve to ids in this space only, by
 * exact name, and only when one record has that name. Fictional data: Mira
 * Chen at Fieldnote.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import type { PrismaClient } from "@prisma/client";
import { dateMention } from "@ensemble/shared-types";
import { closeDesktopDatabase, openMemoryDatabase } from "../lib/pglite-engine.js";
import { resolveTypedMentions, typedMentionTokens } from "./mentions.js";

let db: PrismaClient;
const ALL = "diagrams,plots,skills";

before(async () => {
  process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble_test";
  await openMemoryDatabase();
  const { PrismaClient } = await import("@prisma/client");
  const { desktopAdapter } = await import("../lib/desktop-db.js");
  db = new PrismaClient({ adapter: desktopAdapter()! });
  await db.user.create({ data: { id: "mira", email: "mira@fieldnote.example", name: "Mira Chen", passwordHash: "scrypt:test" } });
  await db.user.create({ data: { id: "dev", email: "dev@other.example", name: "Dev Patel", passwordHash: "scrypt:test" } });
  await db.person.create({ data: { id: "p-anika", userId: "mira", name: "Anika Rao", email: "anika@fieldnote.example" } });
  await db.person.create({ data: { id: "p-sam-1", userId: "mira", name: "Sam Lee" } });
  await db.person.create({ data: { id: "p-sam-2", userId: "mira", name: "sam lee" } });
  await db.person.create({ data: { id: "p-alerts", userId: "mira", name: "nse_alerts" } });
  await db.person.create({ data: { id: "p-gone", userId: "mira", name: "Old Contact", deletedAt: new Date() } });
  await db.project.create({ data: { id: "proj-atlas", userId: "mira", name: "Atlas launch" } });
  await db.project.create({ data: { id: "proj-other", userId: "dev", name: "Orion" } });
  await db.blockDiagram.create({ data: { id: "diagram-1", userId: "mira", title: "Transformer" } });
  await db.task.create({ data: { id: "task-dropped", userId: "mira", title: "Old idea", status: "dropped" } });
  await db.task.create({ data: { id: "task-brief", userId: "mira", title: "Write the brief", status: "todo" } });
});

after(async () => {
  await db?.$disconnect();
  await closeDesktopDatabase();
});

test("tokens carry their kind and the names they could mean, longest first", () => {
  assert.deepEqual(typedMentionTokens("Ask @people:Mira Chen, then @diagram:Transformer."), [
    { kind: "people", names: ["Mira Chen, then", "Mira Chen,", "Mira Chen", "Mira"] },
    { kind: "diagram", names: ["Transformer.", "Transformer"] },
  ]);
  assert.deepEqual(typedMentionTokens("mail mira@people:x, @nobody:y, and @person: Sam\nnext line"), [{ kind: "people", names: ["Sam"] }]);
  assert.deepEqual(typedMentionTokens("@people:Mira @project:Atlas"), [
    { kind: "people", names: ["Mira"] },
    { kind: "project", names: ["Atlas"] },
  ]);
});

test("a unique exact name resolves, ignoring case and trailing punctuation", async () => {
  const mentions = await resolveTypedMentions(db, "mira", ALL, "Ask @people:anika rao about @projects:Atlas launch. And @diagram:Transformer?");
  assert.deepEqual(mentions, [
    { kind: "people", id: "p-anika", label: "Anika Rao" },
    { kind: "project", id: "proj-atlas", label: "Atlas launch" },
    { kind: "diagram", id: "diagram-1", label: "Transformer" },
  ]);
  assert.deepEqual(await resolveTypedMentions(db, "mira", ALL, "cc @person:anika@fieldnote.example"), [
    { kind: "people", id: "p-anika", label: "Anika Rao" },
  ]);
  assert.deepEqual(await resolveTypedMentions(db, "mira", ALL, "@people:nse_alerts"), [{ kind: "people", id: "p-alerts", label: "nse_alerts" }]);
  assert.deepEqual(await resolveTypedMentions(db, "mira", ALL, "@todo:Write the brief today"), [{ kind: "task", id: "task-brief", label: "Write the brief" }]);
  assert.deepEqual(await resolveTypedMentions(db, "mira", ALL, "@date:2026-10-14 standup"), [dateMention("2026-10-14")]);
});

test("ambiguous names, partial names, other spaces, removed records and off modules stay unresolved", async () => {
  assert.deepEqual(await resolveTypedMentions(db, "mira", ALL, "Ask @people:Sam Lee"), []);
  assert.deepEqual(await resolveTypedMentions(db, "mira", ALL, "Ask @people:Ani"), []);
  assert.deepEqual(await resolveTypedMentions(db, "mira", ALL, "Ask @project:Orion"), []);
  assert.deepEqual(await resolveTypedMentions(db, "dev", ALL, "Ask @project:Atlas launch"), []);
  assert.deepEqual(await resolveTypedMentions(db, "mira", ALL, "Ask @people:Old Contact"), []);
  assert.deepEqual(await resolveTypedMentions(db, "mira", ALL, "Ask @task:Old idea"), []);
  assert.deepEqual(await resolveTypedMentions(db, "mira", "plots", "Ask @diagram:Transformer"), []);
  assert.deepEqual(await resolveTypedMentions(db, "dev", ALL, "Ask @project:Orion"), [{ kind: "project", id: "proj-other", label: "Orion" }]);
});

test("the client's mentions come first and win over a typed token with the same name", async () => {
  const sent = [{ kind: "people" as const, id: "p-sam-2", label: "sam lee" }];
  assert.deepEqual(await resolveTypedMentions(db, "mira", ALL, "Ask @people:sam lee about @project:Atlas launch", sent), [
    sent[0],
    { kind: "project", id: "proj-atlas", label: "Atlas launch" },
  ]);
  const picked = [{ kind: "people" as const, id: "p-anika", label: "Anika Rao" }];
  assert.deepEqual(await resolveTypedMentions(db, "mira", ALL, "Ask @people:Anika Rao", picked), picked);
});
