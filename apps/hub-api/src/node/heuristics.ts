/**
 * The numbers Ensemble Node decides with (docs/35 §4, §5.6), in one versioned config: the router's
 * brakes. Every decision it records (`node_decisions`, node/trace.ts) names the config's version and
 * hash, so a decision can be judged again under other numbers.
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
  version: z.string().max(40).default("2026-11-21.1"),
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
    })
    .default({}),
});
export type NodeHeuristics = z.infer<typeof NodeHeuristics>;
export type RouterBrakes = NodeHeuristics["router"];

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
