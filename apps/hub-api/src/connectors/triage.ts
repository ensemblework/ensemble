/**
 * Turns what a fetch read into proposed todos (docs/03 §4.2, docs/05 §3).
 *
 * Deterministic proposals (review requests, assigned issues) are created as
 * they are. Mail and chat go to the low tier model in one batch; if no model
 * is reachable a conservative heuristic runs instead, and the extraction row
 * records which one decided.
 */
import type { Settings } from "@ensemble/shared-types";
import { appendLedger } from "../lib/ledger.js";
import { prisma } from "../lib/prisma.js";
import { isHmTime, isIsoDate, zonedDateTimeToUtc, zonedParts } from "../lib/clock.js";
import { complete } from "../lib/runtime.js";
import type { StoredArtifact } from "./ingest.js";
import { heuristicTodo, triageTodosFromReply, warnTriageFallback, type ModelTodo } from "./triage-todos.js";
import type { Proposal } from "./types.js";

export const TRIAGE_PROMPT = `You triage an engineer's inbox and chat for their personal agent.

The engineer: <<IDENTITY>>
Their projects: <<PROJECTS>>
Today: <<TODAY>>

For each item below, decide whether it asks the engineer to do something: reply with information, review, decide, send, attend, fix, or deliver. Newsletters, receipts, automated notifications, FYIs and threads where someone else owns the next step are NOT todos.

Return JSON only:
{"todos":[{"id":"<item id>","title":"<imperative, specific, under 90 chars, e.g. Reply to Priya with p95 latency numbers>","priority":"p0|p1|p2","due":"YYYY-MM-DD, a full ISO datetime, or null","due_time":"HH:MM or null","owner":"me|agent","rationale":"<one sentence: who asked what>","excerpt":"<the exact sentence that asks, copied from the item>"}]}

When the email states a time, set due_time to that time as 24-hour HH:MM (or put the time in due as an ISO datetime). If it states a date but no time, omit due_time. Use absolute dates in titles and text (for example "before the Oct 6 release", not "before the release tomorrow"). These rows are proposals: describe them as proposed ("I've proposed a project page — press Apply to create it"). Do not say you have created or drafted them before Apply.

Only include items that need action. owner is "agent" only for a short factual reply or a routine acknowledgement the agent could draft; otherwise "me". p0 means today or blocking someone; p1 this week; p2 whenever.

Items:
<<ITEMS>>`;

type TriageItem = StoredArtifact & { personId?: string | null };

const SOURCE_KIND: Record<string, Proposal["sourceKind"]> = { email: "email", chat_msg: "slack", channel_msg: "slack" };
const DEFAULT_DUE_TIME = "17:00";

/** Clock time from HH:MM or HH:MM:SS. Anything else is not a time. */
function clockTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{2}:\d{2})(?::\d{2})?$/.exec(value.trim());
  return match && isHmTime(match[1]!) ? match[1]! : null;
}

/**
 * A triage due date in the user's zone.
 * `due_time` (HH:MM) or the time on an ISO `due` wins. An invalid time, or no
 * time at all, is 17:00. A missing or unreadable date is no due date.
 */
export function triageDueInstant(
  due: string | null | undefined,
  dueTime: string | null | undefined,
  timeZone: string,
): Date | null {
  if (!due || !due.trim()) return null;
  const text = due.trim();
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(text);
  const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?/.exec(text);
  const date = dateOnly?.[1] ?? iso?.[1];
  if (!date || !isIsoDate(date)) return null;
  const stated = dueTime == null || !String(dueTime).trim() ? null : clockTime(dueTime);
  // A due_time that was sent but is not a clock time is 17:00, not the ISO time.
  if (dueTime && String(dueTime).trim() && !stated) return zonedDateTimeToUtc(date, DEFAULT_DUE_TIME, timeZone);
  // An ISO time with Z or an offset is an instant already; reading it as the
  // user's wall clock would move it by the offset, sometimes onto another day.
  if (iso && !stated && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const instant = new Date(text);
    if (!Number.isNaN(instant.getTime())) return instant;
  }
  const fromIso = iso ? clockTime(iso[2]) : null;
  return zonedDateTimeToUtc(date, stated ?? fromIso ?? DEFAULT_DUE_TIME, timeZone);
}

async function nextOrder(userId: string): Promise<number> {
  const last = await prisma.task.findFirst({ where: { userId, status: "proposed" }, orderBy: { boardOrder: "desc" }, select: { boardOrder: true } });
  return (last?.boardOrder ?? 0) + 1;
}

async function exists(userId: string, sourceRef: string): Promise<boolean> {
  return Boolean(await prisma.task.findFirst({ where: { userId, sourceRef }, select: { id: true } }));
}

export async function createProposals(userId: string, proposals: Proposal[], via: string): Promise<number> {
  let created = 0;
  let order = await nextOrder(userId);
  for (const proposal of proposals) {
    if (await exists(userId, proposal.sourceRef)) continue;
    const task = await prisma.task.create({
      data: {
        userId,
        title: proposal.title.slice(0, 200),
        description: proposal.description,
        sourceKind: proposal.sourceKind,
        sourceRef: proposal.sourceRef,
        sourceUrl: proposal.sourceUrl ?? null,
        excerpt: proposal.excerpt ?? null,
        status: "proposed",
        owner: "unassigned",
        priority: proposal.priority,
        due: proposal.due ?? null,
        people: proposal.people ?? [],
        repoId: proposal.repoId ?? null,
        rationale: proposal.rationale,
        createdBy: "agent",
        confidence: via === "model" ? 0.75 : 0.6,
        boardOrder: order++,
      },
    });
    await prisma.artifact.update({ where: { id: proposal.artifactId }, data: { taskId: task.id } }).catch(() => undefined);
    await prisma.taskTransition.create({
      data: { userId, taskId: task.id, toStatus: "proposed", toOwner: "unassigned", actor: "agent", reason: `fetch:${via}` },
    });
    created += 1;
  }
  if (created) await appendLedger({ userId, actor: "agent", action: "todo.propose", payload: { created, via } });
  return created;
}

function itemText(item: TriageItem): string {
  const meta = item.input.metadata ?? {};
  const from = (meta.from as string | undefined) ?? item.input.participants?.[0]?.name ?? "unknown";
  return [
    `id: ${item.id}`,
    `kind: ${item.input.kind}${meta.directlyToMe ? " (addressed to me)" : ""}${meta.mentionsMe ? " (mentions me)" : ""}`,
    `from: ${from}`,
    `subject: ${item.input.title}`,
    `sent: ${item.input.ts.toISOString().slice(0, 16)}`,
    `text: ${item.input.text.slice(0, 1500).replace(/\s+/g, " ")}`,
  ].join("\n");
}

function heuristic(item: TriageItem): ModelTodo | null {
  return heuristicTodo(item);
}

export async function triage(userId: string, settings: Settings, items: TriageItem[]): Promise<{ created: number; via: string; error?: string }> {
  if (!items.length || !settings.fetch.proposeTodos) return { created: 0, via: "none" };
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
  const projects = await prisma.project.findMany({ where: { userId, deletedAt: null, status: "active" }, select: { name: true }, take: 30 });
  const byId = new Map(items.map((item) => [item.id, item]));
  let todos: ModelTodo[] = [];
  let via = "model";
  let model: string | null = null;
  let error: string | undefined;
  for (let start = 0; start < items.length; start += 15) {
    const batch = items.slice(start, start + 15);
    try {
      const answer = await complete({
        userId,
        settings,
        tier: "easy",
        purpose: "Triage",
        json: true,
        jsonShape: "triage",
        system: "You are a precise triage classifier. Return only JSON.",
        prompt: TRIAGE_PROMPT.replace("<<IDENTITY>>", `${user?.name || "the engineer"} <${user?.email ?? settings.email}>`)
          .replace("<<PROJECTS>>", projects.map((row) => row.name).join(", ") || "(none yet)")
          .replace("<<TODAY>>", zonedParts(settings.timezone).date)
          .replace("<<ITEMS>>", batch.map(itemText).join("\n---\n")),
      });
      model = answer.model;
      const decided = triageTodosFromReply(answer.text, batch);
      if (decided.via === "heuristic") {
        via = "heuristic";
        error = decided.error;
      }
      todos.push(...decided.todos);
    } catch (failure) {
      via = "heuristic";
      error = failure instanceof Error ? failure.message : String(failure);
      warnTriageFallback(failure);
      todos.push(...batch.map(heuristic).filter((row): row is ModelTodo => row !== null));
    }
  }
  todos = todos.filter((row, index, all) => all.findIndex((other) => other.id === row.id) === index);
  for (const item of items) {
    const found = todos.find((row) => row.id === item.id);
    await prisma.extraction.upsert({
      where: { artifactId: item.id },
      create: { userId, artifactId: item.id, items: found ? [{ type: "ask", toMe: true, text: found.excerpt ?? found.title, confidence: 0.7 }] : [], model, method: via },
      update: { items: found ? [{ type: "ask", toMe: true, text: found.excerpt ?? found.title, confidence: 0.7 }] : [], model, method: via },
    });
  }
  const proposals: Proposal[] = todos.map((row) => {
    const item = byId.get(row.id)!;
    const thread = item.input.threadId ?? item.input.externalId;
    return {
      sourceRef: `${item.input.kind === "email" ? "gmail" : "slack"}:thread:${thread}`,
      sourceKind: SOURCE_KIND[item.input.kind] ?? "other",
      title: row.title,
      description: item.input.text.slice(0, 2000),
      sourceUrl: item.input.url ?? null,
      excerpt: row.excerpt ?? null,
      priority: row.priority === "p0" || row.priority === "p2" ? row.priority : "p1",
      due: triageDueInstant(row.due, row.dueTime, settings.timezone),
      people: item.personId ? [item.personId] : [],
      artifactId: item.id,
      rationale: row.rationale ?? "",
    };
  });
  return { created: await createProposals(userId, proposals, via), via, error };
}
