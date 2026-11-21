/**
 * The harness around a Code tab turn (docs/16 §9): how the turn's agent session starts (fresh, resume,
 * handoff or fork, workspace/sessions.ts), the handoff record a new session gets, the skills written
 * into the agent's own skill folder, and the turn packet (turn-packet.ts) that goes with the owner's
 * message. A session's later turns get only what changed since the packet it last got; the run keeps
 * what it delivered (`Run.packet`), its version (`Run.promptVersion`) and the skills (`Run.skillIds`,
 * `Run.skillSignatures`).
 */
import { hostname } from "node:os";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { CompletionSchema, parseCompletion } from "./completion.js";
import { steerPrompt } from "./engine-watch.js";
import { codingSkills, skillsToWrite, writeSkillFolder, type SkillFolder } from "./engines/skill-folders.js";
import { buildHandoff, HandoffRecord, renderHandoff, saveHandoff, writeHandoffFile, type HandoffReason } from "./handoff-record.js";
import { ownWords } from "./mentioned.js";
import { continuesSessionOf, handoffReasonOf, sessionOperation, type SessionOperation } from "./sessions.js";
import { isCodeAgentTurn, steerOf } from "./trust.js";
import { acceptanceOf, buildPacket, packetRecordOf, packetSource, packetSummary, PacketSummarySchema, parsePacketSource, type Criterion, type Delivered, type PacketRecord, type PacketSource } from "./turn-packet.js";
import type { JobContext } from "./tools.js";

/** The owner's run profile instructions for Code tab turns, as the composer sent them (`context.profileInstructions`). */
export function profileInstructionsOf(context: unknown): string | null {
  const value = typeof context === "object" && context !== null ? (context as { profileInstructions?: unknown }).profileInstructions : undefined;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 4000) : null;
}

/** The message's acceptance criteria, then the task's, with ids that do not clash; at most 12. */
export function turnCriteria(message: string, task: readonly Criterion[]): Criterion[] {
  const own = acceptanceOf(ownWords(message));
  const out = [...own];
  const ids = new Set(own.map((row) => row.id));
  const texts = new Set(own.map((row) => row.text.toLowerCase()));
  let next = 1;
  for (const row of task) {
    if (out.length >= 12 || texts.has(row.text.toLowerCase())) continue;
    let id = row.id;
    if (ids.has(id)) {
      while (ids.has(`AC-${next}`)) next += 1;
      id = `AC-${next}`;
    }
    ids.add(id);
    texts.add(row.text.toLowerCase());
    out.push({ id, text: row.text });
  }
  return out;
}

type Db = PrismaClient | Prisma.TransactionClient;
type Link = { id: string; provider: string | null; model: string; context: unknown; continueFromJobId: string | null; runId: string | null };
const LINK = { id: true, provider: true, model: true, context: true, continueFromJobId: true, runId: true } as const;

/** What the session's packets delivered last: back from `from` while the runs are in the same session. */
export async function lastDelivered(db: Db, job: { provider: string | null; model: string; context: unknown }, from: string | null): Promise<Delivered | null> {
  let child: { provider: string | null; model: string; context: unknown } = job;
  let id = from;
  for (let hops = 0; id && hops < 30; hops += 1) {
    const run: Link | null = await db.workspaceJob.findUnique({ where: { id }, select: LINK });
    if (!run || !continuesSessionOf(child, run)) return null;
    const record = run.runId ? packetRecordOf((await db.run.findUnique({ where: { id: run.runId }, select: { packet: true } }))?.packet) : null;
    if (record) return record.delivered;
    child = run;
    id = run.continueFromJobId;
  }
  return null;
}

export type CodeTurn = {
  prompt: string;
  record: PacketRecord;
  operation: SessionOperation;
  handoff: { record: HandoffRecord; reason: HandoffReason; file: string | null } | null;
  skills: SkillFolder | null;
};

export type CodeTurnInput = {
  /** How the packet names the owner. */
  owner: string;
  /** The run's rules, one "- …" line each. */
  rules: string[];
  /** The agent session the turn resumes, if it does. */
  resume: string | null;
  /** The agent no longer had that session: start a new one with a handoff record. */
  sessionGone?: boolean;
  /** The folder's commit when the turn started. */
  head: string | null;
  /** The owner's time zone, when the packet's facts do not carry one. */
  timezone: string;
  /** Tests give the facts; otherwise the claim's (a paired computer) or this computer's records. */
  source?: PacketSource;
  now?: Date;
};

/** Everything the turn sends with the owner's message, and how its session starts. Writes the skills and the handoff record. */
export async function prepareCodeTurn(ctx: Pick<JobContext, "prisma" | "job" | "userId" | "root" | "secretEnv">, input: CodeTurnInput): Promise<CodeTurn> {
  const { prisma, job } = ctx;
  const parent = job.continueFromJobId ? await prisma.workspaceJob.findUnique({ where: { id: job.continueFromJobId }, select: LINK }) : null;
  let operation = sessionOperation(job, parent);
  let reason: HandoffReason | null = operation === "handoff" ? handoffReasonOf(job, parent!) : operation === "fork" ? "fork" : null;
  // Same agent, but its session is gone (or never started): a new session that gets a record of the earlier one.
  if (parent && (input.sessionGone || (operation === "resume" && !input.resume))) {
    operation = "handoff";
    reason = "session_gone";
  }
  const resumed = operation === "resume" && Boolean(input.resume);
  const source = input.source ?? parsePacketSource((job.context as { codePacket?: unknown } | null)?.codePacket) ?? (await packetSource(prisma, ctx.userId, job));

  const written = await writeSkillFolder(ctx.root, job.provider ?? "", skillsToWrite(codingSkills(), source.skills)).catch(() => null);
  const skills = written?.skills.length ? written : null;

  let handoff: CodeTurn["handoff"] = null;
  if (reason && parent) {
    const record = await buildHandoff(prisma, {
      userId: ctx.userId,
      to: { agent: job.provider ?? "unknown" },
      reason,
      sourceJobId: parent.id,
      computer: hostname(),
      head: input.head,
      secrets: Object.values(ctx.secretEnv ?? {}),
      now: input.now,
    }).catch(() => null);
    if (record) {
      await saveHandoff(prisma, record, { userId: ctx.userId, jobId: job.id, sourceJobId: parent.id, reason });
      const file = await writeHandoffFile(ctx.root, record).catch(() => null);
      handoff = { record, reason, file };
    }
  }

  const steer = steerOf(job.context);
  const built = buildPacket({
    owner: input.owner,
    root: ctx.root,
    rules: input.rules,
    source,
    profile: profileInstructionsOf(job.context),
    skills: skills ? { folder: skills.rel, list: skills.skills.map((skill) => ({ name: skill.name, description: skill.description })) } : null,
    acceptance: turnCriteria(job.instructions, source.acceptance),
    timezone: source.timezone ?? input.timezone,
    now: input.now,
    handoff: handoff ? { id: handoff.record.id, text: renderHandoff(handoff.record) } : null,
    message: steer && resumed ? steerPrompt(steer.update) : job.instructions,
    previous: resumed ? await lastDelivered(prisma, job, job.continueFromJobId) : null,
  });
  return { prompt: built.prompt, record: { ...built.record, operation }, operation, handoff, skills };
}

/** Keeps what the turn sent on its run: the packet, its version, and the skills it gave the agent. */
export async function keepCodeTurn(db: Db, runId: string, turn: CodeTurn): Promise<void> {
  const owned = turn.skills?.skills.filter((skill) => skill.source === "owner" && skill.id).map((skill) => skill.id!) ?? [];
  await db.run.update({
    where: { id: runId },
    data: {
      packet: turn.record as unknown as Prisma.InputJsonValue,
      promptVersion: turn.record.version,
      ...(turn.skills ? { skillIds: owned, skillSignatures: turn.skills.skills.map((skill) => ({ name: skill.name, source: skill.source, sha256: skill.sha256 })) as Prisma.InputJsonValue } : {}),
    },
  });
}

/** What a paired computer sends about a Code tab turn with its end, for the web to keep on its own run. */
export const CodeTurnResult = z.object({
  completion: CompletionSchema.optional(),
  packet: PacketSummarySchema.optional(),
  skillIds: z.array(z.string().max(100)).max(12).optional(),
  skills: z.array(z.object({ name: z.string().max(100), source: z.enum(["ensemble", "owner"]), sha256: z.string().max(80) })).max(40).optional(),
  handoff: z.object({ reason: z.enum(["agent", "subscription", "fork", "session_gone"]), record: HandoffRecord }).optional(),
});
export type CodeTurnResult = z.infer<typeof CodeTurnResult>;

/** The turn's facts this computer kept (its run's packet, skills and completion, and its handoff record), to send with its end. */
export async function codeTurnResultOf(db: Db, job: { id: string; runId: string | null; context: unknown }, scrub: (text: string) => string): Promise<CodeTurnResult | null> {
  if (!isCodeAgentTurn(job.context) || !job.runId) return null;
  const run = await db.run.findUnique({ where: { id: job.runId }, select: { completion: true, packet: true, skillIds: true, skillSignatures: true } });
  const completion = parseCompletion(run?.completion);
  const record = packetRecordOf(run?.packet);
  const handoff = await db.sessionHandoff.findFirst({ where: { jobId: job.id }, orderBy: { createdAt: "desc" }, select: { reason: true, record: true } });
  const deep = <T>(value: T): T => {
    if (typeof value === "string") return scrub(value) as T;
    if (Array.isArray(value)) return value.map(deep) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, deep(item)])) as T;
    return value;
  };
  const parsed = CodeTurnResult.safeParse({
    ...(completion ? { completion: deep(completion) } : {}),
    ...(record ? { packet: packetSummary(record) } : {}),
    ...(run?.skillIds.length ? { skillIds: run.skillIds } : {}),
    ...(Array.isArray(run?.skillSignatures) && run.skillSignatures.length ? { skills: run.skillSignatures } : {}),
    ...(handoff ? { handoff: { reason: handoff.reason, record: deep(handoff.record) } } : {}),
  });
  return parsed.success && Object.keys(parsed.data).length ? parsed.data : null;
}

/** Keeps what a computer sent about a Code tab turn on the web's run, and its handoff record with the web's ids. */
export async function keepCodeTurnResult(db: Db, job: { id: string; userId: string; taskId: string; continueFromJobId: string | null }, runId: string, result: CodeTurnResult): Promise<void> {
  await db.run.update({
    where: { id: runId },
    data: {
      ...(result.completion ? { completion: result.completion as unknown as Prisma.InputJsonValue } : {}),
      ...(result.packet ? { packet: result.packet as unknown as Prisma.InputJsonValue, promptVersion: result.packet.version } : {}),
      ...(result.skillIds ? { skillIds: result.skillIds } : {}),
      ...(result.skills ? { skillSignatures: result.skills as Prisma.InputJsonValue } : {}),
    },
  });
  if (!result.handoff) return;
  const source = job.continueFromJobId ? await db.workspaceJob.findFirst({ where: { id: job.continueFromJobId, userId: job.userId }, select: { id: true, runId: true } }) : null;
  const record: HandoffRecord = {
    ...result.handoff.record,
    task: { ...result.handoff.record.task, id: job.taskId },
    from: { ...result.handoff.record.from, jobId: source?.id ?? result.handoff.record.from.jobId, runId: source?.runId ?? null },
  };
  const exists = await db.sessionHandoff.findUnique({ where: { id: record.id }, select: { id: true } });
  if (!exists) await saveHandoff(db, record, { userId: job.userId, jobId: job.id, sourceJobId: source?.id ?? null, reason: result.handoff.reason });
}
