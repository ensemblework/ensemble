/**
 * A cut-off model reply is not a finished answer.
 * The marker stays on the saved text so the next turn's history tells the model it stopped early.
 */
import { truncateText } from "../lib/text.js";
import { CONNECTION_DROPPED_NOTICE, isAbortError, isNonModelNotice, isTransportDrop } from "../lib/stream-drop.js";

export { CONNECTION_DROPPED_NOTICE, isNonModelNotice } from "../lib/stream-drop.js";

/** Drop `]` and collapse whitespace so a provider reason cannot break the marker line. */
export function sanitizeCutOffReason(reason: string | null): string | null {
  if (!reason) return null;
  const cleaned = reason.replace(/\]/g, "").replace(/\s+/g, " ").trim();
  return cleaned || null;
}

export function cutOffNotice(reason: string | null): string {
  if (!reason) return "The reply was cut off before the model finished.";
  const lowered = reason.toLowerCase();
  if (lowered === "length" || lowered === "max_tokens" || reason === "MAX_TOKENS") {
    return "The reply hit the length limit.";
  }
  if (reason.startsWith("content_filter")) {
    const detail = reason.slice("content_filter".length).replace(/^:\s*/, "").trim();
    return detail ? `The model stopped early (content filter: ${detail}).` : "The model stopped early (content filter).";
  }
  return `The model stopped early (${reason}).`;
}

export function cutOffReply(partial: string, reason: string | null): string {
  const safe = sanitizeCutOffReason(reason);
  const notice = cutOffNotice(safe);
  const marker = `[Cut off: ${notice} This reply is incomplete. Reason: ${safe ?? "none"}.]`;
  const body = partial.trim();
  return body ? `${marker}\n\n${body}` : marker;
}

const CUT_OFF_LINE = /^\[Cut off:\s*(.+)\s+Reason: .+\]$/;

/**
 * Pull the plain notice out of a saved reply. The marker line itself stays in history.
 * Only the first line counts. A model that repeats "[Cut off:" later in the answer is quoting, not stopping.
 */
export function splitCutOffReply(content: string): { body: string; notice: string | null } {
  const lines = content.split("\n");
  const first = lines[0]?.trim() ?? "";
  if (!first.startsWith("[Cut off:")) return { body: content.trim(), notice: null };
  const matched = CUT_OFF_LINE.exec(first);
  const notice = matched?.[1]?.trim() || first.replace(/^\[Cut off:\s*/, "").replace(/\]$/, "").trim();
  const body = lines.slice(1).join("\n").trim();
  return { body, notice };
}

export type StreamFailureReply =
  | { kind: "cancel"; text: string }
  | { kind: "cutoff"; text: string }
  | { kind: "notice"; text: string }
  | { kind: "error" };

/**
 * What to save when the model stream throws.
 * User Stop keeps the partial text with no cut-off notice.
 * A transport drop after text is a cut-off reply. A drop before any text is a notice the next turn does not send back.
 * Any other error is left for the existing failure path.
 */
export function replyAfterStreamFailure(streamed: string, error: unknown, cancelled: boolean): StreamFailureReply {
  if (cancelled || isAbortError(error)) return { kind: "cancel", text: streamed.trim() };
  if (!isTransportDrop(error)) return { kind: "error" };
  if (streamed.trim()) return { kind: "cutoff", text: cutOffReply(streamed, null) };
  return { kind: "notice", text: CONNECTION_DROPPED_NOTICE };
}

export function historyEntries(
  rows: Array<{ role: string; content: string; toolCalls?: unknown }>,
): Array<{ role: string; content: string }> {
  return rows
    .filter((row) => {
      if (row.role !== "user" && row.role !== "assistant") return false;
      if (row.role === "assistant" && isNonModelNotice(row.content)) return false;
      return true;
    })
    .map((row) => {
      const calls = Array.isArray(row.toolCalls) ? (row.toolCalls as Array<{ state?: string; summary?: string }>) : [];
      const done = calls
        .filter((call) => call.state === "ok")
        .map((call) => call.summary)
        .filter((summary): summary is string => Boolean(summary));
      const content = done.length ? `${row.content}\n\n(You did: ${done.join("; ")})` : row.content;
      return { role: row.role, content: truncateText(content, 4000) };
    })
    .filter((message) => message.content.trim().length > 0);
}
