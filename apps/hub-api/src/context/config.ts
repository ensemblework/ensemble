/**
 * The numbers that choose what a node turn is given from its owner's workspace, its memories and the skills
 * catalogue (docs/35 §5.6): every weight, cap and budget in one versioned config, with the defaults here.
 * Context DB retrieval (context/retrieve.ts), memory (node/memory.ts) and skill selection (node/skills.ts)
 * read it; each turn's `node.instructions` record names its version and hash with what was chosen, so a
 * choice can be judged again under other numbers.
 *
 * Tuning without a release: `ENSEMBLE_CONTEXT_CONFIG` holds a JSON object with only the fields to change,
 * or the path of a file with one (read again at most once a minute). An invalid override is ignored (the
 * defaults apply) and logged.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

const weight = (value: number) => z.number().min(-100).max(100).default(value);
const count = (value: number, max = 1_000) => z.number().int().min(0).max(max).default(value);

export const ContextConfig = z.object({
  /** Change it with every change of the defaults; recorded with each turn's choices. */
  version: z.string().max(40).default("2026-11-21.1"),
  retrieval: z
    .object({
      enabled: z.boolean().default(true),
      /** Tokens (characters / 4) for everything "From your workspace" shows. */
      budgetTokens: count(1_200, 8_000),
      /** Points per signal. An item's score is its kind's weight × (text × rank share + coverage × share of words + recency × decay + the bonuses). */
      weights: z
        .object({
          /** Times the item's full-text rank over the best rank of this request (0 to 1). */
          text: weight(1),
          /** Times the share of the request's words the item contains (0 to 1): more of them beats one in a title. */
          coverage: weight(1),
          /** Times exp(−ln 2 × age in days / `recencyHalfLifeDays`). */
          recency: weight(0.15),
          /** It belongs to the project open in this turn. */
          project: weight(0.3),
          /** The owner's words name it (its title or its link). */
          mentioned: weight(0.8),
          /** Open work: a task not done, an active project. */
          open: weight(0.1),
        })
        .default({}),
      /** Times its score, per kind. */
      kinds: z
        .object({
          task: weight(1),
          project: weight(1),
          page: weight(1),
          meeting: weight(1),
          person: weight(0.8),
          file: weight(0.9),
          app: weight(0.7),
        })
        .default({}),
      recencyHalfLifeDays: z.number().min(1).max(3_650).default(30),
      /** Items scoring less are left out. */
      minScore: z.number().min(0).max(100).default(0.3),
      /**
       * The newest rows of each kind read for a match, so a search costs the same however big the workspace is;
       * then the matching ones ranked (those with a word in their title first, then the newest, with the first
       * `rankChars` of their text), and how many of a kind can be shown.
       */
      recentPerKind: count(1_000, 20_000),
      rankPerKind: count(100, 5_000),
      rankChars: count(2_000, 100_000),
      perKind: count(6, 50),
      /** Items "Related to this request" at most. */
      maxRelated: count(10, 50),
      /** Always given in an owner's turn: open tasks due before today, due today, and today's calendar. */
      always: z.object({ overdue: count(8, 50), today: count(8, 50), events: count(10, 50) }).default({}),
      /** Characters of an item's own words shown with it; the rest stays behind its link. */
      snippetChars: count(160, 1_000),
      /** Words of the request searched, and how long a word is before its first letters also match (`deploym:*`). */
      queryTerms: count(16, 64),
      prefixFrom: count(6, 30),
      /** Characters of the owner's words and the task's goal read for the search. */
      queryChars: count(2_000, 20_000),
    })
    .default({}),
  memory: z
    .object({
      /** Bytes for the memories always given: pinned ones and the owner's preferences (scope owner). */
      alwaysBytes: count(2_048, 64_000),
      /** Tokens for all memories given, the always ones included. */
      budgetTokens: count(1_500, 8_000),
      /** A memory ranking lower for this turn's words is left out (0: the newest fill what room is left). */
      minRank: z.number().min(0).max(1).default(0),
    })
    .default({}),
  skills: z
    .object({
      /** Skills listed in the catalogue, and its characters. */
      max: count(8, 50),
      budgetChars: count(1_200, 20_000),
      /** Characters of a skill's "when to use" on its line. */
      lineChars: count(125, 1_000),
      /** Points per signal (node/skills.ts `scoreSkill`). */
      weights: z
        .object({
          /** Per keyword or phrase of the skill found in the request. */
          keyword: weight(3),
          /** The skill's name is in the request. */
          name: weight(4),
          /** Per word of the request in the skill's description (at most `descriptionMax` of them). */
          description: weight(1),
          descriptionMax: count(3, 50),
          /** Per word of the request in the first part of an owner's skill (at most `descriptionMax`). */
          body: weight(0.25),
          /** It was read in this conversation's last replies. */
          recent: weight(2),
          /** A process skill (priority p0): a lead over skills the request fits as well; alone, under `minScore`. */
          p0: weight(0.4),
        })
        .default({}),
      /** Skills scoring less are not listed. */
      minScore: z.number().min(0).max(100).default(0.5),
      /**
       * The best skill's guidance in full with the turn when its own words (keywords and name) give at least
       * `minScore` points (3: one keyword or phrase, what the regex skills before the catalogue needed), within
       * `chars` characters.
       */
      inline: z.object({ minScore: z.number().min(0).max(1_000).default(3), chars: count(1_500, 20_000) }).default({}),
      /** Replies looked back over for skills read with node_skill. */
      recentReplies: count(6, 100),
    })
    .default({}),
});
export type ContextConfig = z.infer<typeof ContextConfig>;
export type RetrievalConfig = ContextConfig["retrieval"];
export type MemoryConfig = ContextConfig["memory"];
export type SkillsConfig = ContextConfig["skills"];

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = ContextConfig.parse({});

/** The config's version and a short fingerprint of its values, stored with every turn's choices. */
export function contextConfigRef(config: ContextConfig): { version: string; hash: string } {
  return { version: config.version, hash: createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12) };
}

let cached: { raw: string; at: number; config: ContextConfig } | null = null;
let warned = "";

/** The config this process chooses with: the override when it is set and valid, else the defaults. */
export function activeContextConfig(log?: { warn: (data: object, message: string) => void }): ContextConfig {
  const raw = process.env.ENSEMBLE_CONTEXT_CONFIG?.trim() ?? "";
  if (!raw) return DEFAULT_CONTEXT_CONFIG;
  const inline = raw.startsWith("{");
  if (cached && cached.raw === raw && (inline || Date.now() - cached.at < 60_000)) return cached.config;
  let config = DEFAULT_CONTEXT_CONFIG;
  try {
    const parsed = ContextConfig.safeParse(JSON.parse(inline ? raw : readFileSync(raw, "utf8")));
    if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    config = parsed.data;
    warned = "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (warned !== message) log?.warn({ err: message }, "ENSEMBLE_CONTEXT_CONFIG ignored; node context uses its defaults");
    warned = message;
  }
  cached = { raw, at: Date.now(), config };
  return config;
}

/** Test seam: forget the cached override. */
export function resetContextConfigCache(): void {
  cached = null;
  warned = "";
}
