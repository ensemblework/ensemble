import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { createHttpHarness } from "./http.js";
import { morningInstructions } from "../cowork/morning-skill.js";

process.env.NODE_ENV = "test";
process.env.ENSEMBLE_SIGNUP_MODE = "open";
process.env.ENSEMBLE_INPROCESS_RUNTIME = "1";
const h = await createHttpHarness();
const { createMorningRoutine, createRoutine, runDueRoutines, runRoutine, updateRoutine } = await import("../routines/service.js");
const { saveSettings } = await import("../lib/settings.js");
const { setRuntimeFetchForTests } = await import("../runtime/models.js");
const { setCredentialResolverForTests } = await import("../runtime/credentials.js");
const { setRuntimeSleepForTests } = await import("../runtime/pace.js");
const { startScheduler } = await import("../jobs/scheduler.js");
const { sseHub } = await import("../lib/sse.js");
after(() => h.close());

async function migrate() {
  const sql = await readFile(new URL("../../prisma/migrations/20261128100000_morning_brief_routine/migration.sql", import.meta.url), "utf8");
  await h.prisma.$transaction(async (tx) => {
    for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement);
  });
}

test("migration preserves the saved time, zone and full skill body, pauses disabled briefs and never recreates a deleted default", async () => {
  const on = await h.asUser(), off = await h.asUser(), fresh = await h.asUser();
  const body = `# My morning brief\n\n${"Focus on my classes. ".repeat(300)}\n`;
  await h.prisma.user.update({ where: { id: fresh.id }, data: { profession: "Teacher" } });
  for (const [user, enabled] of [[on, true], [off, false]] as const) {
    await h.prisma.preference.create({ data: { userId: user.id, key: "hub.settings", value: { timezone: "Europe/Berlin", morningBrief: { enabled, time: "07:30" } } } });
    await h.prisma.skill.create({ data: { userId: user.id, slug: "morning-brief", name: "Morning brief", body, scope: { purpose: "morning-brief" } } });
  }
  const ordinary = await createRoutine(h.prisma, on.id, { title: "Morning brief", instruction: "A separate user routine", cadence: { every: "week" } });
  await h.prisma.notification.create({ data: { userId: on.id, kind: "morning_brief", title: "Morning", body: "Latest saved brief", url: "/morning-brief", readAt: new Date() } });
  await migrate();
  const brief = await h.prisma.assistantRoutine.findUniqueOrThrow({ where: { userId_builtInKey: { userId: on.id, builtInKey: "morning-brief" } } });
  assert.equal(brief.cron, "30 7 * * *");
  assert.equal(brief.timezone, "Europe/Berlin");
  assert.equal(brief.instruction, body);
  assert.equal(brief.status, "active");
  assert.equal(brief.lastSummary, "Latest saved brief");
  assert.equal((await on.inject({ method: "GET", url: "/api/brief/today" })).json().brief, "Latest saved brief");
  assert.ok(brief.conversationId);
  await h.prisma.assistantRoutine.update({ where: { id: brief.id }, data: { lastStatus: "failed", lastSummary: "The model was unavailable." } });
  assert.equal((await on.inject({ method: "GET", url: "/api/brief/today" })).json().brief, "Latest saved brief");
  assert.equal((await h.prisma.assistantRoutine.findFirstOrThrow({ where: { userId: off.id } })).status, "paused");
  assert.equal((await h.prisma.assistantRoutine.findFirstOrThrow({ where: { userId: fresh.id } })).instruction, morningInstructions("Teacher"));
  assert.ok((await h.prisma.skill.findFirstOrThrow({ where: { userId: on.id } })).deletedAt);
  const settings = (await h.prisma.preference.findUniqueOrThrow({ where: { userId_key: { userId: on.id, key: "hub.settings" } } })).value;
  assert.ok(settings && typeof settings === "object" && !Array.isArray(settings));
  assert.ok(!("morningBrief" in settings));
  await migrate();
  assert.equal(await h.prisma.assistantRoutine.count({ where: { userId: on.id, builtInKey: "morning-brief" } }), 1);
  assert.equal(await h.prisma.assistantMessage.count({ where: { conversationId: brief.conversationId } }), 1);
  const edited = await updateRoutine(h.prisma, on.id, brief.id, { instruction: body, cadence: { every: "day", time: "06:45" } });
  assert.equal(edited.instruction, body.trim());
  assert.equal(edited.cron, "45 6 * * *");
  assert.notEqual(edited.nextRunAt, brief.nextRunAt?.toISOString());
  assert.equal((await on.inject({ method: "DELETE", url: `/api/routines/${brief.id}` })).statusCode, 204);
  await migrate();
  assert.equal(await h.prisma.assistantRoutine.count({ where: { userId: on.id, builtInKey: "morning-brief" } }), 0);
  assert.ok(await h.prisma.assistantRoutine.findUnique({ where: { id: ordinary.id } }));
});

test("signup creates one active 08:00 brief and routine reads and seeding cannot bring a deleted one back", async () => {
  const email = `brief-signup-${Date.now()}@example.test`;
  const response = await h.app.inject({ method: "POST", url: "/api/auth/signup", payload: { email, password: "test-password-only-123", name: "Mira" } });
  assert.equal(response.statusCode, 200, response.body);
  const userId = response.json().user.id as string;
  const brief = await h.prisma.assistantRoutine.findFirstOrThrow({ where: { userId } });
  assert.equal(brief.builtInKey, "morning-brief");
  assert.equal(brief.status, "active");
  assert.equal(brief.cron, "0 8 * * *");
  assert.equal(brief.instruction, morningInstructions(null));
  assert.equal((await h.app.inject({ method: "POST", url: "/api/auth/signup", payload: { email, password: "test-password-only-123" } })).statusCode, 409);
  await h.prisma.$transaction((tx) => createMorningRoutine(tx, userId));
  assert.equal(await h.prisma.assistantRoutine.count({ where: { userId } }), 1);
  await h.prisma.assistantRoutine.delete({ where: { id: brief.id } });
  await h.prisma.$transaction((tx) => createMorningRoutine(tx, userId));
  assert.equal(await h.prisma.assistantRoutine.count({ where: { userId } }), 0);
});

test("brief and other routines share the default model; ticks, pauses and deletion never start the legacy delivery", async () => {
  const user = await h.asUser(), stranger = await h.asUser();
  await saveSettings(h.prisma, user.id, { timezone: "Pacific/Kiritimati", assistant: { defaultTier: "medium" }, models: { medium: { provider: "ollama", model: "fixture-default" } } });
  await h.prisma.$transaction((tx) => createMorningRoutine(tx, user.id));
  const brief = await h.prisma.assistantRoutine.findFirstOrThrow({ where: { userId: user.id } });
  const other = await createRoutine(h.prisma, user.id, { title: "Inbox", instruction: "Read my inbox", cadence: { every: "day" } });
  await h.prisma.assistantRoutine.updateMany({ where: { userId: user.id }, data: { nextRunAt: new Date(0) } });
  const models: string[] = [];
  const text = "Start with your classes. ".repeat(30);
  setCredentialResolverForTests(async (_userId, provider) => ({ provider, secret: "", source: "none", baseUrl: null }));
  setRuntimeSleepForTests(async () => undefined);
  setRuntimeFetchForTests(async (url, init) => {
    assert.match(String(url), /^http:\/\/127\.0\.0\.1:11434\//);
    const body = JSON.parse(String(init?.body));
    models.push(body.model);
    return new Response(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ model: body.model, choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  try {
    let finished = 0;
    let off = () => {};
    let timer: ReturnType<typeof setTimeout>;
    const delivered = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Scheduler did not complete both routines.")), 10_000);
      off = sseHub.onFrame(({ userId, frame }) => {
        if (userId === user.id && frame.event === "notification" && ++finished === 2) resolve();
      });
    });
    const stop = startScheduler(h.app);
    try { await delivered; } finally { stop(); off(); clearTimeout(timer!); }
    assert.deepEqual(models, ["fixture-default", "fixture-default"]);
    const notes = await h.prisma.notification.findMany({ where: { userId: user.id } });
    assert.equal(notes.length, 2);
    assert.ok(notes.every((note) => note.kind === "routine" && note.url?.startsWith("/routines?routine=")));
    assert.equal((await h.prisma.assistantRoutine.findUniqueOrThrow({ where: { id: brief.id } })).lastStatus, "ok");
    await user.inject({ method: "POST", url: "/api/notifications/read" });
    assert.equal((await user.inject({ method: "GET", url: "/api/brief/today" })).json().brief, text.trim());
    assert.equal((await stranger.inject({ method: "GET", url: "/api/brief/today" })).json().routine, null);
    assert.equal((await stranger.inject({ method: "GET", url: "/api/routines" })).json().routines.length, 0);
    assert.equal((await stranger.inject({ method: "PATCH", url: `/api/routines/${brief.id}`, payload: { status: "paused" } })).statusCode, 404);
    assert.equal((await stranger.inject({ method: "DELETE", url: `/api/routines/${brief.id}` })).statusCode, 404);
    assert.equal((await user.inject({ method: "PATCH", url: `/api/routines/${brief.id}`, payload: { instruction: " " } })).statusCode, 400);
    await h.prisma.assistantRoutine.update({ where: { id: brief.id }, data: { nextRunAt: new Date(0) } });
    await runDueRoutines(h.app, user.id, true);
    assert.equal(models.length, 2, "rescheduling cannot deliver a second scheduled brief on the same local day");
    await updateRoutine(h.prisma, user.id, brief.id, { status: "paused" });
    await h.prisma.assistantRoutine.update({ where: { id: brief.id }, data: { nextRunAt: new Date(0), lastRunAt: null } });
    await runDueRoutines(h.app, user.id, true);
    await runDueRoutines(h.app, user.id, false);
    assert.equal(models.length, 2);
    assert.equal((await user.inject({ method: "DELETE", url: `/api/routines/${brief.id}` })).statusCode, 204);
    await runDueRoutines(h.app, user.id, true);
    assert.equal(models.length, 2);
    assert.equal((await user.inject({ method: "POST", url: "/api/brief/deliver" })).statusCode, 404);
    assert.equal((await user.inject({ method: "GET", url: "/api/brief/skill" })).statusCode, 404);
    assert.equal((await user.inject({ method: "POST", url: "/api/brief/prompt", payload: { action: "show" } })).statusCode, 404);
    assert.ok(await h.prisma.assistantRoutine.findUnique({ where: { id: other.id } }));
  } finally {
    setRuntimeFetchForTests(null);
    setCredentialResolverForTests(null);
    setRuntimeSleepForTests(null);
  }
});

test("a routine in flight cannot recreate a notification after Everything is erased", async () => {
  const user = await h.asUser();
  await saveSettings(h.prisma, user.id, { assistant: { defaultTier: "medium" }, models: { medium: { provider: "ollama", model: "fixture-default" } } });
  const routine = await createRoutine(h.prisma, user.id, { title: "Morning brief", instruction: "My private context", cadence: { every: "day" } });
  const row = await h.prisma.assistantRoutine.findUniqueOrThrow({ where: { id: routine.id } });
  const { deleteWorkspaceData } = await import("../lib/workspace-data.js");
  let called = false;
  setCredentialResolverForTests(async (_userId, provider) => ({ provider, secret: "", source: "none", baseUrl: null }));
  setRuntimeFetchForTests(async () => {
    called = true;
    await deleteWorkspaceData(h.prisma, user.id, "everything");
    return new Response(`data: ${JSON.stringify({ model: "fixture-default", choices: [{ delta: { content: "Erased private context" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  try {
    assert.equal(await runRoutine(h.app, row, "scheduled"), null);
    assert.equal(called, true);
    assert.equal(await h.prisma.notification.count({ where: { userId: user.id } }), 0);
    assert.equal(await h.prisma.assistantMessage.count({ where: { userId: user.id } }), 0);
  } finally {
    setRuntimeFetchForTests(null);
    setCredentialResolverForTests(null);
  }
});
