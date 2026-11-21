/**
 * Who may use the desktop now. The takeover lease says whether the agent or the owner has it: while the
 * owner holds it, agent input and model screenshots pause; it returns to the agent after two minutes
 * without input at the computer (or when handed back), and every change bumps a counter, so anything the
 * agent started under the old counter is discarded. The controller claim says which conversation
 * drives the desktop: one at a time; the others are told they are busy, with their place in line.
 */

export const LEASE_IDLE_MS = 120_000;
/** Input at the computer this much after the agent's own last input is the owner's. */
export const OWNER_INPUT_MARGIN_MS = 750;
/** The agent counts as driving the desktop this long after its last input. */
export const ACTIVE_CONTROL_MS = 60_000;

export type LeaseView = { holder: "agent" | "owner"; counter: number; since: string; reason: string | null };

export class TakeoverLease {
  holder: "agent" | "owner" = "agent";
  counter = 0;
  since: number;
  reason: string | null = null;
  /** When the agent last sent input (its own, not the owner's). */
  lastAgentInputAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {
    this.since = now();
  }

  view(): LeaseView {
    return { holder: this.holder, counter: this.counter, since: new Date(this.since).toISOString(), reason: this.reason };
  }

  take(reason: string): void {
    this.holder = "owner";
    this.counter += 1;
    this.since = this.now();
    this.reason = reason;
  }

  release(reason: string): void {
    if (this.holder === "agent") return;
    this.holder = "agent";
    this.counter += 1;
    this.since = this.now();
    this.reason = reason;
  }

  agentInput(): void {
    this.lastAgentInputAt = this.now();
  }

  /**
   * The computer's idle time (ms since the last input anyone made), read now. The owner's lease ends after
   * two minutes of it; input the agent did not send while it drives the desktop is the owner taking over.
   * Null when the desktop does not say: the owner's lease then ends two minutes after it began.
   */
  observeIdle(idleMs: number | null): "released" | "taken" | null {
    const now = this.now();
    if (this.holder === "owner") {
      // Quiet since the takeover began: input before it does not count.
      const quiet = idleMs === null ? now - this.since : Math.min(idleMs, now - this.since);
      if (quiet >= LEASE_IDLE_MS) {
        this.release("expired");
        return "released";
      }
      return null;
    }
    if (idleMs === null || this.lastAgentInputAt === null) return null;
    const sinceAgent = now - this.lastAgentInputAt;
    if (sinceAgent > ACTIVE_CONTROL_MS) return null;
    if (idleMs < sinceAgent - OWNER_INPUT_MARGIN_MS) {
      this.take("owner_input");
      return "taken";
    }
    return null;
  }
}

export const CLAIM_IDLE_MS = 90_000;
/** A conversation told it is busy keeps its place this long without asking again. */
export const WAIT_KEEP_MS = 120_000;

type Holder = { key: string; label: string; since: number; lastUsed: number; pinned: boolean };
type Waiter = { key: string; label: string; since: number; lastAsked: number };

export type Claim = { ok: true } | { ok: false; place: number; holder: { label: string; since: string } };

export class Controllers {
  private holder: Holder | null = null;
  private waiting: Waiter[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  current(): { key: string; label: string; since: string } | null {
    this.lapse();
    return this.holder ? { key: this.holder.key, label: this.holder.label, since: new Date(this.holder.since).toISOString() } : null;
  }

  private lapse(): void {
    const now = this.now();
    this.waiting = this.waiting.filter((row) => now - row.lastAsked < WAIT_KEEP_MS);
    if (this.holder && !this.holder.pinned && now - this.holder.lastUsed > CLAIM_IDLE_MS) this.holder = null;
  }

  /** Whether `key` may drive the desktop now: it holds it, or nobody does and it is first in line. */
  claim(key: string, label: string): Claim {
    this.lapse();
    const now = this.now();
    if (this.holder?.key === key) {
      this.holder.lastUsed = now;
      return { ok: true };
    }
    const head = this.waiting[0];
    if (!this.holder && (!head || head.key === key)) {
      this.waiting = this.waiting.filter((row) => row.key !== key);
      this.holder = { key, label, since: now, lastUsed: now, pinned: false };
      return { ok: true };
    }
    let waiter = this.waiting.find((row) => row.key === key);
    if (!waiter) {
      waiter = { key, label, since: now, lastAsked: now };
      this.waiting.push(waiter);
    }
    waiter.lastAsked = now;
    const holder = this.holder ?? { label: head!.label, since: head!.since };
    return { ok: false, place: this.waiting.indexOf(waiter) + 1, holder: { label: holder.label, since: new Date(holder.since).toISOString() } };
  }

  /** A call of the holder ended: its claim lapses only after `CLAIM_IDLE_MS` from now. */
  touch(key: string): void {
    if (this.holder?.key === key) this.holder.lastUsed = this.now();
  }

  /** While it records, the controller keeps the desktop even without calls. */
  pin(key: string, pinned: boolean): void {
    if (this.holder?.key === key) {
      this.holder.pinned = pinned;
      this.holder.lastUsed = this.now();
    }
  }

  release(key: string): void {
    if (this.holder?.key === key) this.holder = null;
    this.waiting = this.waiting.filter((row) => row.key !== key);
  }

  holds(key: string): boolean {
    this.lapse();
    return this.holder?.key === key;
  }
}
