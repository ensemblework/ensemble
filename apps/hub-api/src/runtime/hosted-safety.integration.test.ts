import assert from "node:assert/strict";
import test from "node:test";
import { createHttpHarness } from "../test/http.js";

test("hosted gates preserve core data and paired execution, with durable transactional quotas", { timeout: 180_000 }, async (t) => {
  const before = { ...process.env };
  process.env.HUB_WEB_ORIGIN = "http://localhost:3000";
  const harness = await createHttpHarness();
  const { prisma, app } = harness;
  const { Assign, createJob } = await import("../workspace/assign.js");
  const { tickServerQueue } = await import("../workspace/worker.js");
  const { enrichDocument, queuedEnrichmentDocuments } = await import("../context/enrich-documents.js");
  const { saveSettings } = await import("../lib/settings.js");
  const { createCappedJob } = await import("../lib/hosted-limits.js");
  const { saveAccount, getAccount } = await import("../connectors/accounts.js");
  const { storedTableBytes, removeDatasetFiles } = await import("../plots/store.js");
  const { ingestDataset } = await import("../plots/service.js");
  const member = await harness.asUser("member@example.test");
  const unverified = await harness.asUser("unverified@example.test");
  await prisma.user.update({ where: { id: member.id }, data: { emailVerifiedAt: new Date(), passwordHash: null } });
  await prisma.user.update({ where: { id: unverified.id }, data: { passwordHash: null } });
  const datasets: string[] = [];
  t.after(async () => {
    for (const id of datasets) removeDatasetFiles(member.id, id);
    await harness.close();
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  });
  process.env.NODE_ENV = "production";
  process.env.ENSEMBLE_DESKTOP = "0";
  process.env.ENSEMBLE_SERVER_RUNNER = "off";
  process.env.ENSEMBLE_OPERATOR_EMAILS = "operator@example.test";
  process.env.ENSEMBLE_TERMINAL = "on";

  await t.test("nonoperator host routes return 403 while notes remain usable unverified", async () => {
    for (const url of ["/api/code/repos", "/api/workspace", "/api/workspace/branches?path=/tmp", "/api/terminal/status", "/api/connectors/google/start"]) {
      const response = await member.inject({ method: "GET", url });
      assert.equal(response.statusCode, 403, `${url}: ${response.body}`);
    }
    const task = await unverified.inject({ method: "POST", url: "/api/tasks", payload: { title: "Core note still works" } });
    assert.equal(task.statusCode, 201, task.body);
    const catalog = await unverified.inject({ method: "GET", url: "/api/models" });
    assert.equal(catalog.statusCode, 403, catalog.body);
    const roots = await member.inject({ method: "PATCH", url: "/api/settings", payload: { code: { roots: ["/tmp/never-probed"] } } });
    assert.equal(roots.statusCode, 403, roots.body);
    const settings = await unverified.inject({ method: "PATCH", url: "/api/settings", payload: { timezone: "UTC" } });
    assert.equal(settings.statusCode, 200, settings.body);
    const person = await unverified.inject({ method: "POST", url: "/api/people", payload: { name: "Fictional test contact" } });
    assert.equal(person.statusCode, 201, person.body);
    const contacts = await unverified.inject({ method: "GET", url: "/api/people" });
    assert.equal(contacts.statusCode, 200, contacts.body);
  });

  await t.test("verification blocks assignment, but verified BYOK users can assign to paired devices", async () => {
    const task = await prisma.task.create({ data: { userId: member.id, title: "Paired execution", createdBy: "me" } });
    const token = await harness.asToken(member, "device");
    const device = await prisma.device.create({ data: { userId: member.id, name: "Test computer", platform: "linux", tokenId: token.id, capabilities: { folders: ["Project"] } } });
    const payload = { taskId: task.id, kind: "code", deviceId: device.id, folderLabel: "Project", provider: "openai", model: "gpt-test" };
    const remote = await member.inject({ method: "POST", url: "/api/agent/assign", payload });
    assert.equal(remote.statusCode, 201, remote.body);
    const job = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: remote.json<{ jobId: string }>().jobId } });
    assert.equal(job.deviceId, device.id);
    assert.equal(job.externalRoot, null);
    await assert.rejects(createJob(prisma, member.id, Assign.parse({ ...payload, deviceId: undefined })), { statusCode: 403 });
    const otherTask = await prisma.task.create({ data: { userId: unverified.id, title: "Unverified", createdBy: "me" } });
    await assert.rejects(createJob(prisma, unverified.id, Assign.parse({ ...payload, taskId: otherTask.id })), { statusCode: 403 });
    const claim = await token.inject({ method: "POST", url: "/api/devices/self/claim" });
    assert.equal(claim.statusCode, 200, claim.body);
    await prisma.workspaceJob.update({ where: { id: job.id }, data: { status: "queued", leaseToken: null, leaseUntil: null, leaseOwner: null } });
    await prisma.user.update({ where: { id: member.id }, data: { emailVerifiedAt: null } });
    try {
      const refused = await token.inject({ method: "POST", url: "/api/devices/self/claim" });
      assert.equal(refused.statusCode, 403, refused.body);
    } finally {
      await prisma.user.update({ where: { id: member.id }, data: { emailVerifiedAt: new Date() } });
    }
  });

  await t.test("unverified browser/device sessions cannot pair or consume legacy pairing codes", async () => {
    const pair = await unverified.inject({ method: "POST", url: "/api/devices/pair" });
    assert.equal(pair.statusCode, 403, pair.body);
    const { sha256 } = await import("../lib/auth.js");
    const code = "ABCD2345";
    const pairing = await prisma.devicePairing.create({ data: { userId: unverified.id, codeHash: sha256(code), expiresAt: new Date(Date.now() + 60_000) } });
    const registration = await app.inject({ method: "POST", url: "/api/devices/register", payload: { code, name: "Test computer", platform: "linux" } });
    assert.equal(registration.statusCode, 403, registration.body);
    assert.equal((await prisma.devicePairing.findUniqueOrThrow({ where: { id: pairing.id } })).usedAt, null);
  });

  await t.test("OAuth-only operator sessions stay valid but cannot bypass passkey enrollment step-up", async () => {
    const operator = await harness.asUser("operator@example.test");
    await prisma.user.update({ where: { id: operator.id }, data: { passwordHash: null, emailVerifiedAt: new Date() } });
    const enrollment = await operator.inject({ method: "POST", url: "/api/terminal/passkeys/options", headers: { origin: "http://localhost:3000" }, payload: { password: "not-an-account-password" } });
    assert.equal(enrollment.statusCode, 403, enrollment.body);
    assert.match(enrollment.json<{ error: string }>().error, /OAuth-only sign-in is valid/);
    const tasks = await operator.inject({ method: "GET", url: "/api/tasks" });
    assert.equal(tasks.statusCode, 200, tasks.body);
  });

  await t.test("the queue refuses legacy nonoperator jobs without claiming device jobs", async () => {
    const task = await prisma.task.create({ data: { userId: unverified.id, title: "Legacy queued", createdBy: "me" } });
    const job = await prisma.workspaceJob.create({ data: { userId: unverified.id, taskId: task.id, kind: "research", executionMode: "sandbox", model: "mock", provider: "mock", instructions: "" } });
    assert.equal(await tickServerQueue(app), true);
    const stopped = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(stopped.status, "failed");
    assert.match(stopped.error ?? "", /Verify your email/);
    assert.equal(await prisma.run.count({ where: { userId: unverified.id } }), 0);
    const devices = await prisma.workspaceJob.findMany({ where: { userId: member.id, deviceId: { not: null } } });
    assert.ok(devices.every((row) => row.status === "queued"));
  });

  await t.test("document enrichment leaves unverified work queued and performs no model turn", async () => {
    const document = await prisma.document.create({ data: { userId: unverified.id, filename: "queued.txt", mediaType: "text/plain", byteSize: 10, sha256: "test", original: Buffer.from("test"), format: "txt", enrichmentStatus: "queued" } });
    assert.equal(await enrichDocument(app, document.id), null);
    assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).enrichmentAttempts, 0);
    const ready = await prisma.document.create({ data: { userId: member.id, filename: "ready.txt", mediaType: "text/plain", byteSize: 10, sha256: "ready", original: Buffer.from("ready"), format: "txt", enrichmentStatus: "queued" } });
    assert.deepEqual(await queuedEnrichmentDocuments(app), [{ id: ready.id }]);
  });

  await t.test("concurrent job admissions cannot exceed the configured daily cap", async () => {
    process.env.ENSEMBLE_MAX_JOBS_PER_DAY = "2";
    const task = await prisma.task.create({ data: { userId: member.id, title: "Quota", createdBy: "me" } });
    const outcomes = await Promise.allSettled([1, 2, 3].map(() => createCappedJob(prisma, member.id, {
      data: { userId: member.id, taskId: task.id, kind: "research", deviceId: null, executionMode: "sandbox", model: "mock", instructions: "" },
    })));
    // One paired job was already admitted in this UTC day.
    assert.equal(outcomes.filter((row) => row.status === "fulfilled").length, 1);
    const refusals = outcomes.filter((row) => row.status === "rejected");
    assert.equal(refusals.length, 2);
    for (const refusal of refusals) if (refusal.status === "rejected") assert.equal(refusal.reason.statusCode, 429);
    assert.equal(await prisma.workspaceJob.count({ where: { userId: member.id } }), 2);
    await prisma.workspaceJob.deleteMany({ where: { userId: member.id, deviceId: null } });
    await assert.rejects(createCappedJob(prisma, member.id, { data: { userId: member.id, taskId: task.id, kind: "research", executionMode: "sandbox", model: "mock", instructions: "" } }), { statusCode: 429 });
  });

  await t.test("connector cap is persisted under the user lock and core settings are still editable", async () => {
    process.env.ENSEMBLE_MAX_CONNECTORS = "1";
    await saveSettings(prisma, member.id, { connections: { github: { enabled: true } } });
    await assert.rejects(saveSettings(prisma, member.id, { connections: { slack: { enabled: true } } }), { statusCode: 429 });
    const saved = await prisma.preference.findFirstOrThrow({ where: { userId: member.id, key: "hub.settings" } });
    assert.equal(JSON.stringify(saved.value).includes('"slack":{"enabled":true}'), false);
    await saveSettings(prisma, unverified.id, { timezone: "UTC" });
    await saveAccount(member.id, "github", { accessToken: "own-connector-token" });
    assert.equal((await getAccount(member.id, "github"))?.source, "you");
    await assert.rejects(saveAccount(member.id, "slack", { accessToken: "second-connector-token" }), { statusCode: 429 });
  });

  await t.test("dataset byte admission counts both compressed table and original and is race safe", async () => {
    const columns = [{ name: "value", type: "number" as const }];
    const rows = [[1], [2]];
    process.env.ENSEMBLE_MAX_DATASET_BYTES = String(storedTableBytes({ columns, rows }));
    const outcomes = await Promise.allSettled([1, 2].map(() => ingestDataset(prisma, member.id, { columns, rows })));
    for (const outcome of outcomes) if (outcome.status === "fulfilled") datasets.push(outcome.value.id);
    assert.equal(datasets.length, 1);
    assert.equal(outcomes.filter((row) => row.status === "rejected").length, 1);
    const rejected = outcomes.find((row) => row.status === "rejected");
    if (rejected?.status === "rejected") assert.equal(rejected.reason.statusCode, 429);
    const sum = await prisma.plotDataset.aggregate({ where: { userId: member.id }, _sum: { byteSize: true } });
    assert.equal(sum._sum.byteSize, Number(process.env.ENSEMBLE_MAX_DATASET_BYTES));
  });
});
