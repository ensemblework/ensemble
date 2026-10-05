/** What the document panel shows for a model summary, including a failed job. */

export function enrichmentFailure(error: unknown): string | null {
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed || null;
  }
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    const trimmed = error.message.trim();
    return trimmed || null;
  }
  return null;
}

export function documentSummaryLine(document: {
  summary: string | null;
  enrichmentStatus: string;
  enrichmentError?: unknown;
}): string {
  if (document.enrichmentStatus === "failed") {
    return enrichmentFailure(document.enrichmentError) ?? "The summary failed.";
  }
  if (document.summary) return document.summary;
  if (document.enrichmentStatus === "queued" || document.enrichmentStatus === "running") return "Summarizing…";
  return "No summary yet. It is written by the context worker, one bounded model request per document.";
}

export function summaryTagTone(status: string): "red" | "green" | "gray" {
  if (status === "failed") return "red";
  if (status === "done") return "green";
  return "gray";
}
