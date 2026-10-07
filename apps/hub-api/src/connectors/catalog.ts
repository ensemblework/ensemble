/**
 * The connector store with each person's state (GET /api/connectors/catalog):
 * the shared catalog from @ensemble/shared-types, plus whether this person is
 * connected, which products are on, how each sync source is doing, and the
 * state of any remote MCP connection.
 */
import { CONNECTOR_CATALOG, type ConnectorCatalogEntry, type Settings } from "@ensemble/shared-types";
import type { PrismaClient } from "@prisma/client";
import { loadSettings } from "../lib/settings.js";
import { isAccountProvider, oauthApp, type AccountProvider } from "./accounts.js";
import { listConnectors } from "./base.js";
import { OAUTH_PROVIDERS } from "./oauth.js";
import { productState, suiteById } from "./products.js";
import { missingScopes } from "./tokens.js";

export interface SourceState {
  enabled: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface ConnectorState {
  connected: boolean;
  account: string | null;
  /** False when the operator has not set up what this connector needs; the store says "Not set up on this server yet". */
  appReady: boolean;
  /** True when browser sign-in (Ensemble's own OAuth app) is available for this connector. */
  oauthReady: boolean;
  products: Record<string, boolean>;
  /** Products that are on but whose access was not approved yet. Connect again to approve them. */
  needsConsent: string[];
  sources: Record<string, SourceState>;
  mcp?: { status: "pending" | "connected" | "error" | "disabled"; toolCount: number; lastError: string | null };
}

export type CatalogEntryWithState = ConnectorCatalogEntry & { state: ConnectorState };

export function catalogEntries(): readonly ConnectorCatalogEntry[] {
  return CONNECTOR_CATALOG ?? [];
}

/** Sync sources an entry feeds: its products' sources, or the sources that sign in with its provider. */
export function entrySources(entry: Pick<ConnectorCatalogEntry, "id" | "provider" | "products">): string[] {
  const fromProducts = (entry.products ?? []).flatMap((product) => product.sources ?? []);
  const suite = suiteById(entry.id);
  const fromSuite = suite ? Object.values(suite.products).flatMap((product) => product.sources) : [];
  const fromProvider = entry.provider
    ? listConnectors()
        .filter((connector) => connector.account === entry.provider && connector.sync)
        .map((connector) => connector.id)
    : [];
  return [...new Set<string>([...fromProducts, ...fromSuite, ...fromProvider])];
}

/** Sync sources that sign in with this provider (settings.connections keys). */
export function providerSources(provider: AccountProvider): string[] {
  const ids = new Set<string>(
    listConnectors()
      .filter((connector) => connector.account === provider && connector.connect !== "builtin")
      .map((connector) => connector.id),
  );
  for (const entry of catalogEntries()) if (entry.provider === provider) for (const id of entrySources(entry)) ids.add(id);
  return [...ids];
}

export function entryProducts(entry: ConnectorCatalogEntry, settings: Pick<Settings, "connectorProducts">): Record<string, boolean> {
  const suite = suiteById(entry.id);
  if (suite) return productState(suite, settings);
  const saved = settings.connectorProducts?.[entry.id] ?? {};
  return Object.fromEntries((entry.products ?? []).map((product) => [product.id, saved[product.id] ?? product.defaultOn]));
}

interface UserView {
  settings: Settings;
  tokens: Map<string, { account: string | null; scopes: string[] }>;
  sync: Map<string, { lastSyncAt: Date | null; lastError: string | null }>;
  mcp: Map<string, { status: string; tools: unknown; lastError: string | null }>;
  apps: Map<string, Promise<boolean>>;
}

async function userView(prisma: PrismaClient, userId: string): Promise<UserView> {
  const [settings, tokens, sync, mcp] = await Promise.all([
    loadSettings(prisma, userId),
    prisma.authToken.findMany({ where: { userId }, select: { provider: true, account: true, scopes: true } }),
    prisma.syncState.findMany({ where: { userId }, select: { connector: true, lastSyncAt: true, lastError: true } }),
    prisma.mcpConnection
      .findMany({ where: { userId }, select: { serverId: true, status: true, tools: true, lastError: true } })
      .catch(() => [] as Array<{ serverId: string; status: string; tools: unknown; lastError: string | null }>),
  ]);
  return {
    settings,
    tokens: new Map(tokens.map((row) => [row.provider, { account: row.account, scopes: row.scopes }])),
    sync: new Map(sync.map((row) => [row.connector, { lastSyncAt: row.lastSyncAt, lastError: row.lastError }])),
    mcp: new Map(mcp.map((row) => [row.serverId, row])),
    apps: new Map(),
  };
}

function appConfigured(view: UserView, provider: string): Promise<boolean> {
  let pending = view.apps.get(provider);
  if (!pending) {
    pending = oauthApp(provider).then(Boolean, () => false);
    view.apps.set(provider, pending);
  }
  return pending;
}

const MCP_STATUSES = new Set(["pending", "connected", "error", "disabled"]);

async function stateFor(entry: ConnectorCatalogEntry, view: UserView): Promise<ConnectorState> {
  const provider = entry.provider && isAccountProvider(entry.provider) ? entry.provider : null;
  const token = provider ? view.tokens.get(provider) : undefined;
  const oauthReady =
    entry.status !== "soon" && entry.auth.includes("oauth") && provider !== null && OAUTH_PROVIDERS.includes(provider) && (await appConfigured(view, provider));
  const otherPath = entry.auth.some((kind) => kind === "token" || kind === "mcp" || kind === "file" || kind === "builtin");
  const products = entryProducts(entry, view.settings);
  const suite = suiteById(entry.id);
  const needsConsent =
    suite && token
      ? Object.entries(products)
          .filter(([id, on]) => on && missingScopes(token, suite.products[id]?.scopes ?? []).length > 0)
          .map(([id]) => id)
      : [];
  const sources = Object.fromEntries(
    entrySources(entry).map((id) => {
      const sync = view.sync.get(id);
      return [
        id,
        {
          enabled: view.settings.connections[id as keyof Settings["connections"]]?.enabled ?? false,
          lastSyncAt: sync?.lastSyncAt?.toISOString() ?? null,
          lastError: sync?.lastError ?? null,
        },
      ];
    }),
  );
  const state: ConnectorState = {
    connected: Boolean(token),
    account: token?.account ?? null,
    appReady: entry.status !== "soon" && (oauthReady || otherPath),
    oauthReady,
    products,
    needsConsent,
    sources,
  };
  if (entry.auth.includes("mcp")) {
    const row = view.mcp.get(entry.id);
    if (row) {
      state.mcp = {
        status: (MCP_STATUSES.has(row.status) ? row.status : "error") as NonNullable<ConnectorState["mcp"]>["status"],
        toolCount: Array.isArray(row.tools) ? row.tools.length : 0,
        lastError: row.lastError,
      };
    }
  }
  return state;
}

export async function catalogWithState(prisma: PrismaClient, userId: string): Promise<CatalogEntryWithState[]> {
  const view = await userView(prisma, userId);
  return Promise.all(catalogEntries().map(async (entry) => ({ ...entry, state: await stateFor(entry, view) })));
}

/** State for one store entry, e.g. after its products change. */
export async function entryState(prisma: PrismaClient, userId: string, entry: ConnectorCatalogEntry): Promise<ConnectorState> {
  return stateFor(entry, await userView(prisma, userId));
}

/** A store entry that is not in the shared catalog yet still needs a shape for the products route. */
export function syntheticEntry(id: string): ConnectorCatalogEntry | undefined {
  const suite = suiteById(id);
  if (!suite) return undefined;
  return { id, name: id, vendor: id, category: "suites", featured: false, logo: id, tagline: "", auth: ["oauth"], provider: suite.provider, reads: [], writes: [], status: "ready" };
}

