/**
 * Remote MCP connections: connect, finish sign-in, open a short-lived client,
 * list and call tools, disconnect.
 *
 * Every call opens a fresh client with the stored credentials and closes it
 * when done; nothing stays connected between assistant turns.
 */
import type { McpConnection, Prisma, PrismaClient } from "@prisma/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { auth, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  InvalidClientError,
  InvalidGrantError,
  InvalidTokenError,
  OAuthError,
  UnauthorizedClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { catalogEntry } from "@ensemble/shared-types";
import { redactText } from "../../lib/redact.js";
import { DEFAULT_RETURN_TO, mcpClientMetadataUrl, mcpRedirectUrl, safeReturnTo } from "./config.js";
import { McpAuthUnsupported, McpReconnectRequired, RowOAuthProvider } from "./provider.js";
import { readEnvelope, readTokens, sealJson, type McpClientEnvelope, type McpStatus, type McpToolSpec } from "./store.js";
import { assertMcpUrlAllowed, guardedFetch, McpUrlError, type LookupFn } from "./url-guard.js";

export const CONNECT_TIMEOUT_MS = 20_000;
export const LIST_TIMEOUT_MS = 30_000;
export const CALL_TIMEOUT_MS = 60_000;
/** Refresh this long before the access token runs out. */
const REFRESH_MARGIN_MS = 60_000;
const MAX_TOOL_PAGES = 10;
export const MAX_STORED_TOOLS = 200;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_STORED_SCHEMA_CHARS = 64_000;
export const MAX_RESULT_TEXT_CHARS = 4_500;
export const MAX_STRUCTURED_CHARS = 1_200;

export type McpTransportKind = "streamable-http" | "sse";

export type McpDeps = {
  /** Replaces global fetch under the URL guard. Tests only. */
  fetch?: FetchLike;
  hosted?: boolean;
  lookup?: LookupFn;
  now?: () => number;
};

type Db = PrismaClient;

export class McpConnectionError extends Error {
  readonly expose = true;
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "McpConnectionError";
  }
}

let defaultDeps: McpDeps = {};

/** Tests only: defaults for calls that do not pass deps (the routes). */
export function setMcpDepsForTests(deps: McpDeps | null): void {
  defaultDeps = deps ?? {};
}

function fetchFor(deps: McpDeps): FetchLike {
  return guardedFetch({ fetch: deps.fetch, hosted: deps.hosted, lookup: deps.lookup });
}

function now(deps: McpDeps): number {
  return deps.now?.() ?? Date.now();
}

function newClient(): Client {
  return new Client({ name: "Ensemble", version: "1.0.0" }, { capabilities: {} });
}

type OpenOptions = {
  url: string;
  transport: McpTransportKind;
  authProvider?: OAuthClientProvider;
  bearer?: string;
  deps: McpDeps;
};

function makeTransport(kind: McpTransportKind, options: OpenOptions) {
  const fetchFn = fetchFor(options.deps);
  const requestInit: RequestInit | undefined = options.bearer ? { headers: { Authorization: `Bearer ${options.bearer}` } } : undefined;
  if (kind === "sse") {
    return new SSEClientTransport(new URL(options.url), { authProvider: options.authProvider, requestInit, fetch: fetchFn });
  }
  return new StreamableHTTPClientTransport(new URL(options.url), {
    authProvider: options.authProvider,
    requestInit,
    fetch: fetchFn,
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1_000, maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1 },
  });
}

/** Streamable HTTP first; a 404 or 405 on initialize means an older HTTP+SSE server. */
export async function openClient(options: OpenOptions): Promise<Client> {
  const client = newClient();
  try {
    await client.connect(makeTransport(options.transport, options), { timeout: CONNECT_TIMEOUT_MS });
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    if (options.transport === "streamable-http" && error instanceof StreamableHTTPError && (error.code === 404 || error.code === 405)) {
      const legacy = newClient();
      try {
        await legacy.connect(makeTransport("sse", options), { timeout: CONNECT_TIMEOUT_MS });
        return legacy;
      } catch {
        await legacy.close().catch(() => undefined);
      }
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compactTool(tool: Record<string, unknown>): McpToolSpec | null {
  if (typeof tool.name !== "string" || !tool.name || tool.name.length > 128) return null;
  let inputSchema = isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object" };
  if (JSON.stringify(inputSchema).length > MAX_STORED_SCHEMA_CHARS) {
    const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
    inputSchema = {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [
          key,
          isRecord(value) ? { ...(value.type ? { type: value.type } : {}), ...(typeof value.description === "string" ? { description: value.description.slice(0, 200) } : {}) } : {},
        ]),
      ),
      ...(Array.isArray(inputSchema.required) ? { required: inputSchema.required } : {}),
    };
  }
  const raw = isRecord(tool.annotations) ? tool.annotations : {};
  const annotations: NonNullable<McpToolSpec["annotations"]> = {};
  if (typeof raw.title === "string") annotations.title = raw.title.slice(0, 200);
  for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
    if (typeof raw[key] === "boolean") annotations[key] = raw[key] as boolean;
  }
  return {
    name: tool.name,
    ...(typeof tool.title === "string" && tool.title.trim() ? { title: tool.title.trim().slice(0, 200) } : {}),
    ...(typeof tool.description === "string" ? { description: tool.description.slice(0, MAX_DESCRIPTION_CHARS) } : {}),
    inputSchema,
    ...(Object.keys(annotations).length ? { annotations } : {}),
  };
}

/** tools/list with pagination, capped at MAX_STORED_TOOLS. */
export async function listAllTools(client: Client): Promise<McpToolSpec[]> {
  const tools: McpToolSpec[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: LIST_TIMEOUT_MS });
    for (const tool of result.tools) {
      const compact = compactTool(tool as unknown as Record<string, unknown>);
      if (!compact || seen.has(compact.name)) continue;
      seen.add(compact.name);
      tools.push(compact);
    }
    cursor = result.nextCursor;
    if (!cursor || tools.length >= MAX_STORED_TOOLS) break;
  }
  return tools.slice(0, MAX_STORED_TOOLS);
}

function errorCode(error: unknown): string | undefined {
  const own = (error as { code?: unknown }).code;
  const cause = (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof cause === "string" ? cause : typeof own === "string" ? own : undefined;
}

export type FailureKind = "auth" | "network" | "timeout" | "other";

export function classifyMcpError(error: unknown): FailureKind {
  if (error instanceof McpReconnectRequired || error instanceof UnauthorizedError) return "auth";
  if (error instanceof InvalidGrantError || error instanceof InvalidClientError || error instanceof UnauthorizedClientError || error instanceof InvalidTokenError) {
    return "auth";
  }
  if (error instanceof StreamableHTTPError || error instanceof SseError) {
    const code = error.code;
    if (code === 401 || code === 403) return "auth";
    if (code === 408 || code === 504) return "timeout";
    if (code === undefined || code === 429 || code >= 500) return "network";
    return "other";
  }
  if (error instanceof McpError) {
    if (error.code === ErrorCode.RequestTimeout) return "timeout";
    if (error.code === ErrorCode.ConnectionClosed) return "network";
    return "other";
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "timeout";
    const code = errorCode(error);
    if (code && /^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR|CERT_|ERR_TLS|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO)/.test(code)) {
      return "network";
    }
    if (error instanceof TypeError && /fetch failed|network|socket/i.test(error.message)) return "network";
  }
  return "other";
}

/** A short, token-free message from anything thrown. */
export function plainMessage(error: unknown, max = 300): string {
  let text = error instanceof OAuthError ? error.message || error.errorCode : error instanceof Error ? error.message : String(error);
  text = text.replace(/^MCP error -?\d+:\s*/, "").replace(/^Error POSTing to endpoint:\s*/, "").replace(/\s+/g, " ").trim();
  text = redactText(text);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text || "Unknown error.";
}

function reconnectMessage(row: Pick<McpConnection, "name">, envelope: McpClientEnvelope): string {
  return envelope.auth === "bearer"
    ? `${row.name} refused the saved token. Paste a new one in Settings → Connections.`
    : `Reconnect ${row.name} in Settings → Connections. Its sign-in expired or was revoked.`;
}

/** Maps a failure to what the person sees, and marks the row when it needs a reconnect. */
async function failure(db: Db, row: McpConnection, error: unknown): Promise<Error> {
  if (error instanceof McpConnectionError || error instanceof McpUrlError || error instanceof McpAuthUnsupported) return error;
  const kind = classifyMcpError(error);
  if (kind === "auth") {
    const message = reconnectMessage(row, readEnvelope(row));
    await db.mcpConnection.update({ where: { id: row.id }, data: { status: "error", lastError: message } }).catch(() => undefined);
    return new McpConnectionError(message, 409, "MCP_RECONNECT");
  }
  if (kind === "network") return new McpConnectionError(`Could not reach ${row.name} right now. Try again in a moment.`, 502, "MCP_UNREACHABLE", true);
  if (kind === "timeout") return new McpConnectionError(`${row.name} took too long to answer. Try again, or ask for less.`, 504, "MCP_TIMEOUT", true);
  return new McpConnectionError(`${row.name}: ${plainMessage(error)}`, 502, "MCP_ERROR");
}

const refreshing = new Map<string, Promise<unknown>>();

/** Refreshes an access token that is about to expire, once per connection at a time. */
async function freshRow(db: Db, row: McpConnection, deps: McpDeps): Promise<McpConnection> {
  while (refreshing.has(row.id)) await refreshing.get(row.id)!.catch(() => undefined);
  const current = (await db.mcpConnection.findUnique({ where: { id: row.id } })) ?? row;
  const tokens = readTokens(current);
  if (!tokens) throw new McpReconnectRequired();
  if (!current.expiresAt || current.expiresAt.getTime() - now(deps) > REFRESH_MARGIN_MS || !tokens.refresh_token) return current;
  const job = (async () => {
    const provider = new RowOAuthProvider(db, current, "background", { now: deps.now });
    const result = await auth(provider, { serverUrl: current.url, fetchFn: fetchFor(deps) });
    if (result !== "AUTHORIZED") throw new McpReconnectRequired();
  })();
  refreshing.set(row.id, job);
  try {
    await job;
  } finally {
    refreshing.delete(row.id);
  }
  return (await db.mcpConnection.findUnique({ where: { id: row.id } })) ?? current;
}

/** The catalog says when a vendor still runs the older HTTP+SSE transport; everything else starts with Streamable HTTP. */
export function transportFor(serverId: string): McpTransportKind {
  return catalogEntry(serverId)?.mcp?.transport ?? "streamable-http";
}

/** Opens a client for a row without status checks. Marks an "error" row connected again when the call works. */
async function runWithRow<T>(db: Db, row: McpConnection, fn: (client: Client, row: McpConnection) => Promise<T>, deps: McpDeps): Promise<T> {
  let client: Client | undefined;
  try {
    const envelope = readEnvelope(row);
    let provider: RowOAuthProvider | undefined;
    let bearer: string | undefined;
    let current = row;
    if (envelope.auth === "oauth") {
      current = await freshRow(db, row, deps);
      provider = new RowOAuthProvider(db, current, "background", { now: deps.now });
    } else if (envelope.auth === "bearer") {
      bearer = readTokens(row)?.access_token;
      if (!bearer) throw new McpReconnectRequired();
    }
    client = await openClient({ url: row.url, transport: transportFor(row.serverId), authProvider: provider, bearer, deps });
    const result = await fn(client, provider?.connection ?? current);
    if (row.status === "error") await db.mcpConnection.update({ where: { id: row.id }, data: { status: "connected", lastError: null } });
    return result;
  } catch (error) {
    throw await failure(db, row, error);
  } finally {
    await client?.close().catch(() => undefined);
  }
}

const USABLE: readonly McpStatus[] = ["connected", "error"];

/**
 * Opens a short-lived MCP client for one of this person's connections, runs fn,
 * and closes it. Tokens are refreshed first when they are about to expire, and
 * once more on a 401. Throws McpConnectionError with a message the person can act on.
 */
export async function withClient<T>(
  db: Db,
  userId: string,
  connectionId: string,
  fn: (client: Client, row: McpConnection) => Promise<T>,
  deps: McpDeps = defaultDeps,
): Promise<T> {
  const row = await db.mcpConnection.findFirst({ where: { id: connectionId, userId } });
  if (!row) throw new McpConnectionError("That connection is no longer available.", 404, "MCP_NOT_FOUND");
  if (row.status === "disabled") throw new McpConnectionError(`${row.name} is switched off. Turn it on in Settings → Connections.`, 409, "MCP_DISABLED");
  if (!(USABLE as readonly string[]).includes(row.status)) throw new McpConnectionError(`Finish connecting ${row.name} first.`, 409, "MCP_PENDING");
  return runWithRow(db, row, fn, deps);
}

export type ConnectInput = {
  serverId: string;
  name: string;
  url: string;
  transport?: McpTransportKind;
  returnTo?: string;
  /** Personal access token or API key, sent as Authorization: Bearer. */
  token?: string;
  /** A client the person registered with the vendor themselves. */
  client?: { clientId: string; clientSecret?: string };
};

export type ConnectOutcome = { id: string; status: McpStatus; authorizeUrl?: string };

const CLEAR_SIGN_IN = { oauthState: null, stateExpiresAt: null, codeVerifier: null } as const;

/** Keeps a registered client across reconnects while it still matches this API's redirect URL. */
function reusableClient(previous: McpClientEnvelope | undefined): Pick<McpClientEnvelope, "client" | "preRegistered"> {
  const client = previous?.client;
  if (!client) return {};
  if (previous.preRegistered) return { client, preRegistered: true };
  const redirects = (client as OAuthClientInformationMixed & { redirect_uris?: unknown }).redirect_uris;
  if (Array.isArray(redirects) && redirects.includes(mcpRedirectUrl())) return { client };
  if (client.client_id === mcpClientMetadataUrl()) return { client };
  return {};
}

function connectFailure(error: unknown, name: string, bearer: boolean): Error {
  if (error instanceof McpUrlError || error instanceof McpAuthUnsupported || error instanceof McpConnectionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/does not support dynamic client registration/i.test(message)) {
    return new McpAuthUnsupported(
      `${name} does not let apps register themselves for sign-in. If it offers a personal access token or API key, paste that instead.`,
      "MCP_TOKEN_REQUIRED",
    );
  }
  const kind = classifyMcpError(error);
  if (kind === "auth") {
    return bearer
      ? new McpConnectionError(`${name} refused that token. Check it and paste it again.`, 400, "MCP_TOKEN_REFUSED")
      : new McpAuthUnsupported(`${name} asked for a sign-in Ensemble could not start. If it offers a personal access token, paste that instead.`, "MCP_TOKEN_REQUIRED");
  }
  if (error instanceof OAuthError) return new McpConnectionError(`${name} refused to register Ensemble: ${plainMessage(error)}`, 400, "MCP_REGISTRATION_REFUSED");
  if (kind === "network") return new McpConnectionError(`Could not reach ${name}. Check the address and try again.`, 502, "MCP_UNREACHABLE", true);
  if (kind === "timeout") return new McpConnectionError(`${name} took too long to answer. Try again in a moment.`, 504, "MCP_TIMEOUT", true);
  return new McpConnectionError(`Could not connect to ${name}: ${plainMessage(error)}`, 400, "MCP_CONNECT_FAILED");
}

/**
 * Starts connecting one server for this person.
 * - token: checked by listing tools, then stored encrypted. Connected at once.
 * - otherwise: probes the server. No sign-in needed → connected. A 401 starts
 *   OAuth (discovery, CIMD or DCR, PKCE, resource) and returns authorizeUrl.
 */
export async function startConnection(db: Db, userId: string, input: ConnectInput, deps: McpDeps = defaultDeps): Promise<ConnectOutcome> {
  const url = (await assertMcpUrlAllowed(input.url, deps)).href;
  const returnTo = safeReturnTo(input.returnTo);
  const transport = input.transport ?? transportFor(input.serverId);
  const existing = await db.mcpConnection.findUnique({ where: { userId_serverId: { userId, serverId: input.serverId } } });

  if (input.token) {
    let client: Client | undefined;
    try {
      client = await openClient({ url, transport, bearer: input.token, deps });
      const tools = await listAllTools(client);
      const data = {
        name: input.name,
        url,
        status: "connected",
        clientInfo: sealJson({ auth: "bearer" } satisfies McpClientEnvelope),
        tokens: sealJson({ access_token: input.token, token_type: "Bearer" }),
        expiresAt: null,
        ...CLEAR_SIGN_IN,
        returnTo,
        tools: tools as unknown as Prisma.InputJsonValue,
        toolsSyncedAt: new Date(now(deps)),
        lastError: null,
      };
      const row = existing
        ? await db.mcpConnection.update({ where: { id: existing.id }, data })
        : await db.mcpConnection.create({ data: { userId, serverId: input.serverId, ...data } });
      return { id: row.id, status: "connected" };
    } catch (error) {
      throw connectFailure(error, input.name, true);
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  const previous = existing ? readEnvelope(existing) : undefined;
  const envelope: McpClientEnvelope = input.client
    ? {
        auth: "oauth",
        client: { client_id: input.client.clientId, ...(input.client.clientSecret ? { client_secret: input.client.clientSecret } : {}) },
        preRegistered: true,
      }
    : { auth: "oauth", ...(existing?.url === url ? reusableClient(previous) : {}) };
  const data = {
    name: input.name,
    url,
    status: "pending",
    clientInfo: sealJson(envelope),
    tokens: null,
    expiresAt: null,
    ...CLEAR_SIGN_IN,
    returnTo,
    lastError: null,
  };
  const row = existing
    ? await db.mcpConnection.update({ where: { id: existing.id }, data })
    : await db.mcpConnection.create({ data: { userId, serverId: input.serverId, ...data } });

  const provider = new RowOAuthProvider(db, row, "connect", { returnTo, now: deps.now });
  let client: Client | undefined;
  try {
    client = await openClient({ url, transport, authProvider: provider, deps });
    const tools = await listAllTools(client);
    await db.mcpConnection.update({
      where: { id: row.id },
      data: {
        status: "connected",
        clientInfo: sealJson({ auth: "none" } satisfies McpClientEnvelope),
        ...CLEAR_SIGN_IN,
        tools: tools as unknown as Prisma.InputJsonValue,
        toolsSyncedAt: new Date(now(deps)),
        lastError: null,
      },
    });
    return { id: row.id, status: "connected" };
  } catch (error) {
    if (provider.authorizationUrl) return { id: row.id, status: "pending", authorizeUrl: provider.authorizationUrl.href };
    const mapped = connectFailure(error, input.name, false);
    if (existing) {
      await db.mcpConnection.update({ where: { id: row.id }, data: { status: "error", lastError: mapped.message, ...CLEAR_SIGN_IN } }).catch(() => undefined);
    } else {
      await db.mcpConnection.delete({ where: { id: row.id } }).catch(() => undefined);
    }
    throw mapped;
  } finally {
    await client?.close().catch(() => undefined);
  }
}

export type CallbackInput = {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
  /** Hosted: the browser finishing the sign-in must be signed in as the person who started it. */
  requireSession?: boolean;
  /** The Ensemble account of the browser's session cookie, if any. */
  sessionUserId?: string | null;
};

export type CallbackOutcome =
  | { ok: true; userId: string; connectionId: string; serverId: string; name: string; returnTo: string; toolCount: number }
  | { ok: false; userId?: string; connectionId?: string; serverId?: string; name?: string; returnTo: string; message: string };

function vendorRefusal(name: string, error: string | undefined, description: string | undefined): string {
  if (error === "access_denied" && !description) return `You did not approve ${name}.`;
  const detail = (description || error || "").replace(/\s+/g, " ").trim().slice(0, 300);
  return detail ? `${name} said: ${detail}` : `Sign-in to ${name} was cancelled.`;
}

/** The OAuth redirect. State is single-use and lives 10 minutes. */
export async function finishConnection(db: Db, input: CallbackInput, deps: McpDeps = defaultDeps): Promise<CallbackOutcome> {
  const expired = "This sign-in link has expired or was already used. Connect again.";
  const row = input.state ? await db.mcpConnection.findUnique({ where: { oauthState: input.state } }) : null;
  if (!row || !input.state) return { ok: false, returnTo: DEFAULT_RETURN_TO, message: expired };
  const claimed = await db.mcpConnection.updateMany({ where: { id: row.id, oauthState: input.state }, data: { oauthState: null, stateExpiresAt: null } });
  if (claimed.count !== 1) return { ok: false, returnTo: DEFAULT_RETURN_TO, message: expired };
  // Without this a person could start a connection and get someone else to approve it, landing that person's tokens on their row.
  if (input.requireSession && input.sessionUserId !== row.userId) {
    await db.mcpConnection
      .update({
        where: { id: row.id },
        data: { status: "error", lastError: "The sign-in was finished in a browser that is not signed in to this Ensemble account. Connect again.", codeVerifier: null },
      })
      .catch(() => undefined);
    return {
      ok: false,
      returnTo: DEFAULT_RETURN_TO,
      message: input.sessionUserId
        ? "This sign-in was started from a different Ensemble account, so nothing was saved. Connect the app from your own Settings."
        : "Sign in to Ensemble in this browser, then connect again. Nothing was saved.",
    };
  }
  const base = { userId: row.userId, connectionId: row.id, serverId: row.serverId, name: row.name, returnTo: safeReturnTo(row.returnTo) };
  const fail = async (message: string): Promise<CallbackOutcome> => {
    await db.mcpConnection
      .update({ where: { id: row.id }, data: { status: "error", lastError: message, codeVerifier: null } })
      .catch(() => undefined);
    return { ok: false, ...base, message };
  };
  if (!row.stateExpiresAt || row.stateExpiresAt.getTime() < now(deps)) return fail(`The sign-in to ${row.name} took longer than 10 minutes. Connect again.`);
  if (input.error || !input.code) return fail(vendorRefusal(row.name, input.error, input.errorDescription));

  const provider = new RowOAuthProvider(db, row, "callback", { now: deps.now });
  try {
    const result = await auth(provider, { serverUrl: row.url, authorizationCode: input.code, fetchFn: fetchFor(deps) });
    if (result !== "AUTHORIZED") return fail(`${row.name} did not finish the sign-in. Connect again.`);
  } catch (error) {
    const kind = classifyMcpError(error);
    if (kind === "network" || kind === "timeout") return fail(`Could not reach ${row.name} to finish the sign-in. Connect again.`);
    return fail(`${row.name} did not accept the sign-in: ${plainMessage(error)}`);
  }

  const signedIn = await db.mcpConnection.update({ where: { id: row.id }, data: { codeVerifier: null } });
  let tools: McpToolSpec[];
  try {
    tools = await runWithRow(db, signedIn, (client) => listAllTools(client), deps);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  await db.mcpConnection.update({
    where: { id: row.id },
    data: { status: "connected", tools: tools as unknown as Prisma.InputJsonValue, toolsSyncedAt: new Date(now(deps)), lastError: null },
  });
  return { ok: true, ...base, toolCount: tools.length };
}

/** Re-lists a connection's tools and caches them. */
export async function refreshTools(db: Db, userId: string, connectionId: string, deps: McpDeps = defaultDeps): Promise<McpConnection> {
  const tools = await withClient(db, userId, connectionId, (client) => listAllTools(client), deps);
  return db.mcpConnection.update({
    where: { id: connectionId },
    data: { status: "connected", tools: tools as unknown as Prisma.InputJsonValue, toolsSyncedAt: new Date(now(deps)), lastError: null },
  });
}

export type McpToolOutput = {
  text: string;
  structured?: unknown;
  isError: boolean;
  truncated: boolean;
};

/** Text for the model, capped; structuredContent only when it is small. */
export function normalizeToolResult(result: unknown): McpToolOutput {
  const record = isRecord(result) ? result : {};
  const parts: string[] = [];
  const content = Array.isArray(record.content) ? record.content : [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push("[image]");
    else if (block.type === "audio") parts.push("[audio]");
    else if (block.type === "resource_link") parts.push(`[link] ${typeof block.name === "string" ? `${block.name} ` : ""}${typeof block.uri === "string" ? block.uri : ""}`.trim());
    else if (block.type === "resource" && isRecord(block.resource)) {
      const resource = block.resource;
      parts.push(typeof resource.text === "string" ? resource.text : `[file] ${typeof resource.uri === "string" ? resource.uri : ""}`.trim());
    }
  }
  if (!content.length && "toolResult" in record) parts.push(JSON.stringify(record.toolResult) ?? "");
  let text = parts.join("\n\n").trim();
  let truncated = false;
  if (text.length > MAX_RESULT_TEXT_CHARS) {
    truncated = true;
    text = `${text.slice(0, MAX_RESULT_TEXT_CHARS)}… (cut ${text.length - MAX_RESULT_TEXT_CHARS} more characters)`;
  }
  let structured: unknown;
  if (record.structuredContent !== undefined) {
    const json = JSON.stringify(record.structuredContent);
    if (json && json.length <= MAX_STRUCTURED_CHARS) structured = record.structuredContent;
    else truncated = true;
  }
  return { text, ...(structured !== undefined ? { structured } : {}), isError: record.isError === true, truncated };
}

/** Calls one tool with a timeout. */
export async function callMcpTool(
  db: Db,
  userId: string,
  connectionId: string,
  toolName: string,
  args: Record<string, unknown>,
  deps: McpDeps = defaultDeps,
): Promise<McpToolOutput> {
  const result = await withClient(
    db,
    userId,
    connectionId,
    (client) => client.callTool({ name: toolName, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS }),
    deps,
  );
  return normalizeToolResult(result);
}

/** Best effort: revoke the refresh and access tokens when the authorization server offers revocation. */
async function revokeTokens(row: McpConnection, deps: McpDeps): Promise<boolean> {
  const envelope = readEnvelope(row);
  const tokens = readTokens(row);
  const endpoint = (envelope.discovery?.authorizationServerMetadata as { revocation_endpoint?: string } | undefined)?.revocation_endpoint;
  if (envelope.auth !== "oauth" || !tokens || !endpoint || !envelope.client) return false;
  const fetchFn = fetchFor(deps);
  let revoked = false;
  for (const [token, hint] of [
    [tokens.refresh_token, "refresh_token"],
    [tokens.access_token, "access_token"],
  ] as const) {
    if (!token) continue;
    const body = new URLSearchParams({ token, token_type_hint: hint });
    const headers = new Headers({ "content-type": "application/x-www-form-urlencoded", accept: "application/json" });
    const { client_id: clientId, client_secret: secret } = envelope.client;
    if (secret) headers.set("authorization", `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`).toString("base64")}`);
    else body.set("client_id", clientId);
    try {
      const response = await fetchFn(endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(5_000) });
      await response.body?.cancel().catch(() => undefined);
      revoked = revoked || response.ok;
    } catch {
      // Removing the connection does not wait on the vendor.
    }
  }
  return revoked;
}

/** Revokes what it can, then deletes the row. */
export async function disconnect(db: Db, userId: string, connectionId: string, deps: McpDeps = defaultDeps): Promise<{ row: McpConnection; revoked: boolean } | null> {
  const row = await db.mcpConnection.findFirst({ where: { id: connectionId, userId } });
  if (!row) return null;
  const revoked = await revokeTokens(row, deps).catch(() => false);
  await db.mcpConnection.deleteMany({ where: { id: row.id, userId } });
  return { row, revoked };
}
