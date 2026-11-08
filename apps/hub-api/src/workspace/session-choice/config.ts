/**
 * The numbers that decide whether a new run continues an agent session (docs/30, Choosing a session):
 * every weight, band, size limit and word list in one versioned config, with the defaults here.
 *
 * Tuning without a release: Ensemble on the web reads an override file (`ENSEMBLE_SESSION_CHOICE_CONFIG`,
 * a JSON object with only the fields to change) and sends the result with each claim, so every computer
 * decides with it from its next run. A computer without one from the web (local only) reads the same
 * variable on itself, else uses the defaults. An invalid override is ignored (the defaults apply) and
 * logged. Each decision records the config's version and hash, and the signals of every candidate, so
 * it can be scored again under any other weights (`scoreCandidate` in score.ts).
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";

const weight = (value: number) => z.number().min(-100).max(100).default(value);
const pattern = (value: string) =>
  z
    .string()
    .max(500)
    .default(value)
    .refine((text) => {
      try {
        new RegExp(text, "i");
        return true;
      } catch {
        return false;
      }
    }, "Not a valid regular expression.");

export const SessionChoiceConfig = z.object({
  /** Change it with every change of the defaults or the override; stored on each decision. */
  version: z.string().max(40).default("2026-11-09.1"),
  enabled: z.boolean().default(true),
  /** Points per signal. A candidate's score is the sum of weight × signal (score.ts). */
  weights: z
    .object({
      mention: weight(10),
      link: weight(10),
      depends: weight(10),
      deliverable: weight(3),
      meeting: weight(3),
      parentPage: weight(2),
      /** Per shared anchor (a file path, code name, issue or PR number, address), up to `anchorMax` in all. */
      anchor: weight(3),
      anchorMax: weight(6),
      /** Times the topic similarity (0–1). */
      topic: weight(6),
      followUp: weight(1),
      newWork: weight(-1),
      warm: weight(1),
      /** The session fills more than `size.soft` of its context window. */
      sizeSoft: weight(-2),
      /** Its fill is unknown and it has more than `size.longChainTasks` tasks. */
      longChain: weight(-2),
    })
    .default({}),
  /** At or above `confident`: continue the session. At or above `unsure`: a new session, recorded as a near miss. */
  bands: z.object({ confident: weight(6), unsure: weight(3) }).default({}),
  size: z
    .object({
      /** Share of the context window past which the session scores less. */
      soft: z.number().min(0).max(1).default(0.4),
      /** Share past which it is never continued: the new session gets its last report instead. */
      hard: z.number().min(0).max(1).default(0.7),
      longChainTasks: z.number().int().min(1).max(1000).default(8),
      hardChainTasks: z.number().int().min(1).max(1000).default(15),
    })
    .default({}),
  /** A session last active this recently still has the provider's prompt cache warm. */
  warmMinutes: z.number().int().min(0).max(24 * 60).default(60),
  limits: z
    .object({
      /** Agents keep a session about this long (Claude Code: 30 days). */
      maxAgeDays: z.number().int().min(1).max(365).default(30),
      candidates: z.number().int().min(1).max(100).default(20),
      /** Text read per candidate session, and from the new task. */
      sessionChars: z.number().int().min(1000).max(200_000).default(20_000),
      taskChars: z.number().int().min(500).max(100_000).default(8000),
      /** Tasks the word rarity is learned from, and how long that table is kept. */
      corpusTasks: z.number().int().min(50).max(20_000).default(2000),
      corpusTtlMinutes: z.number().int().min(1).max(24 * 60).default(60),
      /** Below this many tasks the rarity table is unreliable: topic similarity counts proportionally less. */
      minCorpus: z.number().int().min(1).max(10_000).default(50),
      /** An anchor in more than this share of tasks (index.ts, package.json) is too common to count. */
      anchorMaxDocShare: z.number().min(0).max(1).default(0.2),
      /** Topic similarity counts only with at least this many shared meaningful terms. */
      topicMinShared: z.number().int().min(1).max(50).default(2),
      /** Past this, word matching stops and only links and structure decide. */
      timeBudgetMs: z.number().int().min(100).max(10_000).default(3000),
    })
    .default({}),
  text: z
    .object({
      /** Words ignored besides the built-in English list (text.ts STOPWORDS). */
      extraStopwords: z.array(z.string().max(40)).max(500).default([]),
      /** A title like this follows up earlier work. */
      followUp: pattern("^(fix|fixes|address|follow[- ]?up|also|again|revisit|continue|finish|polish|tweak|adjust|rework|redo|review comments?)\\b"),
      followUpLabels: z.array(z.string().max(40)).max(50).default(["bug", "fix", "hotfix", "follow-up", "followup", "regression"]),
      /** A title like this starts new work (it counts only when nothing anchors the task to the session). */
      newWork: pattern("^(new|create|build|implement|design|set ?up|start|scaffold|prototype)\\b"),
    })
    .default({}),
});
export type SessionChoiceConfig = z.infer<typeof SessionChoiceConfig>;

export const DEFAULT_SESSION_CHOICE: SessionChoiceConfig = SessionChoiceConfig.parse({});

/** A short fingerprint of the config a decision used. */
export function configHash(config: SessionChoiceConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12);
}

/** The config in a value (a claim's, a file's), or null when it is not a valid one. */
export function parseConfig(value: unknown): SessionChoiceConfig | null {
  if (value === undefined || value === null) return null;
  const parsed = SessionChoiceConfig.safeParse(value);
  return parsed.success ? parsed.data : null;
}

let cached: { path: string; mtimeMs: number; config: SessionChoiceConfig; checkedAt: number } | null = null;
let warned = "";

/**
 * The config this process decides with, or sends with claims: the override file when it is set and
 * valid (read again when it changes; looked at no more than once a minute), else the defaults.
 */
export async function activeConfig(log?: { warn: (data: unknown, message: string) => void }): Promise<SessionChoiceConfig> {
  const path = process.env.ENSEMBLE_SESSION_CHOICE_CONFIG?.trim();
  if (!path) return DEFAULT_SESSION_CHOICE;
  const now = Date.now();
  if (cached && cached.path === path && now - cached.checkedAt < 60_000) return cached.config;
  try {
    const info = await stat(path);
    if (cached && cached.path === path && cached.mtimeMs === info.mtimeMs) {
      cached.checkedAt = now;
      return cached.config;
    }
    const parsed = SessionChoiceConfig.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    cached = { path, mtimeMs: info.mtimeMs, config: parsed.data, checkedAt: now };
    warned = "";
    return parsed.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (warned !== message) log?.warn({ path, err: message }, "session choice config override ignored; using the defaults");
    warned = message;
    cached = { path, mtimeMs: -1, config: DEFAULT_SESSION_CHOICE, checkedAt: now };
    return DEFAULT_SESSION_CHOICE;
  }
}

/** Test seam: forget the cached override. */
export function resetConfigCache(): void {
  cached = null;
  warned = "";
}
