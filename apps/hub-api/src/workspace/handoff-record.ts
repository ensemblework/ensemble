/**
 * The handoff record, `ensemble.handoff.v1` (docs/41 §2): what a new agent session gets when it takes
 * over a Code tab thread from another session, because the owner switched agent or subscription, forked
 * the thread, or the agent no longer had its session. Ensemble puts it together from the earlier
 * session's runs (no model call): the task and its packet version, the agent and model requested, sent
 * and reported, each acceptance item with its evidence, what worked and what failed, the owner's
 * answered decisions, files, checks Ensemble ran again, artifacts, the next step and blockers, and the
 * owner's own requests. It is data, never instructions, and never a full history: the rendered part is
 * at most 8,000 characters, filled in priority order, and the whole record is kept in the database and
 * in `.ensemble/handoff/<id>.md` in the run's folder (out of git), where the agent can read it again.
 */
import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ENGINE_LABELS, type CodeEngine } from "@ensemble/shared-types";
import { redactKeys } from "../lib/redact.js";
import { parseReport } from "../node/report.js";
import { parseCompletion, type Completion } from "./completion.js";
import { mentionsIn, ownWords } from "./mentioned.js";
import { excludeInGit, folderIn, writeSafely } from "./run-files.js";
import { continuesSessionOf, subscriptionOf, summaryLine } from "./sessions.js";
import { engineSessionOf } from "./session-continuity.js";
import { packetRecordOf, type Criterion } from "./turn-packet.js";

export const HANDOFF_SCHEMA = "ensemble.handoff.v1";
/** The part a new session gets with its first message. */
export const HANDOFF_CHARS = 8000;
/** The whole record, as kept and written to its file. */
const RECORD_CHARS = 60_000;
export const HANDOFF_DIR = [".ensemble", "handoff"] as const;

export type HandoffReason = "agent" | "subscription" | "fork" | "session_gone";

const REASONS: Record<HandoffReason, string> = {
  agent: "the owner switched to another agent",
  subscription: "the owner switched to another subscription",
  fork: "the owner forked the thread from this point",
  session_gone: "the agent no longer had its earlier session",
};

const text = (max: number) => z.string().max(max);
const AcceptanceItem = z.object({ id: text(20), text: text(600), state: z.enum(["verified", "failed", "unverified"]), evidence: text(600) });

export const HandoffRecord = z.object({
  schema: z.literal(HANDOFF_SCHEMA),
  id: z.string().regex(/^hof_\d{8}_[a-z0-9]{6}$/),
  createdAt: z.string().datetime(),
  trust: z.literal("unreviewed-data"),
  lossy: z.object({ carried: z.array(text(60)).max(20), notCarried: z.array(text(60)).max(20) }),
  supersedes: z.string().max(40).nullable(),
  task: z.object({ id: text(100), title: text(300), sessionId: text(100), packetVersion: text(64).nullable() }),
  from: z.object({
    agent: text(40),
    subscription: text(120),
    model: z.object({ requested: text(200), sent: text(200).nullable(), reported: text(200).nullable() }),
    nativeSessionId: text(300).nullable(),
    jobId: text(100),
    runId: text(100).nullable(),
    computer: text(200).nullable(),
    folder: text(1000).nullable(),
    branch: text(300).nullable(),
    head: text(80).nullable(),
  }),
  to: z.object({ agent: text(40), reason: text(300) }),
  acceptance: z.array(AcceptanceItem).max(12),
  state: z.object({
    worked: z.array(z.object({ what: text(600), evidence: text(600) })).max(20),
    failed: z.array(z.object({ what: text(600), why: text(1200) })).max(20),
    untried: z.array(text(300)).max(10),
  }),
  decisions: z.array(z.object({ ruling: text(800), why: text(300), costIfWrong: text(300) })).max(20),
  files: z.array(z.object({ path: text(1000), status: z.enum(["changed", "deleted"]), note: text(200) })).max(60),
  checks: z.array(z.object({ command: text(2000), result: text(600), at: text(40) })).max(30),
  artifacts: z.array(z.object({ kind: text(40), ref: text(2000), sha256: text(80).nullable(), delivered: z.boolean() })).max(30),
  openWork: z.object({ nextStep: text(800), blockers: z.array(text(600)).max(10), ownerDependency: text(300).nullable() }),
  requests: z.array(text(2000)).max(10),
  context: z.object({ contextDb: z.array(text(200)).max(20), load: z.array(text(1000)).max(10) }),
  toolProvenance: z.array(z.object({ tool: text(200), calls: z.number().int().min(0), lastResult: z.enum(["ok", "failed", "unknown"]) })).max(30),
});
export type HandoffRecord = z.infer<typeof HandoffRecord>;

export function parseHandoff(value: unknown): HandoffRecord | null {
  const parsed = HandoffRecord.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);
const agentName = (agent: string) => ENGINE_LABELS[agent as CodeEngine] ?? agent;

export function handoffId(now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(6);
  return `hof_${day}_${[...bytes].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
}

/** Every string in the record with key shapes and the run's secret values hidden. */
function hidden<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === "string") {
    let out = redactKeys(value);
    for (const secret of secrets) if (secret.length >= 6) out = out.split(secret).join("[hidden]");
    return out as T;
  }
  if (Array.isArray(value)) return value.map((item) => hidden(item, secrets)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, hidden(item, secrets)])) as T;
  return value;
}

type Db = PrismaClient | Prisma.TransactionClient;

const JOB_SELECT = {
  id: true,
  taskId: true,
  provider: true,
  model: true,
  context: true,
  continueFromJobId: true,
  instructions: true,
  summary: true,
  status: true,
  error: true,
  runId: true,
  repoPath: true,
  branch: true,
  report: true,
  evidence: true,
  createdAt: true,
  task: { select: { title: true } },
} as const;
type SessionJob = Prisma.WorkspaceJobGetPayload<{ select: typeof JOB_SELECT }>;

/** The session a run belongs to, oldest first: back from `jobId` while each run continues the one before it. */
async function sessionJobs(db: Db, userId: string, jobId: string, max = 30): Promise<SessionJob[]> {
  const jobs: SessionJob[] = [];
  let id: string | null = jobId;
  while (id && jobs.length < max) {
    const job: SessionJob | null = await db.workspaceJob.findFirst({ where: { id, userId }, select: JOB_SELECT });
    if (!job) break;
    const child = jobs[0];
    if (child && !continuesSessionOf(child, job)) break;
    jobs.unshift(job);
    id = job.continueFromJobId;
  }
  return jobs;
}

export type HandoffInput = {
  userId: string;
  /** The run that takes over: its agent and why. */
  to: { agent: string };
  reason: HandoffReason;
  /** The last run of the session it takes over from. */
  sourceJobId: string;
  /** Where the source session worked, as this computer knows it. */
  computer: string | null;
  head: string | null;
  /** Saved secret values to hide. */
  secrets?: readonly string[];
  now?: Date;
};

const isDone = (status: string) => status === "succeeded";

/** The record for a new session taking over from the session `sourceJobId` ends; null when that run is not here. */
export async function buildHandoff(db: Db, input: HandoffInput): Promise<HandoffRecord | null> {
  const jobs = await sessionJobs(db, input.userId, input.sourceJobId);
  const last = jobs.at(-1);
  if (!last) return null;
  const now = input.now ?? new Date();
  const ids = jobs.map((job) => job.id);
  const runIds = jobs.map((job) => job.runId).filter((id): id is string => Boolean(id));
  const runs = runIds.length ? await db.run.findMany({ where: { id: { in: runIds } }, select: { id: true, completion: true, packet: true, promptVersion: true } }) : [];
  const runOf = new Map(runs.map((run) => [run.id, run]));
  const completions = new Map<string, Completion>();
  for (const job of jobs) {
    const completion = job.runId ? parseCompletion(runOf.get(job.runId)?.completion) : null;
    if (completion) completions.set(job.id, completion);
  }
  const lastRun = last.runId ? runOf.get(last.runId) : undefined;
  const packet = packetRecordOf(lastRun?.packet);
  // The session's acceptance criteria: each turn's packet carried those it was given, the newest wording first.
  const criteria: Criterion[] = [];
  for (const job of [...jobs].reverse()) {
    for (const row of (job.runId ? packetRecordOf(runOf.get(job.runId)?.packet) : null)?.criteria ?? []) {
      if (criteria.length < 12 && !criteria.some((known) => known.id === row.id)) criteria.push(row);
    }
  }
  const reports = new Map(jobs.map((job) => [job.id, parseReport(job.report)]));

  // Checks: Ensemble's reruns, newest first per command; the agent's claims where nothing was run again.
  const checks: HandoffRecord["checks"] = [];
  const seenCommands = new Set<string>();
  const rerunById = new Map<string, Completion["checks"]["runs"][number]>();
  for (const job of [...jobs].reverse()) {
    const completion = completions.get(job.id);
    for (const run of completion?.checks.runs ?? []) {
      if (run.id && !rerunById.has(run.id)) rerunById.set(run.id, run);
      if (seenCommands.has(run.command)) continue;
      seenCommands.add(run.command);
      const result = run.verdict === "pass" ? "passed when Ensemble ran it again" : run.verdict === "fail" ? `failed when Ensemble ran it again${run.reason ? `: ${run.reason}` : ""}` : `not run again${run.reason ? `: ${run.reason}` : ""}`;
      checks.push({ command: clip(run.command, 2000), result: clip(`${run.name}: ${result}`, 600), at: completion!.at });
    }
    for (const check of reports.get(job.id)?.checks ?? []) {
      const command = check.rerun?.command ?? check.name;
      if (seenCommands.has(command)) continue;
      seenCommands.add(command);
      checks.push({ command: clip(command, 2000), result: clip(`${check.name}: the agent reported ${check.verdict}; not run again`, 600), at: job.createdAt.toISOString() });
    }
  }

  const acceptance: HandoffRecord["acceptance"] = criteria.map((criterion) => {
    const rerun = rerunById.get(criterion.id);
    if (rerun?.verdict === "pass") return { ...criterion, state: "verified" as const, evidence: clip(`${rerun.command} passed when Ensemble ran it again`, 600) };
    if (rerun?.verdict === "fail") return { ...criterion, state: "failed" as const, evidence: clip(`${rerun.command} failed when Ensemble ran it again${rerun.reason ? `: ${rerun.reason}` : ""}`, 600) };
    const claimed = [...jobs].reverse().flatMap((job) => reports.get(job.id)?.checks ?? []).find((check) => check.id === criterion.id);
    return { ...criterion, state: "unverified" as const, evidence: claimed ? clip(`The agent reported ${claimed.verdict} (${claimed.name}); not run again`, 600) : "No check reported." };
  });

  const worked: HandoffRecord["state"]["worked"] = [];
  const failed: HandoffRecord["state"]["failed"] = [];
  jobs.forEach((job, index) => {
    const completion = completions.get(job.id);
    const label = `Turn ${index + 1}`;
    if (isDone(job.status) && job.summary?.trim()) {
      const proof = completion ? [`files ${completion.files.state === "changed" ? `changed (${completion.files.count})` : "unchanged"}`, `checks ${completion.checks.state}`].join(", ") : "no record of checks";
      worked.push({ what: clip(`${label}: ${summaryLine(job.summary, 400)}`, 600), evidence: clip(proof, 600) });
    } else if (job.status === "failed" || job.status === "blocked" || job.status === "interrupted") {
      failed.push({ what: clip(`${label}: ${summaryLine(ownWords(job.instructions), 300) || "the turn"}`, 600), why: clip(job.error ?? "It stopped without saying why.", 1200) });
    }
    for (const run of completion?.checks.runs ?? []) {
      if (run.verdict !== "fail") continue;
      failed.push({ what: clip(`${label}: the check ${run.name} (${run.command})`, 600), why: clip([run.reason, run.output.split("\n").filter(Boolean).slice(-3).join(" / ")].filter(Boolean).join(" "), 1200) });
    }
  });

  const answered = await db.agentDecision.findMany({
    where: { userId: input.userId, sessionId: { in: ids }, event: "question", status: "decided" },
    orderBy: { requestedAt: "asc" },
    take: 20,
    select: { title: true, decision: true, reason: true },
  });
  const unattended = await db.workspaceEvent.findMany({ where: { jobId: { in: ids }, kind: "decision" }, orderBy: { sequence: "asc" }, take: 20, select: { data: true } });
  const decisions: HandoffRecord["decisions"] = [
    ...answered.map((row) => ({
      ruling: clip(`${row.title}: ${row.reason?.trim() || (row.decision === "allow" ? "yes" : "skipped")}`, 800),
      why: "The owner answered this when the agent asked.",
      costIfWrong: "Not stated",
    })),
    ...unattended.map((row) => {
      const data = (row.data ?? {}) as { question?: unknown; recommended?: unknown };
      return { ruling: clip(`${String(data.question ?? "A decision")}: ${String(data.recommended ?? "the agent's own choice")}`, 800), why: "Chosen by the agent in an unattended run.", costIfWrong: "Not stated" };
    }),
  ].slice(0, 20);

  const files = new Map<string, HandoffRecord["files"][number]>();
  jobs.forEach((job, index) => {
    const evidence = (job.evidence && typeof job.evidence === "object" ? job.evidence : {}) as { files?: Array<{ path?: unknown; status?: unknown; added?: unknown; removed?: unknown }> };
    for (const file of Array.isArray(evidence.files) ? evidence.files : []) {
      if (typeof file.path !== "string") continue;
      files.delete(file.path);
      files.set(file.path, { path: clip(file.path, 1000), status: file.status === "deleted" ? "deleted" : "changed", note: `+${Number(file.added) || 0} -${Number(file.removed) || 0} in turn ${index + 1}` });
    }
  });
  const fileList = [...files.values()].reverse().slice(0, 60);

  const artifacts: HandoffRecord["artifacts"] = [];
  for (const job of [...jobs].reverse()) {
    const pr = completions.get(job.id)?.pr;
    if (pr?.url && !artifacts.some((row) => row.ref === pr.url)) artifacts.push({ kind: "pr", ref: pr.url, sha256: null, delivered: pr.state !== "none" });
  }
  const evidence = await db.jobEvidence.findMany({ where: { userId: input.userId, jobId: { in: ids } }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, kind: true, name: true, sha256: true } });
  for (const row of evidence) artifacts.push({ kind: row.kind, ref: clip(`${row.name} (evidence ${row.id})`, 2000), sha256: row.sha256, delivered: false });

  const calls = new Map<string, { calls: number; lastResult: "ok" | "failed" | "unknown" }>();
  if (runIds.length) {
    const steps = await db.runStep.findMany({ where: { runId: { in: runIds } }, orderBy: [{ startedAt: "asc" }], take: 2000, select: { toolCalls: true } });
    for (const step of steps) {
      for (const call of (Array.isArray(step.toolCalls) ? step.toolCalls : []) as Array<{ name?: unknown; ok?: unknown }>) {
        if (typeof call.name !== "string") continue;
        const row = calls.get(call.name) ?? { calls: 0, lastResult: "unknown" as const };
        calls.set(call.name, { calls: row.calls + 1, lastResult: call.ok === true ? "ok" : call.ok === false ? "failed" : row.lastResult });
      }
    }
  }
  const toolProvenance = [...calls.entries()].sort((a, b) => b[1].calls - a[1].calls).slice(0, 30).map(([tool, row]) => ({ tool: clip(tool, 200), ...row }));

  const requests = jobs.map((job) => ownWords(job.instructions)).filter(Boolean).slice(-10).map((words) => clip(words, 2000));
  const refs = new Set<string>();
  for (const job of jobs) for (const mention of mentionsIn(job.instructions)) refs.add(`ensemble://${mention.kind}/${mention.id}`);
  const superseded = await db.sessionHandoff.findFirst({ where: { userId: input.userId, jobId: { in: ids } }, orderBy: { createdAt: "desc" }, select: { id: true } });

  const lastCompletion = completions.get(last.id);
  const lastReport = reports.get(last.id);
  const blockers = [
    ...(last.status === "failed" || last.status === "blocked" || last.status === "interrupted" ? [clip(last.error ?? "The last turn stopped.", 600)] : []),
    ...(lastReport?.outcome === "blocked" ? [clip(`The agent reported it was blocked${lastReport.blockedBy ? ` (${lastReport.blockedBy.replace(/_/g, " ")})` : ""}: ${lastReport.summary}`, 600)] : []),
  ];
  const failing = lastCompletion?.checks.runs.find((run) => run.verdict === "fail");
  const open = acceptance.filter((item) => item.state !== "verified").map((item) => item.id);
  const nextStep = blockers.length
    ? "Find out why the last turn stopped (the blockers below), check the folder, then carry on with the owner's message."
    : failing
      ? `Fix what makes the check ${failing.name} fail (${failing.command}), then carry on with the owner's message.`
      : open.length
        ? `Check ${open.join(", ")} (not verified yet), then carry on with the owner's message.`
        : "Carry on with the owner's message that follows.";

  const record: HandoffRecord = {
    schema: HANDOFF_SCHEMA,
    id: handoffId(now),
    createdAt: now.toISOString(),
    trust: "unreviewed-data",
    lossy: {
      carried: ["owner requests", "outcomes", "acceptance", "files", "checks", "decisions", "open work", "tool use"],
      notCarried: ["reasoning", "full tool output", "the agent's own session state", "earlier handoff records (read them)"],
    },
    supersedes: superseded?.id ?? null,
    task: { id: last.taskId, title: clip(last.task.title, 300), sessionId: jobs[0]!.id, packetVersion: lastRun?.promptVersion ?? packet?.base ?? null },
    from: {
      agent: last.provider ?? "unknown",
      subscription: clip(subscriptionOf(last.provider, last.model), 120),
      model: { requested: clip(last.model || "default", 200), sent: last.model ? clip(last.model, 200) : null, reported: typeof (last.evidence as { model?: unknown } | null)?.model === "string" ? clip((last.evidence as { model: string }).model, 200) : null },
      nativeSessionId: await engineSessionOf(db as PrismaClient, last.id).catch(() => null),
      jobId: last.id,
      runId: last.runId,
      computer: input.computer ? clip(input.computer, 200) : null,
      folder: last.repoPath ? clip(last.repoPath, 1000) : null,
      branch: last.branch ? clip(last.branch, 300) : null,
      head: input.head ? clip(input.head, 80) : null,
    },
    to: { agent: input.to.agent, reason: REASONS[input.reason] },
    acceptance,
    state: { worked: worked.slice(-20), failed: failed.slice(-20), untried: [] },
    decisions,
    files: fileList,
    checks: checks.slice(0, 30),
    artifacts: artifacts.slice(0, 30),
    openWork: { nextStep, blockers: blockers.slice(0, 10), ownerDependency: null },
    requests,
    context: { contextDb: [...refs].slice(0, 20), load: [...(superseded ? [`.ensemble/handoff/${superseded.id}.md`] : []), ...fileList.filter((file) => file.status === "changed").slice(0, 5).map((file) => file.path)] },
    toolProvenance,
  };
  return HandoffRecord.parse(hidden(record, input.secrets ?? []));
}

/**
 * The record as Markdown for the agent, filled in priority order (next step, acceptance, what failed,
 * the owner's requests, what worked, decisions, files, checks, artifacts, context, tools) up to
 * `max` characters, ending with where the whole record is.
 */
export function renderHandoff(record: HandoffRecord, max = HANDOFF_CHARS): string {
  const where = `.ensemble/handoff/${record.id}.md`;
  const model = [record.from.model.requested, record.from.model.reported && record.from.model.reported !== record.from.model.requested ? `reported ${record.from.model.reported}` : ""].filter(Boolean).join(", ");
  const head = [
    `Handoff record ${record.id} (${record.schema}), made ${record.createdAt.slice(0, 16).replace("T", " ")} UTC: from ${agentName(record.from.agent)} (${model}) to ${agentName(record.to.agent)}, because ${record.to.reason}.`,
    `Task: ${record.task.title}.${record.task.packetVersion ? ` Instructions version ${record.task.packetVersion}.` : ""}${record.from.branch ? ` Branch ${record.from.branch}${record.from.head ? ` at ${record.from.head.slice(0, 12)}` : ""}.` : ""}`,
    `Not carried over: ${record.lossy.notCarried.join(", ")}.`,
  ];
  const sections: Array<{ title: string; lines: string[] }> = [
    { title: "Next step", lines: [`- ${record.openWork.nextStep}`, ...record.openWork.blockers.map((line) => `- Blocker: ${line}`)] },
    { title: "Acceptance", lines: record.acceptance.map((item) => `- ${item.id} (${item.state}): ${item.text} Evidence: ${item.evidence}`) },
    { title: "Did not work (do not repeat it as it was)", lines: record.state.failed.map((row) => `- ${row.what}: ${row.why}`) },
    { title: "What the owner asked, oldest first", lines: record.requests.map((line) => `- ${line.replace(/\s*\n\s*/g, " / ")}`) },
    { title: "Worked", lines: record.state.worked.map((row) => `- ${row.what} (${row.evidence})`) },
    { title: "Decisions", lines: record.decisions.map((row) => `- ${row.ruling} Why: ${row.why} Cost if wrong: ${row.costIfWrong}.`) },
    { title: "Files changed", lines: record.files.map((row) => `- ${row.path} (${row.status}, ${row.note})`) },
    { title: "Checks", lines: record.checks.map((row) => `- ${row.command}: ${row.result}`) },
    { title: "Artifacts", lines: record.artifacts.map((row) => `- ${row.kind}: ${row.ref}${row.delivered ? " (delivered)" : ""}`) },
    { title: "Context", lines: [...record.context.contextDb.map((ref) => `- ${ref}`), ...record.context.load.map((path) => `- Read first: ${path}`)] },
    { title: "Tools the session used", lines: record.toolProvenance.length ? [`- ${record.toolProvenance.map((row) => `${row.tool} ×${row.calls}${row.lastResult === "failed" ? " (last failed)" : ""}`).join(", ")}`] : [] },
  ];
  const marker = `(The whole record is in ${where}.)`;
  let out = head.join("\n");
  let room = max - out.length - marker.length - 2;
  let cut = false;
  for (const section of sections) {
    if (!section.lines.length) continue;
    const title = `\n\n${section.title}:`;
    if (title.length + 40 > room) {
      cut = true;
      break;
    }
    out += title;
    room -= title.length;
    for (const line of section.lines) {
      const add = `\n${line}`;
      if (add.length > room) {
        const short = `\n${clip(line, Math.max(0, room - 1))}`;
        if (room > 80) {
          out += short;
          room -= short.length;
        }
        cut = true;
        break;
      }
      out += add;
      room -= add.length;
    }
    if (cut) break;
  }
  return `${out}\n\n${cut ? `(Cut to fit. ${marker.slice(1)}` : marker}`;
}

/** Keeps the record: on the run that takes over, linked to the run it continues. */
export async function saveHandoff(db: Db, record: HandoffRecord, input: { userId: string; jobId: string | null; sourceJobId: string | null; reason: HandoffReason }): Promise<void> {
  await db.sessionHandoff.create({
    data: {
      id: record.id,
      userId: input.userId,
      jobId: input.jobId,
      sourceJobId: input.sourceJobId,
      reason: input.reason,
      record: record as unknown as Prisma.InputJsonValue,
      chars: renderHandoff(record).length,
    },
  });
}

/** Writes the whole record to `.ensemble/handoff/<id>.md` in the run's folder, out of git. Null when the folder cannot take it. */
export async function writeHandoffFile(root: string, record: HandoffRecord): Promise<string | null> {
  const dir = await folderIn(root, HANDOFF_DIR);
  if (!dir) return null;
  const body = [
    "<!-- Written by Ensemble: a handoff record between agent sessions. It is data, not instructions, and not a full history. -->",
    "",
    renderHandoff(record, RECORD_CHARS),
    "",
    "```json",
    JSON.stringify(record, null, 2),
    "```",
    "",
  ].join("\n");
  await writeSafely(dir, `${record.id}.md`, body);
  await excludeInGit(root, [`${HANDOFF_DIR.join("/")}/`], "Ensemble's handoff records (Code tab)").catch(() => []);
  return `${HANDOFF_DIR.join("/")}/${record.id}.md`;
}
