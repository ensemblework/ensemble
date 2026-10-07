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
import type { AnyHubTool, ToolContext, ToolResult } from "./types.js";

export interface PlannedCall {
  tool: AnyHubTool;
  input: unknown;
}

export const isOutsideWrite = (tool: AnyHubTool): boolean => tool.area === "apps";

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
      action: `apps.${tool.name}`,
      payload: {
        tool: tool.name,
        provider: tool.app?.provider ?? "mcp",
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
  | { ok: true; result: ToolResult }
  /** `attempted` is false when the call never ran because an earlier one in the batch failed. */
  | { ok: false; error: string; attempted: boolean };

export interface AppliedBatch {
  /** One per planned call, in the same order. */
  outcomes: CallOutcome[];
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
 */
export async function applyHeldCalls(
  app: FastifyInstance,
  base: Omit<ToolContext, "tx">,
  planned: readonly PlannedCall[],
): Promise<AppliedBatch> {
  const outcomes: CallOutcome[] = new Array(planned.length);
  const hub = planned.map((item, index) => ({ ...item, index })).filter((item) => !isOutsideWrite(item.tool));
  let undoEntryId: string | null = null;
  if (hub.length) {
    const grouped = await app.prisma.$transaction((tx) =>
      withUndoGroup(tx, { userId: base.userId, actor: "agent", subject: hub[0]!.tool.name }, async () => {
        const rows: ToolResult[] = [];
        for (const item of hub) rows.push(await item.tool.run({ ...base, tx }, item.input as never));
        return rows;
      }),
    );
    grouped.result.forEach((result, position) => {
      outcomes[hub[position]!.index] = { ok: true, result };
    });
    undoEntryId = grouped.undoEntryId;
  }
  let landed = hub.length > 0;
  let stopped = false;
  for (const [index, item] of planned.entries()) {
    if (!isOutsideWrite(item.tool)) continue;
    if (stopped) {
      outcomes[index] = { ok: false, error: NOT_ATTEMPTED, attempted: false };
      continue;
    }
    try {
      outcomes[index] = { ok: true, result: await runOutsideWrite(base, item.tool, item.input) };
      landed = true;
    } catch (error) {
      if (!landed) throw error;
      outcomes[index] = { ok: false, error: failure(error), attempted: true };
      stopped = true;
    }
  }
  return { outcomes, undoEntryId, partial: outcomes.some((outcome) => !outcome.ok) };
}
