import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createHttpHarness, type HttpUser } from "../test/http.js";

test("uploaded-document quotas are per-user, transactional, and retain no rejected originals", { timeout: 180_000 }, async (t) => {
  const before = { ...process.env };
  const harness = await createHttpHarness();
  t.after(async () => {
    await harness.close();
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  });
  process.env.NODE_ENV = "production";
  process.env.ENSEMBLE_DESKTOP = "0";
  process.env.ENSEMBLE_SERVER_RUNNER = "off";
  process.env.ENSEMBLE_MAX_DOCUMENT_BYTES = "5";

  const upload = (user: HttpUser, filename: string, original: Buffer, mediaType = "text/plain") => user.inject({
    method: "POST",
    url: "/api/documents",
    payload: { filename, mediaType, dataBase64: original.toString("base64"), summarize: false },
  });
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

  await t.test("an unverified OAuth session can store exactly the limit, but one extra byte leaves no original or artifact", async () => {
    const user = await harness.asUser();
    await harness.prisma.user.update({ where: { id: user.id }, data: { passwordHash: null } });
    const original = Buffer.from("hello");
    const accepted = await upload(user, "exact.txt", original);
    assert.equal(accepted.statusCode, 201, accepted.body);
    const { document } = accepted.json<{ document: { id: string; filename: string; parseStatus: string } }>();
    assert.deepEqual(Object.keys(document).sort(), ["filename", "id", "parseStatus"]);
    const download = await user.inject({ method: "GET", url: `/api/documents/${document.id}/original` });
    assert.equal(download.statusCode, 200, download.body);
    assert.deepEqual(download.rawPayload, original);

    const rejectedBytes = Buffer.from("!");
    const rejected = await upload(user, "rejected.txt", rejectedBytes);
    assert.equal(rejected.statusCode, 429, rejected.body);
    const rows = await harness.prisma.document.findMany({ where: { userId: user.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.byteSize, 5);
    assert.equal(rows[0]!.original.byteLength, 5);
    assert.equal(await harness.prisma.document.count({ where: { userId: user.id, sha256: digest(rejectedBytes) } }), 0);
    assert.equal(await harness.prisma.artifact.count({ where: { userId: user.id, kind: "file" } }), 1);
    assert.equal(await harness.prisma.auditLedger.count({ where: { userId: user.id, action: "document.upload" } }), 1);
  });

  await t.test("concurrent admissions reach the exact threshold once and reject the excess without partial storage", async () => {
    const user = await harness.asUser();
    const first = await upload(user, "first.txt", Buffer.from("ab"));
    assert.equal(first.statusCode, 201, first.body);
    const candidates = [
      { filename: "second.txt", original: Buffer.from("cde") },
      { filename: "third.txt", original: Buffer.from("fgh") },
    ];
    const responses = await Promise.all(candidates.map((candidate) => upload(user, candidate.filename, candidate.original)));
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 429]);
    const rows = await harness.prisma.document.findMany({ where: { userId: user.id } });
    assert.equal(rows.length, 2);
    assert.equal(rows.reduce((sum, row) => sum + row.byteSize, 0), 5);
    assert.equal(rows.reduce((sum, row) => sum + row.original.byteLength, 0), 5);
    const rejectedIndex = responses.findIndex((response) => response.statusCode === 429);
    assert.equal(await harness.prisma.document.count({ where: { userId: user.id, sha256: digest(candidates[rejectedIndex]!.original) } }), 0);
    assert.equal(await harness.prisma.artifact.count({ where: { userId: user.id, kind: "file" } }), 2);
  });

  await t.test("retained soft-deleted binary originals still consume quota, independently of other users", async () => {
    process.env.ENSEMBLE_MAX_DOCUMENT_BYTES = "2";
    const user = await harness.asUser();
    const other = await harness.asUser();
    const original = Buffer.from([0xfe, 0xef]);
    const accepted = await upload(user, "original.pdf", original, "application/pdf");
    assert.equal(accepted.statusCode, 201, accepted.body);
    const id = accepted.json<{ document: { id: string } }>().document.id;
    const deleted = await user.inject({ method: "DELETE", url: `/api/documents/${id}` });
    assert.equal(deleted.statusCode, 204, deleted.body);
    const retained = await harness.prisma.document.findUniqueOrThrow({ where: { id } });
    assert.notEqual(retained.deletedAt, null);
    assert.deepEqual(Buffer.from(retained.original), original);
    const rejected = await upload(user, "rejected.pdf", Buffer.from([1]), "application/pdf");
    assert.equal(rejected.statusCode, 429, rejected.body);
    assert.equal(await harness.prisma.document.count({ where: { userId: user.id } }), 1);
    const independent = await upload(other, "other.txt", Buffer.from("yz"));
    assert.equal(independent.statusCode, 201, independent.body);
    await harness.prisma.document.delete({ where: { id } });
    const freed = await upload(user, "freed.txt", Buffer.from("uv"));
    assert.equal(freed.statusCode, 201, freed.body);
  });

  await t.test("development and desktop uploads preserve uncapped storage behavior", async () => {
    process.env.ENSEMBLE_MAX_DOCUMENT_BYTES = "1";
    const user = await harness.asUser();
    process.env.NODE_ENV = "development";
    const local = await upload(user, "dev.txt", Buffer.from("larger"));
    assert.equal(local.statusCode, 201, local.body);
    process.env.NODE_ENV = "production";
    process.env.ENSEMBLE_DESKTOP = "1";
    const desktop = await upload(user, "desktop.txt", Buffer.from("different"));
    assert.equal(desktop.statusCode, 201, desktop.body);
    assert.equal((await harness.prisma.document.aggregate({ where: { userId: user.id }, _sum: { byteSize: true } }))._sum.byteSize, 15);
  });
});
