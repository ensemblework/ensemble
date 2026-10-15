/**
 * Adding people by hand (POST /api/people): an address must be valid, and adding someone
 * who is already there says so instead of making a second copy. Also what the Context
 * Artifacts tile reads about a file from GET /api/desk/live. Fictional data: Mira Chen at Fieldnote.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHttpHarness } from "../test/http.js";

const harness = await createHttpHarness();
const db = harness.prisma;
after(() => harness.close());

async function add(user: Awaited<ReturnType<typeof harness.asUser>>, payload: Record<string, unknown>) {
  const response = await user.inject({ method: "POST", url: "/api/people", payload });
  return { status: response.statusCode, body: response.json() as { person?: { id: string; name: string; email: string | null; upn: string | null }; error?: string; code?: string } };
}

test("an invalid email is refused", async () => {
  const mira = await harness.asUser();
  const bad = await add(mira, { name: "Arjun Rao", email: "arjun@" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error ?? "", /email/i);
  assert.equal(await db.person.count({ where: { userId: mira.id } }), 0);
});

test("the same email, in any case, finds the person already there", async () => {
  const mira = await harness.asUser();
  const first = await add(mira, { name: "Arjun Rao", email: "Arjun.Rao@fieldnote.example" });
  assert.equal(first.status, 201);
  assert.equal(first.body.person?.upn, "arjun.rao@fieldnote.example");

  const again = await add(mira, { name: "A. Rao", email: " arjun.rao@FIELDNOTE.example " });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "person_exists");
  assert.deepEqual(again.body.person, { id: first.body.person!.id, name: "Arjun Rao", email: "Arjun.Rao@fieldnote.example" });
  assert.equal(again.body.error, "Arjun Rao is already in your people.");
  assert.equal(await db.person.count({ where: { userId: mira.id, deletedAt: null } }), 1);
});

test("an address recorded for someone counts as theirs", async () => {
  const mira = await harness.asUser();
  const first = await add(mira, { name: "Lena Ortiz", email: "lena@fieldnote.example" });
  await db.personIdentity.create({ data: { userId: mira.id, personId: first.body.person!.id, kind: "email", value: "lena.ortiz@studio.example" } });
  const again = await add(mira, { name: "Lena", email: "Lena.Ortiz@studio.example" });
  assert.equal(again.status, 409);
  assert.equal(again.body.person?.id, first.body.person!.id);
});

test("without an email, the same name is the same person; other people's lists do not count", async () => {
  const mira = await harness.asUser();
  const other = await harness.asUser();
  assert.equal((await add(mira, { name: "Priya Shah" })).status, 201);
  const again = await add(mira, { name: "  priya shah " });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "person_exists");
  assert.equal((await add(other, { name: "Priya Shah" })).status, 201, "another account has its own people");
  assert.equal((await add(mira, { name: "Priya Shah", email: "priya.s@client.example" })).status, 201, "a different address is someone else");
});

test("someone removed can be added again with the same address", async () => {
  const mira = await harness.asUser();
  const first = await add(mira, { name: "Tomás Reyes", email: "tomas@fieldnote.example" });
  assert.equal((await mira.inject({ method: "DELETE", url: `/api/people/${first.body.person!.id}` })).statusCode, 204);
  const again = await add(mira, { name: "Tomás Reyes", email: "tomas@fieldnote.example" });
  assert.equal(again.status, 201);
  assert.notEqual(again.body.person?.id, first.body.person!.id);
});

test("desk live says what a file is and where it came from", async () => {
  const mira = await harness.asUser();
  const ts = new Date();
  await db.artifact.createMany({
    data: [
      { userId: mira.id, kind: "file", externalId: "file:fictional-upload", title: "Site survey", ts, metadata: { documentId: "fictional-upload", format: "pdf", byteSize: 10 } },
      { userId: mira.id, kind: "file", externalId: "drive:fictional-doc", title: "Q3 plan", ts, metadata: { via: "app-item", source: "google_workspace", itemKind: "file", itemId: "fictional-doc", facts: { Type: "Google Doc" } } },
    ],
  });
  const response = await mira.inject({ method: "GET", url: "/api/desk/live" });
  assert.equal(response.statusCode, 200);
  const rows = (response.json() as { artifacts: Array<{ title: string; source: string; format: string | null; fileType: string | null }> }).artifacts;
  const upload = rows.find((row) => row.title === "Site survey");
  const doc = rows.find((row) => row.title === "Q3 plan");
  assert.deepEqual({ source: upload?.source, format: upload?.format, fileType: upload?.fileType }, { source: "Your files", format: "pdf", fileType: null });
  assert.deepEqual({ source: doc?.source, format: doc?.format, fileType: doc?.fileType }, { source: "Google Drive", format: null, fileType: "Google Doc" });
});
