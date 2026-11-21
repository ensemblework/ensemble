/**
 * Drives one task run as its owner: makes the nodes and rooms, sends the owner's messages, and while
 * the nodes work answers their cards (lib/cards.ts), stops any coding run on another agent or model
 * than the run's (the cost fence), records the agent sessions that appear, writes what changes to the
 * trace, and waits until nothing is left running.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cardType, decisionType, planCard, planDecision } from "./cards.js";
import { codingSessions, copilotSessionsIn, turnSessions, type SessionLedger } from "./sessions.js";
import type { Redactor } from "./redact.js";
import type { CardLog, MadeNode, Task, TaskContext } from "./types.js";
import { LIVE_JOB, type Owner, type World } from "./world.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Busy with only plans and nothing running for this long: the plan waits on something that will not come. */
const STALL_MS = 5 * 60_000;
const POLL_MS = 1500;

export type Trace = { path: string; write: (kind: string, data: Record<string, unknown>) => void };

export function traceFile(path: string, redact: Redactor): Trace {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  const start = Date.now();
  return { path, write: (kind, data) => appendFileSync(path, `${JSON.stringify(redact.deep({ t: Date.now() - start, kind, ...data }, 1500))}\n`) };
}

export type Drive = {
  ctx: TaskContext;
  world: World;
  owner: Owner;
  trace: Trace;
  ledger: SessionLedger;
  started: number;
  deadline: number;
  cards: CardLog[];
  errors: string[];
  notes: string[];
  cleanups: Array<() => Promise<void> | void>;
};

type State = { handled: Set<string>; fenced: Set<string>; seen: Map<string, string>; isCodeEngine: (value: string) => boolean; holding: boolean };
const states = new WeakMap<Drive, State>();

export async function startDrive(input: { world: World; owner: Owner; task: Task; repeat: number; dir: string; deviceId: string; trace: Trace; ledger: SessionLedger; log: (line: string) => void; timeoutMs: number }): Promise<Drive> {
  const { world, owner, trace } = input;
  const { isCodeEngine } = await import("../../../packages/shared-types/src/index.js");
  const cleanups: Array<() => Promise<void> | void> = [];
  const api = async <T,>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown): Promise<T> => {
    const response = await owner.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
    if (response.statusCode >= 300) throw new Error(`${method} ${url} answered ${response.statusCode}: ${response.body.slice(0, 300)}`);
    return (response.body ? response.json() : {}) as T;
  };
  const request = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const response = await owner.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
    return { status: response.statusCode, body: response.body, json: () => (response.body ? response.json() : null) as unknown };
  };
  const ctx: TaskContext = {
    world,
    owner,
    task: input.task,
    repeat: input.repeat,
    dir: input.dir,
    deviceId: input.deviceId,
    nodes: {},
    rooms: {},
    data: {},
    log: input.log,
    onCleanup: (work) => void cleanups.push(work),
    api,
    request,
    holdCards: (on) => {
      states.get(drive)!.holding = on;
      trace.write("hold", { cards: on });
    },
    computer: {
      offline: async () => {
        await world.computer.offline();
        trace.write("computer", { action: "offline" });
      },
      online: async () => {
        await world.computer.online();
        trace.write("computer", { action: "online" });
      },
      restart: async (downMs) => {
        trace.write("computer", { action: "restart", downMs: downMs ?? null });
        await world.computer.restart(downMs);
        trace.write("computer", { action: "restarted" });
      },
      dropLink: (ms) => {
        world.link.drop(ms, "the task cut it");
        trace.write("computer", { action: "link dropped", ms });
      },
      loseAnswer: (match, ms) => {
        world.loseAnswer(match, ms);
        trace.write("computer", { action: "next answer lost", url: match.url.source, answer: match.answer.source, ms });
      },
      faults: () => ({ lost: world.lostAnswers(), drops: world.link.drops() }),
      inspect: () => world.computer.inspect(),
      dirs: world.computer.dirs,
      isOnline: async () => {
        const device = await world.prisma.device.findUnique({ where: { id: input.deviceId }, select: { revokedAt: true, lastSeenAt: true } });
        return Boolean(device && !device.revokedAt && world.deviceOnline(device.lastSeenAt));
      },
    },
    makeNode: async (key, templateId, options = {}) => {
      const made = await api<{ node: { id: string; slug: string }; room: { id: string } }>("POST", "/api/node/nodes", { templateId, ...(options.name ? { name: options.name } : {}), ...(options.slug ? { slug: options.slug } : {}) });
      await world.prisma.nodeAgent.update({ where: { id: made.node.id }, data: { provider: world.agent, model: world.model } });
      const node: MadeNode = { id: made.node.id, slug: made.node.slug, roomId: made.room.id };
      ctx.nodes[key] = node;
      ctx.rooms[key] = made.room.id;
      ctx.rooms.main ??= made.room.id;
      trace.write("setup.node", { key, template: templateId, slug: node.slug });
      return node;
    },
    makeCrew: async (key, title, members, lead) => {
      const made = await api<{ room: { id: string } }>("POST", "/api/node/crews", { title, nodeIds: members.map((name) => ctx.nodes[name]!.id), leadNodeId: ctx.nodes[lead]!.id });
      ctx.rooms[key] = made.room.id;
      trace.write("setup.crew", { key, title, members: members.map((name) => ctx.nodes[name]!.slug), lead: ctx.nodes[lead]!.slug });
      return made.room.id;
    },
  };
  const drive: Drive = { ctx, world, owner, trace, ledger: input.ledger, started: Date.now(), deadline: Date.now() + input.timeoutMs, cards: [], errors: [], notes: [], cleanups };
  states.set(drive, { handled: new Set(), fenced: new Set(), seen: new Map(), isCodeEngine: (value) => isCodeEngine(value), holding: false });
  return drive;
}

/** Runs what setup asked to stop or remove at the end. */
export async function runCleanups(drive: Drive): Promise<void> {
  for (const work of drive.cleanups) await Promise.resolve(work()).catch(() => undefined);
}

/** Every room the owner is in (their nodes' DMs, crews, and rooms the nodes opened). */
async function ownerRooms(drive: Drive): Promise<string[]> {
  const rows = await drive.world.prisma.nodeRoomMember.findMany({ where: { userId: drive.owner.id }, select: { roomId: true } });
  return [...new Set([...rows.map((row) => row.roomId), ...Object.values(drive.ctx.rooms)])];
}

export async function say(drive: Drive, roomKey: string, text: string): Promise<string> {
  const roomId = drive.ctx.rooms[roomKey];
  if (!roomId) throw new Error(`No room "${roomKey}" in this task.`);
  const sent = await drive.ctx.api<{ message: { id: string } }>("POST", `/api/node/rooms/${roomId}/messages`, { body: text });
  drive.trace.write("say", { room: roomKey, text });
  drive.ctx.log(`owner → ${roomKey}: ${text.slice(0, 120)}${text.length > 120 ? "…" : ""}`);
  return sent.message.id;
}

function logCard(drive: Drive, entry: CardLog): void {
  drive.cards.push(entry);
  drive.trace.write("card", { ...entry });
  drive.ctx.log(`card ${entry.type}: ${entry.answered ? entry.answer : `not answered (${entry.note ?? ""})`}`);
}

/** Answers every owner card that is waiting, once each. */
async function answerCards(drive: Drive): Promise<void> {
  const state = states.get(drive)!;
  if (state.holding) return;
  const prisma = drive.world.prisma;
  const decisions = await prisma.agentDecision.findMany({ where: { userId: drive.owner.id, status: "pending" }, orderBy: { requestedAt: "asc" } });
  for (const row of decisions) {
    if (state.handled.has(row.id)) continue;
    state.handled.add(row.id);
    const type = decisionType(row);
    let plan = planDecision(row);
    if ("skip" in plan) {
      logCard(drive, { id: row.id, type, answer: "", answered: false, at: new Date().toISOString(), note: plan.skip });
      continue;
    }
    let response = await drive.owner.inject({ method: "POST", url: plan.url, payload: plan.body });
    if (response.statusCode === 400 && plan.body.scope === "session") {
      const again = planDecision(row, "once");
      if (!("skip" in again)) {
        plan = again;
        response = await drive.owner.inject({ method: "POST", url: plan.url, payload: plan.body });
      }
    }
    const ok = response.statusCode < 300;
    logCard(drive, { id: row.id, type, answer: plan.answer, answered: ok, at: new Date().toISOString(), ...(ok ? (plan.note ? { note: plan.note } : {}) : { note: `${response.statusCode} ${response.body.slice(0, 160)}` }) });
  }
  const rooms = await ownerRooms(drive);
  const cards = await prisma.nodeMessage.findMany({
    where: { roomId: { in: rooms }, createdAt: { gte: new Date(drive.started) }, OR: [{ kind: "approval" }, { data: { path: ["type"], equals: "device_code" } }] },
    orderBy: { createdAt: "asc" },
    select: { id: true, kind: true, data: true },
  });
  for (const card of cards) {
    if (state.handled.has(card.id)) continue;
    const plan = planCard(card);
    if (!plan) continue;
    state.handled.add(card.id);
    if ("skip" in plan) {
      logCard(drive, { id: card.id, type: cardType(card), answer: "", answered: false, at: new Date().toISOString(), note: plan.skip });
      continue;
    }
    const response = await drive.owner.inject({ method: "POST", url: plan.url, payload: plan.body });
    const ok = response.statusCode < 300;
    logCard(drive, { id: card.id, type: cardType(card), answer: plan.answer, answered: ok, at: new Date().toISOString(), ...(ok ? (plan.note ? { note: plan.note } : {}) : { note: `${response.statusCode} ${response.body.slice(0, 160)}: ${plan.note ?? ""}` }) });
  }
}

/** Stops a coding run on any agent or model other than the run's own: the owner's plan pays for every call. */
async function fence(drive: Drive): Promise<void> {
  const state = states.get(drive)!;
  const { world } = drive;
  const jobs = await world.prisma.workspaceJob.findMany({ where: { createdAt: { gte: new Date(drive.started) }, status: { in: [...LIVE_JOB] } }, select: { id: true, userId: true, provider: true, model: true } });
  for (const job of jobs) {
    if (state.fenced.has(job.id) || !job.provider || !state.isCodeEngine(job.provider)) continue;
    if (job.provider === world.agent && job.model === world.model) continue;
    state.fenced.add(job.id);
    await world.stopJob(world.app, job.userId, job.id).catch(() => undefined);
    const why = `cost fence: stopped a ${job.provider} run on ${job.model || "its default model"}`;
    drive.errors.push(why);
    drive.trace.write("fence", { job: job.id, provider: job.provider, model: job.model });
    drive.ctx.log(why);
  }
}

/** Records the agent sessions the run's nodes and coding runs made so far. */
async function noteSessions(drive: Drive, final = false): Promise<void> {
  const task = drive.ctx.task.id;
  const found = [
    // Turns on the subscription run in this process, or on the computer when Ensemble hands them over (a relay task).
    ...[...turnSessions(drive.world.dirs.state), ...turnSessions(drive.world.computer.dirs.state)].map((row) => ({ ...row, kind: "node-turn" as const })),
    ...(await codingSessions(drive.world.prisma)).map((row) => ({ ...row, kind: "coding" as const })),
    ...(final ? copilotSessionsIn(drive.world.dirs.root).map((id) => ({ agent: "copilot-cli", id, folder: null, kind: "found" as const })) : []),
  ];
  for (const row of found) {
    if (drive.ledger.record({ agent: row.agent, id: row.id, kind: row.kind, task, folder: row.folder })) drive.trace.write("session", { agent: row.agent, id: row.id, sessionKind: row.kind });
  }
}

/** Writes to the trace what changed since the last look: new messages and card states, turns, runs and plans. */
async function traceChanges(drive: Drive): Promise<void> {
  const { seen } = states.get(drive)!;
  const prisma = drive.world.prisma;
  const since = new Date(drive.started);
  const changed = (key: string, value: string) => {
    if (seen.get(key) === value) return false;
    seen.set(key, value);
    return true;
  };
  const rooms = await ownerRooms(drive);
  const nodes = await prisma.nodeAgent.findMany({ where: { userId: drive.owner.id }, select: { id: true, slug: true } });
  const slug = new Map(nodes.map((row) => [row.id, row.slug]));
  for (const row of await prisma.nodeMessage.findMany({ where: { roomId: { in: rooms }, createdAt: { gte: since } }, orderBy: [{ createdAt: "asc" }, { seq: "asc" }] })) {
    const data = record(row.data);
    const status = typeof data.status === "string" ? data.status : "";
    if (!changed(`m:${row.id}`, status)) continue;
    const author = row.authorKind === "node" ? `node:${slug.get(row.authorNodeId ?? "") ?? "?"}` : row.authorKind === "human" ? "owner" : row.authorKind;
    const media = Array.isArray(data.media) ? data.media.length : 0;
    drive.trace.write("message", { room: row.roomId.slice(0, 8), seq: row.seq, author, messageKind: row.kind, ...(data.type ? { type: data.type } : {}), ...(status ? { status } : {}), ...(media ? { media } : {}), private: row.visibleTo.length > 0, body: row.body });
  }
  for (const row of await prisma.nodeTurn.findMany({ where: { userId: drive.owner.id, createdAt: { gte: since } }, orderBy: { createdAt: "asc" } })) {
    // Where a checkout records how a turn ended (parked, coalesced, skipped), beside its status.
    const outcome = (row as { outcome?: string | null }).outcome ?? null;
    const ended = outcome && outcome !== row.status && outcome !== "running" && outcome !== "queued" ? outcome : null;
    if (changed(`t:${row.id}`, `${row.status}|${ended ?? ""}`)) drive.trace.write("turn", { turn: row.id.slice(0, 8), node: slug.get(row.nodeId) ?? "?", reason: row.reason, status: row.status, ...(ended ? { outcome: ended } : {}), ...(row.planStep ? { step: row.planStep } : {}), ...(row.error ? { error: row.error } : {}) });
  }
  for (const row of await prisma.workspaceJob.findMany({ where: { createdAt: { gte: since } }, select: { id: true, deviceId: true, status: true, provider: true, model: true, kind: true } })) {
    if (changed(`j:${row.id}`, row.status)) drive.trace.write("job", { job: row.id.slice(0, 8), on: row.deviceId ? "computer" : "server", status: row.status, provider: row.provider, model: row.model, jobKind: row.kind });
  }
  for (const row of await prisma.nodeMission.findMany({ where: { userId: drive.owner.id }, include: { steps: { select: { id: true, handle: true, status: true, outcome: true, attempt: true } } } })) {
    const shape = `${row.status}|${row.steps.map((step) => `${step.id}:${step.status}:${step.outcome}:${step.attempt}`).join(",")}`;
    if (changed(`p:${row.id}`, shape)) drive.trace.write("plan", { plan: row.id.slice(0, 8), status: row.status, steps: row.steps.map((step) => ({ id: step.id, node: step.handle, status: step.status, outcome: step.outcome, attempt: step.attempt })) });
  }
}

/** One look: cards answered, the fence applied, sessions recorded, changes traced. Never throws. */
export async function tick(drive: Drive): Promise<void> {
  for (const step of [answerCards, fence, noteSessions, traceChanges] as Array<(drive: Drive) => Promise<void>>) {
    try {
      await step(drive);
    } catch (error) {
      const message = `harness: ${step.name} failed: ${error instanceof Error ? error.message : String(error)}`;
      if (!drive.errors.includes(message)) drive.errors.push(message);
    }
  }
}

/** What still runs for this owner: turns, runs on either side, plans, and the computer's own jobs. */
export async function busy(drive: Drive): Promise<string[]> {
  const prisma = drive.world.prisma;
  const owner = drive.owner.id;
  const [turns, jobs, runs, missions] = await Promise.all([
    prisma.nodeTurn.count({ where: { userId: owner, status: { in: ["queued", "running"] } } }),
    prisma.workspaceJob.count({ where: { userId: owner, status: { in: [...LIVE_JOB] } } }),
    prisma.nodeRun.count({ where: { userId: owner, reportedAt: null } }),
    prisma.nodeMission.count({ where: { userId: owner, status: { in: ["running", "reporting"] } } }),
  ]);
  return [
    ...(turns ? [`turns ${turns}`] : []),
    ...(jobs ? [`runs ${jobs}`] : []),
    ...(runs ? [`unreported runs ${runs}`] : []),
    ...(missions ? [`missions ${missions}`] : []),
  ];
}

/**
 * Waits until nothing has run for `settleMs`; "stalled" when only a plan is open and nothing has run
 * for a long while; "busy" when `limitMs` passes first (the task goes on), "timeout" at the task's end.
 */
export async function waitQuiet(drive: Drive, settleMs = 6000, limitMs?: number): Promise<"quiet" | "timeout" | "stalled" | "busy"> {
  const limit = limitMs ? Date.now() + limitMs : Number.POSITIVE_INFINITY;
  let quietSince = 0;
  let plansOnlySince = 0;
  for (;;) {
    await tick(drive);
    const reasons = await busy(drive);
    const now = Date.now();
    if (!reasons.length) {
      quietSince ||= now;
      if (now - quietSince >= settleMs) return "quiet";
    } else quietSince = 0;
    if (reasons.length && reasons.every((reason) => reason.startsWith("missions"))) {
      plansOnlySince ||= now;
      if (now - plansOnlySince > STALL_MS) return "stalled";
    } else plansOnlySince = 0;
    if (now > drive.deadline) return "timeout";
    if (now > limit) return "busy";
    await sleep(POLL_MS);
  }
}

/** Waits for `until` to see what it waits for (its answer), looking after cards meanwhile; null on time out. */
export async function waitUntil(drive: Drive, until: (ctx: TaskContext) => Promise<string | null>, timeoutMs: number): Promise<string | null> {
  const end = Math.min(drive.deadline, Date.now() + timeoutMs);
  for (;;) {
    await tick(drive);
    const seen = await until(drive.ctx).catch(() => null);
    if (seen) return seen;
    if (Date.now() > end) return null;
    await sleep(1000);
  }
}

type Rows = Array<Record<string, unknown>>;

/**
 * Ensemble Node's own record of each turn and of the decisions it made (`node_turn_traces`,
 * `node_decisions`), where this checkout keeps them: hashes, sizes, models, placement and how the loop
 * ran, never a message's text.
 */
export async function traceNodeRecords(drive: Drive): Promise<void> {
  const db = drive.world.prisma as unknown as { nodeTurnTrace?: { findMany(args: unknown): Promise<Rows> }; nodeDecision?: { findMany(args: unknown): Promise<Rows> } };
  const where = { where: { userId: drive.owner.id, createdAt: { gte: new Date(drive.started) } }, orderBy: { createdAt: "asc" } };
  const short = (value: unknown) => (typeof value === "string" ? value.slice(0, 12) : (value ?? null));
  for (const row of db.nodeTurnTrace ? await db.nodeTurnTrace.findMany(where) : []) {
    const sections = record(row.sections);
    const tiers: Record<string, { sections: number; tokens: number }> = {};
    for (const item of Array.isArray(sections.list) ? (sections.list as Rows) : []) {
      const tier = (tiers[String(item.tier ?? "?")] ??= { sections: 0, tokens: 0 });
      tier.sections += 1;
      tier.tokens += Number(item.tokens ?? 0);
    }
    const calls = Array.isArray(row.calls) ? (row.calls as Rows) : [];
    drive.trace.write("turnTrace", {
      turn: String(row.turnId).slice(0, 8),
      instructions: { version: short(row.instructionVersion), hash: short(row.instructionHash), tiers: Object.fromEntries(Object.entries(record(sections.hashes)).map(([tier, hash]) => [tier, short(hash)])), sizes: tiers, dropped: Array.isArray(sections.dropped) ? sections.dropped.length : 0 },
      tools: { hash: short(row.toolSchemaHash), count: row.toolCount ?? null },
      model: { requested: row.modelRequested ?? null, sent: row.modelSent ?? null, reported: row.modelReported ?? null, provider: row.provider ?? null, effort: row.effort ?? null },
      placement: row.placement ?? null,
      tokens: { in: row.tokensIn ?? null, out: row.tokensOut ?? null },
      // The agent's own calls on the owner's plan (its shell, files, web) with how Ensemble answered them.
      calls: calls.slice(0, 60).map((call) => (call.kind === "own" ? `own:${String(call.name)}:${String(call.state)}:${String(call.verdict)}` : `${String(call.name)}:${String(call.state)}`)),
      loop: row.loop ?? null,
      ...(row.report ? { report: row.report } : {}),
      ...(row.error ? { error: row.error } : {}),
    });
  }
  for (const row of db.nodeDecision ? await db.nodeDecision.findMany(where) : []) {
    drive.trace.write("nodeDecision", { turn: typeof row.turnId === "string" ? row.turnId.slice(0, 8) : null, decision: row.kind, choice: row.choice ?? null, ambiguous: row.ambiguous === true, config: row.configVersion ?? null });
  }
}

/** Records the last sessions (including any Copilot session found by its folder). */
export async function finalSessions(drive: Drive): Promise<void> {
  await noteSessions(drive, true).catch(() => undefined);
}

/**
 * Deletes the owner's nodes once the task is graded (their turns stop first): a node can be woken after
 * its task, for a run whose computer has gone, and would then run during the next task.
 */
export async function endNodes(drive: Drive): Promise<void> {
  const nodes = await drive.world.prisma.nodeAgent.findMany({ where: { userId: drive.owner.id }, select: { id: true } });
  for (const node of nodes) await drive.owner.inject({ method: "DELETE", url: `/api/node/nodes/${node.id}` }).catch(() => undefined);
}

/** Stops everything the owner's nodes still do (the room's Stop, everywhere) and waits for the computer to end its runs. */
export async function stopEverything(drive: Drive): Promise<void> {
  const prisma = drive.world.prisma;
  const room = Object.values(drive.ctx.rooms)[0];
  if (room) await drive.owner.inject({ method: "POST", url: `/api/node/rooms/${room}/stop`, payload: { scope: "all" } }).catch(() => undefined);
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    const [jobs, turns] = await Promise.all([
      prisma.workspaceJob.count({ where: { createdAt: { gte: new Date(drive.started) }, status: { in: [...LIVE_JOB] } } }),
      prisma.nodeTurn.count({ where: { userId: drive.owner.id, status: "running" } }),
    ]);
    if (!jobs && !turns) return;
    await tick(drive);
    await sleep(POLL_MS);
  }
  drive.errors.push("harness: work was still running 90 s after the final stop");
}
