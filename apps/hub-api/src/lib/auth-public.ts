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
]);

export function isPublicAuthPath(path: string): boolean {
  return PUBLIC_AUTH.has(path) || /^\/api\/auth\/oauth\/(google|github|microsoft)\/(start|callback)$/.test(path);
}
