/** A parallel write batch is all-or-nothing: one failed preview withdraws the rest. */

const HELD = "Not proposed. Another change in this request failed, so none of them can be applied.";

export function settleWriteBatch<
  T extends { call: { state?: string; isWrite?: boolean; error?: string; summary?: string }; forModel: unknown },
>(outcomes: T[]): T[] {
  const blocked = outcomes.some((item) => item.call.isWrite && item.call.state === "failed");
  if (!blocked) return outcomes;
  return outcomes.map((item) => {
    if (item.call.state !== "awaiting_approval") return item;
    return {
      ...item,
      call: { ...item.call, state: "failed", error: HELD, summary: HELD },
      forModel: {
        error: HELD,
        hint: "Ask the user a question instead of proposing part of this change. Do not say anything is ready to apply.",
      },
    } as T;
  });
}
