/**
 * What a checkout has that some tasks need, read from its source files: a task that requires something
 * this checkout lacks is skipped with "requires <capability>" rather than run and failed, so one suite
 * runs on v1 and on every v2 branch.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capability } from "./types.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const holds = (file: string, pattern: RegExp, root = REPO): boolean => {
  const path = join(root, file);
  return existsSync(path) && pattern.test(readFileSync(path, "utf8"));
};

export const CAPABILITIES: Record<Capability, { what: string; probe: (root?: string) => boolean }> = {
  "tool-journal": {
    what: "the node tool journal with restart reconciliation (node/journal.ts and node_tool_journal, from node-v2/orchestration-b)",
    probe: (root) => holds("apps/hub-api/src/node/journal.ts", /export async function uncertainCalls\b/, root) && holds("apps/hub-api/prisma/schema.prisma", /^model NodeToolJournal\b/m, root),
  },
  "code-tab-harness": {
    what: "the Code tab harness: threads, completion records, turn packets and handoff records (from node-v2/code-tab)",
    probe: (root) =>
      holds("apps/hub-api/src/workspace/completion.ts", /COMPLETION_SCHEMA/, root) &&
      holds("apps/hub-api/src/workspace/turn-packet.ts", /export const PacketSummarySchema\b/, root) &&
      holds("apps/hub-api/src/workspace/handoff-record.ts", /HANDOFF_SCHEMA/, root) &&
      holds("apps/hub-api/src/routes/code-threads.ts", /\/api\/agent\/threads\/:id\/fork/, root),
  },
};

/** What a task requires that this checkout (or the one at `root`) lacks, as "requires <capability> (<what>)". */
export function missing(requires: readonly Capability[] = [], root?: string): string | null {
  const lacking = requires.filter((capability) => !CAPABILITIES[capability].probe(root));
  return lacking.length ? `requires ${lacking.map((capability) => `${capability} (${CAPABILITIES[capability].what})`).join(" and ")}` : null;
}
