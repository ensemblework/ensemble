/**
 * One document summary. The upload route queues the row; this is what a
 * worker runs so the status becomes done or failed instead of staying queued.
 */

const TEXT_CAP = 16_000;
const SUMMARY_CAP = 4_000;

export type SummaryRow = {
  id: string;
  filename: string;
  text: string;
};

export type SummaryOutcome =
  | { status: "done"; summary: string }
  | { status: "failed"; message: string };

export function summaryPrompt(row: SummaryRow): string {
  const body = row.text.slice(0, TEXT_CAP);
  return [
    "Summarize this uploaded document in one short paragraph.",
    "Use only what is in the text. Do not invent tasks, people, or dates.",
    "",
    `Filename: ${row.filename}`,
    "",
    body,
  ].join("\n");
}

export function settleSummary(row: SummaryRow, modelText: string | null, error: unknown): SummaryOutcome {
  if (!row.text.trim()) {
    return { status: "failed", message: "There is no extracted text to summarize." };
  }
  if (error) return { status: "failed", message: failureMessage(error) };
  const summary = (modelText ?? "").trim().slice(0, SUMMARY_CAP);
  if (!summary) return { status: "failed", message: "The model returned an empty summary." };
  return { status: "done", summary };
}

export type SummaryStore = {
  claim(id: string): Promise<SummaryRow | null>;
  finish(id: string, outcome: SummaryOutcome): Promise<void>;
};

/** Claim one queued row and write done or failed. A second caller finds nothing to claim. */
export async function enrichOne(
  store: SummaryStore,
  id: string,
  complete: (prompt: string) => Promise<string>,
): Promise<SummaryOutcome | null> {
  const row = await store.claim(id);
  if (!row) return null;
  let outcome: SummaryOutcome;
  if (!row.text.trim()) {
    outcome = settleSummary(row, null, null);
  } else {
    try {
      outcome = settleSummary(row, await complete(summaryPrompt(row)), null);
    } catch (error) {
      outcome = settleSummary(row, null, error);
    }
  }
  await store.finish(id, outcome);
  return outcome;
}

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.replace(/\s+/g, " ").trim().slice(0, 300);
  return trimmed || "The summary failed.";
}
