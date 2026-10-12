/**
 * HTTP for item sources: a timeout, JSON in and out, and errors a person can
 * read. A token is never put into an error, even when the app echoes it back.
 */
import { ConnectorNotConnectedError } from "../tokens.js";
import type { AccountProvider } from "../accounts.js";
import { ItemError, MAX_ITEM_TEXT, type ItemContext } from "./types.js";

const TIMEOUT_MS = 20_000;

export interface ItemRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  /** Objects are sent as JSON; strings and URLSearchParams as they are. */
  body?: unknown;
  /** Read the body as text instead of JSON. */
  text?: boolean;
}

function vendorMessage(body: unknown): string {
  if (!body || typeof body !== "object") return typeof body === "string" ? body : "";
  const record = body as Record<string, unknown>;
  for (const key of ["message", "error_description", "error", "detail", "title", "errorMessage"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string") return (value as { message: string }).message;
  }
  const errors = record.errors ?? record.errorMessages;
  if (Array.isArray(errors)) {
    const first = errors[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && typeof (first as { message?: unknown }).message === "string") return (first as { message: string }).message;
  }
  return "";
}

/** Calls an app's API with the person's token. `label` names the app in errors. */
export async function itemFetch<T>(ctx: ItemContext, provider: AccountProvider, label: string, url: string, init: ItemRequest = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...init.headers };
  let body: RequestInit["body"];
  if (typeof init.body === "string" || init.body instanceof URLSearchParams) body = init.body;
  else if (init.body !== undefined) {
    headers["Content-Type"] ??= "application/json";
    body = JSON.stringify(init.body);
  }
  let response: Response;
  try {
    response = await ctx.fetch(url, {
      method: init.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      body,
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new ItemError(timedOut ? `${label} did not answer in time. Try again.` : `Could not reach ${label}. Try again in a moment.`, timedOut ? 504 : 502);
  }
  const raw = await response.text().catch(() => "");
  if (!response.ok) {
    let parsed: unknown = raw;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = raw.slice(0, 300);
    }
    if (response.status === 401) {
      throw new ConnectorNotConnectedError(provider, `${label} no longer accepts the saved sign-in. Connect it again in Settings → Connections.`);
    }
    let said = vendorMessage(parsed).replace(/\s+/g, " ").trim();
    if (ctx.token.token) said = said.split(ctx.token.token).join("[token]");
    said = said.slice(0, 240);
    if (response.status === 403) throw new ItemError(`${label} refused access${said ? `: ${said}` : ""}. The connection may lack permission for this.`, 403);
    if (response.status === 404) throw new ItemError(`${label} could not find that. It may have moved, or this connection cannot see it.`, 404);
    if (response.status === 429) throw new ItemError(`${label} is rate limiting requests. Try again in a minute.`, 429);
    throw new ItemError(`${label} answered with an error (${response.status})${said ? `: ${said}` : ""}.`);
  }
  if (init.text) return raw as T;
  try {
    return (raw ? JSON.parse(raw) : {}) as T;
  } catch {
    throw new ItemError(`${label} sent something Ensemble could not read.`);
  }
}

/** Collapses whitespace and caps the text kept from one read. */
export function capText(text: string, max = MAX_ITEM_TEXT): string {
  const clean = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return clean.length > max ? `${clean.slice(0, max)}\n\n… (cut ${clean.length - max} more characters)` : clean;
}

/** "Status: Open · Due: 2026-10-20" style facts with empty values dropped. */
export function facts(entries: Record<string, string | number | null | undefined | false>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === null || value === undefined || value === false || value === "") continue;
    out[key] = String(value);
  }
  return out;
}

/** Markdown for an item: a facts list, then its body. */
export function itemMarkdown(title: string, entries: Record<string, string>, body: string): string {
  const lines = Object.entries(entries).map(([key, value]) => `- ${key}: ${value}`);
  return capText([`# ${title}`, lines.join("\n"), body].filter(Boolean).join("\n\n"));
}
