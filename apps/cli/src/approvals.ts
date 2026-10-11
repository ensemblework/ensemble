/**
 * Answering this computer's questions from the terminal, trusting folders here,
 * and choosing whether the web and phone may approve for this computer.
 * Everything goes through the local runner's API; nothing reaches the server
 * except what the runner already relays.
 */
import { resolve } from "node:path";
import { localJson, type Discovery } from "./sidecar.js";

export type PendingDecision = {
  id: string;
  event: string;
  toolName: string;
  title: string;
  source?: string;
  requestedAt?: string;
  detail?: { options?: string[]; command?: string | null; taskTitle?: string; recommended?: string | null; allowCustom?: boolean };
};

export type Answer = { decision: "allow" | "deny"; scope: "once"; reason?: string };

export async function listPending(discovery: Discovery): Promise<PendingDecision[]> {
  const body = await localJson<{ decisions?: PendingDecision[] }>(discovery, "/api/decisions?status=pending");
  return (body.decisions ?? []).filter((row) => (row.source ?? "ensemble") === "ensemble");
}

/** Numbered for `ensemble needs answer <n> …`; options numbered within each question. */
export function formatPending(rows: PendingDecision[]): string {
  if (!rows.length) return "Nothing is waiting for you on this computer.";
  return rows
    .map((row, index) => {
      const head = `${index + 1}. ${row.event === "question" ? "Question" : `Wants to ${row.toolName}`}: ${row.title}${row.detail?.taskTitle ? `  (${row.detail.taskTitle})` : ""}`;
      const lines = [head];
      if (row.detail?.command) lines.push(`   $ ${row.detail.command}`);
      const options = row.detail?.options ?? [];
      if (row.event === "question" && options.length) {
        options.forEach((option, at) => lines.push(`   ${at + 1}) ${option}${row.detail?.recommended === option ? "  (recommended)" : ""}`));
        lines.push(`   Answer: ensemble needs answer ${index + 1} <1-${options.length}>${row.detail?.allowCustom ? ' or "your own answer"' : ""}, or deny`);
      } else {
        lines.push(`   Answer: ensemble needs answer ${index + 1} allow | deny`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * Turns what the person typed into the answer the runner expects: allow or deny
 * for a permission; an option number, an option's text, or (when allowed) free
 * text for a question. Throws with the reason when it does not fit.
 */
export function answerFor(row: PendingDecision, input: string): Answer {
  const text = input.trim();
  const lower = text.toLowerCase();
  if (["deny", "no", "n", "skip"].includes(lower)) return { decision: "deny", scope: "once" };
  const options = row.detail?.options ?? [];
  if (row.event === "question" && options.length) {
    const number = Number(text);
    if (Number.isInteger(number) && number >= 1 && number <= options.length) return { decision: "allow", scope: "once", reason: options[number - 1]! };
    const match = options.find((option) => option.toLowerCase() === lower);
    if (match) return { decision: "allow", scope: "once", reason: match };
    if (row.detail?.allowCustom && text) return { decision: "allow", scope: "once", reason: text.slice(0, 500) };
    throw new Error(`Answer with a number from 1 to ${options.length}${row.detail?.allowCustom ? ", your own words in quotes" : ""}, or deny.`);
  }
  if (["allow", "yes", "y", "ok"].includes(lower)) return { decision: "allow", scope: "once" };
  throw new Error("Answer allow or deny.");
}

export async function answerPending(discovery: Discovery, row: PendingDecision, answer: Answer): Promise<void> {
  await localJson<unknown>(discovery, `/api/decisions/${encodeURIComponent(row.id)}/decide`, { method: "POST", body: JSON.stringify(answer) });
}

export type TrustedFolder = { id: string; path: string; createdAt?: string };

export async function listTrusted(discovery: Discovery): Promise<TrustedFolder[]> {
  return (await localJson<{ folders?: TrustedFolder[] }>(discovery, "/api/workspace/trust")).folders ?? [];
}

/** Trusts a folder on this computer. System folders, the home folder and Ensemble's own code are refused by the runner. */
export async function trustFolder(discovery: Discovery, folder: string): Promise<TrustedFolder> {
  return localJson<TrustedFolder>(discovery, "/api/workspace/trust", { method: "POST", body: JSON.stringify({ path: resolve(folder) }) });
}

export async function untrustFolder(discovery: Discovery, folder: string): Promise<boolean> {
  const wanted = resolve(folder);
  const row = (await listTrusted(discovery)).find((item) => item.path === wanted || item.id === folder);
  if (!row) return false;
  await localJson<unknown>(discovery, `/api/workspace/trust/${encodeURIComponent(row.id)}`, { method: "DELETE" });
  return true;
}

export async function webApprovals(discovery: Discovery, on?: boolean): Promise<boolean> {
  const body =
    on === undefined
      ? await localJson<{ acceptWebApprovals?: boolean }>(discovery, "/api/remote")
      : await localJson<{ acceptWebApprovals?: boolean }>(discovery, "/api/remote", { method: "PUT", body: JSON.stringify({ acceptWebApprovals: on }) });
  return body.acceptWebApprovals !== false;
}
