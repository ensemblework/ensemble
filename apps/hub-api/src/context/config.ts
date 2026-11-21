/**
 * The numbers that choose what a node turn is given from its owner's workspace, its memories, the skills
 * catalogue and its tool tiers (docs/35 §5.6): every weight, cap, budget and rule in one versioned config, with the
 * defaults here.
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

/**
 * The default tool tiers (node/skills.ts `chooseTiers`): tools a conversation turn is offered only for their kind of
 * work. Tools by name, or a prefix ending in `*`; words as case-insensitive regular expressions, any one calling for them.
 */
export const DEFAULT_TOOL_TIERS = [
  {
    name: "advanced",
    tools: ["browser_console", "browser_network_errors", "browser_record", "browser_upload", "capture_app_start", "capture_app_stop", "capture_apps", "capture_check", "capture_status", "capture_video", "capture_screenshot"],
    words: [
      String.raw`\b(?:videos?|record(?:ing)?|screencast|gif|(?:browser|js|javascript|dev ?tools) console|console (?:logs?|errors?|messages?|output)|network (?:errors?|requests?|tab)|devtools|upload|dev server|localhost|127\.0\.0\.1|desktop app|electron|tauri|app window|e2e|end[- ]to[- ]end|playwright|(?:test|testing|tested|debug|debugging|qa|build|building|check|checking)\b[^.?!\n]{0,40}\b(?:app|apps|site|website|web ?page|page|ui|frontend|front[- ]end|sign-?up|log-?in|form|flow|feature|endpoint|game|build))\b`,
    ],
  },
  {
    // An app on the owner's screen: its windows, the screen, a recording, the computer itself.
    name: "desktop",
    tools: ["desktop_*"],
    words: [
      String.raw`\b(?:desktop|(?<!web[ -]?)apps?|applications?|programs?|windows?|screens?|screenshots?|gui|record(?:ing)?|videos?|screencast|calculator|install(?:er|ing)?|file manager|finder|menu bar|dialog|click(?:s|ed|ing)?)\b`,
      String.raw`\btype (?:in|into)\b`,
      String.raw`\b(?:open|close|quit)\s+\S`,
      String.raw`\b(?:is|are)\s+[^?.!\n]{1,40}?\s+(?:running|open)\b`,
      String.raw`\bmy\s+(?:mac|pc|computer|laptop|desktop|machine)\b`,
    ],
  },
  {
    // Work for several nodes: a crew's plan, a step for a member or a helper.
    name: "crew",
    tools: ["node_plan", "node_plan_revise", "node_delegate", "node_crew_add"],
    words: [String.raw`@[a-z0-9]|\b(?:crew|delegate|delegating|helpers?|(?:other|my|your|another|new|the) nodes?\b(?!\.\w))`],
    always: "crew" as const,
  },
  { name: "sessions", tools: ["node_session_delete", "node_session_queue", "node_session_adopt", "node_session_hand_over", "node_answer_question"], words: [String.raw`\b(?:sessions?|claude|codex|copilot|cursor|gemini|coding agents?|adopt|hand (?:it )?over|queue)\b`] },
  { name: "terminal", tools: ["terminal_*", "live_view"], words: [String.raw`\b(?:terminal|shell|interactive|ssh|repl|live|watch|tty|tmux|htop)\b`] },
  {
    name: "maker",
    tools: ["node_create", "node_create_group", "node_routines"],
    words: [String.raw`\b(?:routines?|every (?:day|morning|evening|night|week(?:day)?|month|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+)|daily|weekly|monthly|hourly|each (?:day|morning|evening|week|month)|recurring|automat\w*|(?:a|new|another) (?:node|group|crew)\b(?!\.\w))`],
  },
];

const regexSource = z.string().min(1).max(4_000).refine((source) => {
  try {
    new RegExp(source, "i");
    return true;
  } catch {
    return false;
  }
}, "Not a regular expression.");

const ToolTier = z.object({
  name: z.string().min(1).max(40),
  tools: z.array(z.string().min(1).max(100)).min(1).max(100),
  words: z.array(regexSource).max(50),
  /** What about the node keeps the tier in every turn: `crew`, it leads a crew, has helpers or other nodes, or works in a crew, task room or plan. */
  always: z.enum(["crew"]).optional(),
});
const count = (value: number, max = 1_000) => z.number().int().min(0).max(max).default(value);

export const ContextConfig = z.object({
  /** Change it with every change of the defaults; recorded with each turn's choices. */
  version: z.string().max(40).default("2026-11-22.1"),
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
  /** Tools a conversation turn is offered only for their kind of work (node/skills.ts `chooseTiers`); the rest stay within reach through hub_use_tool. */
  tools: z
    .object({
      tiers: z.array(ToolTier).max(20).default(DEFAULT_TOOL_TIERS),
      /** Replies looked back over for a tier's tools used lately. */
      recentReplies: count(3, 50),
    })
    .default({}),
});
export type ContextConfig = z.infer<typeof ContextConfig>;
export type RetrievalConfig = ContextConfig["retrieval"];
export type MemoryConfig = ContextConfig["memory"];
export type SkillsConfig = ContextConfig["skills"];
export type ToolTiersConfig = ContextConfig["tools"];

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
