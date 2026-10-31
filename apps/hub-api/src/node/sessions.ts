/**
 * Ensemble Node as the controller of its owner's coding-agent sessions (docs/35 §8). The work itself
 * happens in the owner's own agent (Claude Code, Codex, Cursor, GitHub Copilot, Grok Build, OpenCode,
 * Gemini CLI, Antigravity) on their paired computer and their own subscription; a node starts a
 * session there, sends it the next message (after what is queued, as a change to the run going on,
 * or in place of it), stops it, and summarises what each session did. Every run is an Ensemble job,
 * so the computer's rules, Needs me and the run's record apply as for any task.
 *
 * Isolation: a session belongs to the node whose run it started with (its first node run), or to the
 * node it was last handed to or taken over by (`moveSession`). Other nodes never see or touch it. A
 * session started outside Node (the Hub, the CLI) belongs to no node until one continues or adopts it.
 *
 * A run a node starts on its own keeps its record on an internal task that stays off the board
 * (lib/node-tasks.ts); a run on a board task the owner named stays on that task.
 *
 * The node's tools and its owner's session card (node/session-routes.ts) call the same functions here,
 * so a steer, a queued message, a replacement, a stop, a reorder or a message taken out of the queue is
 * the same action from either, and each is recorded for the node's work board (node/session-queue.ts).
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { NodeAgent, NodeMessage, NodeRoom, PrismaClient } from "@prisma/client";
import { CODE_ENGINES, ENGINE_LABELS, engineHasSandbox, isCodeEngine, pickRunProfile, type CodeEngine, type RunProfile, type Settings } from "@ensemble/shared-types";
import { AssignInput, chooseComputer, chooseProfile, plan, type Plan } from "../assistant/tools/agent-assign.js";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool, type ToolContext, type ToolResult } from "../assistant/types.js";
import { isPaused } from "../lib/activity.js";
import { nodeTaskRef } from "../lib/node-tasks.js";
import { loadSettings } from "../lib/settings.js";
import { truncateText } from "../lib/text.js";
import { appendLedger } from "../lib/ledger.js";
import { sseHub } from "../lib/sse.js";
import { computerAgents } from "../subscriptions/turn.js";
import { createJob, inSession, sessionChoices, type AssignInput as JobRequest } from "../workspace/assign.js";
import { dropFromQueue, LIVE_RUN, listSessions, liveOrder, placeInQueue, reorderQueue, resolveSession, runsOfSession, summaryLine, type AgentSession, type SessionRun } from "../workspace/sessions.js";
import { steerOf } from "../workspace/trust.js";
import { stopJob } from "../workspace/worker.js";
import { postMessage, roomPeople, updateMessageData } from "./store.js";
import { finishStep, MAX_STEP_FAILURES, stepCardsWaiting, stepLive, stepRun, stepRuns, type PlanLink } from "./plans.js";
import { enqueueTurn } from "./queue.js";
import { recordSessionEvent, refreshSessionCards, sessionOwners, type SessionAction, type SessionActor, type SessionVia } from "./session-queue.js";
import { appliedLine, requestedSettings, startingSettings, tuningProblem, type SettingValues, type Tuning } from "./settings.js";
import { questionTools } from "./session-questions.js";
import { secretScopeFor } from "./secret-scope.js";
import { missionContext } from "./placement.js";

export { sessionOwners };

export type SessionLineage = { rootMessageId: string | null; botDepth: number; fromNonOwner: boolean };

/** Where a session call runs from: a node turn, or an approval its owner gave. */
export type SessionEnv = {
  ctx: ToolContext;
  prisma: PrismaClient;
  app: FastifyInstance;
  node: NodeAgent;
  room: NodeRoom;
  lineage: SessionLineage;
  privateTo: string[] | null;
  /** A plan step's call: its runs and cards belong to the step (node/plans.ts). */
  plan?: PlanLink | null;
  /** chat: the node's own tool call (or a card of it its owner approved). card: its owner, on the session card. */
  via?: "chat" | "card";
};

const Agent = z.enum(["ensemble", ...CODE_ENGINES]);
export const DELIVERIES = ["queue", "steer", "replace"] as const;
export type Delivery = (typeof DELIVERIES)[number];

const options = AssignInput.omit({ taskId: true, instructions: true, session: true });

export const StartInput = options
  .extend({
    title: z.string().min(1).max(120).describe("A short name for this piece of work, shown on the run card (“Fix the login redirect”)."),
    prompt: z
      .string()
      .min(1)
      .max(6000)
      .describe("The message for the agent, sent as written: what to do and where, how to check it, what done looks like. Write it as the owner would to their agent."),
    taskId: z
      .string()
      .uuid()
      .optional()
      .describe("Only when your owner wants this work on their Ensemble board: the board task it belongs to (make one with hub_create_tasks). Leave out to keep the run off the board."),
    agent: Agent.optional().describe("Only when your owner names the agent: claude-code, codex, cursor-agent, copilot-cli (GitHub Copilot), grok-cli, opencode, gemini-cli, antigravity. Leave out for their run profile's agent, else one signed in on the computer."),
    fast: z.boolean().optional().describe("Only when your owner asks for the model's fast mode (Claude Code, Codex): true, or false to turn it off."),
  })
  .strict();
export type StartInput = z.infer<typeof StartInput>;

export const SendInput = z
  .object({
    session: z.string().uuid().describe("The session's id, from node_sessions."),
    prompt: z.string().min(1).max(6000).describe("The message for the agent, sent as written. For steer: only the change."),
    title: z.string().min(1).max(120).optional().describe("A short name for this piece of work, for the run card. Leave out for steer."),
    delivery: z
      .enum(DELIVERIES)
      .default("queue")
      .describe(
        "queue: after what the session is doing and what is queued in it (now, when it is idle). " +
          "steer: change the run going on now: it is interrupted and goes on at once in the same conversation with this update, keeping what it did; what is queued stays after it. " +
          "replace: stop the run going on and drop what is queued, then do this instead.",
      ),
    taskId: z.string().uuid().optional().describe("Only when your owner wants this work on their Ensemble board: the board task it belongs to."),
    model: z.string().max(120).optional().describe("Only when your owner names a model for the agent. Leave out to keep the session's; its thinking level, context window and fast mode carry over unless named too."),
    effort: z.string().max(20).optional().describe("Only when your owner names a thinking level; default for the model's own. Leave out to keep the session's."),
    context: z.enum(["default", "long_context"]).optional().describe("Only when your owner names the context window: long_context for the long (1M) window, default for the standard one. Leave out to keep the session's."),
    fast: z.boolean().optional().describe("Only when your owner names the model's fast mode (Claude Code, Codex): true, or false to turn it off. Leave out to keep the session's."),
    mode: z.enum(["ask", "review", "unattended"]).optional().describe("Only when your owner says: ask, review or unattended."),
  })
  .strict();
export type SendInput = z.infer<typeof SendInput>;

export const StopInput = z
  .object({
    session: z.string().uuid().describe("The session's id, from node_sessions."),
    queued: z.enum(["drop", "keep"]).default("drop").describe("drop: also drop the messages queued in it. keep: they run after the stop."),
  })
  .strict();

export const QueueInput = z
  .object({
    session: z.string().uuid().describe("The session's id, from node_sessions."),
    order: z.array(z.string().uuid()).max(100).optional().describe("Every message queued in it (their jobIds from node_sessions' queue), in the order they should run."),
    cancel: z.array(z.string().uuid()).min(1).max(100).optional().describe("Queued messages (jobIds) to take out of the queue. They never start."),
  })
  .strict();
export type QueueInput = z.infer<typeof QueueInput>;

export const AdoptInput = z.object({ session: z.string().uuid().describe("The session's id, from node_sessions (one with yours: false).") }).strict();

export const HandOverInput = z
  .object({
    session: z.string().uuid().describe("The session's id, from node_sessions."),
    to: z.string().trim().min(1).max(80).describe("The handle of another of your owner's nodes, e.g. @designer."),
    note: z.string().trim().min(1).max(600).optional().describe("What that node should know to carry the session on, in a line or two."),
  })
  .strict();
export type HandOverInput = z.infer<typeof HandOverInput>;

export type SessionCall = { action: "start"; input: StartInput } | { action: "send"; input: SendInput } | { action: "hand_over"; input: HandOverInput };

/** Whether the owner asked this node to check with them before it starts work on their computer. */
export function computerWorkAsks(node: Pick<NodeAgent, "autonomy">): boolean {
  const autonomy = (node.autonomy && typeof node.autonomy === "object" ? node.autonomy : {}) as Record<string, unknown>;
  return autonomy.computerWork === "ask";
}

const scopeOf = (node: Pick<NodeAgent, "userId">) => ({ space: node.userId, runner: null });

export type NodeSession = AgentSession & { yours: boolean };

/** The sessions this node may use, most recently active first: its own, then those no node owns. Other nodes' never show. */
export async function sessionsForNode(prisma: PrismaClient, node: Pick<NodeAgent, "id" | "userId">, filter: { query?: string; limit?: number } = {}): Promise<NodeSession[]> {
  const all = await listSessions(prisma, scopeOf(node), { query: filter.query, limit: 100 });
  const owners = await sessionOwners(prisma, node.userId, all.map((row) => row.id));
  return all
    .filter((row) => {
      const owner = owners.get(row.id);
      return !owner || owner === node.id;
    })
    .map((row) => ({ ...row, yours: owners.get(row.id) === node.id }))
    .slice(0, Math.max(1, Math.min(filter.limit ?? 12, 50)));
}

/** A session this node may use, or why not. */
export async function usableSession(prisma: PrismaClient, node: Pick<NodeAgent, "id" | "userId">, id: string): Promise<AgentSession> {
  const session = await resolveSession(prisma, scopeOf(node), id);
  if (!session) throw new ToolBlockedError("There is no agent session with that id.", "List your sessions with node_sessions.");
  const owner = (await sessionOwners(prisma, node.userId, [session.id])).get(session.id);
  if (owner && owner !== node.id) {
    throw new ToolBlockedError("That session belongs to another of your owner's nodes; you cannot use it.", "Start a new session, or hand the work to that node (node_delegate).");
  }
  return session;
}

type WorkItem = { title: string; asked: string | null; result: string; status: string; at: string };

/** What a session did, one line per task in it (a steered run counts with the task it changed), newest last. */
async function workOf(prisma: PrismaClient, runs: SessionRun[], max: number): Promise<WorkItem[]> {
  const asked = await prisma.nodeRun.findMany({ where: { jobId: { in: runs.map((row) => row.id) } }, select: { jobId: true, prompt: true } });
  const prompts = new Map(asked.map((row) => [row.jobId, row.prompt]));
  const byTask = new Map<string, SessionRun[]>();
  for (const run of runs) byTask.set(run.taskId, [...(byTask.get(run.taskId) ?? []), run]);
  return [...byTask.values()].slice(-max).map((group) => {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const said = group.map((row) => prompts.get(row.id)).filter((text): text is string => Boolean(text?.trim()));
    return {
      title: first.title,
      asked: said.length ? truncateText(said.join(" · then: "), 400) : null,
      result: summaryLine(last.summary || last.error || last.progress) || (LIVE_RUN.has(last.status) ? "Not done yet." : "No summary."),
      status: last.status,
      at: (last.finishedAt ?? last.createdAt).toISOString(),
    };
  });
}

/** The run going on and the queue, as `node_session_queue` takes them. */
function queueView(row: Pick<AgentSession, "id">, runs: SessionRun[]) {
  const order = liveOrder(runs, row.id);
  const head = order[0];
  const current = head && (head.status !== "queued" || head.id === row.id) ? head : null;
  return {
    running: current ? { jobId: current.id, title: current.title, status: current.status } : null,
    queue: order.filter((run) => run.status === "queued" && run.id !== current?.id).map((run, index) => ({ jobId: run.id, title: run.title, position: index + 1 })),
  };
}

function sessionView(row: NodeSession, work: WorkItem[], runs: SessionRun[]) {
  return {
    id: row.id,
    yours: row.yours,
    agent: row.agentName,
    model: row.model === "default" ? null : row.model,
    effort: row.effort,
    context: row.contextTier ?? "default",
    fast: row.fast,
    computer: row.computer ?? "a paired computer",
    folder: row.folder,
    status: row.status,
    lastActive: row.lastActiveAt,
    tasks: row.tasks,
    runs: row.runs,
    ...queueView(row, runs),
    work,
  };
}

const agentLabel = (engine: string | null | undefined) => (engine && isCodeEngine(engine) ? ENGINE_LABELS[engine] : "Ensemble's agent");

/** The run profile a node's sessions use unless a call names one: its own (Settings → run profiles), else its owner's default. */
export function nodeRunProfile(settings: Pick<Settings, "runProfiles" | "defaultRunProfileId" | "orchestration">, node: Pick<NodeAgent, "runProfileId">): RunProfile {
  return pickRunProfile(settings, node.runProfileId);
}

/**
 * What a node's sessions run with unless its owner names others, in one line for its persona: “GitHub
 * Copilot · gpt-6.1-sol · medium thinking · 1M context (the run profile “Copilot”)”. A profile with no
 * coding agent takes one signed in on the computer (`agentOn`).
 */
export function agentDefaults(profile: RunProfile): string {
  if (!isCodeEngine(profile.engine)) return `a coding agent signed in on the computer, on its default model (the run profile “${profile.name}”)`;
  const parts = [
    ENGINE_LABELS[profile.engine as CodeEngine],
    profile.model.trim() || "its default model",
    profile.effort && profile.effort !== "default" ? `${profile.effort} thinking` : "",
    profile.context === "long_context" ? "1M context" : "",
  ].filter(Boolean);
  return `${parts.join(" · ")} (the run profile “${profile.name}”)`;
}

/**
 * A coding agent signed in on the computer, for a run whose profile names none. With the sandbox on,
 * one that runs in its own OS sandbox there comes first: the others stop at once in a sandboxed run.
 */
export async function agentOn(prisma: Pick<PrismaClient, "device">, deviceId: string | undefined, engines: string[], sandboxed = false): Promise<CodeEngine> {
  const device = deviceId ? await prisma.device.findUnique({ where: { id: deviceId } }) : null;
  const signedIn = device ? computerAgents(device).agents.filter((agent) => agent.signedIn !== false).map((agent) => agent.id as string) : [];
  const runnable: string[] = engines.filter(isCodeEngine);
  const fits = (id: string) => !sandboxed || engineHasSandbox(id as CodeEngine, device?.platform);
  return (signedIn.find((id) => runnable.includes(id) && fits(id)) ?? signedIn.find((id) => runnable.includes(id)) ?? runnable.find(fits) ?? runnable[0] ?? "claude-code") as CodeEngine;
}

/** An agent that has no OS sandbox on that computer cannot take a sandboxed run: said before the run is made, with what to do. */
export async function refuseUnsandboxable(prisma: Pick<PrismaClient, "device">, deviceId: string | null | undefined, engine: string, sandboxed: boolean | undefined): Promise<void> {
  if (sandboxed === false || !isCodeEngine(engine)) return;
  const device = deviceId ? await prisma.device.findUnique({ where: { id: deviceId }, select: { platform: true, name: true } }) : null;
  if (!device || engineHasSandbox(engine, device.platform)) return;
  throw new ToolBlockedError(
    `${ENGINE_LABELS[engine]} has no OS sandbox Ensemble can turn on on ${device.name}, and this run profile has the sandbox on, so the run would stop at once.`,
    "Use another agent (Claude Code, Codex, Cursor or GitHub Copilot run sandboxed), or ask your owner to turn the sandbox off in the run profile: Ensemble still judges every command, edit and fetch.",
  );
}

/** The task a run keeps its record on: the board task named, else a new internal one off the board. */
async function taskFor(env: SessionEnv, input: { taskId?: string; title: string; prompt: string }): Promise<{ id: string; direct: boolean; made: boolean }> {
  if (input.taskId) {
    const task = await env.prisma.task.findFirst({ where: { id: input.taskId, userId: env.node.userId, deletedAt: null }, select: { id: true } });
    if (!task) throw new ToolBlockedError("That task is not on your owner's board.", "Use the id hub_create_tasks or hub_list_tasks gave, or leave taskId out to keep the run off the board.");
    return { id: task.id, direct: false, made: false };
  }
  const task = await env.prisma.task.create({
    data: {
      userId: env.node.userId,
      title: truncateText(input.title.trim(), 300),
      description: input.prompt,
      owner: "agent",
      status: "todo",
      sourceKind: "other",
      sourceRef: nodeTaskRef(env.node.id),
      createdBy: "agent",
    },
  });
  return { id: task.id, direct: true, made: true };
}

async function refuseWhenPaused(env: SessionEnv): Promise<void> {
  if (env.app.redis && (await isPaused(env.app.redis as never, env.node.userId))) {
    throw new ToolBlockedError("Your owner stopped all agent work in Ensemble (Stop everything), so nothing new can start.", "They resume it in Ensemble first.");
  }
  // A step that keeps failing reports instead of opening run after run on the owner's computer.
  if (env.plan?.planStep && (await stepRuns(env.prisma, env.plan.planId, env.plan.planStep)).failed >= MAX_STEP_FAILURES) {
    throw new ToolBlockedError(`${MAX_STEP_FAILURES} agent runs of this step have failed.`, "Report what happened: reply with the result, or call node_step_blocked with why.");
  }
}

/** A version like 0.4.18 from a computer's app version ("cli-0.4.18", "cli-test-0.4.19-testing.1", "0.4.18"). */
function versionOf(appVersion: string | null | undefined): number[] | null {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(appVersion ?? "");
  return found ? found.slice(1, 4).map(Number) : null;
}

/** Continuing a session needs Ensemble 0.4.18 there: older runtimes open a new agent session for every message. */
export const SESSION_CONTINUE_VERSION = [0, 4, 18];

export function continuesSessions(device: { appVersion: string | null; capabilities: unknown }): boolean {
  const caps = (device.capabilities ?? {}) as { sessions?: unknown };
  if (typeof caps.sessions === "number" && caps.sessions >= 1) return true;
  const version = versionOf(device.appVersion);
  // A computer that never said its version is not refused on a guess.
  if (!version) return true;
  for (let index = 0; index < 3; index += 1) {
    if (version[index]! !== SESSION_CONTINUE_VERSION[index]!) return version[index]! > SESSION_CONTINUE_VERSION[index]!;
  }
  return true;
}

const squash = (value: string) => value.toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-").trim();
const EFFORT_WORDS: Record<string, string> = { "extra-high": "xhigh", "x-high": "xhigh", "very-high": "xhigh", maximum: "max", minimal: "minimal", none: "none" };

/**
 * The model and thinking level the computer's agent knows them by: a model named by its label ("GPT
 * 6.1 Sol") becomes its id, and a level the model does not take is refused here with the ones it
 * takes, before a run is made that the agent would refuse.
 */
export async function agentModel(prisma: PrismaClient, deviceId: string | null | undefined, engine: string, model: string | undefined, effort: string | undefined): Promise<{ model?: string; effort?: string }> {
  const out: { model?: string; effort?: string } = {};
  const wantedEffort = effort?.trim() ? (EFFORT_WORDS[squash(effort)] ?? squash(effort)) : undefined;
  const device = deviceId ? await prisma.device.findUnique({ where: { id: deviceId }, select: { capabilities: true, name: true } }) : null;
  const agent = device ? computerAgents(device).agents.find((row) => row.id === engine) : undefined;
  const models = agent?.models ?? [];
  let chosen: (typeof models)[number] | undefined;
  // "default" is the agent's own model or level: nothing to look up.
  if (model?.trim() && squash(model) === "default") out.model = "default";
  else if (model?.trim()) {
    const wanted = squash(model);
    chosen =
      models.find((row) => squash(row.id) === wanted || (row.aliases ?? []).some((alias) => squash(alias) === wanted)) ??
      models.find((row) => squash(row.label) === wanted) ??
      models.find((row) => squash(row.label).startsWith(wanted));
    if (!chosen && models.length && !agent?.typedModels) {
      throw new ToolBlockedError(
        `${agentLabel(engine)} on ${device!.name} has no model “${model}”.`,
        `Its models: ${models.filter((row) => row.id !== "auto").slice(0, 30).map((row) => `${row.id}${row.label !== row.id ? ` (${row.label})` : ""}`).join(", ")}.`,
      );
    }
    out.model = chosen?.id ?? model.trim();
  }
  if (wantedEffort === "default") out.effort = "default";
  else if (wantedEffort) {
    const levels = chosen?.efforts ?? agent?.efforts ?? [];
    if (levels.length && !levels.includes(wantedEffort)) {
      throw new ToolBlockedError(`${chosen?.label ?? model ?? agentLabel(engine)} does not take thinking “${effort}”.`, `It takes: ${levels.join(", ")}.`);
    }
    out.effort = wantedEffort;
  }
  return out;
}

/** The computer's listing of an agent (capabilities `agents`), to check settings against. */
async function listingOf(prisma: PrismaClient, deviceId: string | null | undefined, engine: string) {
  const device = deviceId ? await prisma.device.findUnique({ where: { id: deviceId }, select: { capabilities: true, name: true } }) : null;
  return { computer: device?.name ?? null, listing: device ? computerAgents(device).agents.find((row) => row.id === engine) ?? null : null };
}

/**
 * When settings were asked for, the run's instructions end by saying they are applied, so the agent does
 * not stop to check its own model (as the job's own fields say what it was sent).
 */
function withAppliedSettings(body: JobRequest, requested: SettingValues): JobRequest {
  if (!Object.keys(requested).length || body.engine === "ensemble") return body;
  const line = appliedLine({ model: body.model?.trim() || "default", effort: body.reasoningEffort?.trim() || "default", context: body.contextTier === "long_context" ? "long_context" : "default", fast: body.fast === true });
  if (!line) return body;
  return { ...body, instructions: truncateText([body.instructions, line].filter((part) => part?.trim()).join("\n\n"), 8000) };
}

/** A setting the computer's agent cannot honour stops the call with what to do instead; nothing is swapped quietly. */
async function refuseUnhonoured(prisma: PrismaClient, deviceId: string | null | undefined, engine: string, body: JobRequest, from: Pick<Tuning, "modelNamed" | "kept"> = {}): Promise<void> {
  const { computer, listing } = await listingOf(prisma, deviceId, engine);
  const problem = tuningProblem({
    engine,
    computer,
    listing,
    model: body.model?.trim() || null,
    effort: body.reasoningEffort?.trim() || null,
    context: body.contextTier === "long_context" ? "long_context" : null,
    fast: body.fast === true,
    ...from,
  });
  if (problem) throw new ToolBlockedError(problem.message, problem.remedy);
}

async function queueJob(env: SessionEnv, body: JobRequest, context: Record<string, unknown>, cleanup?: () => Promise<unknown>, keepSettings = false): Promise<string> {
  try {
    // A plan step's run works where its step holds its place (node/placement.ts): its worktree, its port.
    const mission = await missionContext(env.prisma, env.plan);
    const created = await createJob(env.prisma, env.node.userId, body, { actor: env.via === "card" ? "me" : "agent", keepSettings, context: { node: { nodeId: env.node.id }, secrets: await secretScopeFor(env.prisma, env), ...mission, ...context } as never });
    if (!created) throw new ToolBlockedError("That task is not available any more.");
    return created.jobId;
  } catch (error) {
    await cleanup?.().catch(() => undefined);
    if (error instanceof ToolBlockedError) throw error;
    // Trust, engine, folder and computer refusals are the owner's to resolve; say exactly what.
    throw new ToolBlockedError(error instanceof Error ? error.message : String(error));
  }
}

type Follow = { jobId: string; taskId: string; title: string; prompt: string; sessionId: string | null; direct: boolean; delivery: "new" | Delivery; requested: SettingValues };

/**
 * A run card in the room and the node run that follows the job (node/runs.ts reports when it ends),
 * with the run's settings (requested, resolved, observed; node/settings.ts) on both.
 */
async function followRun(env: SessionEnv, info: Follow): Promise<NodeMessage> {
  const { prisma, node, room } = env;
  const job = await prisma.workspaceJob.findUniqueOrThrow({
    where: { id: info.jobId },
    select: { status: true, progress: true, provider: true, model: true, reasoningEffort: true, context: true, folderLabel: true, repoUrl: true, device: { select: { name: true } } },
  });
  const settings = startingSettings(info.requested, job);
  const people = await roomPeople(prisma, room.id);
  // The computer and its work are the owner's: other people in a room do not see the card.
  const visibleTo = env.privateTo || people.some((id) => id !== node.userId) ? [node.userId] : [];
  const step = env.plan?.planStep ? env.plan : null;
  const { message } = await postMessage(prisma, {
    roomId: room.id,
    userId: node.userId,
    authorKind: "node",
    authorNodeId: node.id,
    kind: "run",
    body: info.title,
    planId: step?.planId ?? null,
    data: {
      ...(step ? { plan: { id: step.planId, step: step.planStep } } : {}),
      jobId: info.jobId,
      ...(info.direct ? { direct: true } : { taskId: info.taskId }),
      sessionId: info.sessionId,
      delivery: info.delivery,
      agent: agentLabel(job.provider),
      // What the run goes with, for the card: the engine's id, its model, thinking level and context window ("default" for the agent's own).
      engine: job.provider ?? null,
      model: settings.resolved.model ?? "default",
      effort: settings.resolved.effort ?? "default",
      context: settings.resolved.context ?? "default",
      status: job.status,
      computer: job.device?.name ?? null,
      progress: job.progress,
      summary: null,
      error: null,
      private: Boolean(env.privateTo),
      settings,
    },
    visibleTo,
    rootMessageId: env.lineage.rootMessageId,
    botDepth: env.lineage.botDepth,
  });
  await prisma.nodeRun.create({
    data: {
      userId: node.userId,
      nodeId: node.id,
      roomId: room.id,
      messageId: message.id,
      jobId: info.jobId,
      taskId: info.taskId,
      status: job.status,
      sessionId: info.sessionId,
      prompt: truncateText(info.prompt, 4000),
      direct: info.direct,
      planId: step?.planId ?? null,
      planStep: step?.planStep ?? null,
      settings: settings as never,
    },
  });
  return message;
}

/** Who took a run over: the plan step whose turn acted (if any), and the node when it acted itself (not its owner). */
type TakenBy = { plan: PlanLink | null; nodeId?: string };

/** The node itself acting in a call, unless its owner did on the session's card. */
const takenBy = (env: SessionEnv): TakenBy => ({ plan: env.plan ?? null, ...(env.via === "card" ? {} : { nodeId: env.node.id }) });

/**
 * The plan step this node's newest run in a session does, while that step goes on: steering or replacing
 * that run from the node's conversation (an attention turn, its owner's word) goes on with the step, as
 * the session's card does (node/session-routes.ts).
 */
async function ownStep(prisma: PrismaClient, node: Pick<NodeAgent, "id" | "userId">, sessionId: string): Promise<PlanLink | null> {
  const latest = await prisma.nodeRun.findFirst({ where: { userId: node.userId, nodeId: node.id, OR: [{ sessionId }, { sessionId: null, jobId: sessionId }] }, orderBy: { createdAt: "desc" } });
  return latest?.planId && latest.planStep && (await stepLive(prisma, latest.planId, latest.planStep)) ? { planId: latest.planId, planStep: latest.planStep } : null;
}

/**
 * Runs this node started that a newer call took over (steered, replaced, stopped, paused): their
 * cards say so, and node/runs.ts does not wake the node when they end.
 */
async function quiet(app: FastifyInstance, jobIds: string[], why: "steered" | "replaced" | "stopped" | "paused" | "cancelled", by: TakenBy = { plan: null }): Promise<void> {
  const current = by.plan;
  if (!jobIds.length) return;
  const prisma = app.prisma;
  const runs = await prisma.nodeRun.findMany({ where: { jobId: { in: jobIds }, reportedAt: null } });
  for (const run of runs) {
    const card = run.messageId ? await prisma.nodeMessage.findUnique({ where: { id: run.messageId } }) : null;
    if (card) await updateMessageData(prisma, card, { quiet: why });
  }
  // A plan step's run taken over from outside that step wakes nobody: its node hears it here instead,
  // so the step does not wait for it.
  const steps = new Map<string, { planId: string; planStep: string; nodeId: string; roomId: string }>();
  for (const run of runs) {
    if (!run.planId || !run.planStep || (current?.planId === run.planId && current.planStep === run.planStep)) continue;
    steps.set(`${run.planId}:${run.planStep}`, { planId: run.planId, planStep: run.planStep, nodeId: run.nodeId, roomId: run.roomId });
  }
  for (const step of steps.values()) {
    if (!(await stepLive(prisma, step.planId, step.planStep))) continue;
    if ((await stepRuns(prisma, step.planId, step.planStep)).pending || (await stepCardsWaiting(prisma, step.planId, step.planStep))) continue;
    // The step's own node did it from its conversation: that is the step going on, not a stop from outside.
    const own = by.nodeId === step.nodeId;
    const queued = await enqueueTurn(app, {
      nodeId: step.nodeId,
      roomId: step.roomId,
      reason: "run",
      note: own
        ? `You ${why} the agent run for your plan step from your conversation with your owner. Go on with the step, or report what it got done with node_step_report.`
        : `The agent run for your plan step was ${why} from outside the step. Reply with what the step got done, or call node_step_blocked with why it cannot be finished.`,
      planId: step.planId,
      planStep: step.planStep,
    });
    if (!queued) await finishStep(app, step.planId, step.planStep, { status: "stopped", result: `Its agent run was ${why}.` });
  }
}

export type Started = { summary: string; data: Record<string, unknown> };

function placeLine(found: Plan): string {
  const where = found.where.computer ? ` on ${found.where.computer.name}${found.where.computer.online ? "" : " (offline now: it starts when that computer is back)"}` : "";
  const folder = found.session ? ` in ${found.session.folder}` : found.body.repoUrl ? ` in a fresh clone of ${found.body.repoUrl}` : found.body.folderLabel ? ` in “${found.body.folderLabel}”` : " in a new folder";
  return `${where}${folder}`;
}

/** A new session with one of the owner's coding agents. */
export async function startSession(env: SessionEnv, input: StartInput): Promise<Started> {
  await refuseWhenPaused(env);
  // A plan step's runs go as its owner asked the lead (agent, model, thinking, context), unless named here.
  if (env.plan?.planStep) {
    const run = await stepRun(env.prisma, env.plan.planId, env.plan.planStep);
    const agent = Agent.safeParse(run.agent).success ? (run.agent as z.infer<typeof Agent>) : undefined;
    input = { ...input, agent: input.agent ?? agent, model: input.model ?? run.model, effort: input.effort ?? run.effort, context: input.context ?? run.context };
  }
  // What was asked, as asked (the step's settings count as asked); the profile fills in the rest.
  const requested = requestedSettings(input);
  const profile = input.profile ? chooseProfile(env.ctx, input.profile) : nodeRunProfile(env.ctx.settings, env.node);
  let agent: z.infer<typeof Agent> | undefined = input.agent ?? (isCodeEngine(profile.engine) ? profile.engine : undefined);
  const where = await chooseComputer(env.ctx, profile, agent ?? "claude-code", input.computer);
  if (!agent) agent = await agentOn(env.prisma, where.deviceId, where.computer?.engines ?? [], profile.sandbox);
  const named = await agentModel(env.prisma, where.deviceId, agent, input.model, input.effort);
  input = { ...input, ...named };
  const task = await taskFor(env, input);
  const cleanup = task.made ? () => env.prisma.task.delete({ where: { id: task.id } }) : undefined;
  let found: Plan;
  try {
    const { prompt: _prompt, title: _title, taskId: _taskId, fast, ...rest } = input;
    found = await plan(env.ctx, { ...rest, taskId: task.id, agent, profile: profile.id, ...(where.deviceId ? { computer: where.deviceId } : {}), ...(task.direct ? {} : { instructions: input.prompt }) });
    // Named here, over the profile's: fast mode, and the agent's own default thinking level.
    if (isCodeEngine(found.engine) && fast !== undefined) found.body.fast = fast;
    if (isCodeEngine(found.engine) && input.effort === "default") found.body.reasoningEffort = "default";
    await refuseUnhonoured(env.prisma, found.where.deviceId, found.engine, found.body);
    await refuseUnsandboxable(env.prisma, found.where.deviceId, found.engine, found.body.sandbox);
  } catch (error) {
    await cleanup?.().catch(() => undefined);
    throw error;
  }
  const jobId = await queueJob(env, withAppliedSettings(found.body, requested), {}, cleanup);
  const sessionId = isCodeEngine(found.engine) ? jobId : null;
  await followRun(env, { jobId, taskId: task.id, title: input.title, prompt: input.prompt, sessionId, direct: task.direct, delivery: "new", requested });
  if (sessionId) await refreshSessionCards(env.prisma, env.node.userId, sessionId);
  return {
    summary: `Started ${agentLabel(found.engine)}${placeLine(found)}: “${input.title}”. You hear when it ends.`,
    data: { session: sessionId, jobId, agent: agentLabel(found.engine), computer: found.where.computer?.name ?? null, onBoard: !task.direct },
  };
}

const ranOnComputer = (run: SessionRun) => Boolean(run.startedAt || run.claimedAt);
const ON_COMPUTER = new Set(["claimed", "running", "waiting_approval", "stopping"]);
const by = (env: SessionEnv) => (env.via === "card" ? { actor: "owner" as const, via: "card" as const } : { actor: "node" as const, via: "chat" as const });

/** Records the action for the node's work board and brings the session's cards up to date. */
async function noteAction(env: SessionEnv, sessionId: string, action: SessionAction, jobId: string | null, detail: Record<string, unknown> = {}): Promise<void> {
  await recordSessionEvent(env.prisma, { userId: env.node.userId, nodeId: env.node.id, sessionId, jobId, action, ...by(env), detail });
  await refreshSessionCards(env.prisma, env.node.userId, sessionId);
}

/**
 * Adds a change to a run that has not been claimed yet: a steer's change, or the brief of any other
 * run (both are read when the computer claims it). False when it was claimed meanwhile.
 */
async function amendQueued(prisma: PrismaClient, jobId: string, text: string): Promise<boolean> {
  const job = await prisma.workspaceJob.findUnique({ where: { id: jobId }, select: { instructions: true, context: true, status: true } });
  if (!job || job.status !== "queued") return false;
  const context = (job.context && typeof job.context === "object" ? job.context : {}) as Record<string, unknown>;
  const steer = steerOf(context);
  const data = steer
    ? { context: { ...context, steer: { update: truncateText(`${steer.update}\n\nAlso: ${text}`, 8000) } } as never }
    : { instructions: truncateText([job.instructions, `Update from your owner: ${text}`].filter((part) => part.trim()).join("\n\n"), 8000) };
  const changed = await prisma.workspaceJob.updateMany({ where: { id: jobId, status: "queued" }, data });
  if (changed.count !== 1) return false;
  const run = await prisma.nodeRun.findFirst({ where: { jobId }, select: { id: true, prompt: true } });
  if (run) await prisma.nodeRun.update({ where: { id: run.id }, data: { prompt: truncateText(`${run.prompt ?? ""}\n\nUpdate: ${text}`.trim(), 4000) } });
  return true;
}

/**
 * Takes queued runs out of a session (cancelled, never started), each only while still unclaimed, under
 * the session's lock (`dropFromQueue`): their tasks go back to To do, their cards say why and their ends
 * wake nobody. Returns the ids taken out.
 */
async function dropQueuedRuns(env: SessionEnv, sessionId: string, jobIds: string[], why: "replaced" | "stopped" | "cancelled", error: string): Promise<string[]> {
  const { prisma, node } = env;
  const dropped = await dropFromQueue(prisma, scopeOf(node), sessionId, jobIds, error);
  if (!dropped.length) return dropped;
  const jobs = await prisma.workspaceJob.findMany({ where: { id: { in: dropped } }, select: { id: true, taskId: true } });
  for (const job of jobs) {
    await prisma.task.updateMany({ where: { id: job.taskId, owner: "agent", status: { in: ["todo", "in_progress"] } }, data: { status: "todo" } });
    await appendLedger({ userId: node.userId, actor: env.via === "card" ? "me" : "agent", action: "workspace.job.stop", taskId: job.taskId, payload: { jobId: job.id, was: "queued", via: env.via ?? "chat" } });
    sseHub.publish(node.userId, { event: "workspace", data: { id: job.id } });
  }
  await quiet(env.app, dropped, why, takenBy(env));
  return dropped;
}

/** Stops runs of a session that are on their computer, newest first. Returns the ids asked to stop. */
async function stopOnComputer(env: SessionEnv, jobIds: string[]): Promise<string[]> {
  if (!jobIds.length) return [];
  const live = await env.prisma.workspaceJob.findMany({ where: { id: { in: jobIds }, status: { in: [...ON_COMPUTER] as never } }, orderBy: { createdAt: "desc" }, select: { id: true } });
  for (const job of live) await stopJob(env.app, env.node.userId, job.id);
  return live.map((job) => job.id);
}

/** The next message for one of this node's sessions: queued, steering the run going on, or replacing it. */
export async function sendToSession(env: SessionEnv, input: SendInput): Promise<Started> {
  const { prisma, node } = env;
  await refuseWhenPaused(env);
  const session = await usableSession(prisma, node, input.session);
  if (session.deviceId) {
    const device = await prisma.device.findUnique({ where: { id: session.deviceId }, select: { appVersion: true, capabilities: true, name: true } });
    if (device && !continuesSessions(device)) {
      throw new ToolBlockedError(
        `Ensemble on ${device.name} (${device.appVersion ?? "an old version"}) cannot carry on an agent session: every message would open a new session with the agent.`,
        "Tell your owner to update Ensemble there (`ensemble update`). Do not start new sessions to get around it.",
      );
    }
  }
  // What was asked, as asked; the session's own settings fill in the rest (inSession).
  const requested = requestedSettings({ model: input.model, effort: input.effort, context: input.context, fast: input.fast });
  input = { ...input, ...(await agentModel(prisma, session.deviceId, session.agent, input.model, input.effort)) };
  const runs = await runsOfSession(prisma, scopeOf(node), session.id);
  const chain = liveOrder(runs, session.id);
  const active = chain[0];
  let delivery: Delivery = input.delivery;
  if (delivery === "steer" && !active) delivery = "queue";
  if ((delivery === "steer" || delivery === "replace") && chain.length && !env.plan?.planStep && env.via !== "card") {
    const step = await ownStep(prisma, node, session.id);
    if (step) env = { ...env, plan: step };
  }
  const where = `${session.agentName}${session.computer ? ` on ${session.computer}` : ""}, ${session.folder}`;

  if (delivery === "steer") {
    // Not started yet: the change goes into its brief.
    if (active!.status === "queued" && (await amendQueued(prisma, active!.id, input.prompt))) {
      await noteAction(env, session.id, "steer", active!.id, { title: active!.title, joined: true });
      return { summary: `“${active!.title}” had not started yet, so the change is in its brief (${where}).`, data: { session: session.id, jobId: active!.id } };
    }
    // A change already waiting to go on after the interrupted run: this one joins it, in order.
    const pending = chain[1];
    if (pending && pending.continueFromJobId === active!.id && steerOf((await prisma.workspaceJob.findUnique({ where: { id: pending.id }, select: { context: true } }))?.context) && (await amendQueued(prisma, pending.id, input.prompt))) {
      await noteAction(env, session.id, "steer", pending.id, { title: active!.title, joined: true });
      return { summary: `Added to the change already going in to “${active!.title}” (${where}).`, data: { session: session.id, jobId: pending.id } };
    }
  }

  const steering = delivery === "steer";
  const fallbackTitle = input.title ?? truncateText(input.prompt.split("\n")[0]!.trim(), 80);
  // A steer is the same task going on; anything else is a new task in the session.
  const task = steering
    ? { id: active!.taskId, direct: (await prisma.nodeRun.findFirst({ where: { jobId: active!.id }, select: { direct: true } }))?.direct ?? false, made: false }
    : await taskFor(env, { taskId: input.taskId, title: fallbackTitle, prompt: input.prompt });
  const cleanup = task.made ? () => prisma.task.delete({ where: { id: task.id } }) : undefined;

  let body: JobRequest;
  try {
    const found = await plan(env.ctx, {
      taskId: task.id,
      session: session.id,
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.context ? { context: input.context } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(steering || !task.direct ? { instructions: input.prompt } : {}),
    });
    // Each setting is kept from the session, the agent's own default, or as named (workspace/assign.ts).
    const asked: JobRequest = {
      ...found.body,
      ...(input.effort === "default" ? { reasoningEffort: "default" } : {}),
      ...(input.fast !== undefined ? { fast: input.fast } : {}),
    };
    const choices = sessionChoices(asked, session.agent);
    body = await inSession(prisma, node.userId, asked).catch((error: unknown) => {
      throw new ToolBlockedError(error instanceof Error ? error.message : String(error));
    });
    await refuseUnhonoured(prisma, body.deviceId ?? session.deviceId, session.agent, body, {
      modelNamed: choices.model.state === "explicit",
      kept: { effort: choices.effort.state === "inherit", context: choices.context.state === "inherit", fast: choices.fast.state === "inherit" },
    });
  } catch (error) {
    await cleanup?.().catch(() => undefined);
    throw error;
  }
  delete (body as { session?: string }).session;

  // What the new run continues: a steer, the run it interrupts; a queued message, the end of the chain;
  // a replacement, the last run that reached the computer (a run never claimed has no folder there).
  // These are where it starts from; when it is claimed it continues the run that actually ran last.
  const fresh = delivery === "replace" && !chain.some(ranOnComputer) && !runs.some((row) => !LIVE_RUN.has(row.status) && ranOnComputer(row));
  if (steering) body.continueFromJobId = active!.id;
  else if (delivery === "queue" && chain.length) body.continueFromJobId = chain[chain.length - 1]!.id;
  else if (delivery === "replace") {
    const anchor = chain.find(ranOnComputer) ?? [...runs].reverse().find((row) => !LIVE_RUN.has(row.status) && ranOnComputer(row));
    if (anchor) body.continueFromJobId = anchor.id;
    else if (fresh) {
      // Nothing of the session reached the computer: start over where it was to work.
      const first = await prisma.workspaceJob.findUniqueOrThrow({ where: { id: session.id }, select: { folderLabel: true, repoUrl: true } });
      delete body.continueFromJobId;
      if (first.folderLabel) body.folderLabel = first.folderLabel;
      if (first.repoUrl) body.repoUrl = first.repoUrl;
    }
  }
  const jobId = await queueJob(env, withAppliedSettings(body, requested), steering ? { steer: { update: input.prompt } } : {}, cleanup, true);
  const sessionId = fresh ? jobId : session.id;

  // Only once the new run exists does anything stop. Its place in the queue is set under the session's
  // lock: a steer goes before everything queued, a queued message after it.
  if (steering) {
    await prisma.workspaceJob.updateMany({ where: { continueFromJobId: active!.id, status: "queued", id: { not: jobId } }, data: { continueFromJobId: jobId } });
    await placeInQueue(prisma, scopeOf(node), session.id, jobId, "first");
    const now = await prisma.workspaceJob.findUnique({ where: { id: active!.id }, select: { status: true, cancelRequestedAt: true } });
    if (now && now.status !== "stopping" && !now.cancelRequestedAt) await stopJob(env.app, node.userId, active!.id);
    await quiet(env.app, [active!.id], "steered", takenBy(env));
  } else if (delivery === "replace" && chain.length) {
    const ids = chain.map((row) => row.id);
    // What is queued never starts; then what is on the computer (or reached it meanwhile) stops.
    const dropped = await dropQueuedRuns(env, session.id, ids, "replaced", "Replaced by a newer message.");
    await stopOnComputer(env, ids.filter((id) => !dropped.includes(id)));
    await quiet(env.app, ids.filter((id) => !dropped.includes(id)), "replaced", takenBy(env));
    if (!fresh) await placeInQueue(prisma, scopeOf(node), session.id, jobId, "last");
  } else if (delivery === "queue") {
    await placeInQueue(prisma, scopeOf(node), session.id, jobId, "last");
  }

  const title = steering ? `Update: ${active!.title}` : fallbackTitle;
  await followRun(env, { jobId, taskId: task.id, title: truncateText(title, 200), prompt: input.prompt, sessionId, direct: task.direct, delivery, requested });
  await noteAction(env, sessionId, delivery, jobId, { title: truncateText(title, 200), ...(Object.keys(requested).length ? { settings: requested } : {}) });
  if (fresh) await refreshSessionCards(prisma, node.userId, session.id);
  const waiting = delivery === "queue" && chain.length ? ` It starts after ${chain.length === 1 ? `“${chain[0]!.title}”` : `the ${chain.length} runs ahead of it`}.` : "";
  const verb = steering
    ? `Steered “${active!.title}”: it goes on with your change`
    : delivery === "replace"
      ? `Stopped what the session was doing${chain.length ? ` (${chain.length} run${chain.length === 1 ? "" : "s"})` : ""} and started this instead`
      : chain.length
        ? "Queued in the session"
        : "Sent to the session";
  return {
    summary: `${verb} (${where}).${waiting} You hear when it ends.`,
    data: { session: sessionId, jobId, delivery, queuedBehind: delivery === "queue" ? chain.length : 0 },
  };
}

/** Stops a session's run going on, and unless asked to keep them, what is queued in it. */
export async function stopSession(env: SessionEnv, input: z.infer<typeof StopInput>): Promise<Started> {
  const { prisma, node } = env;
  const session = await usableSession(prisma, node, input.session);
  const chain = liveOrder(await runsOfSession(prisma, scopeOf(node), session.id), session.id);
  const queued = chain.filter((row) => row.status === "queued").map((row) => row.id);
  const busy = chain.filter((row) => row.status !== "queued").map((row) => row.id);
  if (!busy.length && (input.queued === "keep" || !queued.length)) return { summary: "Nothing is running in that session.", data: { session: session.id, stopped: 0 } };
  const dropped = input.queued === "drop" ? await dropQueuedRuns(env, session.id, queued, "stopped", "Removed from the queue.") : [];
  // A queued run claimed meanwhile is on its computer now: it stops too unless the queue is kept.
  const stopped = await stopOnComputer(env, input.queued === "drop" ? [...busy, ...queued.filter((id) => !dropped.includes(id))] : busy);
  const targets = [...stopped, ...dropped];
  await quiet(env.app, stopped, "stopped", takenBy(env));
  await noteAction(env, session.id, "stop", stopped[0] ?? null, { queued: input.queued, stopped: stopped.length, dropped: dropped.length });
  const titles = chain.filter((row) => targets.includes(row.id)).map((row) => `“${row.title}”`);
  const kept = input.queued === "keep" ? queued.length : 0;
  return {
    summary: `${titles.length ? `Stopped ${titles.join(", ")}.` : "Nothing was running."} What it changed so far stays.${kept ? ` ${kept} queued message${kept === 1 ? "" : "s"} will run next.` : ""}`,
    data: { session: session.id, stopped: targets.length },
  };
}

/**
 * Reorders a session's queued messages, or takes some out of the queue. Only messages not yet claimed
 * move or go, under the session's lock; an order made from a queue that changed meanwhile is refused.
 */
export async function editSessionQueue(env: SessionEnv, input: QueueInput): Promise<Started> {
  const { prisma, node } = env;
  if (Boolean(input.order) === Boolean(input.cancel)) throw new ToolBlockedError("Give either order or cancel.");
  const session = await usableSession(prisma, node, input.session);
  if (input.order) {
    await reorderQueue(prisma, scopeOf(node), session.id, input.order);
    await noteAction(env, session.id, "reorder", null, { order: input.order });
    return { summary: `The session's queue now runs in that order (${input.order.length} message${input.order.length === 1 ? "" : "s"}).`, data: { session: session.id, order: input.order } };
  }
  const runs = await runsOfSession(prisma, scopeOf(node), session.id);
  const asked = input.cancel ?? [];
  const unknown = asked.filter((id) => !runs.some((row) => row.id === id));
  if (unknown.length) throw new ToolBlockedError("That message is not in this session.", "Read its queue with node_sessions.");
  const dropped = await dropQueuedRuns(env, session.id, asked, "cancelled", "Removed from the queue.");
  for (const id of dropped) await noteAction(env, session.id, "cancel", id, { title: runs.find((row) => row.id === id)?.title ?? null });
  const missed = asked.filter((id) => !dropped.includes(id));
  if (!dropped.length) throw new ToolBlockedError("That message is no longer queued: it already started or ended.", "Stop it with node_session_stop, or steer the session.");
  return {
    summary: `Took ${dropped.length} message${dropped.length === 1 ? "" : "s"} out of the queue.${missed.length ? ` ${missed.length} had already started or ended.` : ""}`,
    data: { session: session.id, cancelled: dropped, missed },
  };
}

/**
 * Moves a session to another of its owner's nodes (docs/35 §8.9): from now on that node sees it, sends it
 * messages and answers for it, and the node that had it no longer does. Runs already started still report
 * to the node that started them. Recorded as the new node's `adopt` event, which `sessionOwners` reads.
 */
export async function moveSession(
  prisma: PrismaClient,
  input: { accountId: string; sessionId: string; to: Pick<NodeAgent, "id">; from: Pick<NodeAgent, "id" | "slug"> | null; actor: SessionActor; via: SessionVia; note?: string },
): Promise<void> {
  await recordSessionEvent(prisma, {
    userId: input.accountId,
    nodeId: input.to.id,
    sessionId: input.sessionId,
    action: "adopt",
    actor: input.actor,
    via: input.via,
    detail: { from: input.from?.id ?? null, fromHandle: input.from?.slug ?? null, ...(input.note ? { note: input.note } : {}) },
  });
  await refreshSessionCards(prisma, input.accountId, input.sessionId);
}

/** Takes over a session no node manages (started in the Hub or the CLI) without sending it anything. */
export async function adoptSession(env: SessionEnv, input: z.infer<typeof AdoptInput>): Promise<Started> {
  const session = await usableSession(env.prisma, env.node, input.session);
  const owner = (await sessionOwners(env.prisma, env.node.userId, [session.id])).get(session.id);
  if (owner === env.node.id) return { summary: "You already manage that session.", data: { session: session.id } };
  await moveSession(env.prisma, { accountId: env.node.userId, sessionId: session.id, to: env.node, from: null, ...by(env) });
  return { summary: `You manage the ${session.agentName} session in ${session.folder} now; your owner's other nodes no longer see it.`, data: { session: session.id } };
}

async function lastingNodeByHandle(prisma: PrismaClient, accountId: string, handle: string): Promise<NodeAgent> {
  const slug = handle.trim().replace(/^@/, "").toLowerCase();
  const found = await prisma.nodeAgent.findFirst({ where: { userId: accountId, slug, parentNodeId: null } });
  if (!found) throw new ToolBlockedError(`Your owner has no node @${slug}.`, "Name one of their nodes by its handle; helpers do not take sessions.");
  return found;
}

/** Hands one of this node's sessions to another of its owner's nodes. */
export async function handOverSession(env: SessionEnv, input: HandOverInput): Promise<Started> {
  const { prisma, node } = env;
  const session = await usableSession(prisma, node, input.session);
  const target = await lastingNodeByHandle(prisma, node.userId, input.to);
  if (target.id === node.id) return { summary: "You already manage that session.", data: { session: session.id } };
  await moveSession(prisma, { accountId: node.userId, sessionId: session.id, to: target, from: node, ...by(env), note: input.note });
  return {
    summary: `@${target.slug} manages the ${session.agentName} session in ${session.folder} now and sees what it did; you no longer see it. Runs you started in it still report to you.`,
    data: { session: session.id, to: target.id },
  };
}

/** What a held session call does, as the card says it under "@node wants to start work on your computer". */
function describeCall(call: SessionCall): string {
  if (call.action === "hand_over") {
    const input = call.input;
    return `Hand a session to @${input.to.replace(/^@/, "")}${input.note ? `\n\n${truncateText(input.note, 600)}` : ""}`;
  }
  if (call.action === "start") {
    const input = call.input;
    const agent = input.agent ? agentLabel(input.agent) : "your coding agent";
    const where = `${input.computer && input.computer !== "any" ? ` on ${input.computer}` : ""}${input.folder ? ` in “${input.folder}”` : input.repoUrl ? ` in a clone of ${input.repoUrl}` : ""}`;
    return `Start ${agent}${where}: ${input.title}\n\n${truncateText(input.prompt, 1200)}`;
  }
  const input = call.input;
  const verb = input.delivery === "steer" ? "Change the run going on in its session" : input.delivery === "replace" ? "Replace what its session is doing" : "Next in its session";
  return `${verb}${input.title ? `: ${input.title}` : ""}\n\n${truncateText(input.prompt, 1200)}`;
}

/** One owner-only card with exactly this call; approvals.ts runs it when the owner approves. */
export async function holdForOwner(env: SessionEnv, call: SessionCall, extra: Record<string, unknown> = {}, body?: string): Promise<ToolResult> {
  const { message } = await postMessage(env.prisma, {
    roomId: env.room.id,
    userId: env.node.userId,
    authorKind: "node",
    authorNodeId: env.node.id,
    kind: "approval",
    body: body ?? describeCall(call),
    data: {
      type: "session",
      status: "pending",
      action: call.action,
      input: call.input,
      private: Boolean(env.privateTo),
      fromNonOwner: env.lineage.fromNonOwner,
      ...(env.plan?.planStep ? { plan: { id: env.plan.planId, step: env.plan.planStep } } : {}),
      ...extra,
    },
    visibleTo: [env.node.userId],
    rootMessageId: env.lineage.rootMessageId,
    botDepth: env.lineage.botDepth,
  });
  return toolOk("Waiting for your owner's approval: they see a card with exactly this request and approve or discard it. Say so in one short line.", { approvalId: message.id });
}

export async function runSessionCall(env: SessionEnv, call: SessionCall): Promise<Started> {
  if (call.action === "hand_over") return handOverSession(env, HandOverInput.parse(call.input));
  return call.action === "start" ? startSession(env, StartInput.parse(call.input)) : sendToSession(env, SendInput.parse(call.input));
}

/** A ToolContext for session calls made outside a model turn (an owner's approval). */
export async function ownerContext(app: FastifyInstance, ownerId: string): Promise<ToolContext> {
  return { app, prisma: app.prisma, userId: ownerId, actor: "agent", settings: await loadSettings(app.prisma, ownerId) };
}

export type SessionToolScope = {
  prisma: PrismaClient;
  node: NodeAgent;
  room: NodeRoom;
  lineage: SessionLineage;
  privateTo: string[] | null;
  /** Only the owner reads this turn's thread and only the owner started it (a DM, a crew, their private thread). */
  ownerOnly: boolean;
  plan?: PlanLink | null;
};

/**
 * The session tools for a node turn. Where only the owner reads and the owner started the turn, it
 * gets them all, acting at once unless the owner asked this node to check first. Anywhere other
 * people read (a room's shared thread, even in a turn a run's report started) it may only ask to
 * start work or send a session a message, which waits for the owner's card, and never lists the
 * owner's sessions.
 */
export function sessionTools(scope: SessionToolScope): AnyHubTool[] {
  const fromOwner = scope.ownerOnly && !scope.lineage.fromNonOwner;
  const asks = !fromOwner || computerWorkAsks(scope.node);
  const env = (ctx: ToolContext): SessionEnv => ({ ctx, prisma: scope.prisma, app: ctx.app, node: scope.node, room: scope.room, lineage: scope.lineage, privateTo: scope.privateTo, plan: scope.plan ?? null });
  const result = (done: Started) => toolOk(done.summary, done.data);

  const start = defineTool({
    name: "node_session_start",
    area: "tasks",
    description:
      "Real coding work on your owner's computer (changing code in a repository, building a feature, fixing a bug, a test-and-fix loop; no Ensemble task needed): start a new session with one of their own coding agents (Claude Code, Codex, Cursor, GitHub Copilot, Grok Build, OpenCode, Gemini CLI, Antigravity) on their paired computer and their own subscription: the agent does the work in a folder that computer shares (folder), a fresh clone (repoUrl) or a new empty folder, and you hear when it ends. " +
      "Your run profile decides the agent, model, thinking level, context, computer, mode and git rules unless your owner names others (profile, agent, computer, model, effort, context, mode, branch, pullRequest). " +
      "For work that builds on what one of your sessions already did, use node_session_send instead. Off the board unless you pass taskId.",
    input: StartInput,
    isWrite: false,
    risk: "medium",
    async run(ctx, input) {
      if (asks) return holdForOwner(env(ctx), { action: "start", input });
      return result(await startSession(env(ctx), input));
    },
  });
  const send = defineTool({
    name: "node_session_send",
    area: "tasks",
    description:
      "Send the next message to one of your sessions (node_sessions): the same agent goes on in its own conversation, in the same folder, remembering what it did, and the provider reuses its cache. " +
      "delivery queue: after what it is doing (“then do Y”); steer: change the run going on (“do X this way instead”); replace: drop what it is doing and queued, do this instead (“stop X, do Y”).",
    input: SendInput,
    isWrite: false,
    risk: "medium",
    async run(ctx, input) {
      if (asks) return holdForOwner(env(ctx), { action: "send", input });
      return result(await sendToSession(env(ctx), input));
    },
  });
  if (scope.lineage.fromNonOwner) return [start];
  if (!fromOwner) return [start, send];

  return [
    defineTool({
      name: "node_sessions",
      area: "tasks",
      description:
        "Your agent sessions on your owner's computers, most recently active first: for each, the agent, model, thinking level, context window and fast mode, computer, folder, whether it is working, waiting for your owner, queued or idle, the run going on and the messages queued after it (jobIds, in order), and one line per task done in it (what was asked, what came of it). " +
        "Read it before choosing a session, and when your owner asks what you have been working on. Sessions no node owns yet (started in Ensemble or the CLI) show with yours: false; you may continue them, or take one over with node_session_adopt. Other nodes' sessions never show.",
      input: z
        .object({
          session: z.string().uuid().optional().describe("One session's id, for all of its tasks."),
          query: z.string().max(200).optional().describe("Words to match in the tasks, summary, folder, agent or computer."),
          limit: z.number().int().min(1).max(30).default(10),
        })
        .strict(),
      isWrite: false,
      risk: "low",
      async run(_ctx, input) {
        if (input.session) {
          const session = await usableSession(scope.prisma, scope.node, input.session);
          const owner = (await sessionOwners(scope.prisma, scope.node.userId, [session.id])).get(session.id);
          const runs = await runsOfSession(scope.prisma, scopeOf(scope.node), session.id);
          return toolOk(`Session with ${session.agentName} in ${session.folder}.`, { session: sessionView({ ...session, yours: owner === scope.node.id }, await workOf(scope.prisma, runs, 40), runs) });
        }
        const sessions = await sessionsForNode(scope.prisma, scope.node, { query: input.query, limit: input.limit });
        const views = await Promise.all(
          sessions.map(async (row) => {
            const runs = await runsOfSession(scope.prisma, scopeOf(scope.node), row.id);
            return sessionView(row, await workOf(scope.prisma, runs, 6), runs);
          }),
        );
        return toolOk(views.length ? `${views.length} session(s).` : "No sessions yet: node_session_start begins one.", { sessions: views });
      },
    }),
    start,
    send,
    defineTool({
      name: "node_session_stop",
      area: "tasks",
      description: "Stop the run going on in one of your sessions, and the messages queued in it unless queued is keep. What the agent changed so far stays; the session can go on later with node_session_send.",
      input: StopInput,
      isWrite: false,
      risk: "low",
      async run(ctx, input) {
        return result(await stopSession(env(ctx), input));
      },
    }),
    defineTool({
      name: "node_session_queue",
      area: "tasks",
      description:
        "Edit the messages queued in one of your sessions, as your owner can on its card: order (every queued message's jobId from node_sessions, in the order they should run) or cancel (jobIds to take out; they never start). Only messages that have not started can move or go.",
      input: QueueInput,
      isWrite: false,
      risk: "low",
      async run(ctx, input) {
        return result(await editSessionQueue(env(ctx), input));
      },
    }),
    defineTool({
      name: "node_session_adopt",
      area: "tasks",
      description:
        "Take over a session no node manages yet (yours: false in node_sessions: started in Ensemble or the CLI) without sending it anything, when your owner wants you to look after it: from then on only you see and run it, and its card names you.",
      input: AdoptInput,
      isWrite: false,
      risk: "low",
      async run(ctx, input) {
        return result(await adoptSession(env(ctx), input));
      },
    }),
    defineTool({
      name: "node_session_hand_over",
      area: "tasks",
      description:
        "Hand one of your sessions to another of your owner's nodes (to: its handle) when your owner asks, or when the session's work is that node's: it then sees the session, sends it messages and answers for it, and you no longer see it. Runs already going on still report to you. note: what it should know to carry on.",
      input: HandOverInput,
      isWrite: false,
      risk: "low",
      async run(ctx, input) {
        if (asks) {
          const session = await usableSession(scope.prisma, scope.node, input.session);
          const to = input.to.replace(/^@/, "");
          return holdForOwner(env(ctx), { action: "hand_over", input }, {}, `Hand the ${session.agentName} session in ${session.folder} to @${to}${input.note ? `\n\n${truncateText(input.note, 600)}` : ""}`);
        }
        return result(await handOverSession(env(ctx), input));
      },
    }),
    ...questionTools(scope),
  ];
}

export type StoppedRun = { title: string; agent: string; computer: string | null; started: boolean };

/** Pausing a node: every run it started that has not ended is stopped (queued ones leave the queue). */
export async function stopNodeRuns(app: FastifyInstance, node: Pick<NodeAgent, "id" | "userId">): Promise<StoppedRun[]> {
  const prisma = app.prisma;
  const runs = await prisma.nodeRun.findMany({ where: { nodeId: node.id, reportedAt: null }, orderBy: { createdAt: "desc" } });
  const jobs = await prisma.workspaceJob.findMany({
    // A run already being stopped (by an earlier pause, steer or stop) is not still going on.
    where: { id: { in: runs.map((row) => row.jobId) }, status: { in: [...LIVE_RUN].filter((status) => status !== "stopping") as never }, cancelRequestedAt: null },
    select: { id: true, status: true, provider: true, startedAt: true, claimedAt: true, task: { select: { title: true } }, device: { select: { name: true } } },
  });
  const order = new Map(runs.map((row, index) => [row.jobId, index]));
  const live = jobs.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  for (const job of live) await stopJob(app, node.userId, job.id);
  await quiet(app, live.map((job) => job.id), "paused");
  return live
    .reverse()
    .map((job) => ({ title: job.task.title, agent: agentLabel(job.provider), computer: job.device?.name ?? null, started: job.status !== "queued" || Boolean(job.startedAt || job.claimedAt) }));
}

/** What a node says in its DM when it is paused: only the work that was still going on, no model call. */
export function pausedNotice(stopped: readonly StoppedRun[]): string {
  if (!stopped.length) return "Paused, as you asked. Send me a message when you need me again.";
  const line = (row: StoppedRun) => `- “${row.title}” (${row.agent}${row.computer ? ` on ${row.computer}` : ""})`;
  const running = stopped.filter((row) => row.started);
  const queued = stopped.filter((row) => !row.started);
  return [
    "Paused, as you asked.",
    running.length ? `I stopped what I was running on your computer:\n${running.map(line).join("\n")}` : "",
    queued.length ? `I took ${queued.length === 1 ? "this" : "these"} out of the queue:\n${queued.map(line).join("\n")}` : "",
    "What was changed so far stays. Send me a message to pick up again.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
