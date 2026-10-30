/**
 * Applying held writes: the person pressed Apply.
 *
 * Hub writes run in one transaction with one undo entry, as before. Writes to
 * connected apps cannot be rolled back or undone, so they run after the Hub
 * transaction commits, one at a time, outside any database transaction (a slow
 * vendor API must not hold row locks), and each one is ledgered as
 * `apps.<tool>` once it has happened.
 */
import type { FastifyInstance } from "fastify";
import { appendLedger } from "../lib/ledger.js";
import { withUndoGroup } from "../lib/undo.js";
import { safePublicError } from "../lib/text.js";
import { ensureAppAccess } from "./apps.js";
import type { AnyHubTool, CallSpace, ToolContext, ToolResult } from "./types.js";

export interface PlannedCall {
  call?: { callId?: string };
  tool: AnyHubTool;
  input: unknown;
}

export const isOutsideWrite = (tool: AnyHubTool): boolean => tool.area === "apps" || tool.outsideTransaction === true;

/** Ids and links worth keeping in the ledger. Never the document body or a token. */
function ledgerRefs(data: unknown): Record<string, string> {
  if (!data || typeof data !== "object") return {};
  const out: Record<string, string> = {};
  for (const key of ["id", "link", "name", "range", "address"]) {
    const value = (data as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length <= 500) out[key] = value;
  }
  return out;
}

/** Runs one write in a connected app and records it. The tool's own errors propagate unchanged. */
export async function runOutsideWrite(ctx: Omit<ToolContext, "tx">, tool: AnyHubTool, input: unknown): Promise<ToolResult> {
  await ensureAppAccess(ctx, tool);
  const result = await tool.run(ctx, input as never);
  try {
    await appendLedger({
      userId: ctx.userId,
      actor: "agent",
      action: `${tool.area === "apps" ? "apps" : "assistant"}.${tool.name}`,
      payload: {
        tool: tool.name,
        provider: tool.app?.provider ?? (tool.outsideTransaction ? "ensemble" : "mcp"),
        summary: result.summary,
        href: result.href ?? null,
        conversationId: ctx.conversationId ?? null,
        ...ledgerRefs(result.data),
      },
    });
  } catch (error) {
    // The outside change already happened; failing the request now would tell the person it did not.
    ctx.app?.log?.error?.({ err: error, tool: tool.name }, "Could not ledger an applied connected-app write");
  }
  return result;
}

export type CallOutcome =
  /** `undoEntryId`: the Undo entry of the call's space's batch (Hub writes only). `space`: where a call that names one acted. */
  | { ok: true; result: ToolResult; undoEntryId?: string | null; space?: CallSpace }
  /** `attempted` is false when the call never ran because an earlier one in the batch failed. */
  | { ok: false; error: string; attempted: boolean };

export interface AppliedBatch {
  /** One per planned call, in the same order. */
  outcomes: CallOutcome[];
  /** The first Undo entry the batch made (one per space when its calls act in several). */
  undoEntryId: string | null;
  /** Some calls landed and some did not. */
  partial: boolean;
}

export const NOT_ATTEMPTED = "Not applied: an earlier change in this batch failed, so this one was not sent.";

const failure = (error: unknown): string => safePublicError(error, "That change failed. Nothing was sent for it.");

/**
 * Applies a held batch in order of safety: Hub writes in one transaction and
 * undo entry, then connected-app writes one by one, stopping at the first that
 * fails. Throws only when nothing ran, so a retry is safe. Once something has
 * landed it returns an outcome per call instead, so the caller can record what
 * happened and never run the landed calls again.
 *
 * Calls that name a space (an Ensemble Node acting for its owner, node/spaces.ts)
 * are checked there again first, with the access the person has now. Hub writes
 * then run in one transaction and Undo entry per space, in that space's scope, so
 * each entry lands in the space it changed.
 */
export async function applyHeldCalls(
  app: FastifyInstance,
  base: Omit<ToolContext, "tx">,
  planned: readonly PlannedCall[],
): Promise<AppliedBatch> {
  const outcomes: CallOutcome[] = new Array(planned.length);
  const spaces = await Promise.all(planned.map((item) => item.tool.spaceFor?.(base, item.input)));
  const contextOf = (index: number): Omit<ToolContext, "tx"> => spaces[index]?.context(base) ?? base;
  const within = <T>(space: CallSpace | undefined, work: () => Promise<T>): Promise<T> => (space ? space.run(work) : work());
  const groups = new Map<string, Array<PlannedCall & { index: number }>>();
  for (const [index, item] of planned.entries()) {
    if (isOutsideWrite(item.tool)) continue;
    const key = spaces[index]?.id ?? base.userId;
    groups.set(key, [...(groups.get(key) ?? []), { ...item, index }]);
  }
  let undoEntryId: string | null = null;
  let landed = false;
  let stopped = false;
  for (const [spaceId, hub] of groups) {
    if (stopped) {
      for (const item of hub) outcomes[item.index] = { ok: false, error: NOT_ATTEMPTED, attempted: false };
      continue;
    }
    const space = spaces[hub[0]!.index];
    const ctx = contextOf(hub[0]!.index);
    try {
      // A batch can be dozens of writes (a cleared board); Prisma's 5 s default would roll it all back.
      const grouped = await within(space, () =>
        app.prisma.$transaction(
          (tx) =>
            withUndoGroup(tx, { userId: spaceId, actor: "agent", subject: hub[0]!.tool.name }, async () => {
              const rows: ToolResult[] = [];
              for (const item of hub) rows.push(await item.tool.run({ ...ctx, tx }, item.input as never));
              return rows;
            }),
          { timeout: 30_000, maxWait: 10_000 },
        ),
      );
      grouped.result.forEach((result, position) => {
        outcomes[hub[position]!.index] = { ok: true, result, undoEntryId: grouped.undoEntryId, ...(space ? { space } : {}) };
      });
      undoEntryId ??= grouped.undoEntryId;
      landed = true;
    } catch (error) {
      if (!landed) throw error;
      for (const item of hub) outcomes[item.index] = { ok: false, error: failure(error), attempted: true };
      stopped = true;
    }
  }
  for (const [index, item] of planned.entries()) {
    if (!isOutsideWrite(item.tool)) continue;
    if (stopped) {
      outcomes[index] = { ok: false, error: NOT_ATTEMPTED, attempted: false };
      continue;
    }
    const space = spaces[index];
    try {
      const result = await within(space, () => runOutsideWrite({ ...contextOf(index), toolCallId: item.call?.callId ?? base.toolCallId }, item.tool, item.input));
      outcomes[index] = { ok: true, result, ...(space ? { space } : {}) };
      landed = true;
    } catch (error) {
      if ((error as { partial?: boolean })?.partial) landed = true;
      if (!landed) throw error;
      outcomes[index] = { ok: false, error: failure(error), attempted: true };
      stopped = true;
    }
  }
  return { outcomes, undoEntryId, partial: outcomes.some((outcome) => !outcome.ok) };
}
