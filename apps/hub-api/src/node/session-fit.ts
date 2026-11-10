/**
 * Which of a node's own coding-agent sessions a new piece of work fits (docs/35, Choosing a session): asked
 * only when the node starts a session (node_session_start), never on a turn that starts none. The node's
 * model decides; this finds what it decides between. It scores the node's own sessions of the same agent,
 * on the same computer, in the same folder, with Ensemble's session-choice scorer (workspace/session-choice:
 * exact anchors, TF-IDF topic over the owner's tasks, follow-up wording, warm cache, size), with no model.
 * A session that fits (band unsure or better, not too full) is shown to the node with why, and the start
 * waits for its choice: continue it (node_session_send) or start fresh (newSession: true).
 */
import type { PrismaClient } from "@prisma/client";
import { activeConfig } from "../workspace/session-choice/config.js";
import { bandOf, scoreCandidate, type Signals } from "../workspace/session-choice/score.js";
import { buildCorpus, featuresOf, similarity } from "../workspace/session-choice/text.js";
import type { NodeSession } from "./sessions.js";

export type FitWork = { title: string; prompt: string };
export type SessionText = { title: string; asked: string | null; result: string };
export type Fit = { id: string; agent: string; folder: string; computer: string; score: number; band: "confident" | "unsure"; why: string; did: string[]; tasks: number; lastActive: string };

/** Sessions shown at most: the node needs a short list, not its history. */
export const MAX_FITS = 3;

/** The fitting sessions, best first; empty when none fits (then the session starts at once). */
export async function fitSessions(
  prisma: Pick<PrismaClient, "task">,
  userId: string,
  work: FitWork,
  candidates: ReadonlyArray<{ session: NodeSession; work: SessionText[]; taskIds?: string[] }>,
  now = new Date(),
): Promise<Fit[]> {
  if (!candidates.length) return [];
  const config = await activeConfig();
  const extra = new Set(config.text.extraStopwords.map((word) => word.toLowerCase()));
  // Rarity over the owner's other recent tasks, so words in nearly every task weigh nothing. The sessions'
  // own tasks and the new work stay out: what they share would otherwise count as common, and for an owner
  // with few tasks a shared file path would never count.
  const own = [...new Set(candidates.flatMap((row) => row.taskIds ?? []))];
  const tasks = await prisma.task.findMany({ where: { userId, ...(own.length ? { id: { notIn: own } } : {}) }, orderBy: { updatedAt: "desc" }, take: 500, select: { title: true, description: true } });
  const corpus = buildCorpus(tasks.map((task) => `${task.title}\n${(task.description ?? "").slice(0, 1500)}`), Date.now() + 2000, extra);
  const asked = featuresOf([{ text: work.title, weight: 3 }, { text: work.prompt, weight: 1 }], extra);
  const followUp = new RegExp(config.text.followUp, "i").test(work.title.trim());
  const newWork = new RegExp(config.text.newWork, "i").test(work.title.trim());
  const fits: Fit[] = [];
  for (const { session, work: done } of candidates) {
    const text = featuresOf(done.flatMap((item) => [{ text: item.title, weight: 3 }, { text: item.asked ?? "", weight: 1 }, { text: item.result, weight: 1 }]), extra);
    const sim = corpus ? similarity(asked, text, corpus, config.limits.anchorMaxDocShare) : null;
    const topic = sim && sim.shared.length >= config.limits.topicMinShared ? Math.round(sim.cosine * Math.min(1, corpus!.docs / config.limits.minCorpus) * 1000) / 1000 : 0;
    const signals: Signals = {
      link: null,
      deliverable: false,
      meeting: false,
      parentPage: false,
      anchors: sim?.anchors ?? [],
      topic,
      sharedTerms: sim?.shared ?? [],
      followUp,
      newWork,
      warm: now.getTime() - new Date(session.lastActiveAt).getTime() <= config.warmMinutes * 60_000,
      fill: null,
      tasks: session.tasks,
    };
    const scored = scoreCandidate(signals, config);
    const band = bandOf(scored.score, config);
    if (band === "none" || scored.tooFull) continue;
    const shared = [...signals.anchors, ...signals.sharedTerms].slice(0, 4);
    fits.push({
      id: session.id,
      agent: session.agentName,
      folder: session.folder,
      computer: session.computer ?? "a paired computer",
      score: scored.score,
      band,
      why: shared.length ? `shared: ${shared.join(", ")}` : followUp ? "the new work reads as a follow-up" : "recent, related work",
      did: done.slice(-3).map((item) => `${item.title}: ${item.result}`.slice(0, 200)),
      tasks: session.tasks,
      lastActive: session.lastActiveAt,
    });
  }
  return fits.sort((a, b) => b.score - a.score || b.lastActive.localeCompare(a.lastActive)).slice(0, MAX_FITS);
}

/** What the node reads when sessions fit: short, with what each did and why it fits, and the two ways on. */
export function fitMessage(fits: readonly Fit[]): string {
  const lines = fits.map((fit, index) => `${index + 1}. ${fit.id} — ${fit.agent} in ${fit.folder} on ${fit.computer}, ${fit.tasks} task${fit.tasks === 1 ? "" : "s"}, ${fit.why}. Did: ${fit.did.join(" | ")}`);
  return [
    `Not started yet: ${fits.length === 1 ? "one of your sessions" : `${fits.length} of your sessions`} may fit this work. Continuing one keeps what the agent already learned and its prompt cache, and costs less.`,
    ...lines,
    "Continue one with node_session_send (session: its id, the same prompt), or start a fresh one with node_session_start again with newSession: true when the work is unrelated.",
  ].join("\n");
}
