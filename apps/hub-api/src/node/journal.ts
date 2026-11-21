/**
 * The tool journal (docs/35 §5.8): every call a node turn makes to Ensemble's tools, on Ensemble's own loop
 * or relayed from the owner's agent on their computer, is written before the tool runs (`recorded`), marked
 * just before it runs (`dispatched`) and settled after (`succeeded`, `failed`, or `not_run` when a check
 * stopped it first). A call is keyed by its turn, its tool, the SHA-256 of its canonical arguments and how
 * many identical calls came before it in the turn (`node_tool_journal.call_key`), never by the provider's
 * call id, which changes when a call is sent again.
 *
 * The same call again gets what the first returned instead of acting twice, unless it only looks (a
 * read-only tool runs again): an identical call while the first still runs waits for it; on the relay, an
 * identical call after an answer that never reached the computer (its request ended first) is that call
 * again; and a turn resumed after a restart meets the calls its first try made, so one that only started
 * (`dispatched` with no result, `uncertain` after the restart) answers that it may have run and was not run
 * again. A second identical call after any of these runs: the caller has seen the first one's answer.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Prisma, type NodeTurn, type NodeToolJournal } from "@prisma/client";
import type { AssistantToolCall } from "@ensemble/shared-types";
import type { JournalCall, JournalReplay, JournalTicket, ToolJournal } from "../assistant/agent.js";
import { answerReceived } from "../subscriptions/relay.js";
import { stableJson } from "./session-queue.js";
import { shortText } from "./trace.js";
import { redactArgs } from "../lib/redact.js";

export type JournalState = "recorded" | "dispatched" | "succeeded" | "failed" | "uncertain" | "not_run";

/** A call's arguments as one canonical string: parsed and keys sorted, so the same call hashes the same however it was written. */
export function canonicalArguments(raw: string): string {
  try {
    return stableJson(JSON.parse(raw || "{}"));
  } catch {
    return raw;
  }
}

export function argumentsHash(raw: string): string {
  return createHash("sha256").update(canonicalArguments(raw)).digest("hex");
}

/** `<tool>:<arguments hash>:<n>`: n counts the identical calls before it in the turn. */
export function callKeyOf(tool: string, hash: string, repeat: number): string {
  return `${tool}:${hash}:${repeat}`;
}

/** A string with its secrets out (lib/redact.ts `redactArgs`: a JSON object or list in it by key, and in the text). */
function redactedText(text: string): string {
  return String(redactArgs(text));
}

/**
 * The short label a call that can change something keeps (`node_tool_journal.label`): its input with every
 * secret taken out first (lib/redact.ts `redactArgs`: by key at any depth, and in text), then written canonically,
 * then cut to 240 characters.
 */
export function journalLabel(raw: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw || "{}");
  } catch {
    value = raw;
  }
  const redacted = redactArgs(value);
  return shortText(typeof redacted === "string" ? redacted : stableJson(redacted), 240);
}

type Settled = { state: "ok" | "failed"; summary: string };
/** How a call that ran ended, or that a check stopped it before it ran (`ran: false`). */
type Flight = Settled & { ran: boolean };

/** What the model is told when an identical call is answered from the journal, by why it was not run again. */
function replayOf(settled: Settled, why: "running" | "unreceived" | "earlier"): JournalReplay {
  const again =
    why === "running"
      ? "The same call was already running, so it did not run a second time: this is what it returned."
      : why === "unreceived"
        ? "This exact call already ran a moment ago (its answer did not reach you), so it did not run again: this is what it returned."
        : "This exact call already ran earlier in this work, before a restart, so it did not run again: this is what it returned.";
  const forModel =
    settled.state === "ok"
      ? { ok: true, replayed: true, summary: settled.summary, note: `${again} Call it again only if it must run a second time.` }
      : { error: settled.summary || "It failed.", replayed: true, note: `${again} It had failed: fix its input, or call it again to try again.` };
  return { state: settled.state, summary: settled.summary, forModel };
}

/** What a call that may have run without saying so answers, in place of running it again. */
export function uncertainReplay(tool: string): JournalReplay {
  const summary = `An earlier ${tool} call with this input started but its result was never saved (the server restarted), so it may already have happened. It was not run again.`;
  return {
    state: "failed",
    summary,
    forModel: { error: summary, uncertain: true, note: "Check whether it took effect (look it up) before calling it again. Calling it again the same way runs it." },
  };
}

const settledOf = (row: Pick<NodeToolJournal, "state" | "summary">): Settled => ({ state: row.state === "succeeded" ? "ok" : "failed", summary: row.summary ?? "" });

/** One identical call's place in a live turn: how many came before, the ones running now and the answers given. */
class Repeats {
  next = 0;
  readonly running = new Map<number, Promise<Flight>>();
  /** Answers given, with whether each reached its caller (a relayed call's request may end before its answer). */
  readonly answered: Array<{ settled: Settled; received: () => boolean }> = [];

  /** An answer that never reached its caller: the caller's next identical call is that call again. Given back once. */
  unreceived(): Settled | null {
    const found = this.answered.find((row) => !row.received());
    if (!found) return null;
    found.received = () => true;
    return found.settled;
  }
}

/**
 * The journal of one live try of a node turn (`turn`), keyed under the turn it continues when it is a
 * resume: its first try's calls are its own. One per try, shared by its model calls.
 */
export class TurnJournal implements ToolJournal {
  private readonly repeats = new Map<string, Repeats>();
  private readonly rootId: string;

  constructor(
    private readonly app: Pick<FastifyInstance, "prisma" | "log">,
    private readonly turn: Pick<NodeTurn, "id" | "userId" | "nodeId" | "originTurnId">,
  ) {
    this.rootId = turn.originTurnId ?? turn.id;
  }

  async begin(call: JournalCall): Promise<{ replay: JournalReplay } | { ticket: JournalTicket }> {
    const canonical = canonicalArguments(call.arguments);
    const hash = createHash("sha256").update(canonical).digest("hex");
    const base = `${call.name}:${hash}`;
    let repeats = this.repeats.get(base);
    if (!repeats) {
      repeats = new Repeats();
      this.repeats.set(base, repeats);
    }
    if (call.sideEffect) {
      // The same call while it still runs waits for it; when a check stopped that one first, this one goes through the checks itself.
      const running = [...repeats.running.values()][0];
      const first = running ? await running : null;
      if (first?.ran) return { replay: replayOf(first, "running") };
      const lost = first ? null : repeats.unreceived();
      if (lost) return { replay: replayOf(lost, "unreceived") };
    }
    const repeat = repeats.next;
    repeats.next += 1;
    let finish: (flight: Flight) => void = () => undefined;
    if (call.sideEffect) repeats.running.set(repeat, new Promise<Flight>((resolve) => (finish = resolve)));
    const done = (flight: Flight) => {
      repeats.running.delete(repeat);
      finish(flight);
    };
    try {
      const earlier = await this.record(call, hash, repeat);
      if (earlier) {
        done({ ...earlier, ran: true });
        return { replay: earlier.replay };
      }
    } catch (error) {
      done({ state: "failed", summary: "It could not be recorded, so it did not run.", ran: false });
      throw error;
    }
    return { ticket: this.ticket(call, callKeyOf(call.name, hash, repeat), repeats, done) };
  }

  /**
   * Writes the call's row, or finds the row an earlier try of the turn wrote under the same key. Returns
   * the answer to give in place of running it when that row says the call already ran, or may have.
   */
  private async record(call: JournalCall, hash: string, repeat: number): Promise<(Settled & { replay: JournalReplay }) | null> {
    const prisma = this.app.prisma;
    const key = callKeyOf(call.name, hash, repeat);
    const where = { turnId_callKey: { turnId: this.rootId, callKey: key } };
    const fresh = { attemptTurnId: this.turn.id, state: "recorded", summary: null, dispatchedAt: null, finishedAt: null };
    const existing = await prisma.nodeToolJournal.findUnique({ where });
    if (existing) {
      if (call.sideEffect && (existing.state === "succeeded" || existing.state === "failed")) {
        const settled = settledOf(existing);
        return { ...settled, replay: replayOf(settled, "earlier") };
      }
      if (call.sideEffect && (existing.state === "dispatched" || existing.state === "uncertain")) {
        if (existing.state === "dispatched") await prisma.nodeToolJournal.update({ where: { id: existing.id }, data: { state: "uncertain" } });
        const replay = uncertainReplay(call.name);
        return { state: "failed", summary: replay.summary, replay };
      }
      // Recorded but never run (or only looked): it runs now, under this try.
      await prisma.nodeToolJournal.update({ where: { id: existing.id }, data: fresh });
      return null;
    }
    try {
      await prisma.nodeToolJournal.create({
        data: {
          userId: this.turn.userId,
          nodeId: this.turn.nodeId,
          turnId: this.rootId,
          attemptTurnId: this.turn.id,
          callKey: key,
          tool: call.name,
          argsHash: hash,
          repeat,
          state: "recorded",
          sideEffect: call.sideEffect,
          label: call.sideEffect ? journalLabel(call.arguments) : null,
        },
      });
    } catch (error) {
      // Written meanwhile under the same key (two processes on one turn): read as above.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return this.record(call, hash, repeat);
      throw error;
    }
    return null;
  }

  private ticket(call: JournalCall, key: string, repeats: Repeats, done: (flight: Flight) => void): JournalTicket {
    const prisma = this.app.prisma;
    const where = { turnId_callKey: { turnId: this.rootId, callKey: key } };
    // A relayed call says whether its answer reached the computer (subscriptions/relay.ts); any other always does.
    const received = answerReceived() ?? (() => true);
    return {
      async dispatched() {
        await prisma.nodeToolJournal.update({ where, data: { state: "dispatched", dispatchedAt: new Date() } });
      },
      async settle(outcome: { state: AssistantToolCall["state"]; ran: boolean; summary: string }) {
        const settled: Settled = { state: outcome.state === "ok" ? "ok" : "failed", summary: shortText(redactedText(outcome.summary || (outcome.state === "ok" ? "Done." : "It failed.")), 500) };
        const state: JournalState = !outcome.ran ? "not_run" : outcome.state === "ok" ? "succeeded" : "failed";
        if (call.sideEffect && outcome.ran) repeats.answered.push({ settled, received });
        done({ ...settled, ran: outcome.ran });
        await prisma.nodeToolJournal.update({ where, data: { state, summary: settled.summary, finishedAt: new Date() } });
      },
    };
  }
}

export function turnJournal(app: Pick<FastifyInstance, "prisma" | "log">, turn: Pick<NodeTurn, "id" | "userId" | "nodeId" | "originTurnId">): TurnJournal {
  return new TurnJournal(app, turn);
}

/**
 * After a restart (node/queue.ts `recoverTurns`, before any turn runs): every call that started and never
 * settled may have acted, so it becomes `uncertain` and is never run again blindly. Returns, per turn try,
 * the calls that can change something and may have run.
 */
export async function uncertainCalls(app: Pick<FastifyInstance, "prisma">): Promise<Map<string, Array<{ tool: string; label: string | null }>>> {
  const prisma = app.prisma;
  const rows = await prisma.nodeToolJournal.findMany({ where: { state: "dispatched" }, select: { id: true, attemptTurnId: true, tool: true, label: true, sideEffect: true } });
  if (rows.length) await prisma.nodeToolJournal.updateMany({ where: { id: { in: rows.map((row) => row.id) }, state: "dispatched" }, data: { state: "uncertain" } });
  const byTurn = new Map<string, Array<{ tool: string; label: string | null }>>();
  for (const row of rows) {
    if (!row.sideEffect) continue;
    byTurn.set(row.attemptTurnId, [...(byTurn.get(row.attemptTurnId) ?? []), { tool: row.tool, label: row.label }]);
  }
  return byTurn;
}

/** The calls of a turn try that acted: settled ones that can change something. */
export async function actedCalls(app: Pick<FastifyInstance, "prisma">, attemptTurnId: string): Promise<number> {
  return app.prisma.nodeToolJournal.count({ where: { attemptTurnId, sideEffect: true, state: { in: ["succeeded", "failed"] } } });
}
