/**
 * The bridge between an agent running an assistant turn on this computer and Ensemble's tools.
 * The agent starts Ensemble's MCP server (scripts/ensemble-ask-mcp.mjs with
 * ENSEMBLE_ASSISTANT_TURN); that server lists and calls the turn's tools through this runtime's
 * loopback API (`/api/engine/assistant/*`, routes/engine.ts) with the turn's own secret. The
 * tools themselves run where the turn's data is: in this process on the desktop, on Ensemble on
 * the web for a turn relayed from there.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
/** What a tool call tells the agent; `tools` is the turn's new list when the call changed it (hub_how_to). */
export type ToolAnswer = { text: string; isError?: boolean; tools?: ToolSpec[] };

type Bridge = {
  secret: string;
  tools: ToolSpec[];
  call: (name: string, input: unknown) => Promise<ToolAnswer>;
};

const bridges = new Map<string, Bridge>();

export function openBridge(tools: ToolSpec[], call: Bridge["call"]): { credential: string; close: () => void } {
  const id = randomUUID();
  const secret = randomBytes(24).toString("hex");
  const bridge: Bridge = { secret, tools, call };
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
