/**
 * An engine's work as run steps: each tool call (what it was asked, what came back, how long it
 * took), its thinking and its messages, and the final answer, so a run shows the work and not only
 * the result. Text is cut to a preview and known secret shapes are redacted before anything is
 * stored; a paired computer sends these same previews to Ensemble on the web (docs/25 §4.5).
 *
 * Engines handle their notifications concurrently, so each call here takes its place and updates
 * its state at once, and the database writes run one after another in that order: a result that
 * arrives before its call was recorded waits for it instead of being lost.
 */
import type { Prisma } from "@prisma/client";
import { redactText } from "../../lib/redact.js";
import { truncateText } from "../../lib/text.js";
import type { JobContext } from "../tools.js";

export const TRACE_PREVIEW = { input: 600, output: 1200, thinking: 2000, message: 2000, result: 20_000 } as const;
/** Steps one run keeps. Past this, tool calls still count but are not stored one by one. */
export const TRACE_MAX_STEPS = 600;

export function preview(value: unknown, max: number): string {
  if (value == null) return "";
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value, null, 1);
    } catch {
      text = String(value);
    }
  }
  return truncateText(redactText(text), max);
}

/** A call that names a file of keys or settings secrets (.env, a private key, .npmrc…). */
const SECRET_FILE = /(?:^|[\s"'=/\\:])(?:\.env(?:\.[\w.-]+)?|[\w.-]+\.(?:pem|key|p12|pfx|keystore|jks)|id_(?:rsa|dsa|ecdsa|ed25519)|\.npmrc|\.netrc|\.pypirc|\.pgpass|\.git-credentials|credentials(?:\.json)?|secrets?\.(?:ya?ml|json|toml))(?=$|[\s"',;)\]}])/i;
export const SECRET_OUTPUT = "(Not kept: this call read a file that holds keys or secrets.)";

/** What a tool call returned, as stored: a preview, or nothing when the call read a secrets file. */
export function outputPreview(args: string, output: unknown, max: number = TRACE_PREVIEW.output): string {
  return SECRET_FILE.test(args) ? SECRET_OUTPUT : preview(output, max);
}

type Open = { index: number; startedAt: Date; name: string; summary: string; input: string };

export type TraceTotals = { model?: string | null; tokensIn?: number | null; tokensOut?: number | null };

export class EngineTrace {
  private next = 0;
  private readonly open = new Map<string, Open>();
  /** Results that came back before their call was recorded, by call id. */
  private readonly early = new Map<string, { output: unknown; ok: boolean; at: Date }>();
  private stored = 0;
  private queue: Promise<void> = Promise.resolve();
  private ended = false;

  constructor(
    private readonly ctx: Pick<JobContext, "prisma" | "runId">,
    private readonly engine: string,
  ) {}

  /** Queues one write after the ones before it. Never throws: a trace never fails a run. */
  private write(index: number, data: Omit<Prisma.RunStepUncheckedCreateInput, "runId" | "index">): Promise<void> {
    const runId = this.ctx.runId;
    if (!runId) return this.queue;
    const run = () =>
      this.ctx.prisma.runStep
        .upsert({ where: { runId_index: { runId, index } }, create: { runId, index, ...data }, update: data })
        .then(
          () => undefined,
          () => undefined,
        );
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  private take(): number | null {
    if (this.stored >= TRACE_MAX_STEPS) return null;
    this.stored += 1;
    return this.next++;
  }

  /** The engine's reasoning, as it showed it. */
  thinking(text: string): Promise<void> {
    const body = text.trim();
    if (!body) return this.queue;
    const index = this.take();
    if (index == null) return this.queue;
    const now = new Date();
    return this.write(index, { title: "Thinking", status: "done", reasoning: preview(body, TRACE_PREVIEW.thinking), reasoningSource: this.engine, startedAt: now, endedAt: now });
  }

  /** Something the engine said on the way (not its final answer). */
  message(text: string, totals: TraceTotals = {}): Promise<void> {
    const body = text.trim();
    if (!body) return this.queue;
    const index = this.take();
    if (index == null) return this.queue;
    const now = new Date();
    return this.write(index, {
      title: "Message",
      status: "done",
      output: preview(body, TRACE_PREVIEW.message),
      model: totals.model ?? null,
      tokensIn: totals.tokensIn ?? null,
      tokensOut: totals.tokensOut ?? null,
      startedAt: now,
      endedAt: now,
    });
  }

  /** A tool call starts: its name, a one-line summary, and the arguments it was given. */
  toolStart(id: string, name: string, input: unknown, summary: string): Promise<void> {
    const index = this.take();
    if (index == null) return this.queue;
    const startedAt = new Date();
    const args = preview(input, TRACE_PREVIEW.input);
    const key = id || `tool-${index}`;
    this.open.set(key, { index, startedAt, name, summary, input: args });
    const started = this.write(index, {
      title: summary || name,
      status: "running",
      toolCalls: [{ id, name, args, engine: this.engine }] as Prisma.InputJsonValue,
      startedAt,
    });
    const early = id ? this.early.get(id) : undefined;
    if (!early) return started;
    this.early.delete(id);
    return this.toolEnd(id, early.output, early.ok, early.at);
  }

  /** The tool call's result came back (or it failed). */
  toolEnd(id: string, output: unknown, ok = true, endedAt = new Date()): Promise<void> {
    const open = this.open.get(id);
    if (!open) {
      if (id && !this.ended && this.early.size < 200) this.early.set(id, { output, ok, at: endedAt });
      return this.queue;
    }
    this.open.delete(id);
    const text = outputPreview(open.input, output);
    return this.write(open.index, {
      title: open.summary || open.name,
      status: ok ? "done" : "failed",
      output: text,
      toolCalls: [{ id, name: open.name, args: open.input, ok, output: text, ms: Math.max(0, endedAt.getTime() - open.startedAt.getTime()), engine: this.engine }] as Prisma.InputJsonValue,
      startedAt: open.startedAt,
      endedAt,
      ...(ok ? {} : { error: text.slice(0, 500) || "The tool failed." }),
    });
  }

  /** Tool calls whose result never came back, closed as they stand. */
  private closeOpen(status: "done" | "failed" | "skipped", note?: string): void {
    const now = new Date();
    for (const [id, open] of [...this.open.entries()]) {
      this.open.delete(id);
      void this.write(open.index, {
        title: open.summary || open.name,
        status,
        toolCalls: [{ id, name: open.name, args: open.input, ok: status === "done", engine: this.engine }] as Prisma.InputJsonValue,
        startedAt: open.startedAt,
        endedAt: now,
        ...(note ? { error: note } : {}),
      });
    }
  }

  /** At the end: open tool calls are closed as they stand; then the answer. */
  finish(text: string, totals: TraceTotals = {}, outcome: "done" | "failed" = "done"): Promise<void> {
    if (this.ended) return this.queue;
    this.ended = true;
    this.closeOpen(outcome);
    const now = new Date();
    return this.write(this.next++, {
      title: "Result",
      status: outcome,
      output: preview(text, TRACE_PREVIEW.result),
      model: totals.model ?? null,
      tokensIn: totals.tokensIn ?? null,
      tokensOut: totals.tokensOut ?? null,
      startedAt: now,
      endedAt: now,
    });
  }

  /** The run stopped or failed before the engine finished: open calls end with it, without a result step. */
  stop(outcome: "failed" | "skipped", note: string): Promise<void> {
    if (this.ended) return this.queue;
    this.ended = true;
    this.closeOpen(outcome, note);
    return this.queue;
  }
}
