export const MCP_OAUTH_SCOPES = ["ensemble:read", "ensemble:write", "ensemble:apps", "offline_access"] as const;
export const MCP_OAUTH_REQUEST_PATTERN = /^ens_oauth_request_[A-Za-z0-9_-]{43}$/;

export interface McpOAuthConsent {
  csrf: string;
  clientName: string;
  clientOrigin: string;
  clientMetadataOrigin: string | null;
  accountEmail: string;
  expiresAt: string;
  canWrite: boolean;
  canUseApps: boolean;
  spaces: Array<{ id: string; name: string }>;
}

export interface McpOAuthDecision {
  request: string;
  csrf: string;
  decision: "allow" | "deny";
  spaceId?: string;
  canWrite?: boolean;
  canUseApps?: boolean;
}

export interface McpOAuthConnections {
  csrf: string;
  connections: Array<{
    id: string;
    name: string;
    space: string;
    canWrite: boolean;
    canUseApps: boolean;
    createdAt: string;
    lastUsedAt: string | null;
  }>;
}

/** Only the MCP consent page can be carried through a provider sign-in. */
export function mcpRequestFromLoginNext(value: string | null): string | null {
  if (!value?.startsWith("/oauth?")) return null;
  const url = new URL(value, "https://ensemble.invalid");
  const entries = [...url.searchParams];
  return !url.hash && entries.length === 1 && entries[0]?.[0] === "request" &&
    MCP_OAUTH_REQUEST_PATTERN.test(entries[0][1]) ? entries[0][1] : null;
}
