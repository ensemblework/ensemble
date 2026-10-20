/**
 * Plot datasets with the server's blob store on, against an in-memory store: a table goes to the
 * store and not to disk, a CSV's original is not kept, reads come back from the store, editing and
 * deleting reach it, files kept on disk before move into it, the sweep removes only tables no live
 * dataset uses, unreachable storage saves nothing, and uploads over 20 MB are refused.
 * Runs on the in-memory database. Fictional data: Fieldnote.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";
import { MAX_UPLOAD_BYTES } from "@ensemble/shared-types";
import { createHttpHarness, type HttpHarness, type HttpUser } from "../test/http.js";
import { setBlobStoreForTests, type BlobStore } from "../lib/blob-store.js";
import { forgetTable } from "./cache.js";
import { moveLocalDatasetsToBlob, readTable, sweepOrphanDatasets, writeTable } from "./store.js";

const harness: HttpHarness = await createHttpHarness();
const db = harness.prisma;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.ensemble/plots");

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, { bytes: Buffer; modifiedAt: Date }>();
  failing = false;
  async put(key: string, bytes: Uint8Array) {
    if (this.failing) throw new Error("connection refused");
    this.blobs.set(key, { bytes: Buffer.from(bytes), modifiedAt: new Date() });
  }
  async get(key: string) {
    if (this.failing) throw new Error("connection refused");
    return this.blobs.get(key)?.bytes ?? null;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
  async *list(prefix: string) {
    for (const [key, blob] of [...this.blobs]) if (key.startsWith(prefix)) yield { key, modifiedAt: blob.modifiedAt };
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

const csv = "site,reading\nnorth,12\nsouth,15\n";

async function upload(user: HttpUser, text = csv) {
  return user.inject({ method: "POST", url: "/api/plots/datasets", payload: { name: "Readings", filename: "readings.csv", text } });
}

test("a CSV becomes a table in the blob store only; reads, edits and deletes reach it", async () => {
  const user = await person();
  const res = await upload(user);
  assert.equal(res.statusCode, 201, res.body);
  const { id } = (res.json() as { dataset: { id: string } }).dataset;
  assert.deepEqual([...store.blobs.keys()], [`plots/${user.id}/${id}.json.gz`], "only the table: a CSV's original is not kept");
  assert.equal(existsSync(resolve(root, user.id)), false, "nothing on the server's disk");

  forgetTable(id);
  const read = await user.inject({ method: "GET", url: `/api/plots/datasets/${id}?rows=1` });
  assert.equal(read.statusCode, 200, read.body);
  assert.deepEqual((read.json() as { dataset: { rows: unknown[] } }).dataset.rows, [["north", 12], ["south", 15]]);

  const edited = await user.inject({ method: "PATCH", url: `/api/plots/datasets/${id}`, payload: { columns: [{ name: "site", type: "category" }, { name: "value", type: "number" }] } });
  assert.equal(edited.statusCode, 200, edited.body);
  forgetTable(id);
  const row = await db.plotDataset.findUniqueOrThrow({ where: { id } });
  assert.deepEqual((await readTable(user.id, id, row.contentHash)).columns.map((column) => column.name), ["site", "value"]);

  const removed = await user.inject({ method: "DELETE", url: `/api/plots/datasets/${id}` });
  assert.equal(removed.statusCode, 204, removed.body);
  assert.equal(store.blobs.size, 0);
});

test("uploads over 20 MB are refused with a clear message and save nothing", async () => {
  const user = await person();
  const big = "a,b\n" + "1,2\n".repeat(Math.ceil(MAX_UPLOAD_BYTES / 4));
  const res = await upload(user, big);
  assert.equal(res.statusCode, 413, res.body);
  assert.match(res.body, /Files for plots can be up to 20 MB/);
  assert.equal(await db.plotDataset.count({ where: { userId: user.id } }), 0);
  assert.equal(store.blobs.size, 0);
});

test("unreachable storage refuses the import and saves no dataset", async () => {
  const user = await person();
  store.failing = true;
  const res = await upload(user);
  assert.equal(res.statusCode, 503, res.body);
  assert.equal(await db.plotDataset.count({ where: { userId: user.id, deletedAt: null } }), 0);
});

test("datasets kept on disk before the blob store was on move into it and still read", async () => {
  const user = await person();
  setBlobStoreForTests(null);
  const res = await upload(user);
  assert.equal(res.statusCode, 201, res.body);
  const { id } = (res.json() as { dataset: { id: string } }).dataset;
  assert.ok(existsSync(resolve(root, user.id, `${id}.json.gz`)));

  setBlobStoreForTests(store);
  forgetTable(id);
  const before = await user.inject({ method: "GET", url: `/api/plots/datasets/${id}?rows=1` });
  assert.equal(before.statusCode, 200, "read from disk until it moves");
  assert.ok((await moveLocalDatasetsToBlob()) >= 1);
  assert.equal(existsSync(resolve(root, user.id)), false);
  assert.ok(store.blobs.has(`plots/${user.id}/${id}.json.gz`));
  forgetTable(id);
  const afterMove = await user.inject({ method: "GET", url: `/api/plots/datasets/${id}?rows=1` });
  assert.equal(afterMove.statusCode, 200, afterMove.body);
  assert.equal((afterMove.json() as { dataset: { rows: unknown[] } }).dataset.rows.length, 2);
});

test("the sweep removes tables of deleted or unsaved datasets once they are old, never a live one", async () => {
  const user = await person();
  const res = await upload(user);
  const { id } = (res.json() as { dataset: { id: string } }).dataset;
  const table = { columns: [{ name: "x", type: "number" as const }], rows: [[1]] };
  await writeTable(user.id, "00000000-0000-4000-8000-00000000abcd", table);
  const deleted = await db.plotDataset.create({ data: { userId: user.id, name: "Old", format: "csv", columns: [], rowCount: 0, byteSize: 0, contentHash: "x", deletedAt: new Date() } });
  await writeTable(user.id, deleted.id, table);
  assert.equal(await sweepOrphanDatasets(db), 0, "nothing inside the first hour");
  const later = Date.now() + 2 * 60 * 60_000;
  assert.equal(await sweepOrphanDatasets(db, { now: later }), 2);
  assert.deepEqual([...store.blobs.keys()], [`plots/${user.id}/${id}.json.gz`]);
});
