/**
 * Session cookie flags. HttpOnly and SameSite=Lax always.
 * Secure when the process is production, or the request arrived over HTTPS
 * (including x-forwarded-proto from a TLS proxy). Plain http dev stays usable.
 */
export function sessionCookieSecure(input: {
  nodeEnv?: string;
  protocol?: string;
  forwardedProto?: string | string[] | undefined;
}): boolean {
  if (input.nodeEnv === "production") return true;
  if (firstProto(input.forwardedProto) === "https") return true;
  return (input.protocol ?? "").split(",")[0]?.trim().toLowerCase() === "https";
}

function firstProto(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim().toLowerCase() ?? "";
}

export function sessionCookieHeader(name: string, value: string, maxAge: number, secure: boolean, domain?: string | null): string {
  const parts = [`${name}=${value}`, "HttpOnly", "Path=/"];
  if (secure) parts.splice(2, 0, "Secure");
  if (domain) parts.push(`Domain=${domain}`);
  parts.push("SameSite=Lax", `Max-Age=${maxAge}`);
  return parts.join("; ");
}
