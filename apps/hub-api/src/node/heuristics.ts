/**
 * The numbers Ensemble Node decides with (docs/35 §4, §5.7, §6.2-6.3), in one versioned config: the
 * router's brakes, the group modes' deadline, how big a plan may be, how far a stuck step climbs before its
 * owner is asked, and the watchdog's stall rules. None is a limit of Ensemble's own on work: they are brakes
 * on runaway planning and waiting, with generous defaults. Every decision it records (`node_decisions`,
 * node/trace.ts) names the config's version and hash, so a decision can be judged again under other numbers.
 *
 * Tuning without a release: `ENSEMBLE_NODE_HEURISTICS_CONFIG` holds a JSON object with only the fields
 * to change, or the path of a file with one (read again at most once a minute). An invalid override is
 * ignored (the defaults apply) and logged.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

const limit = (value: number) => z.number().int().min(1).max(1_000).default(value);

export const NodeHeuristics = z.object({
  /** Change it with every change of the defaults; recorded on each decision. */
  version: z.string().max(40).default("2026-11-22.2"),
  router: z
    .object({
      /** Node messages in a row in a room (not a helper's room) after which a node's message wakes nobody. */
      botStreak: limit(8),
      /** How deep a chain of node messages under one person's message goes before a node's message wakes nobody. */
      botDepth: limit(12),
      /** Nodes one person's message wakes at most. */
      humanFanout: limit(6),
      /** Nodes one node's message wakes at most. */
      nodeFanout: limit(3),
      /**
       * Node messages of one request (since the last person's message) that the loop brakes read: two nodes
       * saying the same things back and forth (`cycle`), or a node saying the same thing twice at once
       * (`duplicate`), wakes nobody.
       */
      loopWindow: limit(12),
      /** A message of at most this many words is an acknowledgement ("Done.", "ok"): it never counts as a repeat. */
      loopAckWords: z.number().int().min(0).max(20).default(3),
    })
    .default({}),
  groups: z
    .object({
      /** Independent views (node/groups.ts): how long the nodes asked have to answer before their answers are brought together anyway. */
      independentDeadlineSeconds: z.number().int().min(30).max(86_400).default(600),
    })
    .default({}),
  /** How big one plan may be (node/plan-contract.ts `validatePlan`, node/plans.ts `addStep`). */
  plans: z
    .object({
      /** Steps in one plan. */
      maxSteps: limit(100),
      /** Requirements in one plan. */
      maxRequirements: limit(60),
      /** Failed agent runs one attempt of a step may have; then its node reports instead of starting another (node/sessions.ts). */
      maxStepFailures: limit(8),
    })
    .default({}),
  /** The escalation ladder for a stuck step (node/missions-core.ts `settle`): re-plan turns of its lead before its owner gets a card. */
  escalation: z
    .object({
      /** Re-plan turns the lead gets for one step that is blocked, failed the same way twice, or holds a conflict. */
      replanTurns: z.number().int().min(0).max(20).default(1),
    })
    .default({}),
  /** The watchdog's rules for work that stopped moving (node/watchdog.ts `checkWork`). */
  stall: z
    .object({
      /** A working step with no agent run, card or turn of its own, unchanged for this long: its worker is asked once, then it ends blocked. */
      stepMinutes: limit(15),
      /** A mission with nothing working and nothing changed for this long: its next move (or its lead's turn) is made again. */
      missionMinutes: limit(15),
      /** The same failure this many times in one mission: its owner gets the card at once. */
      sameError: limit(3),
      /** A card waiting for its owner this long gets one reminder. */
      cardMinutes: limit(30),
    })
    .default({}),
});
export type NodeHeuristics = z.infer<typeof NodeHeuristics>;
export type RouterBrakes = NodeHeuristics["router"];
export type StallRules = NodeHeuristics["stall"];

export const DEFAULT_NODE_HEURISTICS: NodeHeuristics = NodeHeuristics.parse({});

/** `<version>:<hash>`, stored on every decision made with this config. */
export function heuristicsVersion(config: NodeHeuristics): string {
  return `${config.version}:${createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12)}`;
}

let cached: { raw: string; at: number; config: NodeHeuristics } | null = null;
let warned = "";

/** The config this process decides with: the override when it is set and valid, else the defaults. */
export function activeHeuristics(log?: { warn: (data: unknown, message: string) => void }): NodeHeuristics {
  const raw = process.env.ENSEMBLE_NODE_HEURISTICS_CONFIG?.trim() ?? "";
  if (!raw) return DEFAULT_NODE_HEURISTICS;
  const inline = raw.startsWith("{");
  if (cached && cached.raw === raw && (inline || Date.now() - cached.at < 60_000)) return cached.config;
  let config = DEFAULT_NODE_HEURISTICS;
  try {
    const parsed = NodeHeuristics.safeParse(JSON.parse(inline ? raw : readFileSync(raw, "utf8")));
    if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    config = parsed.data;
    warned = "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (warned !== message) log?.warn({ err: message }, "ENSEMBLE_NODE_HEURISTICS_CONFIG ignored; Ensemble Node uses its defaults");
    warned = message;
  }
  cached = { raw, at: Date.now(), config };
  return config;
}

/** Test seam: forget the cached override. */
export function resetHeuristicsCache(): void {
  cached = null;
  warned = "";
}
