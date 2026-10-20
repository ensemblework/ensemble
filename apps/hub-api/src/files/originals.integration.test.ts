/**
 * Files kept in blob storage (ENSEMBLE_FILE_STORAGE=azure-blob), against an in-memory store:
 * uploads leave only a key on the row, every read path gets the bytes back, replacing writes a
 * new blob, the sweep removes only blobs no row uses, an unreachable store answers 503, and files
 * kept on the row before still read. Runs on the in-memory database. Fictional data: Fieldnote.
 */
import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import type { FileRecord } from "@ensemble/shared-types";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../test/http.js";
import { fileStorageProblem, setBlobStoreForTests, type BlobStore } from "../lib/blob-store.js";
import { sweepOrphanOriginals } from "./originals.js";

const harness: HttpHarness = await createHttpHarness();
const db = harness.prisma;
const { fileTextSettled } = await import("./extract.js");

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, { bytes: Buffer; mediaType: string; modifiedAt: Date }>();
  failing = false;
  async put(key: string, bytes: Uint8Array, mediaType: string) {
    if (this.failing) throw new Error("connection refused");
    this.blobs.set(key, { bytes: Buffer.from(bytes), mediaType, modifiedAt: new Date() });
  }
  async get(key: string) {
    if (this.failing) throw new Error("connection refused");
    return this.blobs.get(key)?.bytes ?? null;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
  async *list(prefix: string) {
    for (const [key, blob] of this.blobs) if (key.startsWith(prefix)) yield { key, modifiedAt: blob.modifiedAt };
  }
}

let store = new MemoryStore();
beforeEach(() => {
  store = new MemoryStore();
  setBlobStoreForTests(store);
});
after(async () => {
  setBlobStoreForTests(undefined);
  await harness.close();
});

async function person(): Promise<HttpUser> {
  const user = await harness.asUser();
  await db.user.update({ where: { id: user.id }, data: { name: "Mira Chen", onboardingRole: "student", onboardingCompletedAt: new Date(), emailVerifiedAt: new Date() } });
  return user;
}

async function upload(user: HttpUser, filename: string, body: string): Promise<FileRecord> {
  const res = await user.inject({ method: "POST", url: "/api/documents", payload: { filename, mediaType: "text/plain", dataBase64: Buffer.from(body).toString("base64"), summarize: false } });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as { file: FileRecord }).file;
}

test("an upload keeps only a blob key on the row, and the original, text and page come from the blob", async () => {
  const user = await person();
  const file = await upload(user, "field-notes.md", "# Field notes\n\nCalibrate the sensor first.");
  const row = await db.document.findUniqueOrThrow({ where: { id: file.id }, select: { original: true, blobKey: true, sha256: true } });
  assert.equal(row.original, null);
  assert.equal(row.blobKey, `documents/${user.id}/${file.id}/${row.sha256}`);
  assert.equal(store.blobs.get(row.blobKey!)?.mediaType, "text/markdown");

  const original = await user.inject({ method: "GET", url: `/api/documents/${file.id}/original` });
  assert.equal(original.statusCode, 200, original.body);
  assert.equal(original.body, "# Field notes\n\nCalibrate the sensor first.");
  const ranged = await user.inject({ method: "GET", url: `/api/documents/${file.id}/original`, headers: { range: "bytes=2-6" } });
  assert.equal(ranged.statusCode, 206);
  assert.equal(ranged.body, "Field");

  await fileTextSettled(file.id);
  const text = await user.inject({ method: "GET", url: `/api/documents/${file.id}/text` });
  assert.match(text.body, /Calibrate the sensor first/);

  const page = await user.inject({ method: "POST", url: `/api/documents/${file.id}/page`, payload: {} });
  assert.equal(page.statusCode, 201, page.body);
});

test("replacing writes a new blob; the sweep removes the old one once it is old, and never one a row uses", async () => {
  const user = await person();
  const file = await upload(user, "readings.csv", "site,reading\nnorth,12\n");
  const first = (await db.document.findUniqueOrThrow({ where: { id: file.id }, select: { blobKey: true } })).blobKey!;
  const replaced = await user.inject({ method: "PUT", url: `/api/documents/${file.id}/content`, payload: { dataBase64: Buffer.from("site,reading\nnorth,15\n").toString("base64") } });
  assert.equal(replaced.statusCode, 200, replaced.body);
  const second = (await db.document.findUniqueOrThrow({ where: { id: file.id }, select: { blobKey: true, original: true } }));
  assert.notEqual(second.blobKey, first);
  assert.equal(second.original, null);
  assert.ok(store.blobs.has(first), "the replaced version waits for the sweep");

  assert.equal(await sweepOrphanOriginals(db, {}), 0, "nothing is swept inside the first hour");
  const later = Date.now() + 2 * 60 * 60_000;
  assert.equal(await sweepOrphanOriginals(db, { now: later }), 1);
  assert.deepEqual([...store.blobs.keys()], [second.blobKey]);

  const read = await user.inject({ method: "GET", url: `/api/documents/${file.id}/original` });
  assert.equal(read.body, "site,reading\nnorth,15\n");
});

test("a blob whose file is purged is swept, and a removed file keeps its blob until then", async () => {
  const user = await person();
  const file = await upload(user, "draft.txt", "Fieldnote draft");
  const key = (await db.document.findUniqueOrThrow({ where: { id: file.id }, select: { blobKey: true } })).blobKey!;
  const removed = await user.inject({ method: "DELETE", url: `/api/documents/${file.id}` });
  assert.ok(removed.statusCode === 200 || removed.statusCode === 204, removed.body);
  const later = Date.now() + 2 * 60 * 60_000;
  assert.equal(await sweepOrphanOriginals(db, { now: later }), 0, "a removed file can still be restored");
  assert.ok(store.blobs.has(key));
  await db.document.delete({ where: { id: file.id } });
  assert.equal(await sweepOrphanOriginals(db, { now: later }), 1);
  assert.equal(store.blobs.size, 0);
});

test("unreachable storage refuses the upload with 503 and saves no row", async () => {
  const user = await person();
  store.failing = true;
  const res = await user.inject({ method: "POST", url: "/api/documents", payload: { filename: "notes.txt", mediaType: "text/plain", dataBase64: Buffer.from("hello").toString("base64"), summarize: false } });
  assert.equal(res.statusCode, 503, res.body);
  assert.match(res.body, /File storage is not reachable/);
  assert.equal(await db.document.count({ where: { userId: user.id } }), 0);
});

test("files kept on the row before blob storage was turned on still read", async () => {
  const user = await person();
  setBlobStoreForTests(null);
  const file = await upload(user, "before.txt", "Kept on the row");
  const row = await db.document.findUniqueOrThrow({ where: { id: file.id }, select: { original: true, blobKey: true } });
  assert.equal(row.blobKey, null);
  assert.equal(Buffer.from(row.original!).toString(), "Kept on the row");
  setBlobStoreForTests(store);
  const read = await user.inject({ method: "GET", url: `/api/documents/${file.id}/original` });
  assert.equal(read.body, "Kept on the row");
});

test("a row must keep its bytes or a blob key", async () => {
  const user = await person();
  await assert.rejects(
    db.$executeRawUnsafe(
      `INSERT INTO context_documents (id, user_id, filename, media_type, byte_size, sha256, original, blob_key, format, updated_at) VALUES ('00000000-0000-4000-8000-000000000001', $1, 'x.txt', 'text/plain', 1, 'x', NULL, NULL, 'txt', NOW())`,
      user.id,
    ),
  );
});

test("the storage settings are checked", () => {
  assert.equal(fileStorageProblem({}), null);
  assert.equal(fileStorageProblem({ ENSEMBLE_FILE_STORAGE: "database" }), null);
  assert.match(fileStorageProblem({ ENSEMBLE_FILE_STORAGE: "s3" }) ?? "", /must be database or azure-blob/);
  assert.match(fileStorageProblem({ ENSEMBLE_FILE_STORAGE: "azure-blob" }) ?? "", /AZURE_STORAGE_CONNECTION_STRING/);
  assert.equal(fileStorageProblem({ ENSEMBLE_FILE_STORAGE: "azure-blob", AZURE_STORAGE_CONNECTION_STRING: "DefaultEndpointsProtocol=https;AccountName=a;AccountKey=b" }), null);
});
