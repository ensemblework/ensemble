export const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";

export const MCP_PUBLIC_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/authorize",
  "/oauth/register",
  "/oauth/token",
  "/oauth/revoke",
  OPENAI_APPS_CHALLENGE_PATH,
] as const;

const PUBLIC_PATHS = new Set<string>(MCP_PUBLIC_PATHS);
export const isMcpPublicPath = (path: string): boolean => PUBLIC_PATHS.has(path);
