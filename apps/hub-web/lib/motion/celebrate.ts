/** One celebration per real clear. The first reading is a baseline, so a page that
 *  loads already empty does not fire. */

export type ClearWatch = { seen: boolean; armed: boolean };

export function initialClear(): ClearWatch {
  return { seen: false, armed: false };
}

export function stepClear(watch: ClearWatch, count: number | null): { watch: ClearWatch; fire: boolean } {
  if (count === null) return { watch, fire: false };
  if (!watch.seen) return { watch: { seen: true, armed: count > 0 }, fire: false };
  if (count > 0) return { watch: { seen: true, armed: true }, fire: false };
  if (watch.armed) return { watch: { seen: true, armed: false }, fire: true };
  return { watch, fire: false };
}

export type TaskSnap = {
  id: string;
  status: string;
  priority: string;
  due: string | null;
  todayFocus: string;
  snoozedUntil: string | null;
};

function startOfDay(date: Date): number {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}

/** Proposed rows still waiting. This is the triage inbox on Today. */
export function inboxCount(tasks: TaskSnap[], now = Date.now()): number {
  return tasks.filter((task) => task.status === "proposed" && (!task.snoozedUntil || Date.parse(task.snoozedUntil) <= now)).length;
}

/** Same membership as Today's focus list: pinned, p0, or due today, and not finished. */
export function focusIds(tasks: TaskSnap[], now = new Date()): string[] {
  const today = startOfDay(now);
  return tasks
    .filter((task) => {
      if (task.status === "done" || task.status === "dropped" || task.status === "proposed") return false;
      if (task.todayFocus === "hidden") return false;
      if (task.todayFocus === "keep") return true;
      if (task.priority === "p0") return true;
      if (!task.due) return false;
      const due = new Date(task.due);
      if (Number.isNaN(due.getTime())) return false;
      return startOfDay(due) <= today;
    })
    .map((task) => task.id);
}

export type TodayWatch = { seen: boolean; ids: string[] };

export function initialToday(): TodayWatch {
  return { seen: false, ids: [] };
}

/** Fires only when every task that was on Today is now marked done. */
export function stepToday(watch: TodayWatch, tasks: TaskSnap[] | null, now = new Date()): { watch: TodayWatch; fire: boolean } {
  if (!tasks) return { watch, fire: false };
  const ids = focusIds(tasks, now);
  if (!watch.seen) return { watch: { seen: true, ids }, fire: false };
  if (ids.length > 0) return { watch: { seen: true, ids }, fire: false };
  const cleared = watch.ids.length > 0 && watch.ids.every((id) => tasks.find((task) => task.id === id)?.status === "done");
  return { watch: { seen: true, ids: [] }, fire: cleared };
}

export function needsCount(input: {
  shell: { approvals: number; decisions: number } | null;
  approvals: number | null;
  decisions: number | null;
  blocked: number | null;
}): number | null {
  if (!input.shell && input.approvals === null && input.decisions === null) return null;
  const approvals = input.approvals ?? input.shell?.approvals ?? 0;
  const decisions = input.decisions ?? input.shell?.decisions ?? 0;
  const blocked = input.blocked ?? 0;
  return approvals + decisions + blocked;
}

/** How long the pose stays up, read from the suite tokens. */
export function celebrateHoldMs(style: CSSStyleDeclaration): number {
  const move = Number.parseFloat(style.getPropertyValue("--m-dur-move"));
  const ui = Number.parseFloat(style.getPropertyValue("--m-dur-ui"));
  const a = Number.isFinite(move) && move > 0 ? move : 0;
  const b = Number.isFinite(ui) && ui > 0 ? ui : 0;
  return a + b;
}
