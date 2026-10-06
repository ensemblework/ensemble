import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

export const LoginProvider = z.enum(["google", "github", "microsoft"]);
export type LoginProvider = z.infer<typeof LoginProvider>;
export type LoginProfile = { subject: string; email: string | null; name: string; verified: boolean };

const GOOGLE_KEYS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const MICROSOFT_KEYS = createRemoteJWKSet(new URL("https://login.microsoftonline.com/common/discovery/v2.0/keys"));
const PROVIDERS = {
  google: { authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", scope: "openid email profile" },
  github: { authorize: "https://github.com/login/oauth/authorize", token: "https://github.com/login/oauth/access_token", scope: "read:user user:email" },
  microsoft: {
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "openid email profile",
  },
} as const;

export function loginProviderConfigured(provider: LoginProvider): boolean {
  return Boolean(process.env[`AUTH_${provider.toUpperCase()}_CLIENT_ID`]?.trim() && process.env[`AUTH_${provider.toUpperCase()}_CLIENT_SECRET`]?.trim());
}

function config(provider: LoginProvider) {
  if (!loginProviderConfigured(provider)) {
    throw Object.assign(new Error(`${provider} sign-in is not configured. Use email or another provider.`), { statusCode: 503 });
  }
  const origin = new URL(process.env.HUB_API_PUBLIC_URL ?? `http://127.0.0.1:${process.env.HUB_API_PORT ?? 4000}`);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("HUB_API_PUBLIC_URL must be one exact http(s) origin.");
  }
  return {
    ...PROVIDERS[provider],
    clientId: process.env[`AUTH_${provider.toUpperCase()}_CLIENT_ID`]!.trim(),
    clientSecret: process.env[`AUTH_${provider.toUpperCase()}_CLIENT_SECRET`]!.trim(),
    callback: `${origin.origin}/api/auth/oauth/${provider}/callback`,
  };
}

export function newOAuthFlow() {
  return { state: randomBytes(32).toString("base64url"), verifier: randomBytes(32).toString("base64url"), nonce: randomBytes(32).toString("base64url") };
}

export function loginAuthorizationUrl(provider: LoginProvider, flow: { state: string; verifier: string; nonce: string }): string {
  const settings = config(provider);
  const url = new URL(settings.authorize);
  url.search = new URLSearchParams({
    client_id: settings.clientId,
    redirect_uri: settings.callback,
    response_type: "code",
    scope: settings.scope,
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: createHash("sha256").update(flow.verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

async function providerJson(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (cause) {
    throw Object.assign(new Error("The sign-in provider could not be reached. Try again.", { cause }), { statusCode: 502 });
  }
  if (!response.ok) throw Object.assign(new Error(`The sign-in provider rejected the request (HTTP ${response.status}). Try again.`), { statusCode: 400 });
  return response.json();
}

export async function exchangeLoginCode(provider: LoginProvider, code: string, verifier: string, nonce: string, options: { keys?: JWTVerifyGetKey } = {}): Promise<LoginProfile> {
  const settings = config(provider);
  const tokens = z.object({ access_token: z.string().optional(), id_token: z.string().optional(), error: z.string().optional() }).parse(
    await providerJson(settings.token, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        redirect_uri: settings.callback,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
      }),
    }),
  );
  if (tokens.error) throw Object.assign(new Error("The sign-in code was rejected or expired. Try again."), { statusCode: 400 });
  if (provider === "github") {
    if (!tokens.access_token) throw new Error("GitHub did not return an access token.");
    const headers = { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    const [rawProfile, rawEmails] = await Promise.all([
      providerJson("https://api.github.com/user", { headers }),
      providerJson("https://api.github.com/user/emails", { headers }),
    ]);
    const profile = z.object({ id: z.number().int(), name: z.string().nullable(), login: z.string() }).parse(rawProfile);
    const emails = z.array(z.object({ email: z.string().email(), primary: z.boolean(), verified: z.boolean() })).parse(rawEmails);
    const email = emails.find((item) => item.primary && item.verified);
    if (!email) throw Object.assign(new Error("Verify your primary GitHub email before signing in to Ensemble."), { statusCode: 400 });
    return { subject: String(profile.id), email: email.email.trim().toLowerCase(), name: (profile.name ?? profile.login).slice(0, 80), verified: true };
  }
  if (!tokens.id_token) throw new Error("The provider did not return an identity token.");
  let issuer: string | string[] = ["https://accounts.google.com", "accounts.google.com"];
  if (provider === "microsoft") {
    const tenant = z.string().uuid().parse(decodeJwt(tokens.id_token).tid);
    issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
  }
  const { payload } = await jwtVerify(tokens.id_token, options.keys ?? (provider === "google" ? GOOGLE_KEYS : MICROSOFT_KEYS), {
    audience: settings.clientId,
    issuer,
    algorithms: ["RS256"],
    requiredClaims: ["sub", "iat", "exp", "nonce"],
    maxTokenAge: "10m",
  });
  if (provider === "google" && payload.azp !== undefined && payload.azp !== settings.clientId) {
    throw Object.assign(new Error("The identity token belongs to a different sign-in client."), { statusCode: 400 });
  }
  if (payload.nonce !== nonce) throw Object.assign(new Error("The sign-in identity did not match this browser. Try again."), { statusCode: 400 });
  const address = z.string().trim().toLowerCase().email().safeParse(payload.email ?? payload.preferred_username);
  return {
    subject: provider === "microsoft" ? `${z.string().uuid().parse(payload.tid)}:${z.string().uuid().parse(payload.oid)}` : z.string().min(1).parse(payload.sub),
    email: address.success ? address.data : null,
    name: typeof payload.name === "string" ? payload.name.slice(0, 80) : "",
    // Microsoft's email/preferred_username claims are not verified ownership claims.
    verified: provider === "google" && payload.email_verified === true,
  };
}
