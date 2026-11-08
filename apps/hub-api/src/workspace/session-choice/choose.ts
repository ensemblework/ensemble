/**
 * Choosing a session (docs/30, Choosing a session), on the computer that runs the agent: which of this
 * computer's agent sessions, if any, a new run continues. Candidates are the sessions of the same agent
 * here that are idle, resumable, not chats, active within `maxAgeDays`, and whose every task is in the new
 * task's project (or all in none): sessions never cross projects. Each gets signals (links, structure,
 * anchors, topic, wording, cache, size: score.ts), a score and a band; the best confident one is
 * continued. Every decision is recorded with all candidates' signals (`SessionChoice`).
 *
 * Bounded: at most `limits.candidates` sessions, `limits.sessionChars` of text each, and word matching
 * stops at `limits.timeBudgetMs` (then links and structure decide alone).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { CodeEngine } from "@ensemble/shared-types";
import { jobOrigin } from "../../remote/origin.js";
import { listSessionGroups, type AgentSession, type SessionScope } from "../sessions.js";
import { configHash, type SessionChoiceConfig } from "./config.js";
import { parseFacts, type TaskFacts } from "./related.js";
import { decide, scoreCandidate, type Band, type LinkReason, type Scored, type Signals } from "./score.js";
import { buildCorpus, featuresOf, similarity, surfaceForms, type Corpus, type TextFeatures } from "./text.js";

/** File names nearly every repository has: never an anchor. */
const COMMON_FILES = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "readme.md", "index.ts", "index.js", "index.tsx", "main.py", "__init__.py", "tsconfig.json", ".gitignore", "cargo.toml", "cargo.lock", "go.mod", "go.sum", "requirements.txt", "pyproject.toml", "agents.md", "claude.md", "gemini.md", "license", "changelog.md"]);
const LINK_ORDER: Record<LinkReason, number> = { mention: 0, link: 1, depends: 2 };

export interface NewTask {
  facts: TaskFacts;
  title: string;
  description: string;
  notes: string;
  instructions: string;
}

export interface Candidate {
  session: AgentSession;
  /** The title of the task the link or best evidence points at, for the reason shown. */
  title: string;
  signals: Signals;
}

export interface Choice {
  decision: "continue" | "new";
  band: Band;
  /** The session continued. */
  session: AgentSession | null;
  title: string | null;
  why: string | null;
  /** The best session was confident but too full: the new session gets its last report. */
  handover: { title: string; summary: string } | null;
  /** new-session: the person asked for one; too-full: the best was too full; unavailable: it could not take the run. */
  note: "new-session" | "too-full" | "unavailable" | null;
  record: Omit<Prisma.SessionChoiceUncheckedCreateInput, "userId" | "jobId">;
}

const clip = (text: string | null | undefined, max: number) => (text ?? "").slice(0, max);

// ---------- word rarity, per account, kept a while ----------

const corpora = new Map<string, Corpus>();

async function corpusFor(prisma: PrismaClient, userId: string, config: SessionChoiceConfig, deadline: number, extra: ReadonlySet<string>): Promise<Corpus | null> {
  const hit = corpora.get(userId);
  if (hit && Date.now() - hit.builtAt < config.limits.corpusTtlMinutes * 60_000) return hit;
  const rows = await prisma.task.findMany({ where: { userId }, orderBy: { updatedAt: "desc" }, take: config.limits.corpusTasks, select: { title: true, description: true, labels: true, notes: true } });
  const corpus = buildCorpus(
    rows.map((row) => [row.title, row.labels.join(" "), clip(row.description, 2000), clip(row.notes, 2000)].join("\n")),
    deadline,
    extra,
  );
  if (corpus) {
    corpora.delete(userId);
    corpora.set(userId, corpus);
    while (corpora.size > 20) corpora.delete(corpora.keys().next().value!);
  }
  return corpus;
}

/** Test seam. */
export function forgetCorpora(): void {
  corpora.clear();
}

// ---------- candidates ----------

type RunRow = {
  id: string;
  taskId: string;
  context: unknown;
  summary: string | null;
  evidence: unknown;
  task: { id: string; title: string; description: string; notes: string; labels: string[]; projectId: string | null; deliverableId: string | null; meetingNoteId: string | null; page: { parentId: string | null } | null };
};

/** A run's task facts: kept on the run, or this computer's own task's; null for an older run claimed from the web (its project is unknown here). */
function runFacts(row: RunRow): TaskFacts | null {
  const kept = parseFacts((row.context as { taskFacts?: unknown } | null)?.taskFacts);
  if (kept) return kept;
  if (jobOrigin(row.context) === "web") return null;
  return { key: row.task.id, projectId: row.task.projectId, deliverableId: row.task.deliverableId, meetingId: row.task.meetingNoteId, parentPageId: row.task.page?.parentId ?? null, labels: row.task.labels, named: [] };
}

const filesOf = (evidence: unknown): string[] => {
  const files = (evidence as { files?: unknown } | null)?.files;
  return Array.isArray(files) ? files.map((file) => (file as { path?: unknown })?.path).filter((path): path is string => typeof path === "string").slice(0, 200) : [];
};

/**
 * The session a new run of `engine` continues on this computer, if any, and the record of why. `scope`:
 * this computer's runs (its own account). Never throws: a failure is a new session.
 */
export async function chooseSession(
  prisma: PrismaClient,
  scope: SessionScope,
  input: { task: NewTask; engine: CodeEngine; config: SessionChoiceConfig; newSession?: boolean; now?: Date },
): Promise<Choice> {
  const started = Date.now();
  const { config, task, engine } = input;
  const now = input.now ?? new Date();
  const deadline = started + config.limits.timeBudgetMs;
  const extra = new Set(config.text.extraStopwords.map((word) => word.toLowerCase()));

  const groups = (await listSessionGroups(prisma, scope, { limit: 100 }))
    .filter(({ session }) => session.agent === engine && session.status === "idle" && session.resumable && !session.chat && !session.deletion && session.deviceId === null)
    .filter(({ session }) => now.getTime() - new Date(session.lastActiveAt).getTime() <= config.limits.maxAgeDays * 86_400_000)
    .slice(0, config.limits.candidates);
  const runIds = groups.flatMap((group) => group.runIds);
  const rows = (await prisma.workspaceJob.findMany({
    where: { id: { in: runIds } },
    select: {
      id: true,
      taskId: true,
      context: true,
      summary: true,
      evidence: true,
      task: { select: { id: true, title: true, description: true, notes: true, labels: true, projectId: true, deliverableId: true, meetingNoteId: true, page: { select: { parentId: true } } } },
    },
  })) as RunRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  // How full each session's context is: the newest report of its agent (`engine_context` with `used`).
  const windows = await prisma.workspaceEvent.findMany({ where: { jobId: { in: runIds }, kind: "engine_context" }, orderBy: { sequence: "desc" }, select: { jobId: true, data: true } });

  const corpus = await corpusFor(prisma, scope.space, config, deadline, extra).catch(() => null);
  const newText: TextFeatures = featuresOf(
    [
      { text: task.title, weight: 3 },
      { text: task.facts.labels.join(" "), weight: 2 },
      { text: clip(`${task.description}\n${task.notes}`, config.limits.taskChars), weight: 1 },
      { text: clip(task.instructions, 2000), weight: 1 },
    ],
    extra,
  );
  const words = surfaceForms(`${task.title}\n${task.facts.labels.join(" ")}\n${clip(`${task.description}\n${task.notes}`, config.limits.taskChars)}\n${clip(task.instructions, 2000)}`, extra);
  const followUp = new RegExp(config.text.followUp, "i").test(task.title.trim()) || task.facts.labels.some((label) => config.text.followUpLabels.includes(label.toLowerCase()));
  const newWork = new RegExp(config.text.newWork, "i").test(task.title.trim());
  const named = new Map(task.facts.named.map((row) => [row.id, row.reason]));

  const prepared: Array<{ session: AgentSession; runs: Array<{ row: RunRow; facts: TaskFacts }>; text: TextFeatures }> = [];
  for (const { session, runIds: ids } of groups) {
    const runs = ids.map((id) => byId.get(id)).filter((row): row is RunRow => Boolean(row)).map((row) => ({ row, facts: runFacts(row) }));
    // Never across projects, and not with runs whose project is unknown here.
    if (!runs.length || runs.some((run) => !run.facts || run.facts.projectId !== task.facts.projectId)) continue;
    let budget = config.limits.sessionChars;
    const fields: Array<{ text: string; weight: number }> = [];
    const push = (text: string, weight: number) => {
      if (budget <= 0 || !text) return;
      const part = text.slice(0, budget);
      budget -= part.length;
      fields.push({ text: part, weight });
    };
    const seenTasks = new Set<string>();
    for (const { row, facts } of runs as Array<{ row: RunRow; facts: TaskFacts }>) {
      if (!seenTasks.has(row.taskId)) {
        seenTasks.add(row.taskId);
        push(row.task.title, 3);
        push(facts.labels.join(" "), 2);
        push(clip(`${row.task.description}\n${row.task.notes}`, 4000), 1);
      }
      push(clip(row.summary, 2000), 1);
      push(filesOf(row.evidence).join("\n"), 1);
    }
    prepared.push({ session, runs: runs as Array<{ row: RunRow; facts: TaskFacts }>, text: featuresOf(fields, extra) });
  }

  // An anchor shared with most of the sessions tells nothing about any one of them.
  const anchorSessions = new Map<string, number>();
  for (const { text } of prepared) for (const anchor of text.anchors) if (newText.anchors.has(anchor)) anchorSessions.set(anchor, (anchorSessions.get(anchor) ?? 0) + 1);
  const tooShared = (anchor: string) => (prepared.length >= 3 && (anchorSessions.get(anchor) ?? 0) > prepared.length / 2) || COMMON_FILES.has(anchor.replace(/^path:/, ""));

  const scored: Array<Scored<Candidate>> = [];
  for (const { session, runs, text } of prepared) {
    let link: LinkReason | null = null;
    let linkTitle = "";
    for (const { row, facts } of runs) {
      const reason = named.get(facts.key);
      if (reason && (!link || LINK_ORDER[reason] < LINK_ORDER[link])) {
        link = reason;
        linkTitle = row.task.title;
      }
    }
    const same = (field: "deliverableId" | "meetingId" | "parentPageId") => Boolean(task.facts[field] && runs.some(({ facts }) => facts[field] === task.facts[field]));
    const sim = corpus && Date.now() <= deadline ? similarity(newText, text, corpus, config.limits.anchorMaxDocShare) : null;
    const anchors = (sim?.anchors ?? []).filter((anchor) => !tooShared(anchor));
    const topic = sim && sim.shared.length >= config.limits.topicMinShared ? Math.round(sim.cosine * Math.min(1, corpus!.docs / config.limits.minCorpus) * 1000) / 1000 : 0;
    const ids = new Set(runs.map(({ row }) => row.id));
    const window = windows.find((event) => ids.has(event.jobId) && typeof (event.data as { used?: unknown })?.used === "number" && typeof (event.data as { size?: unknown })?.size === "number");
    const used = window ? (window.data as { used: number; size: number }) : null;
    const signals: Signals = {
      link,
      deliverable: same("deliverableId"),
      meeting: same("meetingId"),
      parentPage: same("parentPageId"),
      anchors,
      topic,
      sharedTerms: (sim?.shared ?? []).slice(0, 5).map((term) => words.get(term) ?? term),
      followUp,
      newWork,
      warm: now.getTime() - new Date(session.lastActiveAt).getTime() <= config.warmMinutes * 60_000,
      fill: used && used.size > 0 ? Math.min(1, Math.round((used.used / used.size) * 1000) / 1000) : null,
      tasks: new Set(runs.map(({ row }) => row.taskId)).size,
    };
    const result = scoreCandidate(signals, config);
    scored.push({ candidate: { session, title: linkTitle || session.latestTask.title, signals }, score: result.score, parts: result.parts, tooFull: result.tooFull, lastActiveAt: session.lastActiveAt });
  }

  const { ranked, band, pick, handover } = decide(scored, config);
  // Anchors are matched in lower case; the reason shows them as the task wrote them.
  const written = `${task.title}\n${task.description}\n${task.notes}\n${task.instructions}`;
  const lower = written.toLowerCase();
  const shown = (anchor: string) => {
    const text = plain(anchor);
    const at = lower.indexOf(text);
    return at >= 0 ? written.slice(at, at + text.length) : text;
  };
  const chosen = input.newSession ? null : pick;
  const best = chosen ?? ranked[0] ?? null;
  const note = input.newSession ? "new-session" : handover ? "too-full" : null;
  const shownHandover = !input.newSession && handover ? { title: handover.candidate.title, summary: handover.candidate.session.summary } : null;
  return {
    decision: chosen ? "continue" : "new",
    band,
    session: chosen?.candidate.session ?? null,
    title: chosen?.candidate.title ?? null,
    why: best ? reasonOf(best.candidate, shown) : null,
    handover: shownHandover,
    note,
    record: {
      taskId: task.facts.key,
      engine,
      projectId: task.facts.projectId,
      decision: chosen ? "continue" : "new",
      band,
      sessionId: best?.candidate.session.id ?? null,
      continuedJobId: chosen?.candidate.session.lastJobId ?? null,
      score: best?.score ?? null,
      why: best ? reasonOf(best.candidate, shown) : null,
      note,
      configVersion: config.version,
      configHash: configHash(config),
      candidates: ranked.slice(0, config.limits.candidates).map((row) => ({
        sessionId: row.candidate.session.id,
        lastJobId: row.candidate.session.lastJobId,
        lastActiveAt: row.lastActiveAt,
        score: row.score,
        parts: row.parts,
        tooFull: row.tooFull,
        signals: row.candidate.signals,
      })) as unknown as Prisma.InputJsonValue,
      elapsedMs: Date.now() - started,
    },
  };
}

const plain = (anchor: string) => anchor.replace(/^(path|code|ref|url):/, "");

/** Why, in words: the link, else what ties them (deliverable, meeting, page, shared files and terms). `shown`: an anchor as the task wrote it. */
export function reasonOf(candidate: Pick<Candidate, "title" | "signals">, shown: (anchor: string) => string = plain): string {
  const s = candidate.signals;
  const title = `“${candidate.title.slice(0, 80)}”`;
  if (s.link) return s.link === "mention" ? `it mentions ${title}` : s.link === "depends" ? `it depends on ${title}` : `it links to ${title}`;
  const bits = [
    s.deliverable ? "the same deliverable" : "",
    s.meeting ? "the same meeting" : "",
    s.parentPage ? "the same parent page" : "",
    s.anchors.length ? `both name ${s.anchors.slice(0, 2).map(shown).join(" and ")}` : "",
    s.topic > 0 && s.sharedTerms.length ? `shared topic: ${s.sharedTerms.slice(0, 3).join(", ")}` : "",
  ].filter(Boolean);
  return bits.length ? `like ${title}: ${bits.join("; ")}` : `like ${title}`;
}
