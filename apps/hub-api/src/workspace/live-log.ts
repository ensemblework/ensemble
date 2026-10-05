/** The tail of what a running job's commands printed, for the live view. In memory: a restart starts empty. */
const LIMIT = 24_000;
const logs = new Map<string, { text: string; end: number }>();

export function appendLive(jobId: string, text: string): void {
  const current = logs.get(jobId) ?? { text: "", end: 0 };
  const next = current.text + text;
  logs.set(jobId, { text: next.length > LIMIT ? next.slice(-LIMIT) : next, end: current.end + text.length });
}

export function liveLog(jobId: string): string {
  return logs.get(jobId)?.text ?? "";
}

/**
 * What was printed after character offset `from`, and the offset it ends at.
 * Text that already fell out of the tail is skipped, and `from` moves past it.
 */
export function liveLogSince(jobId: string, from: number): { from: number; text: string; end: number } {
  const current = logs.get(jobId);
  if (!current) return { from, text: "", end: from };
  const start = current.end - current.text.length;
  const at = Math.max(from, start);
  return { from: at, text: current.text.slice(at - start), end: current.end };
}

/** Kept a minute after the job ends so a mirror that syncs every few seconds still gets the last lines. */
export function dropLive(jobId: string): void {
  const current = logs.get(jobId);
  setTimeout(() => {
    if (logs.get(jobId) === current) logs.delete(jobId);
  }, 60_000).unref();
}
