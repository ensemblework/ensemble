/**
 * Runs an assistant turn (or a one-off completion) on the person's own AI subscription
 * (docs/30 §8): on this computer when this is the desktop runtime, else on a paired computer
 * that has the agent, through the relay. The caller supplies the tools; this file picks the
 * computer and turns its problems into words.
 */
import { hostname } from "node:os";
import type { Device } from "@prisma/client";
import { ASSISTANT_TURNS_API, parseSubscriptionAgents, SUBSCRIPTION_INFO, type Settings, type SubscriptionAgent, type SubscriptionProvider } from "@ensemble/shared-types";
import { deviceOnline } from "../devices/constants.js";
import { prisma as defaultPrisma } from "../lib/prisma.js";
import { RuntimeError } from "../lib/runtime-error.js";
import { currentScope, keysFor } from "../sharing/context.js";
import { AgentTurnError, runAgentTurn, type AgentTurnResult, type AgentTurnSpec } from "./agents.js";
import type { ToolAnswer, ToolSpec } from "./bridge.js";
import { runOnComputer } from "./relay.js";

type Prismaish = Pick<typeof defaultPrisma, "device">;

/** The computer that runs a turn: this one (desktop runtime) or a paired one. */
export type TurnComputer = { local: true; name: string } | { local: false; id: string; name: string; agent: SubscriptionAgent | null };

const isDesktopRuntime = () => process.env.ENSEMBLE_DESKTOP === "1";

export function computerAgents(device: Pick<Device, "capabilities">): { turns: number; agents: SubscriptionAgent[] } {
  const caps = (device.capabilities ?? {}) as { assistantTurns?: unknown; agents?: unknown };
  return { turns: typeof caps.assistantTurns === "number" ? caps.assistantTurns : 0, agents: parseSubscriptionAgents(caps.agents) };
}

/**
 * Whose paired computers a turn may use: the acting person's, never a space owner's when the
 * space was shared with them (that would spend the owner's subscription).
 */
export function deviceOwners(userId: string): string[] {
  const scope = currentScope();
  const owners = [keysFor(userId)];
  if (scope && scope.spaceId === userId && scope.access.kind === "owner" && scope.accountId !== userId) owners.push(scope.accountId);
  return owners;
}

const since = (date: Date | null): string => {
  if (!date) return "never";
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
};

/** The paired computer for this agent: the chosen one when it can, else the most recently seen that can; or why none can. */
export async function pickComputer(prisma: Prismaish, userId: string, agent: SubscriptionProvider, preferred: string | null): Promise<TurnComputer> {
  const label = SUBSCRIPTION_INFO[agent].label;
  if (isDesktopRuntime()) return { local: true, name: hostname().replace(/\.local$/, "") || "this computer" };
  const devices = await prisma.device.findMany({ where: { userId: { in: deviceOwners(userId) }, revokedAt: null }, orderBy: { lastSeenAt: "desc" } });
  if (!devices.length) {
    throw new RuntimeError(
      `${label} runs on your own computer with your ${label} sign-in. Install Ensemble there (the desktop app, or the ensemble CLI) and sign in with this account, then try again. Or pick a model with an API key in Settings → Models.`,
      409,
    );
  }
  const online = devices.filter((device) => deviceOnline(device.lastSeenAt));
  if (!online.length) {
    const last = devices[0]!;
    throw new RuntimeError(`${label} runs on your computer, and none is online. ${last.name} was last seen ${since(last.lastSeenAt)}. Open Ensemble on it (the desktop app, or \`ensemble\` in a terminal), then try again.`, 503);
  }
  const ordered = preferred ? [...online.filter((device) => device.id === preferred), ...online.filter((device) => device.id !== preferred)] : online;
  const able = ordered.filter((device) => computerAgents(device).turns >= ASSISTANT_TURNS_API);
  if (!able.length) {
    throw new RuntimeError(`Update Ensemble on ${ordered[0]!.name} to use your ${label} subscription from here (the CLI 0.3.10 or the desktop app 0.3.7).`, 409);
  }
  const withAgent = able.map((device) => ({ device, found: computerAgents(device).agents.find((row) => row.id === agent) ?? null })).filter((row) => row.found);
  const ready = withAgent.find((row) => row.found!.signedIn !== false);
  if (ready) return { local: false, id: ready.device.id, name: ready.device.name, agent: ready.found };
  if (withAgent.length) {
    throw new RuntimeError(`${label} is not signed in on ${withAgent[0]!.device.name}. Open Settings → Models → Your AI subscriptions and press Sign in next to ${label}.`, 409);
  }
  const info = SUBSCRIPTION_INFO[agent];
  throw new RuntimeError(`${able[0]!.name} does not have ${label}. ${info.install.label} there (${info.install.url}) and sign in, or pick another model in Settings → Models.`, 409);
}

/** The thinking level to send: only one the agent says it takes for this model. */
export function effortFor(agent: SubscriptionAgent | null, model: string | null, effort: string | null | undefined): string | null {
  if (!effort || effort === "default") return null;
  if (!agent) return effort;
  const perModel = agent.models.find((row) => row.id === model)?.efforts;
  const allowed = perModel ?? agent.efforts;
  return allowed?.includes(effort) ? effort : null;
}

export type SubscriptionTurnInput = {
  userId: string;
  settings: Pick<Settings, "models">;
  agent: SubscriptionProvider;
  model: string | null;
  effort?: string | null;
  system: string;
  prompt: string;
  tools: ToolSpec[];
  maxTurns?: number;
  call: (name: string, input: unknown) => Promise<ToolAnswer>;
  onDelta?: (text: string) => void;
  onStatus?: (text: string) => void;
  signal?: AbortSignal;
  prisma?: Prismaish;
};

export async function runSubscriptionTurn(input: SubscriptionTurnInput): Promise<AgentTurnResult & { computer: string }> {
  const label = SUBSCRIPTION_INFO[input.agent].label;
  const computer = await pickComputer(input.prisma ?? defaultPrisma, input.userId, input.agent, input.settings.models.computer ?? null);
  const spec: AgentTurnSpec = {
    agent: input.agent,
    model: input.model && input.model !== "default" ? input.model : null,
    effort: effortFor(computer.local ? null : computer.agent, input.model, input.effort),
    system: input.system,
    prompt: input.prompt,
    tools: input.tools,
    maxTurns: input.maxTurns ?? 16,
  };
  const signal = input.signal ?? new AbortController().signal;
  const onDelta = input.onDelta ?? (() => undefined);
  input.onStatus?.(`Asking ${label} on ${computer.name}…`);
  try {
    const result = computer.local
      ? await runAgentTurn(spec, { call: input.call, onDelta, signal })
      : await runOnComputer({ device: { id: computer.id, name: computer.name }, spec, call: input.call, onDelta, signal });
    return { ...result, computer: computer.name };
  } catch (error) {
    if (error instanceof AgentTurnError) throw new RuntimeError(error.message, error.problem === "limit" ? 429 : error.problem === "failed" ? 502 : 409);
    throw error;
  }
}

/** Ensemble's system messages and the conversation, as one system prompt and one message for an agent. */
export function agentConversation(messages: ReadonlyArray<Record<string, unknown>>, agent: SubscriptionProvider): { system: string; prompt: string } {
  const text = (value: unknown) => (typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value));
  const systems: string[] = [];
  const turns: Array<{ role: string; content: string }> = [];
  for (const message of messages) {
    const content = text(message.content).trim();
    if (!content) continue;
    if (message.role === "system") systems.push(content);
    else turns.push({ role: String(message.role), content });
  }
  const last = turns.length && turns[turns.length - 1]!.role === "user" ? turns.pop()!.content : "";
  const earlier = turns.map((turn) => `${turn.role === "user" ? "Person" : "You"}: ${turn.content}`).join("\n\n");
  return {
    system: [...systems, howYouRun(agent)].join("\n\n"),
    prompt: earlier ? `Earlier in this conversation, oldest first:\n\n${earlier}\n\n---\n\nThe person's new message:\n\n${last}` : last,
  };
}

export function howYouRun(agent: SubscriptionProvider): string {
  const label = SUBSCRIPTION_INFO[agent].label;
  return [
    "## How you run here",
    `You are the Ensemble assistant, running on the person's own ${label} subscription on their computer. Everything above is your instructions.`,
    'Your only tools are Ensemble\'s, from the MCP server named "ensemble" (a tool these instructions call hub_list_tasks may appear to you as mcp__ensemble__hub_list_tasks). You have no shell, files or web of your own: never offer to run commands or read local files.',
    "When a playbook or these instructions name a tool you cannot see, call hub_use_tool with its exact name and its input.",
    "Writes wait for the person to press Apply, exactly as these instructions say.",
  ].join("\n");
}

/** The dispatcher every turn has: any tool of the turn by name, for agents that do not re-list tools. */
export const USE_TOOL: ToolSpec = {
  name: "hub_use_tool",
  description: "Call one of Ensemble's tools by its exact name when it is not in your tool list, for example one a playbook names. Give the tool's input as an object.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", description: "The tool's exact name, e.g. hub_create_diagram." }, input: { type: "object", description: "The tool's input." } },
    required: ["name"],
  },
};

/** The first JSON value in a reply (agents may wrap it in prose or a code fence). */
export function jsonFrom(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  for (const candidate of [fenced, text]) {
    if (!candidate) continue;
    const start = candidate.search(/[[{]/);
    if (start < 0) continue;
    // Each closing bracket from the end, a bounded number of tries.
    let end = candidate.length;
    for (let tries = 0; tries < 40; tries += 1) {
      end = Math.max(candidate.lastIndexOf("}", end - 1), candidate.lastIndexOf("]", end - 1));
      if (end <= start) break;
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as unknown;
      } catch {
        // shorter
      }
    }
  }
  return undefined;
}
