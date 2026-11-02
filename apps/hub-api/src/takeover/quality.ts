/**
 * How large and how good a live view's pictures are (docs/35 §8.17): watching, at most 1024 pixels wide
 * at JPEG quality 45; in control (a sign-in, a run's tab, a live view taken over), at most 1280 at 55.
 * Each frame's send time steers it: when frames take longer than `SLOW_MS` to reach the relay the
 * pictures get smaller and rougher, a step at a time; when they go quickly again they get better, more
 * slowly, so a link that is busy for a moment does not make them swing. Switching between watching and
 * control, and the next view on this computer within ten minutes, start as far down their steps as the
 * link was found to need (`linkStep`).
 */
export type FrameLevel = { maxWidth: number; quality: number };

export const WATCH_LEVELS: readonly FrameLevel[] = [
  { maxWidth: 1024, quality: 45 },
  { maxWidth: 896, quality: 40 },
  { maxWidth: 768, quality: 34 },
  { maxWidth: 640, quality: 28 },
];
export const CONTROL_LEVELS: readonly FrameLevel[] = [
  { maxWidth: 1280, quality: 55 },
  { maxWidth: 1152, quality: 48 },
  { maxWidth: 1024, quality: 42 },
  { maxWidth: 896, quality: 36 },
  { maxWidth: 768, quality: 30 },
];

/** A frame that takes longer than this to send makes the next ones smaller. */
export const SLOW_MS = 250;
/** Frames this quick make them better again. */
export const FAST_MS = 120;
/** At least this long between a step down and the next change. */
const DOWN_HOLD_MS = 1_500;
/** At least this long before a step up. */
const UP_HOLD_MS = 5_000;
/** How long what was learnt about this computer's link is used for the next view. */
const REMEMBER_MS = 10 * 60_000;

/** How far down its steps the last view on this computer ended up (0 the best, 1 the last), and when. */
const learnt = { step: 0, at: Number.NEGATIVE_INFINITY };

/** Where a new view starts on its steps: as far down as the link was lately found to need. */
export function linkStep(now: number = Date.now()): number {
  return now - learnt.at <= REMEMBER_MS ? learnt.step : 0;
}

const position = (index: number, count: number) => (count > 1 ? index / (count - 1) : 0);
const indexAt = (step: number, count: number) => Math.min(count - 1, Math.max(0, Math.round(step * (count - 1))));

export class FrameQuality {
  private index = 0;
  private average: number | null = null;
  private changedAt: number;

  constructor(
    private levels: readonly FrameLevel[],
    private readonly now: () => number = Date.now,
    step = 0,
  ) {
    this.changedAt = now();
    this.index = indexAt(step, levels.length);
  }

  get level(): FrameLevel {
    return this.levels[this.index]!;
  }

  /** Watching and control have their own steps: it goes on as far down the new ones as it was. */
  use(levels: readonly FrameLevel[]): FrameLevel {
    const step = position(this.index, this.levels.length);
    this.levels = levels;
    this.index = indexAt(step, levels.length);
    this.average = null;
    this.changedAt = this.now();
    return this.level;
  }

  /** One frame took `ms` to send: the new level when it changes, else null. */
  sent(ms: number): FrameLevel | null {
    this.average = this.average === null ? ms : this.average * 0.7 + ms * 0.3;
    const since = this.now() - this.changedAt;
    let next = this.index;
    if (this.average > SLOW_MS && since >= DOWN_HOLD_MS && this.index < this.levels.length - 1) next += 1;
    else if (this.average < FAST_MS && since >= UP_HOLD_MS && this.index > 0) next -= 1;
    if (next === this.index) return null;
    this.index = next;
    this.average = null;
    this.changedAt = this.now();
    learnt.step = position(this.index, this.levels.length);
    learnt.at = this.changedAt;
    return this.level;
  }
}
