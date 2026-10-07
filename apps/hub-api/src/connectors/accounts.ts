/**
 * Per-user connector accounts (oauth_tokens) and instance-level OAuth apps.
 *
 * Tokens are encrypted at rest. A signed-in person's own account always wins;
 * env vars are the localhost-developer fallback, and GitHub can borrow
 * `gh auth token` as docs/01 §2.3 allows.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { decrypt, encrypt } from "../lib/secrets.js";
import { canUseHostCredentials, isHosted, requireHostAccess, requireVerifiedUser } from "../lib/hosted-access.js";
import { assertWithinLimit, hostedLimits, withHostedUserLock } from "../lib/hosted-limits.js";

const run = promisify(execFile);

export const ACCOUNT_PROVIDERS = [
  "google",
  "github",
  "slack",
  "linear",
  "microsoft",
  "notion",
  "atlassian",
  "zoom",
  "docusign",
  "trello",
  "asana",
  "todoist",
  "clickup",
  "monday",
  // Meeting-notes sources: pasted personal API keys (connectors/meetings).
  "fireflies",
  "fathom",
  "granola",
  "tldv",
  "krisp",
  "jamie",
  "otter",
] as const;

export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

export const isAccountProvider = (value: string): value is AccountProvider => (ACCOUNT_PROVIDERS as readonly string[]).includes(value);

export interface Account {
  provider: AccountProvider;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
  account: string | null;
  /** Non-secret connection details saved at connect time (AuthToken.meta). */
  meta: Record<string, unknown>;
  source: "you" | "env" | "cli";
}

const NEVER = new Date("2100-01-01T00:00:00Z");

export async function saveAccount(
  userId: string,
  provider: AccountProvider,
  data: {
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: Date;
    scopes?: string[];
    account?: string | null;
    /** Replaces the stored details when given; left alone when omitted (token refresh). */
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  await requireVerifiedUser(userId);
  const row = {
    accessToken: encrypt(data.accessToken),
    refreshToken: data.refreshToken ? encrypt(data.refreshToken) : null,
    expiresAt: data.expiresAt ?? NEVER,
    scopes: data.scopes ?? [],
    account: data.account ?? null,
  };
  const meta = data.meta as Prisma.InputJsonValue | undefined;
  await withHostedUserLock(prisma, userId, async (tx) => {
    if (isHosted() && !(await tx.authToken.findUnique({ where: { userId_provider: { userId, provider } } }))) {
      assertWithinLimit(await tx.authToken.count({ where: { userId } }), 1, hostedLimits().connectors, "connector accounts");
    }
    await tx.authToken.upsert({
      where: { userId_provider: { userId, provider } },
      create: { userId, provider, ...row, meta: meta ?? {} },
      update: {
        ...row,
        // Google only returns a refresh token on the first consent; keep the old one.
        refreshToken: row.refreshToken ?? undefined,
        ...(meta !== undefined ? { meta } : {}),
      },
    });
  });
}

export async function removeAccount(userId: string, provider: AccountProvider): Promise<void> {
  await prisma.authToken.deleteMany({ where: { userId, provider } });
}

let ghLookup: { at: number; token: string | null } | null = null;
let ghInflight: Promise<string | null> | null = null;
const GH_TTL_MS = 60_000;
/** Page loads must not wait on a macOS keychain prompt. */
const GH_WAIT_MS = 400;

function rememberGh(token: string | null): string | null {
  ghLookup = { at: Date.now(), token };
  return token;
}

function spawnGhToken(): Promise<string | null> {
  return run("gh", ["auth", "token"], { timeout: 1500, killSignal: "SIGKILL" })
    .then(({ stdout }) => rememberGh(stdout.trim() || null))
    .catch(() => rememberGh(null));
}

async function ghToken(): Promise<string | null> {
  if (ghLookup && Date.now() - ghLookup.at < GH_TTL_MS) return ghLookup.token;
  if (!ghInflight) {
    const pending = spawnGhToken().finally(() => {
      if (ghInflight === pending) ghInflight = null;
    });
    ghInflight = pending;
  }
  const pending = ghInflight;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<string | null>((resolve) => {
    timer = setTimeout(() => resolve(ghLookup?.token ?? null), GH_WAIT_MS);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function readSecret(value: string): string | null {
  try {
    return decrypt(value);
  } catch {
    return null;
  }
}

const ENV_FALLBACK: Partial<Record<AccountProvider, string[]>> = {
  github: ["GITHUB_TOKEN"],
  slack: ["SLACK_USER_TOKEN", "SLACK_BOT_TOKEN"],
  linear: ["LINEAR_API_KEY"],
};

const metaOf = (value: Prisma.JsonValue | undefined): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export async function getAccount(
  userId: string,
  provider: AccountProvider,
  allowFallback = true,
  allowCli = true,
): Promise<Account | null> {
  const row = await prisma.authToken.findUnique({ where: { userId_provider: { userId, provider } } });
  if (row) {
    const accessToken = readSecret(row.accessToken);
    if (accessToken) {
      return {
        provider,
        accessToken,
        refreshToken: row.refreshToken ? readSecret(row.refreshToken) : null,
        expiresAt: row.expiresAt,
        scopes: row.scopes,
        account: row.account,
        meta: metaOf(row.meta),
        source: "you",
      };
    }
  }
  if (!allowFallback || !(await canUseHostCredentials(userId))) return null;
  for (const name of ENV_FALLBACK[provider] ?? []) {
    const value = process.env[name]?.trim();
    if (value) return { provider, accessToken: value, refreshToken: null, expiresAt: NEVER, scopes: [], account: null, meta: {}, source: "env" };
  }
  if (provider === "github" && allowCli) {
    const token = await ghToken();
    if (token) return { provider, accessToken: token, refreshToken: null, expiresAt: NEVER, scopes: [], account: null, meta: {}, source: "cli" };
  }
  return null;
}

// ── instance OAuth apps ─────────────────────────────────────────────────────

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
  /** env: the connector's own env vars. settings: saved in Settings → Connections. signin: borrowed from the sign-in app (AUTH_*). */
  source: "env" | "settings" | "signin";
}

/** The connector's own app env vars, then (after any app saved in Settings) the sign-in app of the same provider. */
const APP_ENV: Record<string, { own: [string, string]; signin?: [string, string] }> = {
  google: { own: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], signin: ["AUTH_GOOGLE_CLIENT_ID", "AUTH_GOOGLE_CLIENT_SECRET"] },
  microsoft: { own: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"], signin: ["AUTH_MICROSOFT_CLIENT_ID", "AUTH_MICROSOFT_CLIENT_SECRET"] },
  github: { own: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"], signin: ["AUTH_GITHUB_CLIENT_ID", "AUTH_GITHUB_CLIENT_SECRET"] },
  linear: { own: ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"] },
  notion: { own: ["NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET"] },
  atlassian: { own: ["ATLASSIAN_CLIENT_ID", "ATLASSIAN_CLIENT_SECRET"] },
  slack: { own: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"] },
  zoom: { own: ["ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET"] },
  docusign: { own: ["DOCUSIGN_CLIENT_ID", "DOCUSIGN_CLIENT_SECRET"] },
};

function envPair(names: [string, string] | undefined): { clientId: string; clientSecret: string } | null {
  if (!names) return null;
  const [clientId, clientSecret] = names.map((name) => process.env[name]?.trim() ?? "");
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export async function oauthApp(provider: string): Promise<OAuthApp | null> {
  const names = APP_ENV[provider];
  const own = envPair(names?.own);
  if (own) return { ...own, source: "env" };
  const row = await prisma.connectorApp.findUnique({ where: { provider } });
  const clientSecret = row ? readSecret(row.clientSecret) : null;
  if (row && clientSecret) return { clientId: row.clientId, clientSecret, source: "settings" };
  const signin = envPair(names?.signin);
  return signin ? { ...signin, source: "signin" } : null;
}

export async function saveOAuthApp(provider: string, clientId: string, clientSecret: string, userId: string): Promise<void> {
  await requireHostAccess(userId, "Connector OAuth app administration");
  await prisma.connectorApp.upsert({
    where: { provider },
    create: { provider, clientId, clientSecret: encrypt(clientSecret), updatedBy: userId },
    update: { clientId, clientSecret: encrypt(clientSecret), updatedBy: userId },
  });
}
