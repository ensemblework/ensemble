/**
 * Desk live payload, limitation math, and capture intents against Postgres.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { ZodError } from "zod";
import "../config.js";
import { saveSettings } from "../lib/settings.js";
import { prisma } from "../lib/prisma.js";
import { coworkRoutes } from "../routes/cowork.js";
import { deskRoutes } from "../routes/desk.js";
import "../types.js";

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function user(label: string) {
  return prisma.user.create({
    data: { email: `desk-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@ensemble.test`, name: label },
  });
}

async function appFor(userId: string) {
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.addHook("onRequest", async (request) => {
    request.userId = userId;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: error.message });
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(statusCode).send({ error: message });
  });
  await app.register(deskRoutes);
  await app.register(coworkRoutes);
  return app;
}

async function cleanup(userId: string) {
  await prisma.attendanceMark.deleteMany({ where: { userId } });
  await prisma.timetableSlot.deleteMany({ where: { userId } });
  await prisma.courtHoliday.deleteMany({ where: { userId } });
  await prisma.objective.deleteMany({ where: { userId } });
  await prisma.deployEvent.deleteMany({ where: { userId } });
  await prisma.partRow.deleteMany({ where: { userId } });
  await prisma.testResult.deleteMany({ where: { userId } });
  await prisma.citationLink.deleteMany({ where: { userId } });
  await prisma.gradingRow.deleteMany({ where: { userId } });
  await prisma.reminder.deleteMany({ where: { userId } });
  await prisma.artifact.deleteMany({ where: { userId } });
  await prisma.meetingNote.deleteMany({ where: { userId } });
  await prisma.taskTransition.deleteMany({ where: { userId } });
  await prisma.undoEntry.deleteMany({ where: { userId } });
  await prisma.task.deleteMany({ where: { userId } });
  await prisma.deliverable.deleteMany({ where: { userId } });
  await prisma.repo.deleteMany({ where: { userId } });
  await prisma.person.deleteMany({ where: { userId } });
  await prisma.project.deleteMany({ where: { userId } });
  await prisma.preference.deleteMany({ where: { userId } });
  await prisma.auditLedger.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

test("limitation, mocks, and hearings stay on the desk payload", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("owner");
  const other = await user("other");
  await saveSettings(prisma, owner.id, { timezone: "UTC" });
  const app = await appFor(owner.id);
  const theirs = await appFor(other.id);
  try {
    const holiday = await app.inject({
      method: "POST",
      url: "/api/desk/entries",
      payload: { kind: "holiday", fields: { day: "2026-10-02", name: "Gandhi Jayanti" } },
    });
    assert.equal(holiday.statusCode, 201);
    const matter = await app.inject({
      method: "POST",
      url: "/api/desk/entries",
      payload: { kind: "matter", fields: { title: "Rao v Sunrise", orderDate: "2026-09-02", rule: "30d", court: "NCDRC" } },
    });
    assert.equal(matter.statusCode, 201);
    const mock = await app.inject({ method: "POST", url: "/api/capture", payload: { text: "mock 112/200 today" } });
    assert.equal(mock.statusCode, 201);
    assert.match((mock.json() as { task: { title: string } }).task.title, /112\/200/);
    const hearing = await app.inject({ method: "POST", url: "/api/capture", payload: { text: "hearing Rao v Sunrise 5 Oct Court 32" } });
    assert.equal(hearing.statusCode, 201);
    const asked = await app.inject({ method: "POST", url: "/api/ask", payload: { question: "mock 40/100 polity" } });
    assert.equal(asked.statusCode, 200);
    assert.match((asked.json() as { answer: string }).answer, /40\/100/);

    const live = await app.inject({ method: "GET", url: "/api/desk/live" });
    assert.equal(live.statusCode, 200);
    const body = live.json() as {
      today: string;
      limitation: Array<{ title: string; due: string; days: number; shifted: boolean; note: string | null }>;
      tasks: Array<{ title: string; taskType: string | null; measure: number | null; court: string | null }>;
    };
    const pin = body.limitation.find((row) => row.title === "Rao v Sunrise");
    assert.ok(pin);
    assert.equal(pin?.due, "2026-10-05");
    assert.equal(pin?.shifted, true);
    assert.match(pin?.note ?? "", /s\.4/);
    const expectedDays = Math.round((Date.parse("2026-10-05T00:00:00Z") - Date.parse(`${body.today}T00:00:00Z`)) / 86_400_000);
    assert.equal(pin?.days, expectedDays);
    assert.ok(body.tasks.some((row) => row.taskType === "mock" && row.measure === 112));
    assert.ok(body.tasks.some((row) => row.taskType === "hearing" && row.court === "Court 32"));
    const concept = await app.inject({
      method: "POST",
      url: "/api/desk/entries",
      payload: { kind: "concept", fields: { title: "Photosynthesis", subject: "Light reactions" } },
    });
    assert.equal(concept.statusCode, 201);
    const hold = await app.inject({
      method: "POST",
      url: "/api/desk/entries",
      payload: { kind: "hold", fields: { title: "Rev C", day: "2026-10-12" } },
    });
    assert.equal(hold.statusCode, 201);
    const again = await app.inject({ method: "GET", url: "/api/desk/live" });
    const tasks = (again.json() as { tasks: Array<{ title: string; taskType: string | null; subject: string | null }> }).tasks;
    assert.ok(tasks.some((row) => row.taskType === "concept" && row.title === "Photosynthesis" && row.subject === "Light reactions"));
    assert.ok(tasks.some((row) => row.taskType === "hold" && row.title === "Rev C"));
    await app.inject({ method: "DELETE", url: `/api/desk/entries/concept/${(concept.json() as { id: string }).id}` });
    const afterHide = await app.inject({ method: "GET", url: "/api/desk/live" });
    const remaining = (afterHide.json() as { tasks: Array<{ taskType: string | null; deletedAt?: string | null }> }).tasks;
    assert.equal(remaining.some((row) => row.taskType === "concept"), false);
    const kept = await prisma.task.findFirst({ where: { id: (concept.json() as { id: string }).id } });
    assert.ok(kept?.deletedAt, "turning a concept off the desk does not hard-delete it");

    const stolen = await theirs.inject({ method: "GET", url: "/api/desk/live" });
    assert.equal((stolen.json() as { limitation: unknown[] }).limitation.length, 0);
    const removed = await theirs.inject({ method: "DELETE", url: `/api/desk/entries/holiday/${(holiday.json() as { id: string }).id}` });
    assert.equal(removed.statusCode, 404);
  } finally {
    await app.close();
    await theirs.close();
    await cleanup(owner.id);
    await cleanup(other.id);
  }
});

test("desk live stays inside its take caps when every list is overfilled", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("caps");
  await saveSettings(prisma, owner.id, { timezone: "UTC" });
  const app = await appFor(owner.id);
  try {
    const project = await prisma.project.create({ data: { userId: owner.id, name: "Cap project" } });
    await prisma.project.createMany({
      data: Array.from({ length: 12 }, (_, i) => ({ userId: owner.id, name: `Extra project ${i}` })),
    });
    await prisma.task.createMany({
      data: Array.from({ length: 49 }, (_, i) => ({
        userId: owner.id,
        title: `Cap task ${i}`,
        taskType: i < 9 ? "exam" : i < 22 ? "matter" : "task",
        due: i < 9 ? new Date(Date.UTC(2026, 11, 1 + i)) : null,
        orderDate: i >= 9 && i < 22 ? new Date(Date.UTC(2026, 8, 2)) : null,
        limitationRule: i >= 9 && i < 22 ? "30d" : null,
        court: i >= 9 && i < 22 ? "NCDRC" : null,
      })),
    });
    await prisma.deliverable.createMany({
      data: Array.from({ length: 13 }, (_, i) => ({ userId: owner.id, projectId: project.id, title: `Brief ${i}` })),
    });
    await prisma.person.createMany({
      data: Array.from({ length: 17 }, (_, i) => ({ userId: owner.id, name: `Person ${i}` })),
    });
    await prisma.meetingNote.createMany({
      data: Array.from({ length: 9 }, (_, i) => ({ userId: owner.id, title: `Note ${i}` })),
    });
    await prisma.artifact.createMany({
      data: Array.from({ length: 9 }, (_, i) => ({
        userId: owner.id,
        kind: "file" as const,
        externalId: `cap-${i}`,
        ts: new Date(Date.UTC(2026, 8, 1, 0, i)),
        title: `File ${i}`,
      })),
    });
    await prisma.reminder.createMany({
      data: Array.from({ length: 9 }, (_, i) => ({
        userId: owner.id,
        title: `Reminder ${i}`,
        titleContent: { text: `Reminder ${i}` },
        dueDate: "2026-12-01",
        timeZone: "UTC",
        actionTokenHash: `hash-${i}`,
      })),
    });
    await prisma.timetableSlot.createMany({
      data: Array.from({ length: 41 }, (_, i) => ({
        userId: owner.id,
        title: `Slot ${i}`,
        weekday: i % 7,
        startMin: 9 * 60,
        endMin: 10 * 60,
      })),
    });
    await prisma.courtHoliday.createMany({
      data: Array.from({ length: 41 }, (_, i) => ({
        userId: owner.id,
        day: new Date(Date.UTC(2026, 9, 1 + i)),
        name: `Holiday ${i}`,
      })),
    });
    await prisma.objective.createMany({
      data: Array.from({ length: 9 }, (_, i) => ({ userId: owner.id, title: `Objective ${i}`, progress: i })),
    });
    await prisma.deployEvent.createMany({
      data: Array.from({ length: 9 }, (_, i) => ({ userId: owner.id, name: `Deploy ${i}`, env: "prod" })),
    });
    await prisma.partRow.createMany({
      data: Array.from({ length: 21 }, (_, i) => ({ userId: owner.id, name: `Part ${i}`, qty: 1, status: "out" })),
    });
    await prisma.testResult.createMany({
      data: Array.from({ length: 13 }, (_, i) => ({ userId: owner.id, name: `Test ${i}`, build: "1", status: "pass" })),
    });
    await prisma.citationLink.createMany({
      data: Array.from({ length: 17 }, (_, i) => ({ userId: owner.id, fromTitle: `From ${i}`, toTitle: `To ${i}` })),
    });
    await prisma.gradingRow.createMany({
      data: Array.from({ length: 13 }, (_, i) => ({ userId: owner.id, className: `Class ${i}`, expected: 30, marked: 10 })),
    });
    await prisma.repo.createMany({
      data: Array.from({ length: 13 }, (_, i) => ({ userId: owner.id, fullName: `cap/repo-${i}` })),
    });

    const response = await app.inject({ method: "GET", url: "/api/desk/live" });
    assert.equal(response.statusCode, 200);
    const body = response.json() as Record<string, unknown>;
    const caps: Record<string, number> = {
      tasks: 48,
      deliverables: 12,
      people: 16,
      meetings: 8,
      artifacts: 8,
      reminders: 8,
      slots: 40,
      holidays: 40,
      objectives: 8,
      deploys: 8,
      parts: 20,
      tests: 12,
      citations: 16,
      grading: 12,
      repos: 12,
      projects: 12,
      limitation: 12,
      countdowns: 8,
    };
    for (const [key, cap] of Object.entries(caps)) {
      const rows = body[key];
      assert.ok(Array.isArray(rows), key);
      assert.equal(rows.length, cap, `${key} length ${rows.length}`);
    }
    const bytes = Buffer.byteLength(response.body);
    console.log(`desk live payload at caps: ${bytes} bytes`);
    assert.ok(bytes < 200_000, `desk live payload ${bytes} bytes`);
  } finally {
    await app.close();
    await cleanup(owner.id);
  }
});

test("another user gets 404 deleting non-task desk entries", async (t) => {
  if (!(await databaseReady())) return t.skip("Postgres is not reachable");
  const owner = await user("owner-rows");
  const other = await user("other-rows");
  const app = await appFor(owner.id);
  const theirs = await appFor(other.id);
  const rows: Array<{ kind: string; fields: Record<string, string | number> }> = [
    { kind: "slot", fields: { title: "Algorithms", weekday: 1, start: "09:00", end: "10:00", course: "CS" } },
    { kind: "holiday", fields: { day: "2026-10-02", name: "Gandhi Jayanti" } },
    { kind: "part", fields: { name: "M3 screw", qty: 4, status: "out" } },
    { kind: "test", fields: { name: "Continuity", status: "pass" } },
    { kind: "citation", fields: { from: "Draft", to: "Vaswani 2017" } },
    { kind: "grade", fields: { className: "9-B", expected: 30, marked: 4 } },
    { kind: "objective", fields: { title: "Ship the review", progress: 20 } },
    { kind: "deploy", fields: { name: "hub-web", env: "prod" } },
    { kind: "person", fields: { name: "Priya Shah", capacity: 32 } },
    { kind: "attendance", fields: { name: "Aarav", present: "yes", day: "2026-09-30" } },
  ];
  try {
    const created: Array<{ kind: string; id: string }> = [];
    for (const row of rows) {
      const saved = await app.inject({ method: "POST", url: "/api/desk/entries", payload: { kind: row.kind, fields: row.fields } });
      assert.equal(saved.statusCode, 201, `${row.kind} ${saved.body}`);
      created.push({ kind: row.kind, id: (saved.json() as { id: string }).id });
    }
    for (const row of created) {
      const stolen = await theirs.inject({ method: "DELETE", url: `/api/desk/entries/${row.kind}/${row.id}` });
      assert.equal(stolen.statusCode, 404, `${row.kind} foreign delete ${stolen.statusCode}`);
      const still = await app.inject({ method: "DELETE", url: `/api/desk/entries/${row.kind}/${row.id}` });
      assert.equal(still.statusCode, 200, `${row.kind} owner delete ${still.statusCode} ${still.body}`);
    }
  } finally {
    await app.close();
    await theirs.close();
    await cleanup(owner.id);
    await cleanup(other.id);
  }
});
