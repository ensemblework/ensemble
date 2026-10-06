/**
 * Model credentials. The Python runtime read Postgres with psycopg.
 * This path uses hub-api's Prisma client and the shared v1: AES-GCM secret.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "../lib/prisma.js";
import { decrypt, encrypt } from "../lib/secrets.js";
import { DecryptError } from "./errors.js";
import { canUseHostCredentials, requireHostAccess, requireVerifiedUser } from "../lib/hosted-access.js";

const execFileAsync = promisify(execFile);

export const PROVIDERS = [
  "google",
  "openai",
  "anthropic",
  "mistral",
  "kimi",
  "qwen",
  "openrouter",
  "copilot",
  "cursor",
  "ollama",
] as const;

export type ProviderName = (typeof PROVIDERS)[number];

const ENV_KEYS: Record<string, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  kimi: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
  qwen: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"],
  copilot: ["COPILOT_API_KEY", "GITHUB_TOKEN"],
  cursor: ["CURSOR_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  ollama: [],
};

export interface Credential {
  provider: string;
  secret: string;
  source: "you" | "env" | "cli" | "none";
  baseUrl: string | null;
}

export function hint(secret: string): string {
  return secret.length > 8 ? `…${secret.slice(-4)}` : "set";
}

interface Stored {
  secret: string;
  baseUrl: string | null;
}

interface Listed {
  provider: string;
  hint: string;
  updatedAt: Date;
}

export interface CredentialStore {
  read(userId: string, provider: string): Promise<Stored | null>;
  list(userId: string): Promise<Listed[]>;
  upsert(userId: string, provider: string, secret: string, keyHint: string, baseUrl: string | null): Promise<void>;
  remove(userId: string, provider: string): Promise<void>;
}

function prismaStore(): CredentialStore {
  return {
    async read(userId, provider) {
      const row = await prisma.modelCredential.findUnique({ where: { userId_provider: { userId, provider } } });
      if (!row) return null;
      return { secret: row.secret, baseUrl: row.baseUrl };
    },
    async list(userId) {
      const rows = await prisma.modelCredential.findMany({ where: { userId } });
      return rows.map((row) => ({ provider: row.provider, hint: row.hint, updatedAt: row.updatedAt }));
    },
    async upsert(userId, provider, secret, keyHint, baseUrl) {
      await prisma.modelCredential.upsert({
        where: { userId_provider: { userId, provider } },
        create: { userId, provider, secret, hint: keyHint, baseUrl },
        update: { secret, hint: keyHint, baseUrl, updatedAt: new Date() },
      });
    },
    async remove(userId, provider) {
      await prisma.modelCredential.deleteMany({ where: { userId, provider } });
    },
  };
}

let storeImpl: CredentialStore = prismaStore();
let resolveOverride: ((userId: string | null | undefined, provider: string) => Promise<Credential>) | null = null;

export function setCredentialStoreForTests(store: CredentialStore | null): void {
  storeImpl = store ?? prismaStore();
}

export function setCredentialResolverForTests(
  resolve: ((userId: string | null | undefined, provider: string) => Promise<Credential>) | null,
): void {
  resolveOverride = resolve;
}

async function stored(userId: string, provider: string): Promise<[string, string | null] | null> {
  const row = await storeImpl.read(userId, provider);
  if (!row) return null;
  try {
    return [decrypt(row.secret), row.baseUrl];
  } catch (error) {
    throw new DecryptError();
  }
}

async function ghToken(): Promise<string | null> {
  try {
    const result = await execFileAsync("gh", ["auth", "token"], { timeout: 10_000 });
    const token = result.stdout.trim();
    return token || null;
  } catch {
    return null;
  }
}

export async function resolveCredential(userId: string | null | undefined, provider: string): Promise<Credential> {
  await requireVerifiedUser(userId);
  if (resolveOverride) return resolveOverride(userId, provider);
  if (provider === "mock") return { provider, secret: "mock", source: "you", baseUrl: null };
  if (userId) {
    const found = await stored(userId, provider);
    if (found) {
      if (found[1]) await requireHostAccess(userId, "Custom model proxies");
      return { provider, secret: found[0], source: "you", baseUrl: found[1] };
    }
  }
  if (!(await canUseHostCredentials(userId))) return { provider, secret: "", source: "none", baseUrl: null };
  for (const name of ENV_KEYS[provider] ?? []) {
    const value = (process.env[name] ?? "").trim();
    if (value) return { provider, secret: value, source: "env", baseUrl: null };
  }
  if (provider === "copilot") {
    const token = await ghToken();
    if (token) return { provider, secret: token, source: "cli", baseUrl: null };
  }
  return { provider, secret: "", source: "none", baseUrl: null };
}

export async function saveCredential(userId: string, provider: string, secret: string, baseUrl?: string | null): Promise<void> {
  if (baseUrl) await requireHostAccess(userId, "Custom model proxies");
  await storeImpl.upsert(userId, provider, encrypt(secret), hint(secret), baseUrl ?? null);
}

export async function removeCredential(userId: string, provider: string): Promise<void> {
  await storeImpl.remove(userId, provider);
}

export async function listCredentials(userId: string): Promise<Array<Record<string, unknown>>> {
  const rows = new Map<string, Listed>();
  for (const row of await storeImpl.list(userId)) rows.set(row.provider, row);
  const allowHostKeys = await canUseHostCredentials(userId);
  const out: Array<Record<string, unknown>> = [];
  for (const provider of PROVIDERS) {
    const row = rows.get(provider);
    if (row) {
      out.push({ provider, source: "you", hint: row.hint, updatedAt: row.updatedAt.toISOString() });
      continue;
    }
    const env = allowHostKeys ? (ENV_KEYS[provider] ?? []).find((name) => (process.env[name] ?? "").trim()) : undefined;
    out.push({ provider, source: env ? "env" : "none", hint: env ?? null, updatedAt: null });
  }
  return out;
}

export function isProvider(value: string): boolean {
  return (PROVIDERS as readonly string[]).includes(value);
}
