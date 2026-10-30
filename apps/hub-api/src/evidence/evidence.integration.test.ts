/**
 * Evidence on the web (evidence/routes.ts): a paired computer uploads what its run's worker attached,
 * with the job's lease; the server checks it again (size by kind, the type from the bytes, credential
 * names), redacts text and lists it on the run's card; only the account whose computer ran the job
 * reads it, images inline, active formats (SVG, HTML) never run. A computer with evidence upload off
 * sends only the name. The worker's report arrives with complete. In-memory database; the blob store
 * case uses an in-memory store.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test, { after } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { createHttpHarness, type HttpUser } from "../test/http.js";

const h = await createHttpHarness();
const { setBlobStoreForTests } = await import("../lib/blob-store.js");
const { sweepOrphanEvidence } = await import("./store.js");
after(() => h.close());

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ffff3f0005fe02fea7d6a4a40000000049454e44ae426082", "hex");
const json = (response: LightMyRequestResponse) => response.json() as any;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A paired computer running one job of Mira's from her node, with its run card in the node's DM. */
async function runningJob(user?: HttpUser) {
  const mira = user ?? (await h.asUser());
  await h.prisma.user.update({ where: { id: mira.id }, data: { emailVerifiedAt: new Date() } });
  const key = await h.asToken(mira, "device");
  const device = await h.prisma.device.create({ data: { userId: mira.id, name: "Studio Mac", platform: "macos", tokenId: key.id, lastSeenAt: new Date(), capabilities: { evidenceUpload: true } } });
  const created = await mira.inject({ method: "POST", url: "/api/node/nodes", payload: { templateId: "assistant" } });
  assert.equal(created.statusCode, 201, created.body);
  const { node, room } = json(created) as { node: { id: string }; room: { id: string } };
  const task = await h.prisma.task.create({ data: { userId: mira.id, title: "Fix the export" } });
  const leaseToken = randomBytes(24).toString("base64url");
  const job = await h.prisma.workspaceJob.create({
    data: { userId: mira.id, taskId: task.id, executionMode: "sandbox", model: "default", status: "running", deviceId: device.id, leaseOwner: device.id, leaseToken, leaseUntil: new Date(Date.now() + 120_000), startedAt: new Date() },
  });
  const { postMessage } = await import("../node/store.js");
  const { message } = await postMessage(h.prisma, { roomId: room.id, userId: mira.id, authorKind: "node", authorNodeId: node.id, kind: "run", body: "Fix the export", data: { jobId: job.id, status: "running", direct: true } });
  await h.prisma.nodeRun.create({ data: { userId: mira.id, nodeId: node.id, roomId: room.id, messageId: message.id, jobId: job.id, taskId: task.id, status: "running", direct: true } });
  const upload = (meta: Record<string, unknown>, bytes: Buffer, options: { lease?: string | null; as?: { inject: HttpUser["inject"] } } = {}) =>
    (options.as ?? key).inject({
      method: "POST",
      url: `/api/devices/self/jobs/${job.id}/evidence`,
      headers: {
        "content-type": "application/octet-stream",
        ...(options.lease === null ? {} : { "x-ensemble-job-lease": options.lease ?? leaseToken }),
        "x-ensemble-evidence": Buffer.from(JSON.stringify(meta)).toString("base64url"),
      },
      payload: bytes,
    });
  const meta = (bytes: Buffer, extra: Record<string, unknown> = {}) => ({ id: randomUUID(), kind: "screenshot", name: "export.png", size: bytes.length, sha256: sha(bytes), ...extra });
  const card = async () => ((await h.prisma.nodeMessage.findUniqueOrThrow({ where: { id: message.id } })).data as { evidence?: Array<Record<string, unknown>> }).evidence ?? [];
  return { mira, key, device, job, leaseToken, upload, meta, card };
}

test("a computer uploads a run's evidence with its lease; the server checks it again; only the owner reads it, safely", async () => {
  const { mira, key, job, leaseToken, upload, meta, card } = await runningJob();

  // A screenshot: stored, on the card, readable by its owner inline.
  const shot = meta(PNG, { caption: "The export dialog", requirementId: "r1" });
  const stored = await upload(shot, PNG);
  assert.equal(stored.statusCode, 201, stored.body);
  assert.equal(json(stored).evidence.mime, "image/png");
  assert.deepEqual((await card()).map((row) => [row.id, row.name, row.kind, row.caption, row.requirementId]), [[shot.id, "export.png", "screenshot", "The export dialog", "r1"]]);
  const list = await mira.inject({ method: "GET", url: `/api/node/evidence?jobId=${job.id}` });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(json(list).evidence.length, 1);
  const bytes = await mira.inject({ method: "GET", url: `/api/node/evidence/${shot.id}` });
  assert.equal(bytes.statusCode, 200);
  assert.deepEqual(bytes.rawPayload, PNG);
  assert.equal(bytes.headers["content-type"], "image/png");
  assert.equal(bytes.headers["x-content-type-options"], "nosniff");
  assert.match(String(bytes.headers["content-security-policy"]), /sandbox/);
  assert.match(String(bytes.headers["content-disposition"]), /^inline/);
  const part = await mira.inject({ method: "GET", url: `/api/node/evidence/${shot.id}`, headers: { range: "bytes=0-7" } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.rawPayload.length, 8);

  // The same file again (a retried upload) is the same row.
  assert.equal((await upload(shot, PNG)).statusCode, 200);
  assert.equal(await h.prisma.jobEvidence.count({ where: { jobId: job.id } }), 1);

  // The lease: missing, or not this run's.
  assert.equal((await upload(meta(PNG), PNG, { lease: null })).statusCode, 400);
  assert.equal((await upload(meta(PNG), PNG, { lease: "not-the-lease" })).statusCode, 409);
  // Only the paired computer: not the person's own key, not their browser, not another computer.
  const full = await h.asToken(mira, "full");
  assert.equal((await upload(meta(PNG), PNG, { as: full })).statusCode, 403);
  assert.equal((await upload(meta(PNG), PNG, { as: mira })).statusCode, 403);
  const other = await runningJob();
  assert.equal((await upload(meta(PNG), PNG, { as: other.key })).statusCode, 404, "another person's computer does not hold this job");
  void key;

  // What the description says must be what arrives, within the kind's limit.
  assert.equal((await upload(meta(PNG, { size: PNG.length + 1 }), PNG)).statusCode, 400);
  assert.equal((await upload(meta(PNG, { sha256: sha(Buffer.from("other")) }), PNG)).statusCode, 400);
  const big = Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024 + 1 - PNG.length)]);
  assert.equal((await upload(meta(big), big)).statusCode, 413);
  const text = Buffer.from("just words\n");
  const notImage = await upload(meta(text, { name: "shot.png" }), text);
  assert.equal(notImage.statusCode, 415, "a screenshot must be an image, whatever its name");
  assert.equal((await upload(meta(text, { kind: "file", name: ".env.production" }), text)).statusCode, 422);

  // Text is redacted before it is kept.
  const log = Buffer.from("deploying with ghp_abcdefghijklmnopqrstuvwxyz0123\nAPI_KEY=supersecretvalue123\nall green\n");
  const logMeta = meta(log, { kind: "log", name: "deploy.log" });
  assert.equal((await upload(logMeta, log)).statusCode, 201);
  const kept = (await mira.inject({ method: "GET", url: `/api/node/evidence/${logMeta.id}` })).body;
  assert.doesNotMatch(kept, /ghp_abcdefghijklmnopqrstuvwxyz0123|supersecretvalue123/);
  assert.match(kept, /all green/);

  // An SVG or HTML file never runs: a download, or a sandbox that allows nothing.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/node/nodes")</script></svg>');
  const svgMeta = meta(svg, { kind: "image", name: "chart.svg" });
  assert.equal((await upload(svgMeta, svg)).statusCode, 201);
  const svgRead = await mira.inject({ method: "GET", url: `/api/node/evidence/${svgMeta.id}` });
  assert.match(String(svgRead.headers["content-disposition"]), /^attachment/);
  assert.match(String(svgRead.headers["content-security-policy"]), /default-src 'none'.*sandbox/);
  const html = Buffer.from("<!doctype html><script>alert(document.cookie)</script><p>report</p>");
  const htmlMeta = meta(html, { kind: "report", name: "report.html" });
  assert.equal((await upload(htmlMeta, html)).statusCode, 201);
  const htmlRead = await mira.inject({ method: "GET", url: `/api/node/evidence/${htmlMeta.id}` });
  assert.match(String(htmlRead.headers["content-type"]), /^text\/html/);
  assert.match(String(htmlRead.headers["content-disposition"]), /^attachment/);
  const viewed = await mira.inject({ method: "GET", url: `/api/node/evidence/${htmlMeta.id}?view=1` });
  assert.match(String(viewed.headers["content-disposition"]), /^inline/);
  assert.match(String(viewed.headers["content-security-policy"]), /sandbox/);
  assert.doesNotMatch(String(viewed.headers["content-security-policy"]), /allow-scripts/);

  // Only the owner reads it.
  const tom = await h.asUser();
  assert.equal((await tom.inject({ method: "GET", url: `/api/node/evidence/${shot.id}` })).statusCode, 404);
  assert.deepEqual(json(await tom.inject({ method: "GET", url: `/api/node/evidence?jobId=${job.id}` })).evidence, []);

  // Upload off on that computer: the name and size only, shown as on the computer.
  const local = meta(PNG, { name: "local.png", local: true, mime: "image/png" });
  const localStored = await upload(local, Buffer.alloc(0));
  assert.equal(localStored.statusCode, 201, localStored.body);
  assert.equal(json(localStored).evidence.local, true);
  assert.equal((await card()).find((row) => row.id === local.id)?.local, true);
  const localRead = await mira.inject({ method: "GET", url: `/api/node/evidence/${local.id}` });
  assert.equal(localRead.statusCode, 409);
  assert.match(json(localRead).error, /not uploaded/);

  // The worker's report comes with complete and is kept on the job; a malformed one is not.
  const report = { outcome: "pass", summary: "Export works.", checks: [{ id: "r1-a1", name: "CSV export", verdict: "pass", evidence: [shot.id] }] };
  const done = await key.inject({ method: "POST", url: `/api/devices/self/jobs/${job.id}/complete`, payload: { leaseToken, outcome: "succeeded", summary: "Done.", report } });
  assert.equal(done.statusCode, 200, done.body);
  assert.deepEqual((await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: job.id } })).report, report);
  assert.equal((await upload(meta(PNG), PNG)).statusCode, 409, "after complete the lease is gone");
  const second = await runningJob();
  const malformed = await second.key.inject({ method: "POST", url: `/api/devices/self/jobs/${second.job.id}/complete`, payload: { leaseToken: second.leaseToken, outcome: "succeeded", summary: "Done.", report: { outcome: "great" } } });
  assert.equal(malformed.statusCode, 200);
  assert.equal((await h.prisma.workspaceJob.findUniqueOrThrow({ where: { id: second.job.id } })).report, null);
});

test("with the blob store on, the bytes go there, are read from there, and the sweep removes what no row needs", async () => {
  const blobs = new Map<string, { bytes: Buffer; modifiedAt: Date }>();
  setBlobStoreForTests({
    async put(key, bytes) {
      blobs.set(key, { bytes: Buffer.from(bytes), modifiedAt: new Date() });
    },
    async get(key) {
      return blobs.get(key)?.bytes ?? null;
    },
    async delete(key) {
      blobs.delete(key);
    },
    async *list(prefix) {
      for (const [key, blob] of [...blobs]) if (key.startsWith(prefix)) yield { key, modifiedAt: blob.modifiedAt };
    },
  });
  try {
    const { mira, job, upload, meta } = await runningJob();
    const shot = meta(PNG);
    assert.equal((await upload(shot, PNG)).statusCode, 201);
    const row = await h.prisma.jobEvidence.findUniqueOrThrow({ where: { id: shot.id } });
    assert.equal(row.bytes, null, "not on the row");
    assert.ok(blobs.has(row.storageKey), "in the store");
    assert.deepEqual((await mira.inject({ method: "GET", url: `/api/node/evidence/${shot.id}` })).rawPayload, PNG);
    assert.equal(await sweepOrphanEvidence(h.prisma, { now: Date.now() + 2 * 3_600_000 }), 0, "a blob its row needs stays");
    await h.prisma.workspaceJob.delete({ where: { id: job.id } });
    assert.equal(await h.prisma.jobEvidence.count({ where: { id: shot.id } }), 0, "the row goes with its run");
    assert.equal(await sweepOrphanEvidence(h.prisma, { now: Date.now() + 2 * 3_600_000 }), 1);
    assert.equal(blobs.size, 0);
  } finally {
    setBlobStoreForTests(undefined);
  }
});
