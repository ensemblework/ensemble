const PUBLIC_AUTH = new Set([
  "/api/auth/status",
  "/api/auth/signup",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/verify-email",
  "/api/auth/forgot",
  "/api/auth/reset",
  "/api/cli/auth/start",
  "/api/cli/auth/token",
  // Remote MCP connectors: the OAuth return (bound by single-use state) and the public client metadata document.
  "/api/mcp-connections/callback",
  "/api/mcp-client-metadata.json",
]);

export function isPublicAuthPath(path: string): boolean {
  return PUBLIC_AUTH.has(path) || /^\/api\/auth\/oauth\/(google|github|microsoft)\/(start|callback)$/.test(path);
}
