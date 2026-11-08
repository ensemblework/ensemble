/**
 * A candidate session's score (docs/30, Choosing a session): the sum of weight × signal, with each part
 * kept, so a stored decision can be scored again under other weights without its text. Pure: no
 * database, no clock.
 */
import type { SessionChoiceConfig } from "./config.js";

export type LinkReason = "mention" | "link" | "depends";

/** What is known about a candidate session against the new task. Stored with every decision. */
export interface Signals {
  /** The new task names a task done in the session. */
  link: LinkReason | null;
  deliverable: boolean;
  meeting: boolean;
  parentPage: boolean;
  /** Anchors both share that are not common (file paths, code names, issue numbers, addresses). */
  anchors: string[];
  /** Topic similarity 0–1, already scaled down for a small corpus; 0 when too few terms are shared. */
  topic: number;
  /** The most telling shared terms, for the reason shown. */
  sharedTerms: string[];
  followUp: boolean;
  newWork: boolean;
  /** Last active within `warmMinutes`. */
  warm: boolean;
  /** Share of the context window the session fills (0–1), when its agent reported it. */
  fill: number | null;
  /** Tasks done in the session. */
  tasks: number;
}

export type Parts = Record<string, number>;

export function scoreCandidate(signals: Signals, config: SessionChoiceConfig): { score: number; parts: Parts; tooFull: boolean } {
  const w = config.weights;
  const parts: Parts = {};
  if (signals.link) parts[signals.link] = w[signals.link];
  if (signals.deliverable) parts.deliverable = w.deliverable;
  if (signals.meeting) parts.meeting = w.meeting;
  if (signals.parentPage) parts.parentPage = w.parentPage;
  if (signals.anchors.length) parts.anchor = Math.min(w.anchorMax, w.anchor * signals.anchors.length);
  if (signals.topic > 0) parts.topic = round(w.topic * signals.topic);
  if (signals.followUp) parts.followUp = w.followUp;
  // New work counts against only when nothing ties the task to the session.
  if (signals.newWork && !signals.link && !signals.anchors.length) parts.newWork = w.newWork;
  if (signals.warm) parts.warm = w.warm;
  if (signals.fill !== null && signals.fill > config.size.soft) parts.sizeSoft = w.sizeSoft;
  if (signals.fill === null && signals.tasks > config.size.longChainTasks) parts.longChain = w.longChain;
  const tooFull = signals.fill !== null ? signals.fill > config.size.hard : signals.tasks > config.size.hardChainTasks;
  const score = round(Object.values(parts).reduce((sum, value) => sum + value, 0));
  return { score, parts, tooFull };
}

const round = (value: number) => Math.round(value * 100) / 100;

export type Band = "confident" | "unsure" | "none";

export const bandOf = (score: number, config: SessionChoiceConfig): Band => (score >= config.bands.confident ? "confident" : score >= config.bands.unsure ? "unsure" : "none");

export interface Scored<T> {
  candidate: T;
  score: number;
  parts: Parts;
  tooFull: boolean;
  lastActiveAt: string;
}

/**
 * The decision among scored candidates, best first (score, then the most recently active): continue the
 * best confident one that is not too full; when the best confident ones are all too full, a new session
 * that gets the best one's last report (`handover`); otherwise a new session, with the band of the best.
 */
export function decide<T>(scored: Array<Scored<T>>, config: SessionChoiceConfig): { ranked: Array<Scored<T>>; band: Band; pick: Scored<T> | null; handover: Scored<T> | null } {
  const ranked = [...scored].sort((a, b) => b.score - a.score || b.lastActiveAt.localeCompare(a.lastActiveAt));
  const best = ranked[0] ?? null;
  const band = best ? bandOf(best.score, config) : "none";
  if (band !== "confident") return { ranked, band, pick: null, handover: null };
  const pick = ranked.find((row) => bandOf(row.score, config) === "confident" && !row.tooFull) ?? null;
  return { ranked, band, pick, handover: pick ? null : best };
}
