/**
 * A run's steps as a trace: what the harness did, in order, with each tool call's input, output and
 * time. Steps come from five writers (Ensemble's agent, Claude Code, Codex, Cursor, GitHub Copilot) and from paired
 * computers, so the shapes differ a little; everything here reads them leniently.
 */
import type { RunStep, RunToolCall } from "./api";

export type TraceKind = "thinking" | "message" | "tools" | "result" | "step";

export type TraceCall = {
  key: string;
  name: string;
  summary: string;
  args: string;
  output: string;
  ok: boolean | null;
  running: boolean;
  ms: number | null;
};

export type TraceEntry = {
  id: string;
  index: number;
  kind: TraceKind;
  title: string;
  status: string;
  /** The model's or the engine's reasoning shown with the step. */
  reasoning: string;
  /** What the step said: a message, an answer, or text the model wrote next to its tool calls. */
  text: string;
  error: string;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  calls: TraceCall[];
  startedAt: number | null;
  endedAt: number | null;
  ms: number | null;
  /** Where the step sits on the run's timeline, as fractions of the run (0–1). */
  offset: number | null;
  width: number | null;
};

const time = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

/** A value a harness stored as text or as JSON, as readable text. */
export function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function callsOf(step: RunStep): TraceCall[] {
  const rows = Array.isArray(step.toolCalls) ? (step.toolCalls as RunToolCall[]) : [];
  const running = step.status === "running";
  return rows
    .filter((call) => call && typeof call === "object")
    .map((call, index) => ({
      key: `${step.id}:${call.id ?? index}`,
      name: typeof call.name === "string" && call.name ? call.name : "tool",
      summary: typeof call.summary === "string" ? call.summary : "",
      args: asText(call.args),
      output: asText(call.output),
      ok: typeof call.ok === "boolean" ? call.ok : running ? null : step.status === "failed" ? false : step.status === "done" ? true : null,
      running: running && typeof call.ok !== "boolean",
      ms: typeof call.ms === "number" && Number.isFinite(call.ms) ? call.ms : null,
    }));
}

function kindOf(step: RunStep, calls: TraceCall[]): TraceKind {
  if (calls.length) return "tools";
  if (step.title === "Thinking") return "thinking";
  if (step.title === "Message") return "message";
  if (step.title === "Result" || step.title === "Answer") return "result";
  return "step";
}

/** The run's steps as trace entries, placed on the run's timeline. */
export function traceEntries(steps: RunStep[], runStartedAt: string, runEndedAt: string | null, now = Date.now()): TraceEntry[] {
  const start = time(runStartedAt) ?? now;
  const end = Math.max(time(runEndedAt) ?? now, start + 1);
  const span = end - start;
  return [...steps]
    .sort((a, b) => a.index - b.index)
    .map((step) => {
      const calls = callsOf(step);
      const kind = kindOf(step, calls);
      const startedAt = time(step.startedAt);
      const endedAt = time(step.endedAt) ?? (step.status === "running" ? now : null);
      const callMs = calls.length === 1 ? calls[0]!.ms : null;
      const ms = callMs ?? (startedAt != null && endedAt != null ? Math.max(0, endedAt - startedAt) : null);
      const offset = startedAt != null ? Math.min(1, Math.max(0, (startedAt - start) / span)) : null;
      const width = offset != null && ms != null ? Math.min(1 - offset, Math.max(0, ms / span)) : null;
      return {
        id: step.id,
        index: step.index,
        kind,
        title: step.title,
        status: step.status,
        reasoning: step.reasoning?.trim() ?? "",
        text: (step.output ?? "").trim(),
        error: (step.error ?? "").trim(),
        model: step.model,
        tokensIn: step.tokensIn ?? null,
        tokensOut: step.tokensOut ?? null,
        calls,
        startedAt,
        endedAt,
        ms,
        offset,
        width,
      };
    });
}

export type ToolStat = { name: string; count: number; failed: number; ms: number };

/** Tool calls by name: how many, how many failed, the time they took. Busiest first. */
export function toolStats(entries: TraceEntry[]): ToolStat[] {
  const byName = new Map<string, ToolStat>();
  for (const entry of entries) {
    for (const call of entry.calls) {
      const row = byName.get(call.name) ?? { name: call.name, count: 0, failed: 0, ms: 0 };
      row.count += 1;
      if (call.ok === false) row.failed += 1;
      row.ms += call.ms ?? (entry.calls.length === 1 ? entry.ms ?? 0 : 0);
      byName.set(call.name, row);
    }
  }
  return [...byName.values()].sort((a, b) => b.ms - a.ms || b.count - a.count);
}

/** Every model a run's steps name, in the order they first answered. */
export function modelsSeen(steps: RunStep[]): string[] {
  const seen: string[] = [];
  for (const step of [...steps].sort((a, b) => a.index - b.index)) {
    if (step.model && !seen.includes(step.model)) seen.push(step.model);
  }
  return seen;
}

const squash = (model: string) => model.toLowerCase().replace(/^[a-z-]+\//, "").replace(/[^a-z0-9]/g, "");

/**
 * Whether the model that answered is the one asked for. Providers add dates and versions to an id
 * (claude-sonnet-4-6 answers as claude-sonnet-4-6-20260101), so one containing the other matches.
 */
export function sameModel(asked: string | null | undefined, answered: string | null | undefined): boolean {
  if (!asked || !answered) return true;
  // "default" and "auto" leave the choice to the harness (Claude Code's default follows the plan).
  if (["default", "auto"].includes(asked.trim().toLowerCase())) return true;
  const a = squash(asked);
  const b = squash(answered);
  if (!a || !b) return true;
  return a.includes(b) || b.includes(a);
}

export function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function usd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  if (value === 0) return "$0";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}
