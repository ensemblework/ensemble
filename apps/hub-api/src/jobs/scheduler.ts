/**
 * In-process scheduler (docs/05 §2): the fetch times each person set (paused
 * unless ENSEMBLE_SCHEDULED_FETCH=on), the Today calendar's 30-minute refresh
 * (calendar/sync.ts), the assistant's routines that are due (routines/service.ts), a daily retention pass, expiry of
 * editor decisions nobody answered, an hourly sweep of blobs nothing uses (jobs/blob-sweep.ts), and the
 * inline asks' agent sessions 30 minutes after their last answer (assistant/ask-sessions.ts).
 *
 * One minute tick. A slot runs once per user per local day, recorded in
 * sync_state so a restart inside the same minute does not run it twice.
 */
import { runMeetingPreps } from "../cowork/prep.js";
import type { FastifyInstance } from "fastify";
import { refreshCalendarsIfDue } from "../calendar/sync.js";
import { fetchAll } from "../connectors/sync.js";
import { expireStale } from "../lib/decisions.js";
import { loadSettings } from "../lib/settings.js";
import { HostedAccessError, requireVerifiedUser } from "../lib/hosted-access.js";
import { retentionDue } from "../lib/clock.js";
import { evaluateWatchers } from "../ensemble/watchers.js";
import { deliverMorningBrief, ensureStaleNotice } from "../cowork/service.js";
import { sweepExpiredDeviceLeases } from "../devices/lease.js";
import { sweepStoredBlobs } from "./blob-sweep.js";
import { purgeInteractionEvents } from "../analytics/telemetry.js";
import { claimSlot } from "./claim.js";
import { dispatchDueReminders, runRetention } from "./retention.js";
import { markSchedulerEnabled, markSchedulerTick } from "./scheduler-clock.js";
import { runDueRoutines } from "../routines/service.js";
import { sweepWhenDue } from "../workspace/session-cleanup.js";
import { sweepAskSessions } from "../assistant/ask-sessions.js";
import { retryAssistantSessionDeletes } from "../assistant/delete-chat.js";

const RETENTION_TIME = "03:30";
let lastInteractionPurge = 0;

/**
 * Scheduled fetching is paused product-wide until routines replace it, whatever
 * settings.fetch.scheduled says. ENSEMBLE_SCHEDULED_FETCH=on restores it.
 * Fetch now and per-source Sync keep working.
 */
export function scheduledFetchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENSEMBLE_SCHEDULED_FETCH?.trim().toLowerCase() === "on";
}

/** Whether this minute is one of the person's fetch times and scheduled fetching is allowed at all. */
export function scheduledFetchDue(settings: { fetch: { scheduled: boolean; times: string[] } }, time: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return scheduledFetchEnabled(env) && settings.fetch.scheduled && settings.fetch.times.includes(time);
}

function localClock(timezone: string, at = new Date()): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

function claimSchedule(app: FastifyInstance, userId: string, slot: string): Promise<boolean> {
  const connector = `schedule:${slot.split("@")[0]}`;
  return claimSlot(app.prisma, userId, connector, slot);
}

async function tick(app: FastifyInstance): Promise<void> {
  await app.prisma.accountDeletionLog.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  // Allow two days for late settlement across a UTC month boundary.
  await app.prisma.includedCreditBalance.deleteMany({ where: { period: { lt: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 7) } } });
  await expireStale();
  await sweepExpiredDeviceLeases(app).catch((error: unknown) => app.log.error({ err: error }, "device lease sweep failed"));
  if (Date.now() - lastInteractionPurge > 86_400_000) {
    lastInteractionPurge = Date.now();
    void purgeInteractionEvents(app.prisma).catch((error: unknown) => app.log.error({ err: error }, "interaction log purge failed"));
  }
  void sweepStoredBlobs(app.prisma)
    .then((swept) => {
      if (swept && (swept.moved || swept.originals || swept.datasets || swept.evidence)) app.log.info(swept, "blob sweep");
    })
    .catch((error: unknown) => app.log.error({ err: error }, "blob sweep failed"));
  // Inline asks' agent sessions, 30 minutes after their last answer (assistant/ask-sessions.ts).
  void sweepAskSessions(app).catch((error: unknown) => app.log.error({ err: error }, "ask session sweep failed"));
  // Deleted chats' agent sessions that an online computer has not confirmed dropping yet (assistant/delete-chat.ts).
  void retryAssistantSessionDeletes(app).catch((error: unknown) => app.log.error({ err: error }, "chat session delete retry failed"));
  const users = (await app.prisma.user.findMany({ select: { id: true } })).map((user) => ({ userId: user.id }));
  for (const { userId } of users) {
    try {
      await requireVerifiedUser(userId);
    } catch (error) {
      if (!(error instanceof HostedAccessError)) throw error;
      app.log.info({ userId, reason: error.message }, "scheduler skipped unverified account");
      continue;
    }
    const settings = await loadSettings(app.prisma, userId);
    const now = localClock(settings.timezone);
    void dispatchDueReminders(app, userId).catch((error: unknown) => app.log.error({ err: error }, "reminder dispatch failed"));
    void deliverMorningBrief(app.prisma, userId).catch((error: unknown) => app.log.error({ err: error }, "morning brief failed"));
    void ensureStaleNotice(app.prisma, userId).catch((error: unknown) => app.log.error({ err: error }, "stale nudge failed"));
    void evaluateWatchers(app.prisma, userId).catch((error: unknown) => app.log.error({ err: error }, "watcher evaluation failed"));
    void refreshCalendarsIfDue(app, userId).catch((error: unknown) => app.log.error({ err: error }, "calendar refresh failed"));
    if (settings.automations.meetings.enabled) void runMeetingPreps(app.prisma, userId).catch((error: unknown) => app.log.error({ err: error }, "meeting prep failed"));
    void runDueRoutines(app, userId, settings.routines.enabled).catch((error: unknown) => app.log.error({ err: error }, "routines failed"));
    // The agent sessions of deleted and long-finished work, deleted from the person's agents (workspace/session-cleanup.ts).
    if (settings.orchestration.cleanSessions !== false) sweepWhenDue(app, userId, settings.completedRetentionDays);
    if (scheduledFetchDue(settings, now.time)) {
      if (await claimSchedule(app, userId, `fetch@${now.date}T${now.time}`)) {
        app.log.info({ userId, at: now }, "scheduled fetch");
        void fetchAll(app, userId, "schedule").catch((error: unknown) => app.log.error({ err: error }, "scheduled fetch failed"));
      }
    }
    const slot = await app.prisma.syncState.findUnique({ where: { userId_connector: { userId, connector: "schedule:retention" } } });
    const lastDate = slot?.cursor?.split("@")[1] ?? null;
    const dueNow = retentionDue(lastDate, now, RETENTION_TIME);
    if (dueNow && !retaining.has(userId) && (await claimSchedule(app, userId, `retention@${now.date}`))) {
      // Learning from completed work can wait minutes on a model (an AI plan on the person's computer):
      // it must not hold up the tick for everyone else.
      retaining.add(userId);
      void runRetention(app, userId, {
        deletedDays: settings.retentionDays,
        completedDays: settings.completedRetentionDays,
        historyDays: settings.historyRetentionDays,
      })
        .catch((error: unknown) => app.log.error({ err: error, userId }, "retention failed"))
        .finally(() => retaining.delete(userId));
    }
  }
}

/** Accounts whose daily retention pass is still running. */
const retaining = new Set<string>();

function runTick(app: FastifyInstance, label: string): Promise<void> {
  return tick(app)
    .catch((error: unknown) => app.log.error({ err: error }, label))
    .finally(() => {
      markSchedulerTick();
    });
}

export function startScheduler(app: FastifyInstance): () => void {
  if (process.env.ENSEMBLE_SCHEDULER === "off") return () => undefined;
  markSchedulerEnabled();
  void runTick(app, "scheduler startup tick failed");
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    runTick(app, "scheduler tick failed").finally(() => {
      busy = false;
    });
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

export { localClock };
