/**
 * Per-user connector accounts (oauth_tokens) and instance-level OAuth apps.
 *
 * Tokens are encrypted at rest. A signed-in person's own account always wins;
 * env vars are the localhost-developer fallback, and GitHub can borrow
 * `gh auth token` as docs/01 §2.3 allows.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "../lib/prisma.js";
import { decrypt, encrypt } from "../lib/secrets.js";

const run = promisify(execFile);

export type AccountProvider = "google" | "github" | "slack" | "linear" | "microsoft";

export interface Account {
  provider: AccountProvider;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
  account: string | null;
  source: "you" | "env" | "cli";
}

const NEVER = new Date("2100-01-01T00:00:00Z");

export async function saveAccount(
  userId: string,
  provider: AccountProvider,
  data: { accessToken: string; refreshToken?: string | null; expiresAt?: Date; scopes?: string[]; account?: string | null },
): Promise<void> {
  const row = {
    accessToken: encrypt(data.accessToken),
    refreshToken: data.refreshToken ? encrypt(data.refreshToken) : null,
    expiresAt: data.expiresAt ?? NEVER,
    scopes: data.scopes ?? [],
    account: data.account ?? null,
  };
  await prisma.authToken.upsert({
    where: { userId_provider: { userId, provider } },
    create: { userId, provider, ...row },
    update: {
      ...row,
      // Google only returns a refresh token on the first consent; keep the old one.
      refreshToken: row.refreshToken ?? undefined,
    },
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
        source: "you",
      };
    }
  }
  if (!allowFallback) return null;
  for (const name of ENV_FALLBACK[provider] ?? []) {
    const value = process.env[name]?.trim();
    if (value) return { provider, accessToken: value, refreshToken: null, expiresAt: NEVER, scopes: [], account: null, source: "env" };
  }
  if (provider === "github" && allowCli) {
    const token = await ghToken();
    if (token) return { provider, accessToken: token, refreshToken: null, expiresAt: NEVER, scopes: [], account: null, source: "cli" };
  }
  return null;
}

// ── instance OAuth apps ─────────────────────────────────────────────────────

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
  source: "env" | "settings";
}

const APP_ENV: Record<string, [string, string]> = {
  google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  github: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
};

export async function oauthApp(provider: string): Promise<OAuthApp | null> {
  const names = APP_ENV[provider];
  if (names) {
    const [id, secret] = names.map((name) => process.env[name]?.trim() ?? "");
    if (id && secret) return { clientId: id, clientSecret: secret, source: "env" };
  }
  const row = await prisma.connectorApp.findUnique({ where: { provider } });
  if (!row) return null;
  const clientSecret = readSecret(row.clientSecret);
  if (!clientSecret) return null;
  return { clientId: row.clientId, clientSecret, source: "settings" };
}

export async function saveOAuthApp(provider: string, clientId: string, clientSecret: string, userId: string): Promise<void> {
  await prisma.connectorApp.upsert({
    where: { provider },
    create: { provider, clientId, clientSecret: encrypt(clientSecret), updatedBy: userId },
    update: { clientId, clientSecret: encrypt(clientSecret), updatedBy: userId },
  });
}
