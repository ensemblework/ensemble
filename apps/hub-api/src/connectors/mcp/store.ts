/**
 * McpConnection rows: what is stored, how secrets are sealed, and what the Hub sees.
 *
 * clientInfo holds an encrypted envelope: how the connection authenticates,
 * the OAuth client (registered, CIMD or pre-registered) and the cached
 * discovery result (resource metadata and authorization server metadata).
 * tokens holds the encrypted OAuth tokens, or the pasted bearer token.
 */
import type { McpConnection } from "@prisma/client";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { decrypt, encrypt } from "../../lib/secrets.js";

export type McpStatus = "pending" | "connected" | "error" | "disabled";
export const MCP_STATUSES: readonly McpStatus[] = ["pending", "connected", "error", "disabled"];

/** oauth: the MCP authorization flow. bearer: a pasted token sent as Authorization: Bearer. none: the server asks for nothing. */
export type McpAuthKind = "oauth" | "bearer" | "none";

export type McpClientEnvelope = {
  auth: McpAuthKind;
  client?: OAuthClientInformationMixed;
  /** The person typed in this client's id (and secret); keep it across reconnects. */
  preRegistered?: boolean;
  discovery?: OAuthDiscoveryState;
};

export type McpToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/** One cached tools/list entry. */
export type McpToolSpec = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
};

export type McpConnectionView = {
  id: string;
  serverId: string;
  name: string;
  url: string;
  status: McpStatus;
  auth: McpAuthKind;
  toolCount: number;
  tools: Array<{ name: string; title: string | null; description: string | null; readOnly: boolean }>;
  disabledTools: string[];
  lastError: string | null;
  toolsSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function sealJson(value: unknown): string {
  return encrypt(JSON.stringify(value));
}

function openJson<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(decrypt(value)) as T;
  } catch {
    return undefined;
  }
}

export function readEnvelope(row: Pick<McpConnection, "clientInfo">): McpClientEnvelope {
  const stored = openJson<Partial<McpClientEnvelope>>(row.clientInfo);
  const auth: McpAuthKind = stored?.auth === "bearer" || stored?.auth === "none" ? stored.auth : "oauth";
  return {
    auth,
    ...(stored?.client ? { client: stored.client } : {}),
    ...(stored?.preRegistered ? { preRegistered: true } : {}),
    ...(stored?.discovery ? { discovery: stored.discovery } : {}),
  };
}

export function readTokens(row: Pick<McpConnection, "tokens">): OAuthTokens | undefined {
  const tokens = openJson<OAuthTokens>(row.tokens);
  return tokens && typeof tokens.access_token === "string" ? tokens : undefined;
}

export function readCodeVerifier(row: Pick<McpConnection, "codeVerifier">): string | undefined {
  if (!row.codeVerifier) return undefined;
  try {
    return decrypt(row.codeVerifier);
  } catch {
    return undefined;
  }
}

export function expiresAtFrom(tokens: OAuthTokens, now = Date.now()): Date | null {
  return typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0
    ? new Date(now + tokens.expires_in * 1000)
    : null;
}

export function asStatus(value: string): McpStatus {
  return (MCP_STATUSES as readonly string[]).includes(value) ? (value as McpStatus) : "error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function cachedTools(row: Pick<McpConnection, "tools">): McpToolSpec[] {
  if (!Array.isArray(row.tools)) return [];
  const out: McpToolSpec[] = [];
  for (const item of row.tools as unknown[]) {
    if (!isRecord(item) || typeof item.name !== "string" || !item.name) continue;
    out.push({
      name: item.name,
      ...(typeof item.title === "string" ? { title: item.title } : {}),
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      inputSchema: isRecord(item.inputSchema) ? item.inputSchema : { type: "object" },
      ...(isRecord(item.annotations) ? { annotations: item.annotations as McpToolAnnotations } : {}),
    });
  }
  return out;
}

export function toolTitle(tool: McpToolSpec): string {
  return tool.title?.trim() || tool.annotations?.title?.trim() || tool.name;
}

export function toolReadOnly(tool: McpToolSpec): boolean {
  return tool.annotations?.readOnlyHint === true;
}

export function connectionView(row: McpConnection): McpConnectionView {
  const tools = cachedTools(row);
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    url: row.url,
    status: asStatus(row.status),
    auth: readEnvelope(row).auth,
    toolCount: tools.length,
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.title ?? tool.annotations?.title ?? null,
      description: tool.description ? tool.description.slice(0, 300) : null,
      readOnly: toolReadOnly(tool),
    })),
    disabledTools: row.disabledTools,
    lastError: row.lastError,
    toolsSyncedAt: row.toolsSyncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
