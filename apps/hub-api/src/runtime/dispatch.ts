/**
 * In-process stand-in for the Python runtime's HTTP routes.
 * Response objects match what hub-api already parses from port 5055.
 */
import { isProvider, listCredentials, removeCredential, saveCredential } from "./credentials.js";
import { CallError, DecryptError, ModelAuthError, ProviderError, friendlyKeyError, statusForProvider } from "./errors.js";
import { catalog, clearCatalogCache, completeText, completeWithTools, listModels } from "./models.js";
import { parseTable, runPlot } from "./plots-python.js";
import { groundedSearch } from "./search.js";
import type { Json } from "./payload.js";

export class DispatchError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "DispatchError";
  }
}

export function toDispatchError(error: unknown): DispatchError {
  if (error instanceof DispatchError) return error;
  if (error instanceof CallError) return new DispatchError(error.message, error.statusCode);
  if (error instanceof ProviderError) return new DispatchError(error.message, statusForProvider(error.status));
  if (error instanceof DecryptError) return new DispatchError(error.message, 409);
  if (error instanceof ModelAuthError) return new DispatchError(error.message, 503);
  const text = error instanceof Error ? error.message : String(error);
  const safe = text.includes("http://") || text.includes("https://") ? "The model provider could not be reached." : text.slice(0, 500);
  return new DispatchError(safe, 502);
}

export async function dispatchRuntime(
  path: string,
  init: { method?: string; json?: unknown; signal?: AbortSignal } = {},
): Promise<unknown> {
  const url = new URL(path, "http://runtime.local");
  const method = (init.method ?? "GET").toUpperCase();
  const body = init.json && typeof init.json === "object" ? (init.json as Json) : {};
  try {
    return await route(method, url.pathname, url.searchParams, body, init.signal);
  } catch (error) {
    throw toDispatchError(error);
  }
}

async function route(method: string, pathname: string, query: URLSearchParams, body: Json, signal?: AbortSignal): Promise<unknown> {
  if (method === "POST" && pathname === "/api/complete") return completeText(body, { signal });
  if (method === "POST" && pathname === "/api/chat/tools") return completeWithTools(body, { signal });
  if (method === "GET" && pathname === "/api/models") {
    return { providers: await catalog(query.get("userId"), query.get("ollamaUrl"), signal) };
  }
  if (method === "GET" && pathname === "/api/credentials") {
    return { credentials: await listCredentials(query.get("userId") ?? "") };
  }
  if (method === "PUT" && pathname === "/api/credentials") return saveKey(body, signal);
  const credential = pathname.match(/^\/api\/credentials\/([^/]+)$/);
  if (method === "DELETE" && credential) {
    await removeCredential(query.get("userId") ?? "", decodeURIComponent(credential[1] ?? ""));
    clearCatalogCache();
    return { ok: true };
  }
  if (method === "POST" && pathname === "/api/search") return search(body);
  if (method === "POST" && pathname === "/api/plots/parse") {
    return parseTable(String(body.filename ?? "table"), String(body.contentBase64 ?? ""), String(body.sheet ?? ""));
  }
  if (method === "POST" && pathname === "/api/plots/run") {
    const code = String(body.code ?? "");
    if (code.length > 100_000) throw new CallError("That script is too long.", 400);
    const datasets = Array.isArray(body.datasets) ? (body.datasets as Array<Record<string, unknown>>) : [];
    const format = typeof body.format === "string" && body.format ? body.format : "all";
    const dpi = typeof body.dpi === "number" && Number.isFinite(body.dpi) ? body.dpi : 200;
    return runPlot(code, datasets, format, dpi);
  }
  throw new CallError("That runtime route is not available.", 404);
}

async function saveKey(body: Json, signal?: AbortSignal): Promise<{ ok: boolean; models: number }> {
  const provider = String(body.provider ?? "");
  const secret = String(body.apiKey ?? "").trim();
  if (!isProvider(provider) || provider === "ollama") throw new CallError("Unknown provider.", 400);
  if (!secret) throw new CallError("Paste a key first.", 400);
  const userId = String(body.userId ?? "");
  try {
    const found = await listModels(provider, userId, null, secret, signal);
    await saveCredential(userId, provider, secret, typeof body.baseUrl === "string" ? body.baseUrl : null);
    clearCatalogCache();
    return { ok: true, models: found.length };
  } catch (error) {
    if (error instanceof CallError || error instanceof ProviderError || error instanceof ModelAuthError || error instanceof DecryptError) throw error;
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 0;
    const text = error instanceof Error ? error.message : String(error);
    if (status || text.startsWith("HTTP ") || text.includes("://") || error instanceof TypeError) {
      throw new CallError(friendlyKeyError(provider, status), 400);
    }
    throw new CallError(text.slice(0, 200), 400);
  }
}

async function search(body: Json): Promise<{ results: unknown[]; error?: string }> {
  try {
    const results = await groundedSearch(
      typeof body.userId === "string" ? body.userId : null,
      String(body.provider || "google"),
      String(body.model || "gemini-3.5-flash-lite"),
      String(body.query ?? ""),
    );
    return { results };
  } catch {
    return { results: [], error: "search unavailable" };
  }
}
