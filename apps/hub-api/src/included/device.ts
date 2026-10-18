/**
 * Included models in the desktop app and the CLI. Neither holds the Azure key or the credits ledger:
 * a computer connected to an Ensemble account (paired, docs/25) sends each included call to Ensemble's
 * server with its device token, and the server runs it on the account's credits under the same
 * limits as the web (routes/included.ts). A local-only computer cannot use them: every call is
 * refused with INCLUDED_LOCAL_ONLY, which the app shows with a way to connect.
 */
import { createHash } from "node:crypto";
import { INCLUDED_CREDITS_USED, INCLUDED_LOCAL_ONLY, INCLUDED_PAUSED, INCLUDED_PROVIDER, INCLUDED_UNAVAILABLE, includedPeriod, includedResetsAt, type IncludedUsage } from "@ensemble/shared-types";
import { IncludedLimitError, includedErrorFrom } from "./errors.js";
import { ProviderError } from "../runtime/errors.js";
import { loadSettings, readDeviceToken } from "../remote/store.js";

type Json = Record<string, unknown>;
export type DeviceLink = { base: string; token: string };
/** What the server says about the account's included models: the catalog row and this month's credits. */
export type DeviceIncluded = { catalog: Json | null; usage: IncludedUsage | null; error: string | null };

export const INCLUDED_TURN_ROUTE = "/api/devices/self/included/turn";
export const INCLUDED_STATUS_ROUTE = "/api/devices/self/included";

const FRESH_MS = 60_000;
const UNREACHABLE = "Ensemble on the web is not reachable, so included models cannot answer right now. Check this computer's connection and try again.";
const DISCONNECTED = "This computer is no longer connected to your Ensemble account, so it cannot use included models. Connect it again in Settings → Account → This computer.";

let linkSource: (() => Promise<DeviceLink | null>) | null = null;
let held: { pairing: string; at: number; value: DeviceIncluded } | null = null;
let pending: Promise<DeviceIncluded> | null = null;

/** The desktop app's and the CLI's local server (not hosted Ensemble). */
export function onDevice(): boolean {
  return process.env.ENSEMBLE_DESKTOP === "1";
}

/** Tests: where the connection comes from. `null` restores the paired account. */
export function setDeviceLinkForTests(fn: typeof linkSource): void {
  linkSource = fn;
  held = null;
}

/** The server and token of the account this computer is connected to, or null when it is local only. */
export async function deviceLink(): Promise<DeviceLink | null> {
  if (linkSource) return linkSource();
  const settings = loadSettings();
  const base = process.env.ENSEMBLE_REMOTE_API?.trim().replace(/\/+$/, "") || settings.apiBase;
  if (!base || !settings.pairedAt) return null;
  const token = await readDeviceToken();
  return token ? { base, token } : null;
}

async function call(link: DeviceLink, method: string, path: string, body: unknown, signal: AbortSignal): Promise<{ status: number; body: Json }> {
  let response: Response;
  try {
    response = await fetch(`${link.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${link.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted && (signal.reason as { name?: string } | undefined)?.name !== "TimeoutError") throw error;
    throw new IncludedLimitError(INCLUDED_UNAVAILABLE, UNREACHABLE);
  }
  const text = await response.text();
  let parsed: Json = {};
  try {
    parsed = text ? (JSON.parse(text) as Json) : {};
  } catch {
    parsed = { error: text.slice(0, 300) };
  }
  return { status: response.status, body: parsed };
}

/** A refusal from the server as the error this computer shows. */
function refusal(status: number, body: Json): Error {
  const included = includedErrorFrom(body);
  if (included) return included;
  // The device token was revoked (401) or is not this computer's (403): it is local only now.
  if (status === 401 || status === 403) return new IncludedLimitError(INCLUDED_LOCAL_ONLY, DISCONNECTED);
  // An older server has no route for this yet.
  if (status === 404) return new IncludedLimitError(INCLUDED_UNAVAILABLE, "Ensemble on the web does not offer included models to computers yet. Use your own API key or AI plan in Settings → Models.");
  const message = typeof body.error === "string" && body.error ? body.error : typeof body.message === "string" && body.message ? body.message : `Included model call failed (${status}).`;
  return new ProviderError(status, status === 429 ? "rate_limit" : status >= 500 ? "server" : "invalid_request", message);
}

/**
 * The included catalog row and credits for GET /api/models and /api/metrics/credits on this
 * computer, read from the server and held for a minute. Local only: null.
 */
export async function deviceIncluded(): Promise<DeviceIncluded | null> {
  const link = await deviceLink();
  if (!link) return null;
  const pairing = createHash("sha256").update(`${link.base}\u0000${link.token}`).digest("hex");
  if (held && held.pairing === pairing && Date.now() - held.at < FRESH_MS) return held.value;
  pending ??= (async () => {
    let value: DeviceIncluded;
    try {
      const res = await call(link, "GET", INCLUDED_STATUS_ROUTE, undefined, AbortSignal.timeout(8_000));
      if (res.status >= 400) {
        const error = refusal(res.status, res.body);
        value = { catalog: null, usage: null, error: error.message };
      } else {
        value = { catalog: (res.body.catalog as Json | null) ?? null, usage: (res.body.usage as IncludedUsage | null) ?? null, error: null };
      }
    } catch (error) {
      // Off the network, the last answer stays in use for another minute.
      value = held?.pairing === pairing ? held.value : { catalog: null, usage: null, error: (error as Error).message };
    }
    held = { pairing, at: Date.now(), value };
    return value;
  })().finally(() => {
    pending = null;
  });
  return pending;
}

/** A call just spent credits: read them again next time. */
export function forgetDeviceIncluded(): void {
  held = null;
}

/**
 * The cheap check before a chat opens, on this computer: a local-only computer is refused, and so is
 * an account whose credits (or the shared budget) the server last reported as used up. The server's
 * own check on the call is the one that counts.
 */
export async function assertDeviceIncludedOpen(): Promise<void> {
  const status = await deviceIncluded();
  if (!status) throw new IncludedLimitError(INCLUDED_LOCAL_ONLY);
  const usage = status.usage;
  if (!usage?.available) return;
  if (usage.paused) throw new IncludedLimitError(INCLUDED_PAUSED, undefined, usage.resetsAt);
  if (usage.remaining <= 0) throw new IncludedLimitError(INCLUDED_CREDITS_USED, undefined, usage.resetsAt);
}

/** GET /api/metrics/credits on this computer: the account's credits from the server, or local only. */
export async function deviceCredits(now = new Date()): Promise<IncludedUsage> {
  const status = await deviceIncluded();
  if (status?.usage) return status.usage;
  const empty = { calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, inputCredits: 0, outputCredits: 0, credits: 0 };
  return {
    available: false,
    ...(status ? {} : { localOnly: true }),
    models: [],
    period: includedPeriod(now),
    resetsAt: includedResetsAt(now).toISOString(),
    limit: 0,
    used: 0,
    remaining: 0,
    paused: false,
    totals: empty,
    byModel: [],
    byPurpose: [],
    days: [],
  };
}

/** The catalog row GET /api/models lists for included models on this computer. */
export async function deviceIncludedCatalogEntry(): Promise<Json> {
  const status = await deviceIncluded();
  if (status?.catalog) return status.catalog;
  return {
    provider: INCLUDED_PROVIDER,
    available: false,
    source: "included",
    models: [],
    meta: {},
    chat: true,
    cheapest: null,
    error: status ? (status.error ?? "Included models are not set up on Ensemble on the web.") : new IncludedLimitError(INCLUDED_LOCAL_ONLY).message,
    code: status ? INCLUDED_UNAVAILABLE : INCLUDED_LOCAL_ONLY,
    notes: {},
  };
}

/**
 * One included turn, run by the server for the account this computer is connected to. The request
 * is the one the runtime built (messages, tools, thinking level); the server adds the account,
 * reserves the worst case, calls Azure and settles, exactly as for the web.
 */
export async function deviceIncludedTurn(
  body: Json,
  model: string,
  messages: Json[],
  options: { items?: unknown[] | null; jsonMode?: boolean; signal?: AbortSignal; timeoutMs: number },
): Promise<Json> {
  const link = await deviceLink();
  if (!link) throw new IncludedLimitError(INCLUDED_LOCAL_ONLY);
  const timeout = AbortSignal.timeout(options.timeoutMs + 15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const request = {
    model,
    messages,
    items: options.items ?? null,
    jsonMode: Boolean(options.jsonMode),
    reasoningEffort: typeof body.reasoningEffort === "string" ? body.reasoningEffort : null,
    chatTools: Array.isArray(body.chatTools) ? body.chatTools : null,
    responsesTools: Array.isArray(body.responsesTools) ? body.responsesTools : null,
    purpose: typeof body.purpose === "string" ? body.purpose : null,
  };
  try {
    const res = await call(link, "POST", INCLUDED_TURN_ROUTE, request, signal);
    if (res.status >= 400) throw refusal(res.status, res.body);
    const turn = res.body.turn;
    if (!turn || typeof turn !== "object") throw new ProviderError(502, "server", "Ensemble on the web sent an empty answer for the included model.");
    return turn as Json;
  } finally {
    forgetDeviceIncluded();
  }
}
