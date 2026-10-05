/**
 * Connecting sources from the browser: OAuth for Google and GitHub, pasted
 * tokens for GitHub, Slack and Linear, and the one-time OAuth app setup that
 * whoever runs the instance does once.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { oauthApp, removeAccount, saveAccount, saveOAuthApp, type AccountProvider } from "../connectors/accounts.js";
import { listConnectors } from "../connectors/base.js";
import { beginOAuth, finishOAuth, OAUTH_PROVIDERS, redirectUri } from "../connectors/oauth.js";
import { appendLedger } from "../lib/ledger.js";
import { saveSettings } from "../lib/settings.js";

const Provider = z.enum(["google", "github", "slack", "linear"]);

const APP_HELP: Record<string, { console: string; steps: string[] }> = {
  google: {
    console: "https://console.cloud.google.com/auth/audience",
    steps: [
      "This is once, for the person hosting Ensemble. Everyone else only presses Sign in with Google.",
      "Google Auth Platform → Branding: app name, and set the support email to your Gmail. Save. Do this before adding test users.",
      "Audience: External. Leave publishing status on Testing.",
      "Data Access → Add or remove scopes: Gmail (…/auth/gmail.readonly) and Google Calendar (…/auth/calendar.readonly). Enabling those APIs in the Library does not add the scopes.",
      "Clients → Create client → Web application. Paste the redirect URI below into Authorized redirect URIs, then copy the client ID and secret here.",
      "Audience → Test users → Add users: every Gmail that will press Sign in with Google, including yours. Save. While the app is in Testing, Google only lets those addresses through.",
    ],
  },
  github: {
    console: "https://github.com/settings/applications/new",
    steps: [
      "GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.",
      "Homepage URL: your Ensemble address. Authorization callback URL: the redirect URI below.",
      "Register, generate a client secret, and paste both here.",
    ],
  },
};

async function enableFor(userId: string, provider: AccountProvider, on: boolean): Promise<void> {
  const ids = listConnectors()
    .filter((connector) => connector.account === provider && connector.connect !== "later")
    .map((connector) => connector.id);
  await saveSettings(prisma(), userId, { connections: Object.fromEntries(ids.map((id) => [id, { enabled: on }])) });
}

let prismaRef: FastifyInstance["prisma"] | null = null;
const prisma = () => prismaRef!;

async function validateToken(provider: "github" | "slack" | "linear", token: string): Promise<string> {
  if (provider === "github") {
    const response = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, "User-Agent": "Ensemble" } });
    if (!response.ok) throw new Error(`GitHub rejected that token (${response.status}).`);
    return ((await response.json()) as { login: string }).login;
  }
  if (provider === "slack") {
    const response = await fetch("https://slack.com/api/auth.test", { headers: { Authorization: `Bearer ${token}` } });
    const body = (await response.json()) as { ok: boolean; error?: string; user?: string; team?: string };
    if (!body.ok) throw new Error(`Slack rejected that token (${body.error}).`);
    return `${body.user} @ ${body.team}`;
  }
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ query: "{ viewer { email } }" }),
  });
  const body = (await response.json()) as { data?: { viewer: { email: string } }; errors?: Array<{ message: string }> };
  if (!body.data) throw new Error(`Linear rejected that key (${body.errors?.[0]?.message ?? response.status}).`);
  return body.data.viewer.email;
}

export async function connectorRoutes(app: FastifyInstance): Promise<void> {
  prismaRef = app.prisma;

  app.get("/api/connectors/apps", async (request) => {
    const apps = await Promise.all(
      OAUTH_PROVIDERS.map(async (provider) => {
        const row = await oauthApp(provider);
        return {
          provider,
          configured: Boolean(row),
          source: row?.source ?? null,
          clientIdHint: row ? `${row.clientId.slice(0, 12)}…` : null,
          redirectUri: redirectUri(provider),
          console: APP_HELP[provider]?.console ?? null,
          steps: APP_HELP[provider]?.steps ?? [],
        };
      }),
    );
    return { apps, canEdit: request.userId === env.ENSEMBLE_DEV_USER_ID };
  });

  app.put("/api/connectors/apps/:provider", async (request, reply) => {
    const provider = z.enum(["google", "github"]).parse((request.params as { provider: string }).provider);
    if (request.userId !== env.ENSEMBLE_DEV_USER_ID) {
      return reply.code(403).send({ error: "Only the person who runs this Ensemble can set up sign-in apps." });
    }
    const body = z.object({ clientId: z.string().trim().min(8), clientSecret: z.string().trim().min(8) }).parse(request.body);
    await saveOAuthApp(provider, body.clientId, body.clientSecret, request.userId);
    await appendLedger({ userId: request.userId, actor: "me", action: "connector.app.save", payload: { provider } });
    return { ok: true };
  });

  app.get("/api/connectors/:provider/start", async (request) => {
    const provider = z.enum(["google", "github"]).parse((request.params as { provider: string }).provider);
    const { returnTo } = z.object({ returnTo: z.string().default("/settings#connections") }).parse(request.query);
    const safe = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/settings#connections";
    return { url: await beginOAuth(request.userId, provider, safe) };
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
    if (query.error || !query.code) {
      return back("/settings#connections", { connectError: query.error_description ?? query.error ?? "Sign-in was cancelled." });
    }
    try {
      const done = await finishOAuth(provider, query.code, query.state);
      await enableFor(done.userId, provider as AccountProvider, true);
      await appendLedger({ userId: done.userId, actor: "me", action: "connector.connect", payload: { provider, account: done.account } });
      return back(done.returnTo, { connected: provider });
    } catch (error) {
      return back("/settings#connections", { connectError: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/connectors/:provider/token", async (request, reply) => {
    const provider = z.enum(["github", "slack", "linear"]).parse((request.params as { provider: string }).provider);
    const body = z.object({ token: z.string().trim().min(10) }).parse(request.body);
    let account: string;
    try {
      account = await validateToken(provider, body.token);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    await saveAccount(request.userId, provider, { accessToken: body.token, account });
    await enableFor(request.userId, provider, true);
    await appendLedger({ userId: request.userId, actor: "me", action: "connector.connect", payload: { provider, account } });
    return { ok: true, account };
  });

  app.delete("/api/connectors/:provider", async (request, reply) => {
    const provider = Provider.parse((request.params as { provider: string }).provider);
    await removeAccount(request.userId, provider);
    await enableFor(request.userId, provider, false);
    await appendLedger({ userId: request.userId, actor: "me", action: "connector.disconnect", payload: { provider } });
    return reply.code(204).send();
  });
}
