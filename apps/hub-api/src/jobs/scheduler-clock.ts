/**
 * When the in-process scheduler last finished a tick.
 * The health check reads this. The scheduler writes it. Nothing else.
 */

let enabled = false;
let lastTickAt: number | null = null;
let startedAt: number | null = null;

export type SchedulerSnapshot = {
  enabled: boolean;
  lastTickAt: number | null;
  startedAt: number;
};

export function markSchedulerEnabled(at = Date.now()): void {
  enabled = true;
  if (startedAt === null) startedAt = at;
}

export function markSchedulerTick(at = Date.now()): void {
  lastTickAt = at;
}

export function schedulerSnapshot(now = Date.now()): SchedulerSnapshot {
  return { enabled, lastTickAt, startedAt: startedAt ?? now };
}

export function resetSchedulerClockForTests(): void {
  enabled = false;
  lastTickAt = null;
  startedAt = null;
}
