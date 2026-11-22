/**
 * The turn packet of a Code tab turn (docs/16 §9): what Ensemble sends the person's own coding agent
 * with their message. A new agent session gets the whole packet: the Code tab's sections and the
 * constitution's (packages/prompts), the run's rules, the owner's run profile instructions, the skills
 * written into the agent's own skill folder, the Ensemble project, a budgeted Context DB slice of the
 * records the thread names, acceptance criteria and the date. A later turn in the same session gets
 * only what changed since the packet it last got: Context DB facts by their hashes, the rules, the
 * profile, the skills, the date. Each turn's run keeps the packet's version, sizes and hashes.
 *
 * The packet's facts are gathered where the account's records are (`packetSource`): the web at claim
 * time for a paired computer, this computer's own database otherwise. The packet itself is put
 * together on the computer that runs the turn, which holds the session's earlier packets.
 */
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { assemble, type AssembledSection, type DroppedSection, type SectionRequest } from "@ensemble/prompts";
import { workContext } from "../context/graph/packet.js";
import { graphKind, type ItemRef } from "../context/graph/refs.js";
import { CODE_THREAD_PREFIX } from "../lib/node-tasks.js";
import { loadSettings } from "../lib/settings.js";
import { purposeOf } from "../lib/skill-purpose.js";
import { projectBrief } from "./agent-projects.js";
import { mentionsIn } from "./mentioned.js";

export const PACKET_SCHEMA = "code.packet.v1";

/** Characters of Context DB records in a packet, over every record the thread names. */
export const CONTEXT_BUDGET = 5000;
/** At most this many records are the slice's focus: the newest the thread names. */
const MAX_FOCUS = 4;
/** The project brief as the packet carries it (its folder's AGENTS.md has it whole). */
const PROJECT_CHARS = 4000;
/** Tokens for the context tier: profile, skills, project and the Context DB slice, in that order. */
const CONTEXT_TOKENS = 5000;
const MAX_CHANGES = 40;

/** One fact of the Context DB slice, keyed so a later turn can tell whether it changed. */
export const ContextItem = z.object({
  key: z.string().min(1).max(600),
  /** The record and list it belongs to ("Fix the login bug, People"); empty for a record's own line. */
  section: z.string().max(300),
  text: z.string().min(1).max(2000),
});
export type ContextItem = z.infer<typeof ContextItem>;

/** One of the owner's own skills, linked to the task or named in the thread. */
export const OwnerSkill = z.object({
  id: z.string().max(100),
  slug: z.string().max(200),
  name: z.string().max(200),
  description: z.string().max(2000),
  body: z.string().max(40_000),
});
export type OwnerSkill = z.infer<typeof OwnerSkill>;

/** What a Code tab turn's packet is made of, as the records were when the turn was claimed or started. */
export const PacketSource = z.object({
  items: z.array(ContextItem).max(300).default([]),
  project: z.object({ id: z.string().max(100), name: z.string().max(300), brief: z.string().max(12_000), hash: z.string().max(64) }).nullable().default(null),
  skills: z.array(OwnerSkill).max(12).default([]),
  /** The board task's own acceptance criteria (its description), when it has them. */
  acceptance: z.array(z.object({ id: z.string().max(20), text: z.string().max(600) })).max(12).default([]),
  timezone: z.string().max(100).nullable().default(null),
});
export type PacketSource = z.infer<typeof PacketSource>;

/** A claim's or a job context's packet source, when it is one this computer understands. */
export function parsePacketSource(value: unknown): PacketSource | null {
  const parsed = PacketSource.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** What a packet delivered, by hash: the next turn in the same session sends only what differs. */
export const Delivered = z.object({
  schema: z.literal(PACKET_SCHEMA),
  rules: z.string(),
  profile: z.string().nullable(),
  items: z.record(z.string(), z.object({ h: z.string(), label: z.string() })),
  skills: z.array(z.string()),
  acceptance: z.string().nullable().default(null),
  date: z.string(),
  /** The version of the whole packet that started the session. */
  base: z.string(),
});
export type Delivered = z.infer<typeof Delivered>;

export type PacketMode = "full" | "delta" | "none";

/** What a turn's run keeps about its packet (`Run.packet`). */
export type PacketRecord = {
  schema: typeof PACKET_SCHEMA;
  /** Hash of the section files this packet used: which instructions, at which revision (`Run.promptVersion`). */
  version: string;
  /** The version of the whole packet the session started with: the instructions a later turn still works under. */
  base: string;
  hash: string;
  mode: PacketMode;
  sections: AssembledSection[];
  dropped: DroppedSection[];
  chars: number;
  items: { sent: number; changed: number; added: number; removed: number };
  skills: string[];
  /** The acceptance criteria this turn works to (the message's and the task's), each with its id. */
  criteria: Criterion[];
  handoffId: string | null;
  /** How the turn's agent session started (workspace/sessions.ts `SessionOperation`). */
  operation?: "fresh" | "resume" | "handoff" | "fork";
  delivered: Delivered;
};

/** The packet's record a run kept, with what it delivered; null for a run before packets or a malformed one. */
export function packetRecordOf(value: unknown): PacketRecord | null {
  if (!value || typeof value !== "object") return null;
  const delivered = Delivered.safeParse((value as { delivered?: unknown }).delivered);
  return delivered.success ? ({ ...(value as PacketRecord), delivered: delivered.data } as PacketRecord) : null;
}

/** The record without the delivered hashes: what the web keeps and shows for a run on a paired computer. */
export type PacketSummary = Omit<PacketRecord, "delivered">;

export const PacketSummarySchema = z.object({
  schema: z.literal(PACKET_SCHEMA),
  version: z.string().max(64),
  base: z.string().max(64),
  hash: z.string().max(64),
  mode: z.enum(["full", "delta", "none"]),
  sections: z.array(z.object({ name: z.string().max(200), tier: z.enum(["stable", "context", "volatile"]), chars: z.number().int().min(0), tokens: z.number().int().min(0) })).max(60),
  dropped: z.array(z.object({ name: z.string().max(200), tier: z.enum(["stable", "context", "volatile"]), reason: z.literal("budget"), tokens: z.number().int().min(0), items: z.number().int().min(0).optional() })).max(60),
  chars: z.number().int().min(0),
  items: z.object({ sent: z.number().int().min(0), changed: z.number().int().min(0), added: z.number().int().min(0), removed: z.number().int().min(0) }),
  skills: z.array(z.string().max(100)).max(40),
  criteria: z.array(z.object({ id: z.string().max(20), text: z.string().max(600) })).max(12).default([]),
  handoffId: z.string().max(100).nullable(),
  operation: z.enum(["fresh", "resume", "handoff", "fork"]).optional(),
});

export function packetSummary(record: PacketRecord): PacketSummary {
  const { delivered: _delivered, ...summary } = record;
  return summary;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const HANDLE = /ensemble:\/\/[a-z_]+\/[0-9a-f-]{36}/i;

/**
 * Each fact under a key of its own: a fact whose key an earlier one has (two lines with the same label,
 * two records' own lines) gets its occurrence after it (`…#2`), so it is not taken for the other.
 */
export function uniqueKeys(items: readonly ContextItem[]): ContextItem[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const count = (seen.get(item.key) ?? 0) + 1;
    seen.set(item.key, count);
    return count === 1 ? item : { ...item, key: `${item.key.slice(0, 590)}#${count}` };
  });
}

/**
 * A Context DB packet (`workContext`) as facts: the record's own lines as one fact, then each line of
 * its lists, keyed by the record, the list and the line's handle (or its label), so a renamed task is
 * the same fact changed, not a new one. Pagination hints and notes about the packet are left out.
 */
export function contextItems(text: string, focus: string): ContextItem[] {
  const items: ContextItem[] = [];
  let title = focus;
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const first = lines[0] ?? "";
    if (first.startsWith("# ")) {
      const head = /^# (.*?) \(([a-z]+), [^)]*\)$/.exec(first);
      title = head ? `${head[1]} (${head[2]})` : first.slice(2);
      items.push({ key: `${focus}#head`, section: "", text: clip([first.slice(2), ...lines.slice(1)].join(" · "), 2000) });
      continue;
    }
    if (!first.startsWith("## ")) continue;
    const heading = first.slice(3).trim();
    if (heading === "More") continue;
    const section = clip(`${title}, ${heading}`, 300);
    for (const raw of lines.slice(1)) {
      const line = raw.replace(/^- /, "");
      if (/^… more: rel /.test(line)) continue;
      const label = HANDLE.exec(line)?.[0] ?? /^([^:]{1,60}):/.exec(line)?.[1] ?? line;
      items.push({ key: clip(`${focus}|${heading}|${label}`, 600), section, text: clip(line, 2000) });
    }
  }
  return uniqueKeys(items);
}

export type Criterion = { id: string; text: string };

const CRITERIA_HEADING = /^(?:#{1,6}\s*)?\**\s*(acceptance criteria|acceptance|definition of done|done when|done means|success criteria)\s*\**\s*:?\s*\**\s*$/i;
const CRITERIA_INLINE = /^(?:\**\s*)(?:done when|done means|acceptance)\s*\**\s*:\s*(.+)$/i;
const CRITERION_ID = /^(?:[-*]\s*)?(?:\[[ xX]\]\s*)?(AC[-_ ]?\d{1,3})\s*[:.)\]]\s*(.+)$/i;
const LIST_ITEM = /^(?:[-*+]|\d{1,2}[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/;

/**
 * Acceptance criteria written in a message or a task: items under an "Acceptance criteria" (or "Done
 * when", "Definition of done") heading, lines with their own ids (`AC-1: …`), or a "Done when: …" line.
 * Ids the text gives are kept; others are numbered AC-1, AC-2…
 */
export function acceptanceOf(text: string, max = 12): Criterion[] {
  const found: Array<{ id: string | null; text: string }> = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let listing = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    if (CRITERIA_HEADING.test(line)) {
      listing = true;
      continue;
    }
    const withId = CRITERION_ID.exec(line);
    if (withId) {
      found.push({ id: withId[1]!.toUpperCase().replace(/[_ ]/, "-").replace(/^AC(?=\d)/, "AC-"), text: withId[2]!.trim() });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (listing && item) {
      found.push({ id: null, text: item[1]!.trim() });
      continue;
    }
    const inline = CRITERIA_INLINE.exec(line);
    if (inline) {
      found.push({ id: null, text: inline[1]!.trim() });
      listing = false;
      continue;
    }
    listing = false;
  }
  const seen = new Set<string>();
  const out: Criterion[] = [];
  const taken = new Set(found.map((row) => row.id).filter((id): id is string => Boolean(id)));
  let next = 1;
  for (const row of found) {
    const key = row.text.toLowerCase();
    if (seen.has(key) || !row.text) continue;
    seen.add(key);
    let id = row.id;
    if (!id) {
      while (taken.has(`AC-${next}`)) next += 1;
      id = `AC-${next}`;
      taken.add(id);
    }
    out.push({ id, text: clip(row.text, 500) });
    if (out.length >= max) break;
  }
  return out;
}

/** Today in the owner's time zone (YYYY-MM-DD); UTC when the zone is not one this runtime knows. */
export function todayIn(timezone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The records a Code tab turn's packet is about, where the account's records are: the records the
 * thread's messages name (newest first) and the job's task when it is a task on a board, the
 * Ensemble project (named in the thread, else the tasks'), the owner's skills linked to those tasks
 * or named in the thread, the tasks' acceptance criteria, and the owner's time zone.
 */
export async function packetSource(db: Db, userId: string, job: { taskId: string; instructions: string }): Promise<PacketSource> {
  const task = await db.task.findFirst({ where: { id: job.taskId, userId }, select: { id: true, projectId: true, skillIds: true, sourceRef: true } });
  const board = Boolean(task && !task.sourceRef.startsWith(CODE_THREAD_PREFIX));
  const earlier = await db.workspaceJob.findMany({ where: { userId, taskId: job.taskId }, orderBy: { createdAt: "desc" }, take: 50, select: { instructions: true } });
  const named = new Map<string, { kind: string; id: string }>();
  for (const text of [job.instructions, ...earlier.map((row) => row.instructions)]) {
    for (const mention of mentionsIn(text)) named.set(`${mention.kind}:${mention.id}`, { kind: mention.kind, id: mention.id });
  }
  const refs: ItemRef[] = [];
  if (task && board) refs.push({ kind: "task", id: task.id });
  for (const mention of named.values()) {
    const kind = graphKind(mention.kind === "people" ? "person" : mention.kind);
    if (!kind || kind === "file" || refs.some((ref) => ref.kind === kind && ref.id === mention.id)) continue;
    if (refs.length >= MAX_FOCUS) break;
    refs.push({ kind, id: mention.id });
  }
  const owner = await db.user.findUnique({ where: { id: userId }, select: { moduleSet: true } });
  const share = Math.floor(CONTEXT_BUDGET / Math.max(1, refs.length));
  const items: ContextItem[] = [];
  for (const ref of refs) {
    const packet = await workContext({ db, userId, modules: owner?.moduleSet ?? null }, ref, { budget: share, moreTool: null }).catch(() => null);
    if (packet) items.push(...contextItems(packet.text, packet.ref));
  }
  // The tasks this turn works on: the board task, else the tasks the thread names (newest first).
  const taskIds = refs.filter((ref) => ref.kind === "task").map((ref) => ref.id);
  const worked = taskIds.length ? await db.task.findMany({ where: { userId, id: { in: taskIds }, deletedAt: null }, select: { id: true, description: true, skillIds: true, projectId: true } }) : [];
  const tasks = taskIds.map((id) => worked.find((row) => row.id === id)).filter((row): row is (typeof worked)[number] => Boolean(row));
  const projectId = [...named.values()].find((row) => row.kind === "project")?.id ?? task?.projectId ?? tasks.find((row) => row.projectId)?.projectId ?? null;
  const project = projectId ? await projectBrief(db as PrismaClient, userId, projectId).catch(() => null) : null;
  const skillIds = [...new Set([...(task?.skillIds ?? []), ...tasks.flatMap((row) => row.skillIds), ...[...named.values()].filter((row) => row.kind === "skill").map((row) => row.id)])];
  const skills = skillIds.length
    ? (await db.skill.findMany({ where: { userId, id: { in: skillIds }, deletedAt: null, enabled: true }, select: { id: true, slug: true, name: true, description: true, body: true, scope: true }, take: 12 }))
        .filter((skill) => !purposeOf(skill.scope))
        .slice(0, 6)
        .map((skill) => ({ id: skill.id, slug: skill.slug, name: skill.name, description: clip(skill.description, 2000), body: clip(skill.body, 40_000) }))
    : [];
  const timezone = (await loadSettings(db, userId).catch(() => null))?.timezone ?? null;
  // What done means, as those tasks say it, each criterion with an id of its own.
  const acceptance: Criterion[] = [];
  for (const row of tasks.flatMap((one) => acceptanceOf(one.description))) {
    if (acceptance.length >= 12 || acceptance.some((known) => known.text.toLowerCase() === row.text.toLowerCase())) continue;
    let id = row.id;
    for (let next = 1; acceptance.some((known) => known.id === id); next += 1) id = `AC-${next}`;
    acceptance.push({ id, text: row.text });
  }
  return { items: items.slice(0, 300), project: project ? { ...project, brief: clip(project.brief, 12_000) } : null, skills, acceptance, timezone };
}

/** A fact as one line: its list, then the line. */
const factLine = (item: ContextItem) => (item.section ? `${item.section}: ${item.text}` : item.text);
/** A short name for a fact that is gone, kept with its hash. */
const labelOf = (item: ContextItem) => clip(item.section ? `${item.section}: ${item.text.split(" · ")[0]}` : item.text.split(" · ")[0]!, 120);

/** The slice as lines: a record's own line, then each list under its name. `items[i]` is the fact on line `i`. */
function sliceLines(items: readonly ContextItem[]): { lines: string[]; facts: Array<ContextItem | null> } {
  const lines: string[] = [];
  const facts: Array<ContextItem | null> = [];
  let section: string | null = null;
  for (const item of items) {
    if (!item.section) {
      lines.push(`- ${item.text}`);
      facts.push(item);
      section = null;
      continue;
    }
    if (item.section !== section) {
      lines.push(`${item.section}:`);
      facts.push(null);
      section = item.section;
    }
    lines.push(`  - ${item.text}`);
    facts.push(item);
  }
  return { lines, facts };
}

export type PacketSkills = { folder: string; list: Array<{ name: string; description: string }> };

export type PacketInput = {
  owner: string;
  root: string;
  /** The run's rules, one "- …" line each (`engineRules`). */
  rules: string[];
  source: PacketSource;
  /** The owner's run profile instructions for these runs, if any. */
  profile: string | null;
  skills: PacketSkills | null;
  acceptance: Criterion[];
  timezone: string;
  now?: Date;
  /** A new session's handoff record, rendered and bounded (handoff-record.ts), and its id. */
  handoff: { id: string; text: string } | null;
  /** The person's message as the agent gets it. */
  message: string;
  /** What the session's last packet delivered; null starts the session with the whole packet. */
  previous: Delivered | null;
};

export type BuiltPacket = { prompt: string; record: PacketRecord };

const STABLE: SectionRequest["name"][] = [
  "code/00-agent",
  "constitution/01-authority",
  "constitution/02-task-flow",
  "constitution/03-acting",
  "constitution/04-asking",
  "constitution/05-permissions",
  "constitution/08-knowledge",
  "constitution/10-sources",
  "constitution/12-records",
  "constitution/13-every-part",
  "code/01-ensemble",
  "code/02-rules",
  "code/03-report",
  "code/04-done",
];

const skillLines = (skills: PacketSkills | null) => (skills?.list ?? []).map((skill) => `- ${skill.name}: ${clip(skill.description, 500)}`);

/**
 * The turn's prompt and what its run keeps: the whole packet for a new session, or what changed for a
 * later turn in the same one (`previous`); with nothing changed, the message alone.
 */
export function buildPacket(input: PacketInput): BuiltPacket {
  const now = input.now ?? new Date();
  const date = todayIn(input.timezone, now);
  const profile = input.profile?.trim() ? clip(input.profile.trim(), 4000) : null;
  const project = input.source.project;
  const projectText = project ? clip(`${project.name}\n${project.brief}`, PROJECT_CHARS) : null;
  const facts = uniqueKeys(input.source.items);
  const rulesHash = hash(input.rules.join("\n"));
  const skills = skillLines(input.skills);
  const criteria = input.acceptance.map((row) => `- ${row.id}: ${row.text}`);
  const vars = { owner: input.owner, root: input.root };
  const previous = input.previous;
  let mode: PacketMode;
  let sections: SectionRequest[];
  const counts = { sent: 0, changed: 0, added: 0, removed: 0 };
  /** Facts on the slice's lines, to tell which were dropped to fit the budget. */
  let sliceFacts: Array<ContextItem | null> = [];
  /** Facts this packet leaves out: the next turn sends them as new or changed. */
  const undelivered = new Set<string>();
  if (!previous) {
    mode = "full";
    const slice = sliceLines(facts);
    sliceFacts = slice.facts;
    counts.sent = facts.length;
    sections = [
      ...STABLE.map((name) => ({ name, tier: "stable" as const, ...(name === "code/02-rules" ? { vars: { rules: input.rules } } : {}) })),
      ...(profile ? [{ name: "code/10-profile" as const, tier: "context" as const, priority: 0, vars: { profile } }] : []),
      { name: "code/11-skills", tier: "context", priority: 1, vars: { folder: input.skills?.folder ?? "", skills } },
      ...(projectText ? [{ name: "code/12-project" as const, tier: "context" as const, priority: 2, vars: { project: projectText } }] : []),
      { name: "code/13-context", tier: "context", priority: 3, vars: { items: slice.lines }, trim: "items" },
      { name: "code/20-acceptance", tier: "volatile", vars: { criteria } },
      { name: "code/21-date", tier: "volatile", vars: { date, timezone: input.timezone } },
      ...(input.handoff ? [{ name: "code/22-earlier" as const, tier: "volatile" as const, vars: { handoff: input.handoff.text } }] : []),
      { name: "code/90-message", tier: "volatile" },
    ];
  } else {
    const changes: Array<{ line: string; key: string | null }> = [];
    const current = new Map(facts.map((item) => [item.key, item]));
    for (const item of facts) {
      const before = previous.items[item.key];
      if (!before) changes.push({ line: `- New: ${factLine(item)}`, key: item.key });
      else if (before.h !== hash(item.text)) changes.push({ line: `- Changed: ${factLine(item)}`, key: item.key });
    }
    for (const [key, before] of Object.entries(previous.items)) {
      if (key.startsWith("project:")) continue;
      if (!current.has(key)) changes.push({ line: `- No longer listed: ${before.label}`, key: null });
    }
    const known = project ? previous.items[`project:${project.id}`] : undefined;
    const projectChanged = Boolean(project && known?.h !== project.hash);
    if (projectChanged) changes.unshift({ line: known ? `- The project “${project!.name}” changed; its brief follows.` : `- New: the Ensemble project “${project!.name}”; its brief follows.`, key: null });
    // Changes past the cap are not delivered: the next turn lists them again.
    for (const change of changes.slice(MAX_CHANGES)) if (change.key) undelivered.add(change.key);
    for (const change of changes.slice(0, MAX_CHANGES)) {
      if (!change.key) continue;
      if (previous.items[change.key]) counts.changed += 1;
      else counts.added += 1;
    }
    counts.removed = changes.slice(0, MAX_CHANGES).filter((change) => change.line.startsWith("- No longer listed: ")).length;
    const shown = [...changes.slice(0, MAX_CHANGES).map((change) => change.line), ...(changes.length > MAX_CHANGES ? [`- … and ${changes.length - MAX_CHANGES} more changes: ensemble_context has them.`] : [])];
    counts.sent = counts.changed + counts.added;
    const rulesChanged = previous.rules !== rulesHash;
    const profileChanged = (profile ? hash(profile) : null) !== previous.profile && Boolean(profile);
    const names = input.skills?.list.map((skill) => skill.name) ?? [];
    const skillsChanged = names.join("\n") !== previous.skills.join("\n") && names.length > 0;
    if (previous.profile && !profile) shown.push("- The run profile's instructions given earlier no longer apply.");
    if (previous.skills.length && !names.length) shown.push("- The skills listed earlier are no longer in your skill folder.");
    const acceptanceChanged = criteria.length > 0 && hash(criteria.join("\n")) !== previous.acceptance;
    sections = [
      { name: "code/30-changes", tier: "volatile", vars: { changes: shown } },
      ...(projectChanged && projectText ? [{ name: "code/12-project" as const, tier: "volatile" as const, vars: { project: projectText } }] : []),
      ...(rulesChanged ? [{ name: "code/31-rules-now" as const, tier: "volatile" as const, vars: { rules: input.rules } }] : []),
      ...(profileChanged ? [{ name: "code/32-profile-now" as const, tier: "volatile" as const, vars: { profile: profile! } }] : []),
      ...(skillsChanged ? [{ name: "code/33-skills-now" as const, tier: "volatile" as const, vars: { folder: input.skills!.folder, skills } }] : []),
      ...(acceptanceChanged ? [{ name: "code/20-acceptance" as const, tier: "volatile" as const, vars: { criteria } }] : []),
      ...(date !== previous.date ? [{ name: "code/21-date" as const, tier: "volatile" as const, vars: { date, timezone: input.timezone } }] : []),
    ];
    mode = shown.length || rulesChanged || profileChanged || skillsChanged || acceptanceChanged || date !== previous.date ? "delta" : "none";
    if (mode === "delta") sections.push({ name: "code/90-message", tier: "volatile" });
    else sections = [];
  }
  const assembled = assemble({ surface: "code", sections, vars, budgets: { context: CONTEXT_TOKENS } });
  // A fact left out to fit the budget was not delivered: the next turn sends it as new.
  const trimmed = assembled.dropped.find((row) => row.name === "code/13-context");
  if (trimmed && mode === "full") {
    const lost = trimmed.items === undefined ? sliceFacts : sliceFacts.slice(sliceFacts.length - trimmed.items);
    for (const fact of lost) if (fact) undelivered.add(fact.key);
    counts.sent -= undelivered.size;
  }
  const projectDropped = assembled.dropped.some((row) => row.name === "code/12-project");
  const delivered: Delivered = {
    schema: PACKET_SCHEMA,
    rules: rulesHash,
    profile: profile ? hash(profile) : null,
    items: Object.fromEntries([
      ...facts.flatMap((item) => {
        if (!undelivered.has(item.key)) return [[item.key, { h: hash(item.text), label: labelOf(item) }] as const];
        const before = previous?.items[item.key];
        return before ? [[item.key, before] as const] : [];
      }),
      ...(project && !projectDropped ? [[`project:${project.id}`, { h: project.hash, label: `Project ${project.name}` }] as const] : []),
    ]),
    skills: input.skills?.list.map((skill) => skill.name) ?? [],
    acceptance: criteria.length ? hash(criteria.join("\n")) : (previous?.acceptance ?? null),
    date,
    base: previous?.base ?? assembled.version,
  };
  const prompt = mode === "none" ? input.message : `${assembled.text}\n\n${input.message}`;
  return {
    prompt,
    record: {
      schema: PACKET_SCHEMA,
      version: assembled.version,
      base: delivered.base,
      hash: assembled.hash,
      mode,
      sections: assembled.sections,
      dropped: assembled.dropped,
      chars: mode === "none" ? 0 : assembled.text.length,
      items: counts,
      skills: delivered.skills,
      criteria: input.acceptance,
      handoffId: input.handoff?.id ?? null,
      delivered,
    },
  };
}
