/**
 * The bridge between an agent running an assistant turn on this computer and Ensemble's tools.
 * The agent starts Ensemble's MCP server (scripts/ensemble-ask-mcp.mjs with
 * ENSEMBLE_ASSISTANT_TURN); that server lists and calls the turn's tools through this runtime's
 * loopback API (`/api/engine/assistant/*`, routes/engine.ts) with the turn's own secret. The
 * tools themselves run where the turn's data is: in this process on the desktop, on Ensemble on
 * the web for a turn relayed from there. A turn whose agent keeps its own tools also gets each of
 * them judged here (`/api/engine/assistant/ask`): by the hard floor in a chat (own-tools.ts), by the
 * node's folder policy in an Ensemble Node's turn (node-own-tools.ts).
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { bindAiContext } from "../lib/ai-activity.js";
import type { EngineAnswer, EngineCall } from "../workspace/engines/judge.js";

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
/** What a tool call tells the agent; `tools` is the turn's new list when the call changed it (hub_how_to). */
export type ToolAnswer = { text: string; isError?: boolean; tools?: ToolSpec[] };
/** How the agent's own calls in a turn are judged: allowed, or refused with why. */
export type OwnJudge = (calls: EngineCall[]) => Promise<EngineAnswer>;

/**
 * One of the agent's own calls in a node's turn that needs its owner's answer (node-own-tools.ts), as
 * this computer asks Ensemble on the web: what it acts on (a folder's real path, `program:<name>` for
 * a program that changes the system, or a web address's origin) and exactly what would run.
 */
export const OwnAskShape = z.object({
  /** `read`: reading the owner's files, asked only in a node's turn that is not its owner's own. */
  capability: z.enum(["run", "files", "read", "http"]),
  target: z.string().min(1).max(4096),
  label: z.string().min(1).max(300),
  scope: z.enum(["folder", "origin"]),
  /** The operation exactly: the command and the folder it runs in, the files it changes, or the address. */
  operation: z.string().min(1).max(4000),
  /** The same in a few words, for the note that wakes a parked turn ("npm install express"). */
  what: z.string().min(1).max(300),
});
export type OwnAsk = z.infer<typeof OwnAskShape>;

/**
 * What an answer to an ask covers, the same on the computer and on the web: changes and commands in a
 * folder (reading there too), calls to an address, one program that changes the system (for a run at
 * most), or one call that names no path (that call only).
 */
export type OwnAskKind = "write" | "origin" | "program" | "unnamed";
export function ownAskKind(ask: Pick<OwnAsk, "target" | "scope">): OwnAskKind {
  if (ask.target.startsWith("program:")) return "program";
  if (ask.target.startsWith("unnamed:")) return "unnamed";
  return ask.scope === "origin" ? "origin" : "write";
}

/** The owner's answer: allowed, with the grant this computer keeps as a rule; or not, and why (`waiting`: the turn parks). */
export const OwnAnswerShape = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("allow"), grant: z.object({ id: z.string().min(1).max(100), scope: z.enum(["once", "mission", "always"]), target: z.string().min(1).max(4096) }) }),
  z.object({ decision: z.literal("deny"), message: z.string().max(2000), waiting: z.boolean().optional() }),
]);
export type OwnAnswer = z.infer<typeof OwnAnswerShape>;

/** One of the agent's own calls (its shell, files, web) starting or ending, as a node's chat shows it. `acts`: it can change something. */
export const OwnToolEventShape = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  summary: z.string().max(300),
  phase: z.enum(["start", "end"]),
  ok: z.boolean().optional(),
  acts: z.boolean(),
});
export type OwnToolEvent = z.infer<typeof OwnToolEventShape>;

type Bridge = {
  secret: string;
  tools: ToolSpec[];
  call: (name: string, input: unknown) => Promise<ToolAnswer>;
  /** How the agent's own calls are judged, when it keeps its own tools; absent: it has only Ensemble's. */
  judge?: OwnJudge;
};

const bridges = new Map<string, Bridge>();

export function openBridge(tools: ToolSpec[], call: Bridge["call"], options: { judge?: OwnJudge } = {}): { credential: string; close: () => void } {
  const id = randomUUID();
  const secret = randomBytes(24).toString("hex");
  // The judge runs in the turn's AI context: a refusal is logged under its chat, whichever request asked.
  const bridge: Bridge = { secret, tools, call, ...(options.judge ? { judge: bindAiContext(options.judge) } : {}) };
  bridges.set(id, bridge);
  return {
    credential: `${id}.${secret}`,
    close: () => {
      if (bridges.get(id) === bridge) bridges.delete(id);
    },
  };
}

export function bridgeFor(credential: string | undefined): Bridge | null {
  if (!credential) return null;
  const dot = credential.lastIndexOf(".");
  if (dot <= 0) return null;
  const bridge = bridges.get(credential.slice(0, dot));
  if (!bridge) return null;
  const given = Buffer.from(credential.slice(dot + 1));
  const expected = Buffer.from(bridge.secret);
  return given.length === expected.length && timingSafeEqual(given, expected) ? bridge : null;
}

/** Calls a tool through the bridge; a new list from the call replaces the turn's. */
export async function callThroughBridge(bridge: Bridge, name: string, input: unknown): Promise<ToolAnswer> {
  const answer = await bridge.call(name, input);
  if (answer.tools) bridge.tools = answer.tools;
  return answer;
}
