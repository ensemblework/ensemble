/** Panel open: the person is watching a live call. */
export const ACTIVITY_POLL_OPEN_MS = 2_000;
/** Something is running, paused, or queued, and the panel is closed. */
export const ACTIVITY_POLL_BUSY_MS = 30_000;
/** Visible, idle, panel closed. A hidden tab does not poll. */
export const ACTIVITY_POLL_IDLE_MS = 5 * 60_000;

const DAY_MS = 86_400_000;

export function activityPollInterval(input: { hidden: boolean; open: boolean; idle: boolean }): number | false {
  if (input.hidden) return false;
  if (input.open) return ACTIVITY_POLL_OPEN_MS;
  if (input.idle) return ACTIVITY_POLL_IDLE_MS;
  return ACTIVITY_POLL_BUSY_MS;
}

/**
 * Commands for one agent-state poll.
 * Idle: SMEMBERS on the id set, plus GET for the pause flag.
 * Busy: those two, plus MGET of the live values.
 * The old poll used KEYS, which walked the whole keyspace.
 */
export function activityRedisCommandsPerPoll(hasActivities: boolean): number {
  return hasActivities ? 3 : 2;
}

export function activityCommandsPerDay(intervalMs: number | false, commandsPerPoll: number): number {
  if (intervalMs === false || intervalMs <= 0) return 0;
  return Math.round((DAY_MS / intervalMs) * commandsPerPoll);
}
