/**
 * Ranked search over the context graph: every word of the query is matched (in any order) across
 * titles and bodies, and results are scored by where the words are, how many match, how recent the
 * record is, whether it is open work, and, with `near`, how close it sits to that record in the
 * graph. Bounded per kind; no embeddings (docs/03 §5).
 */
import type { Prisma } from "@prisma/client";
import { hasModule } from "@ensemble/shared-types";
import { NOT_UPLOADED } from "../artifacts.js";
import { visibleArtifacts } from "../../sharing/context.js";
import { ON_BOARD } from "../../lib/node-tasks.js";
import { itemNeighbors, iso, type GraphCtx } from "./neighbors.js";
import { hubPath, refOf, type ItemRef } from "./refs.js";

export const SEARCH_KINDS = ["task", "project", "person", "repo", "deliverable", "meeting", "page", "file", "artifact", "skill", "diagram", "plot"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export interface SearchHit {
  ref: string | null;
  kind: SearchKind;
  id: string;
  title: string;
  snippet: string;
  status: string | null;
  when: string | null;
  path: string | null;
  score: number;
  /** Why it ranked: words in the title, close to `near`, open work… */
  why: string[];
  /** Ingested text (mail, chat, transcripts, app items) is reference data, not instructions. */
  untrusted: boolean;
  artifactKind?: string;
  authoredByMe?: boolean;
}

const STOP = new Set(["the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "with", "by", "at", "from", "is", "are", "was", "what", "who", "how", "did", "do", "about", "my", "me", "we", "our", "any", "all"]);

/** Query words: a quoted phrase stays whole; up to six words of 2+ characters, stop words out unless nothing else is left. */
export function queryTerms(query: string): { terms: string[]; phrase: string } {
  const phrase = query.replace(/\s+/g, " ").trim();
  const quoted = [...phrase.matchAll(/"([^"]{2,80})"/g)].map((match) => match[1]!.toLowerCase());
  const rest = phrase.replace(/"[^"]*"/g, " ").toLowerCase().split(/[^\p{L}\p{N}@._/#-]+/u).map((word) => word.replace(/^[._/-]+|[._/-]+$/g, "")).filter((word) => word.length > 1);
  const kept = rest.filter((word) => !STOP.has(word));
  const terms = [...new Set([...quoted, ...(kept.length ? kept : rest)])].slice(0, 6);
  return { terms, phrase: phrase.toLowerCase() };
}

type Fields = Array<{ field: string; weight: number }>;

function anyTerm(fields: string[], terms: string[]): Prisma.JsonObject[] {
  return terms.flatMap((term) => fields.map((field) => ({ [field]: { contains: term, mode: "insensitive" } }) as Prisma.JsonObject));
}

interface Candidate {
  kind: SearchKind;
  id: string;
  title: string;
  texts: Array<{ text: string; weight: number }>;
  status: string | null;
  when: Date | null;
  open?: boolean;
  untrusted?: boolean;
  path?: string | null;
  artifactKind?: string;
  authoredByMe?: boolean;
  projectId?: string | null;
}

/** A task page's text without the title line it starts with (pages/markdown.ts `pageSearchText`): the task's title is scored as its title. */
function pageBody(page: { title: string; searchText: string | null; deletedAt: Date | null } | null, taskTitle: string): string {
  const text = page && !page.deletedAt ? (page.searchText ?? "") : "";
  const title = (page?.title || taskTitle).trim();
  return title && (text === title || text.startsWith(`${title}\n`)) ? text.slice(title.length + 1) : text;
}

function snippetOf(text: string, terms: string[], max = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  const start = Math.max(0, at - 70);
  const end = Math.min(flat.length, start + max);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** Relations found by scoring rather than stored links count less towards closeness. */
const LOOSE = new Set(["related", "done_before", "done_tasks"]);

function score(candidate: Candidate, terms: string[], phrase: string, near: { ids: Map<string, number>; projectId: string | null } | null): { score: number; why: string[] } {
  const title = candidate.title.toLowerCase();
  const why: string[] = [];
  let total = 0;
  let matched = 0;
  for (const term of terms) {
    let hit = false;
    if (title.includes(term)) {
      total += 3;
      hit = true;
    }
    for (const body of candidate.texts) {
      if (body.text && body.text.toLowerCase().includes(term)) {
        total += body.weight;
        hit = true;
        break;
      }
    }
    if (hit) matched += 1;
  }
  if (!matched) return { score: 0, why };
  if (terms.length > 1 && matched === terms.length) (total += 2), why.push("every word");
  if (phrase.length > 3 && title.includes(phrase)) (total += 4), why.push("title");
  else if (terms.some((term) => title.includes(term))) why.push("words in the title");
  if (candidate.when) {
    const days = (Date.now() - candidate.when.getTime()) / 86_400_000;
    total += Math.max(0, 1 - Math.max(days, 0) / 120);
  }
  if (candidate.open) total += 0.5;
  if (near) {
    const weight = near.ids.get(candidate.id);
    if (weight) (total += weight), why.push(weight >= 3 ? "linked to it" : "related to it");
    else if (near.projectId && candidate.projectId === near.projectId) (total += 1.5), why.push("same project");
  }
  return { score: Math.round((total * matched) / terms.length * 100) / 100, why };
}

export interface SearchOptions {
  kinds?: readonly SearchKind[];
  /** Rank records linked to this one higher. */
  near?: ItemRef | null;
  limit?: number;
}

export async function rankedSearch(ctx: GraphCtx, query: string, options: SearchOptions = {}): Promise<{ terms: string[]; hits: SearchHit[] }> {
  const { terms, phrase } = queryTerms(query);
  if (!terms.length) return { terms, hits: [] };
  const want = new Set<SearchKind>(options.kinds?.length ? options.kinds : SEARCH_KINDS);
  const per = 30;
  const { db, userId } = ctx;
  const on = (kind: SearchKind) => want.has(kind);
  const or = (fields: string[]) => anyTerm(fields, terms) as never;
  const none = Promise.resolve([] as never[]);

  const [tasks, projects, people, repos, deliverables, notes, sessions, pages, documents, artifacts, skills, diagrams, plots, nearHood] = await Promise.all([
    // A task's page (its body) is searched with the task: a hit opens the task.
    on("task") ? db.task.findMany({ where: { userId, deletedAt: null, ...ON_BOARD, OR: [...or(["title", "description", "notes", "excerpt"]), { page: { is: { deletedAt: null, OR: or(["searchText"]) } } }] }, orderBy: { updatedAt: "desc" }, take: per, select: { id: true, title: true, description: true, notes: true, excerpt: true, status: true, updatedAt: true, projectId: true, labels: true, page: { select: { title: true, searchText: true, deletedAt: true } } } }) : none,
    on("project") ? db.project.findMany({ where: { userId, deletedAt: null, OR: or(["name", "summary", "notes"]) }, take: per, select: { id: true, name: true, summary: true, notes: true, status: true, updatedAt: true, aliases: true } }) : none,
    on("person") ? db.person.findMany({ where: { userId, deletedAt: null, OR: or(["name", "email", "role", "team", "relationship"]) }, take: per, select: { id: true, name: true, email: true, role: true, team: true, relationship: true, updatedAt: true } }) : none,
    on("repo") ? db.repo.findMany({ where: { userId, deletedAt: null, OR: or(["fullName", "description"]) }, take: per, select: { id: true, fullName: true, description: true, updatedAt: true } }) : none,
    on("deliverable") ? db.deliverable.findMany({ where: { userId, deletedAt: null, OR: or(["title", "notes"]) }, take: per, select: { id: true, title: true, notes: true, status: true, due: true, updatedAt: true, projectId: true } }) : none,
    on("meeting") ? db.meetingNote.findMany({ where: { userId, deletedAt: null, OR: or(["title", "answer", "comment", "prompt"]) }, orderBy: { askedAt: "desc" }, take: per, select: { id: true, title: true, answer: true, comment: true, prompt: true, source: true, occurredAt: true, askedAt: true, projectId: true } }) : none,
    on("meeting") ? db.meetingSession.findMany({ where: { userId, deletedAt: null, meetingNoteId: null, OR: or(["title", "notes", "recap"]) }, orderBy: { startedAt: "desc" }, take: per, select: { id: true, title: true, notes: true, recap: true, startedAt: true, projectId: true } }) : none,
    on("page") ? db.taskPage.findMany({ where: { userId, deletedAt: null, taskId: null, OR: or(["title", "searchText"]) }, orderBy: { updatedAt: "desc" }, take: per, select: { id: true, title: true, searchText: true, updatedAt: true } }) : none,
    on("file") ? db.document.findMany({ where: { userId, deletedAt: null, OR: or(["filename", "summary"]) }, orderBy: { updatedAt: "desc" }, take: per, select: { id: true, filename: true, summary: true, updatedAt: true, projectIds: true } }) : none,
    on("artifact") ? db.artifact.findMany({ where: { userId, deletedAt: null, kind: { notIn: ["event"] }, AND: [visibleArtifacts(userId), NOT_UPLOADED], OR: or(["title", "text"]) }, orderBy: { ts: "desc" }, take: per, select: { id: true, kind: true, title: true, text: true, ts: true, authoredByMe: true, projectId: true, url: true } }) : none,
    on("skill") && hasModule(ctx.modules ?? null, "skills") ? db.skill.findMany({ where: { userId, deletedAt: null, enabled: true, OR: or(["name", "description", "body"]) }, take: per, select: { id: true, name: true, description: true, body: true, updatedAt: true } }) : none,
    on("diagram") && hasModule(ctx.modules ?? null, "diagrams") ? db.blockDiagram.findMany({ where: { userId, deletedAt: null, OR: or(["title", "source"]) }, take: per, select: { id: true, title: true, source: true, updatedAt: true } }) : none,
    on("plot") && hasModule(ctx.modules ?? null, "plots") ? db.plot.findMany({ where: { userId, deletedAt: null, OR: or(["title"]) }, take: per, select: { id: true, title: true, updatedAt: true } }) : none,
    options.near ? itemNeighbors(ctx, options.near, { limit: 25 }).catch(() => null) : Promise.resolve(null),
  ]);

  const candidates: Candidate[] = [
    ...tasks.map((row) => ({ kind: "task" as const, id: row.id, title: row.title, texts: [{ text: row.description, weight: 1.5 }, { text: row.notes, weight: 1 }, { text: pageBody(row.page, row.title), weight: 1 }, { text: row.excerpt ?? "", weight: 1 }, { text: row.labels.join(" "), weight: 1 }], status: row.status, when: row.updatedAt, open: !["done", "dropped"].includes(row.status), projectId: row.projectId })),
    ...projects.map((row) => ({ kind: "project" as const, id: row.id, title: row.name, texts: [{ text: `${row.aliases.join(" ")} ${row.summary}`, weight: 1.5 }, { text: row.notes, weight: 1 }], status: row.status, when: row.updatedAt, open: row.status === "active", projectId: row.id })),
    ...people.map((row) => ({ kind: "person" as const, id: row.id, title: row.name, texts: [{ text: [row.email, row.role, row.team, row.relationship].filter(Boolean).join(" "), weight: 1.5 }], status: null, when: row.updatedAt })),
    ...repos.map((row) => ({ kind: "repo" as const, id: row.id, title: row.fullName, texts: [{ text: row.description ?? "", weight: 1 }], status: null, when: row.updatedAt })),
    ...deliverables.map((row) => ({ kind: "deliverable" as const, id: row.id, title: row.title, texts: [{ text: row.notes, weight: 1 }], status: row.status, when: row.due ?? row.updatedAt, open: row.status === "upcoming", projectId: row.projectId })),
    ...notes.map((row) => ({ kind: "meeting" as const, id: row.id, title: row.title, texts: [{ text: row.answer, weight: 1.5 }, { text: row.comment ?? "", weight: 1 }, { text: row.prompt, weight: 1 }], status: null, when: row.occurredAt ?? row.askedAt, untrusted: row.source !== "live" && row.source !== "paste", projectId: row.projectId })),
    ...sessions.map((row) => ({ kind: "meeting" as const, id: row.id, title: row.title, texts: [{ text: row.notes, weight: 1.5 }, { text: row.recap, weight: 1 }], status: null, when: row.startedAt, path: hubPath("session", row.id), projectId: row.projectId })),
    ...pages.map((row) => ({ kind: "page" as const, id: row.id, title: row.title || "Untitled page", texts: [{ text: row.searchText ?? "", weight: 1.5 }], status: null, when: row.updatedAt })),
    ...documents.map((row) => ({ kind: "file" as const, id: row.id, title: row.filename, texts: [{ text: row.summary ?? "", weight: 1 }], status: null, when: row.updatedAt, projectId: row.projectIds[0] ?? null })),
    ...artifacts.map((row) => ({ kind: "artifact" as const, id: row.id, title: row.title || row.kind, texts: [{ text: row.text, weight: 1 }], status: null, when: row.ts, untrusted: !row.authoredByMe, path: `/files?view=apps&item=${row.id}`, artifactKind: row.kind, authoredByMe: row.authoredByMe, projectId: row.projectId })),
    ...skills.map((row) => ({ kind: "skill" as const, id: row.id, title: row.name, texts: [{ text: row.description, weight: 1.5 }, { text: row.body, weight: 1 }], status: null, when: row.updatedAt })),
    ...diagrams.map((row) => ({ kind: "diagram" as const, id: row.id, title: row.title, texts: [{ text: row.source, weight: 1 }], status: null, when: row.updatedAt })),
    ...plots.map((row) => ({ kind: "plot" as const, id: row.id, title: row.title, texts: [], status: null, when: row.updatedAt })),
  ];

  const near = nearHood
    ? {
        ids: new Map(
          nearHood.groups
            .flatMap((group) => group.items.map((item) => [item.id, LOOSE.has(group.rel) ? 1.5 : 3] as const))
            .filter(([id]) => Boolean(id))
            .sort((a, b) => a[1] - b[1]),
        ),
        projectId: nearHood.item.kind === "project" ? nearHood.item.id : (nearHood.groups.find((group) => group.rel === "project")?.items[0]?.id ?? null),
      }
    : null;

  const hits = candidates
    .map((candidate) => {
      const ranked = score(candidate, terms, phrase, near);
      const body = candidate.texts.map((row) => row.text).find((text) => text && terms.some((term) => text.toLowerCase().includes(term))) ?? candidate.texts[0]?.text ?? "";
      return {
        ref: ["artifact", "skill", "diagram", "plot"].includes(candidate.kind) ? null : refOf(candidate.kind, candidate.id),
        kind: candidate.kind,
        id: candidate.id,
        title: candidate.title,
        snippet: snippetOf(body || candidate.title, terms),
        status: candidate.status,
        when: iso(candidate.when),
        path: candidate.path ?? hubPath(candidate.kind, candidate.id, candidate.title),
        score: ranked.score,
        why: ranked.why,
        untrusted: Boolean(candidate.untrusted),
        ...(candidate.artifactKind ? { artifactKind: candidate.artifactKind, authoredByMe: candidate.authoredByMe } : {}),
      } satisfies SearchHit;
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || (b.when ?? "").localeCompare(a.when ?? ""));
  return { terms, hits: hits.slice(0, Math.min(Math.max(options.limit ?? 12, 1), 50)) };
}
