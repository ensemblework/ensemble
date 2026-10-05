/**
 * In-process scheduler (docs/05 §2): the fetch times each person set, a daily
 * retention pass, and expiry of editor decisions nobody answered.
 *
 * One minute tick. A slot runs once per user per local day, recorded in
 * sync_state so a restart inside the same minute does not run it twice.
 */
import type { FastifyInstance } from "fastify";
import { fetchAll } from "../connectors/sync.js";
import { expireStale } from "../lib/decisions.js";
import { loadSettings } from "../lib/settings.js";
import { retentionDue } from "../lib/clock.js";
import { evaluateWatchers } from "../ensemble/watchers.js";
import { deliverMorningBrief, ensureStaleNotice } from "../cowork/service.js";
import { sweepExpiredDeviceLeases } from "../devices/lease.js";
import { claimSlot } from "./claim.js";
import { dispatchDueReminders, runRetention } from "./retention.js";
import { markSchedulerEnabled, markSchedulerTick } from "./scheduler-clock.js";

const RETENTION_TIME = "03:30";

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
  await expireStale();
  await sweepExpiredDeviceLeases(app).catch((error: unknown) => app.log.error({ err: error }, "device lease sweep failed"));
  const rows = await app.prisma.preference.findMany({ where: { key: "hub.settings", deletedAt: null }, select: { userId: true } });
  const users = rows.length ? rows : await app.prisma.user.findMany({ select: { id: true } }).then((list) => list.map((user) => ({ userId: user.id })));
  for (const { userId } of users) {
    const settings = await loadSettings(app.prisma, userId);
    const now = localClock(settings.timezone);
    void dispatchDueReminders(app, userId).catch((error: unknown) => app.log.error({ err: error }, "reminder dispatch failed"));
    void deliverMorningBrief(app.prisma, userId).catch((error: unknown) => app.log.error({ err: error }, "morning brief failed"));
    void ensureStaleNotice(app.prisma, userId).catch((error: unknown) => app.log.error({ err: error }, "stale nudge failed"));
    void evaluateWatchers(app.prisma, userId).catch((error: unknown) => app.log.error({ err: error }, "watcher evaluation failed"));
    if (settings.fetch.scheduled && settings.fetch.times.includes(now.time)) {
      if (await claimSchedule(app, userId, `fetch@${now.date}T${now.time}`)) {
        app.log.info({ userId, at: now }, "scheduled fetch");
        void fetchAll(app, userId, "schedule").catch((error: unknown) => app.log.error({ err: error }, "scheduled fetch failed"));
      }
    }
    const slot = await app.prisma.syncState.findUnique({ where: { userId_connector: { userId, connector: "schedule:retention" } } });
    const lastDate = slot?.cursor?.split("@")[1] ?? null;
    const dueNow = retentionDue(lastDate, now, RETENTION_TIME);
    if (dueNow && (await claimSchedule(app, userId, `retention@${now.date}`))) {
      await runRetention(app, userId, {
        deletedDays: settings.retentionDays,
        completedDays: settings.completedRetentionDays,
        historyDays: settings.historyRetentionDays,
      });
    }
  }
}

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
