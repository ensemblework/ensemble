/**
 * Connecting apps from the browser: the connector store with each person's
 * state, OAuth sign-in with per-product scopes, pasted tokens, disconnect,
 * and the one-time OAuth app setup that whoever runs the instance does once.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { catalogEntry } from "@ensemble/shared-types";
import { env } from "../config.js";
import { HostedAccessError, isHosted, isOperatorUser, requireHostAccess, requireVerifiedUser } from "../lib/hosted-access.js";
import { ACCOUNT_PROVIDERS, getAccount, oauthApp, removeAccount, saveAccount, saveOAuthApp, type AccountProvider } from "../connectors/accounts.js";
import { listConnectors } from "../connectors/base.js";
import { catalogWithState, entryState, providerSources, syntheticEntry } from "../connectors/catalog.js";
import { deleteSourceData } from "../connectors/forget.js";
import {
  beginOAuth,
  CONNECT_FLOW_SECONDS,
  connectCookieHeader,
  connectCookieName,
  finishOAuth,
  googleScopedToken,
  newBrowserNonce,
  OAUTH_PROVIDERS,
  pendingReturnTo,
  providerLabel,
  redirectUri,
  revokeAtProvider,
} from "../connectors/oauth.js";
import { appendCookie, readCookie } from "../lib/auth.js";
import { GOOGLE_PRODUCT_SCOPES, productState, sourceToggles, suiteById, suiteForProvider, type SuiteSpec } from "../connectors/products.js";
import { TOKEN_PROVIDERS, TokenBody, TokenRejectedError, validateToken } from "../connectors/token-providers.js";
import { missingScopes } from "../connectors/tokens.js";
import { appendLedger } from "../lib/ledger.js";
import { loadSettings, saveSettings } from "../lib/settings.js";

const OAuthProvider = z.enum(OAUTH_PROVIDERS as [AccountProvider, ...AccountProvider[]]);
const TokenProvider = z.enum(TOKEN_PROVIDERS);
const AnyProvider = z.enum(ACCOUNT_PROVIDERS);

const DEFAULT_RETURN = "/settings#connections";

const safeReturn = (value: string | undefined, fallback = DEFAULT_RETURN): string =>
  value && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : fallback;

const APP_HELP: Partial<Record<AccountProvider, { console: string; steps: string[] }>> = {
  google: {
    console: "https://console.cloud.google.com/auth/clients",
    steps: [
      "This is once, for the person hosting Ensemble. Everyone else only presses Connect. The sign-in client (AUTH_GOOGLE_CLIENT_ID) works too: add the redirect URI below to it.",
      "APIs & Services → Library: enable the Gmail API, Google Calendar API, Google Drive API, Google Docs API, Google Sheets API, Google Slides API and Google Picker API.",
      "Google Auth Platform → Data Access → Add or remove scopes: gmail.readonly, calendar.events, calendar.calendarlist.readonly and drive.file. Add drive.readonly only if you want Search all of Drive.",
      "Clients → Create client → Web application. Paste the redirect URI below into Authorized redirect URIs, then copy the client ID and secret here.",
      "While the app is in Testing, add every Google account that will connect under Audience → Test users. Public use of gmail.readonly and drive.readonly needs Google's verification and security assessment.",
    ],
  },
  microsoft: {
    console: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    steps: [
      "Entra admin center → App registrations → New registration. Supported account types: any organizational directory and personal Microsoft accounts. The sign-in app (AUTH_MICROSOFT_CLIENT_ID) works too.",
      "Authentication → Add a platform → Web, and add the redirect URI below.",
      "API permissions → Microsoft Graph → Delegated: User.Read, offline_access, Mail.Read, Calendars.ReadWrite, Chat.Read, Files.Read, Files.ReadWrite.",
      "Certificates & secrets → New client secret. Paste the Application (client) ID and the secret value here.",
    ],
  },
  github: {
    console: "https://github.com/settings/applications/new",
    steps: [
      "GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.",
      "Homepage URL: your Ensemble address. Authorization callback URL: the redirect URI below. To share the sign-in app (AUTH_GITHUB_CLIENT_ID), set its callback to your API origin followed by /api so both callbacks sit under it.",
      "Register, generate a client secret, and paste both here.",
    ],
  },
  linear: {
    console: "https://linear.app/settings/api/applications/new",
    steps: ["Linear → Settings → API → OAuth applications → New.", "Callback URL: the redirect URI below. Scope: read.", "Paste the client ID and secret here."],
  },
  notion: {
    console: "https://www.notion.so/profile/integrations",
    steps: ["Notion → Integrations → New integration → Public.", "Redirect URI: the redirect URI below. Capabilities: read content.", "Paste the OAuth client ID and secret here."],
  },
  atlassian: {
    console: "https://developer.atlassian.com/console/myapps/",
    steps: [
      "Atlassian developer console → Create → OAuth 2.0 integration.",
      "Permissions → Jira API: read:jira-work and read:jira-user.",
      "Authorization → OAuth 2.0 (3LO): the redirect URI below. Paste the client ID and secret here.",
    ],
  },
  slack: {
    console: "https://api.slack.com/apps",
    steps: [
      "Slack API → Create New App → From scratch.",
      "OAuth & Permissions → Redirect URLs: the redirect URI below. User Token Scopes: channels:history, groups:history, im:history, mpim:history, users:read, users:read.email.",
      "Turn on public distribution under Manage Distribution, then paste the client ID and secret here.",
    ],
  },
  zoom: {
    console: "https://marketplace.zoom.us/develop/create",
    steps: [
      "Zoom App Marketplace → Develop → Build App → General App, user-managed.",
      "Redirect URL and allow list: the redirect URI below. Scopes: user:read:user, meeting:read:list_meetings, cloud_recording:read:list_user_recordings, cloud_recording:read:meeting_transcript.",
      "Paste the client ID and secret here. Other Zoom accounts can connect after the app passes Marketplace review.",
    ],
  },
  docusign: {
    console: "https://admindemo.docusign.com/apps-and-keys",
    steps: [
      "Docusign → Apps and Keys → Add App and Integration Key. Authentication: Authorization Code Grant, with a secret key.",
      "Redirect URI: the redirect URI below. Set DOCUSIGN_ENV=production after the key passes go-live review.",
      "Paste the integration key and secret here.",
    ],
  },
};

let prismaRef: FastifyInstance["prisma"] | null = null;
const prisma = () => prismaRef!;

/** Switches every sync source that signs in with this provider on or off. */
async function enableFor(userId: string, provider: AccountProvider, on: boolean): Promise<void> {
  const ids = listConnectors()
    .filter((connector) => connector.account === provider && connector.connect !== "later" && connector.sync)
    .map((connector) => connector.id);
  if (!ids.length) return;
  await saveSettings(prisma(), userId, { connections: Object.fromEntries(ids.map((id) => [id, { enabled: on }])) });
}

/** Saves product toggles; when connected, their sync sources follow them. */
async function saveProducts(userId: string, suite: SuiteSpec, products: Record<string, boolean>, connected: boolean): Promise<void> {
  const patch: Record<string, unknown> = { connectorProducts: { [suite.id]: products } };
  if (connected) {
    patch.connections = Object.fromEntries(Object.entries(sourceToggles(suite, products)).map(([id, on]) => [id, { enabled: on }]));
  }
  await saveSettings(prisma(), userId, patch);
}

export async function connectorRoutes(app: FastifyInstance): Promise<void> {
  prismaRef = app.prisma;

  app.get("/api/connectors/catalog", async (request) => ({ entries: await catalogWithState(app.prisma, request.userId) }));

  app.get("/api/connectors/apps", async (request) => {
    const apps = await Promise.all(
      OAUTH_PROVIDERS.map(async (provider) => {
        const row = await oauthApp(provider);
        return {
          provider,
          label: providerLabel(provider),
          configured: Boolean(row),
          source: row?.source ?? null,
          clientIdHint: row ? `${row.clientId.slice(0, 12)}…` : null,
          redirectUri: redirectUri(provider),
          console: APP_HELP[provider]?.console ?? null,
          steps: APP_HELP[provider]?.steps ?? [],
        };
      }),
    );
    return { apps, canEdit: isHosted() ? await isOperatorUser(request.userId) : request.userId === env.ENSEMBLE_DEV_USER_ID };
  });

  app.put("/api/connectors/apps/:provider", async (request, reply) => {
    const provider = OAuthProvider.parse((request.params as { provider: string }).provider);
    if (isHosted()) await requireHostAccess(request.userId, "Connector OAuth app administration");
    else if (request.userId !== env.ENSEMBLE_DEV_USER_ID) {
      return reply.code(403).send({ error: "Only the person who runs this Ensemble can set up sign-in apps." });
    }
    const body = z.object({ clientId: z.string().trim().min(8), clientSecret: z.string().trim().min(8) }).parse(request.body);
    await saveOAuthApp(provider, body.clientId, body.clientSecret, request.userId);
    await appendLedger({ userId: request.userId, actor: "me", action: "connector.app.save", payload: { provider } });
    return { ok: true };
  });

  app.get("/api/connectors/google/picker", async (request, reply) => {
    await requireVerifiedUser(request.userId);
    const apiKey = process.env.GOOGLE_PICKER_API_KEY?.trim();
    const appId = process.env.GOOGLE_PROJECT_NUMBER?.trim();
    if (!apiKey || !appId) return reply.code(409).send({ error: "Picking Google Drive files is not set up on this server yet." });
    // The browser only ever gets a token narrowed to drive.file, never the stored grant with Gmail or Calendar.
    const accessToken = await googleScopedToken(request.userId, GOOGLE_PRODUCT_SCOPES.drive_docs);
    return { apiKey, appId, accessToken, origin: env.HUB_WEB_ORIGIN };
  });

  app.get("/api/connectors/:provider/start", async (request, reply) => {
    const provider = OAuthProvider.parse((request.params as { provider: string }).provider);
    const query = z.object({ returnTo: z.string().max(2000).optional(), products: z.string().max(500).optional() }).parse(request.query);
    const suite = suiteForProvider(provider);
    let products: Record<string, boolean> | undefined;
    if (suite && query.products !== undefined) {
      const chosen = query.products.split(",").map((id) => id.trim()).filter(Boolean);
      const unknown = chosen.filter((id) => !(id in suite.products));
      if (unknown.length) throw Object.assign(new Error(`Unknown product: ${unknown.join(", ")}.`), { statusCode: 400 });
      if (!chosen.length) throw Object.assign(new Error("Switch on at least one product."), { statusCode: 400 });
      products = Object.fromEntries(Object.keys(suite.products).map((id) => [id, chosen.includes(id)]));
    }
    const nonce = newBrowserNonce();
    const url = await beginOAuth(request.userId, provider, safeReturn(query.returnTo), products, nonce);
    appendCookie(reply, connectCookieHeader(provider, nonce, CONNECT_FLOW_SECONDS, request));
    return { url };
  });

  app.get("/api/connectors/:provider/callback", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const query = z
      .object({ code: z.string().optional(), state: z.string().default(""), error: z.string().optional(), error_description: z.string().optional() })
      .parse(request.query);
    const back = (path: string, params: Record<string, string>) => {
      const [base, hash] = path.split("#");
      const joiner = base!.includes("?") ? "&" : "?";
      return reply.redirect(`${env.HUB_WEB_ORIGIN}${base}${joiner}${new URLSearchParams(params)}${hash ? `#${hash}` : ""}`);
    };
    const returnTo = pendingReturnTo(query.state) ?? DEFAULT_RETURN;
    const nonce = readCookie(request, connectCookieName(provider));
    if (nonce) appendCookie(reply, connectCookieHeader(provider, "", 0, request));
    if (query.error || !query.code) {
      return back(returnTo, { connectError: (query.error_description ?? query.error ?? "Sign-in was cancelled.").slice(0, 300) });
    }
    try {
      const done = await finishOAuth(provider, query.code, query.state, {
        userId: request.authVia === "session" ? request.userId : null,
        nonce,
      });
      const suite = suiteForProvider(done.provider);
      if (suite && done.products) {
        // Google lets people untick a permission on the consent screen; only what was granted is switched on.
        const granted = Object.fromEntries(
          Object.entries(done.products).map(([id, on]) => [id, on && missingScopes({ scopes: done.scopes }, suite.products[id]?.scopes ?? []).length === 0]),
        );
        await saveProducts(done.userId, suite, granted, true);
      } else {
        await enableFor(done.userId, done.provider, true);
      }
      await appendLedger({ userId: done.userId, actor: "me", action: "connector.connect", payload: { provider: done.provider, account: done.account, via: "oauth" } });
      return back(done.returnTo, { connected: done.provider });
    } catch (error) {
      if (error instanceof HostedAccessError) throw error;
      return back(returnTo, { connectError: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
    }
  });

  app.put("/api/connectors/:id/products", async (request, reply) => {
    await requireVerifiedUser(request.userId);
    const { id } = request.params as { id: string };
    const entry = catalogEntry(id) ?? syntheticEntry(id);
    const suite = suiteById(id);
    if (!entry || (!suite && !entry.products?.length)) return reply.code(404).send({ error: "That connector has no products to switch." });
    const body = z
      .object({ products: z.record(z.string(), z.boolean()), returnTo: z.string().max(2000).optional() })
      .strict()
      .parse(request.body);
    const known = suite ? Object.keys(suite.products) : entry.products!.map((product) => product.id);
    const unknown = Object.keys(body.products).filter((product) => !known.includes(product));
    if (unknown.length) return reply.code(400).send({ error: `Unknown product: ${unknown.join(", ")}.` });
    if (!suite) {
      await saveSettings(app.prisma, request.userId, { connectorProducts: { [id]: body.products } });
      return entryState(app.prisma, request.userId, entry);
    }
    const settings = await loadSettings(app.prisma, request.userId);
    const next = { ...productState(suite, settings), ...body.products };
    const account = await getAccount(request.userId, suite.provider, false, false);
    const needs = account ? Object.keys(next).filter((product) => next[product] && missingScopes(account, suite.products[product]!.scopes).length > 0) : [];
    if (account && needs.length) {
      // Switching off takes effect now. Products that need new access are saved when the person approves them.
      const now = Object.fromEntries(Object.entries(next).map(([product, on]) => [product, on && !needs.includes(product)]));
      await saveProducts(request.userId, suite, now, true);
      const returnTo = safeReturn(body.returnTo, `/settings?tab=connections&connector=${encodeURIComponent(id)}`);
      const nonce = newBrowserNonce();
      const url = await beginOAuth(request.userId, suite.provider, returnTo, next, nonce);
      appendCookie(reply, connectCookieHeader(suite.provider, nonce, CONNECT_FLOW_SECONDS, request));
      return { reconnect: true, url, needs, state: await entryState(app.prisma, request.userId, entry) };
    }
    await saveProducts(request.userId, suite, next, Boolean(account));
    await appendLedger({ userId: request.userId, actor: "me", action: "connector.products", payload: { connector: id, products: next } });
    return entryState(app.prisma, request.userId, entry);
  });

  app.post("/api/connectors/:provider/token", async (request, reply) => {
    await requireVerifiedUser(request.userId);
    const provider = TokenProvider.parse((request.params as { provider: string }).provider);
    const body = TokenBody.parse(request.body);
    let validated;
    try {
      validated = await validateToken(provider, body);
    } catch (error) {
      if (error instanceof TokenRejectedError) return reply.code(400).send({ error: error.message });
      throw error;
    }
    await saveAccount(request.userId, provider, { accessToken: validated.secret, account: validated.account, meta: validated.meta, scopes: [] });
    await enableFor(request.userId, provider, true);
    await appendLedger({ userId: request.userId, actor: "me", action: "connector.connect", payload: { provider, account: validated.account, via: "token" } });
    return { ok: true, account: validated.account };
  });

  app.delete("/api/connectors/:provider", async (request) => {
    const provider = AnyProvider.parse((request.params as { provider: string }).provider);
    const { deleteData } = z.object({ deleteData: z.enum(["0", "1", "true", "false"]).optional() }).parse(request.query);
    const userId = request.userId;
    const account = await getAccount(userId, provider, false, false);
    const revoked = account ? await revokeAtProvider(account) : false;
    await removeAccount(userId, provider);
    const sources = providerSources(provider);
    const settings = await loadSettings(app.prisma, userId);
    const on = sources.filter((id) => settings.connections[id as keyof typeof settings.connections]?.enabled);
    if (on.length) await saveSettings(app.prisma, userId, { connections: Object.fromEntries(on.map((id) => [id, { enabled: false }])) });
    const deleted = deleteData === "1" || deleteData === "true" ? await deleteSourceData(app.prisma, userId, sources) : 0;
    await appendLedger({ userId, actor: "me", action: "connector.disconnect", payload: { provider, revoked, deletedArtifacts: deleted } });
    return { ok: true, revoked, deleted };
  });
}
