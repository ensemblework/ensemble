/**
 * The desktop app's account switch (docs/DESKTOP.md §1): first-run choice between local-only and an
 * Ensemble account, the browser sign-in that signs the app's window in and pairs this computer, and
 * the one-time move of local-only data into the account. Reached only with the launch token on loopback;
 * the app's own start page and the bundled Hub call it.
 */
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { appendLedger } from "../lib/ledger.js";
import { hostedClient } from "../remote/client.js";
import { enableRemote, pairComputer, unpairComputer } from "../remote/routes.js";
import { readDeviceToken, loadSettings } from "../remote/store.js";
import { localDataCounts, sendLocalData, type TransferProgress } from "../transfer/export.js";
import { readMode, writeMode, type RuntimeMode } from "./mode.js";

export const DEFAULT_ACCOUNT_API = "https://api.ensemblework.com";

type SignIn = {
  state: "idle" | "waiting" | "moving" | "pairing" | "done" | "error";
  userCode?: string;
  url?: string;
  move: boolean;
  progress?: TransferProgress;
  error?: string;
  notes?: string[];
  account?: { email: string | null; name: string | null };
  startedAt?: string;
};

let current: SignIn = { state: "idle", move: false };
let handoff: string | null = null;
let abort: AbortController | null = null;

const StartResponse = z.object({ deviceCode: z.string(), userCode: z.string(), verificationUriComplete: z.string().url(), interval: z.number(), expiresIn: z.number() });
const TokenResponse = z.object({
  apiBase: z.string().optional(),
  appUrl: z.string().optional(),
  account: z.object({ email: z.string().nullable(), name: z.string().nullable() }).nullable().optional(),
  accountId: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  pairingCode: z.string().optional(),
  webHandoff: z.string().optional(),
  transferToken: z.string().optional(),
});

function cleanBase(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) throw new Error("Use an https Ensemble address.");
  return url.origin;
}

async function postJson(url: string, body: unknown, signal: AbortSignal): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: text.slice(0, 200) };
  }
  return { status: response.status, body: parsed };
}

function errorText(body: unknown, fallback: string): string {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const value = record.error ?? record.message;
  return typeof value === "string" && value.trim() ? value : fallback;
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done, fail) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      fail(new Error("cancelled"));
    }, { once: true });
  });

async function hasLocalData(app: FastifyInstance): Promise<boolean> {
  const counts = await localDataCounts(app.prisma, env.ENSEMBLE_DEV_USER_ID).catch(() => ({}) as Record<string, number>);
  return Object.values(counts).some((value) => value > 0);
}

async function accountState(app: FastifyInstance) {
  const mode = readMode();
  const settings = loadSettings();
  const paired = Boolean((await readDeviceToken()) && settings.pairedAt);
  const local = mode.mode === "account" ? null : await localDataCounts(app.prisma, env.ENSEMBLE_DEV_USER_ID).catch(() => null);
  return {
    mode: mode.mode,
    switchedAt: mode.switchedAt ?? null,
    appUrl: mode.appUrl ?? null,
    accountEmail: mode.accountEmail ?? null,
    moved: mode.moved ?? null,
    paired,
    pairedApi: paired ? settings.apiBase : null,
    deviceName: settings.deviceName,
    local,
    /** The first choice is still open: nothing chosen yet. */
    canChooseLocal: mode.mode === null,
    signIn: { ...current, ready: Boolean(handoff) },
  };
}

/** After the browser approves: move the data (when asked), remember the account, pair, and leave the window a sign-in link. */
async function finishSignIn(app: FastifyInstance, base: string, token: z.infer<typeof TokenResponse>, signal: AbortSignal): Promise<void> {
  const previous = readMode();
  const approved = token.scopes ?? [];
  // Approved without running tasks (an unverified email): the move needs a verified account too. Nothing changes here yet.
  if (previous.mode !== "account" && current.move && !token.transferToken && !approved.includes("runner")) {
    throw new Error("Verify your email in Ensemble first, then move this computer again. Nothing has changed here.");
  }
  const apiBase = token.apiBase ? cleanBase(token.apiBase) : base;
  const appUrl = cleanBase(token.appUrl || apiBase.replace("://api.", "://app."));
  let moved: RuntimeMode["moved"] = previous.moved;
  if (token.transferToken) {
    current = { ...current, state: "moving", progress: { sent: 0, counts: {}, notes: [] } };
    const result = await sendLocalData({
      db: app.prisma,
      userId: env.ENSEMBLE_DEV_USER_ID,
      apiBase,
      token: token.transferToken,
      onProgress: (progress) => {
        current = { ...current, progress };
      },
    });
    if (signal.aborted) throw new Error("cancelled");
    const totals = Object.values(result.counts).reduce((sum, row) => ({ added: sum.added + row.added, merged: sum.merged + row.merged, skipped: sum.skipped + row.skipped }), { added: 0, merged: 0, skipped: 0 });
    moved = { ...totals, notes: result.notes };
    current = { ...current, notes: result.notes };
  }
  const email = token.account?.email ?? null;
  writeMode({
    mode: "account",
    chosenAt: previous.chosenAt ?? new Date().toISOString(),
    ...(previous.mode === "local" ? { switchedAt: new Date().toISOString() } : previous.switchedAt ? { switchedAt: previous.switchedAt } : {}),
    appUrl,
    apiBase,
    ...(email ? { accountEmail: email } : {}),
    ...(moved ? { moved } : {}),
  });
  if (!token.pairingCode && !approved.includes("runner")) {
    current = { ...current, notes: [...(current.notes ?? []), "This computer is not running tasks for your account yet. Verify your email, then sign in again from the app."] };
  }
  if (token.pairingCode) {
    current = { ...current, state: "pairing" };
    const settings = loadSettings();
    const deviceToken = await readDeviceToken();
    const paired = Boolean(deviceToken && settings.pairedAt);
    let sameAccount = !previous.accountEmail || !email || previous.accountEmail.toLowerCase() === email.toLowerCase();
    if (paired && deviceToken && settings.apiBase === apiBase && token.accountId) {
      const owner = await hostedClient(apiBase, deviceToken).owner?.().catch(() => null);
      if (owner) sameAccount = owner === token.accountId;
    }
    try {
      if (paired && settings.apiBase === apiBase && sameAccount) {
        // The CLI runner (same data folder) or an earlier sign-in already paired this computer with this account: it is the same device.
      } else {
        if (paired) await unpairComputer(app, app.log);
        await pairComputer(app, { apiBase, code: token.pairingCode, name: settings.deviceName || hostname() });
      }
      enableRemote();
    } catch (error) {
      app.log.warn({ err: error }, "desktop sign-in could not pair this computer");
      current = { ...current, notes: [...(current.notes ?? []), "This computer could not be connected for tasks. Open Settings → Account → This computer to try again."] };
    }
  }
  await appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "me", action: "desktop.account", payload: { apiBase, moved: Boolean(token.transferToken), switched: previous.mode === "local" } });
  handoff = token.webHandoff ? `${appUrl}/api/auth/handoff?code=${encodeURIComponent(token.webHandoff)}&to=${encodeURIComponent("/today")}` : `${appUrl}/today`;
  current = { ...current, state: "done", account: token.account ?? undefined };
}

async function runSignIn(app: FastifyInstance, base: string, scopes: string[], signal: AbortSignal): Promise<void> {
  try {
    const started = await postJson(`${base}/api/cli/auth/start`, { clientName: (loadSettings().deviceName || hostname() || "this computer").slice(0, 80), platform: process.platform, version: process.env.ENSEMBLE_APP_VERSION ?? "", scopes }, signal);
    if (started.status !== 200) throw new Error(errorText(started.body, "Ensemble did not start the sign-in. Try again in a moment."));
    const flow = StartResponse.parse(started.body);
    current = { ...current, state: "waiting", userCode: flow.userCode, url: flow.verificationUriComplete };
    const deadline = Date.now() + flow.expiresIn * 1000;
    let interval = Math.max(2, flow.interval) * 1000;
    while (Date.now() < deadline) {
      await wait(interval, signal);
      const polled = await postJson(`${base}/api/cli/auth/token`, { deviceCode: flow.deviceCode }, signal).catch(() => ({ status: 0, body: null }));
      if (polled.status === 200) {
        await finishSignIn(app, base, TokenResponse.parse(polled.body), signal);
        return;
      }
      const code = errorText(polled.body, "");
      if (code === "slow_down") interval += 2000;
      else if (code === "access_denied") throw new Error("The sign-in was denied in the browser.");
      else if (code === "expired_token") throw new Error("The sign-in code expired. Start again.");
    }
    throw new Error("The sign-in code expired. Start again.");
  } catch (error) {
    if (signal.aborted) {
      current = { state: "idle", move: false };
      return;
    }
    app.log.warn({ err: error }, "desktop sign-in failed");
    current = { ...current, state: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function desktopAccountRoutes(app: FastifyInstance): Promise<void> {
  const requireApp = (via: string | undefined) => {
    if (via !== "desktop") throw Object.assign(new Error("Only the Ensemble app on this computer can change how it uses Ensemble."), { statusCode: 403 });
  };

  app.get("/api/desktop/account", async (request) => {
    requireApp(request.authVia);
    return accountState(app);
  });

  /** The first choice: keep everything on this computer. Never available after choosing an account. */
  app.post("/api/desktop/mode", async (request, reply) => {
    requireApp(request.authVia);
    z.object({ mode: z.literal("local") }).parse(request.body);
    const mode = readMode();
    if (mode.mode === "account") return reply.code(409).send({ error: "This computer already uses your Ensemble account. That cannot be undone here." });
    if (mode.mode !== "local") {
      if ((await readDeviceToken()) && loadSettings().pairedAt) await unpairComputer(app, request.log);
      writeMode({ mode: "local", chosenAt: new Date().toISOString() });
      await appendLedger({ userId: env.ENSEMBLE_DEV_USER_ID, actor: "me", action: "desktop.local_only", payload: {} });
    }
    return accountState(app);
  });

  app.post("/api/desktop/account/sign-in", async (request, reply) => {
    requireApp(request.authVia);
    const body = z.object({ move: z.boolean().default(true), apiBase: z.string().max(300).optional() }).parse(request.body ?? {});
    if (["waiting", "moving", "pairing"].includes(current.state)) return accountState(app);
    const settings = loadSettings();
    // A computer the CLI already paired signs in to that same server.
    const pairedBase = (await readDeviceToken()) && settings.pairedAt ? settings.apiBase : null;
    let base: string;
    try {
      base = cleanBase(body.apiBase?.trim() || readMode().apiBase || pairedBase || process.env.ENSEMBLE_ACCOUNT_API?.trim() || DEFAULT_ACCOUNT_API);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Use an https Ensemble address." });
    }
    const mode = readMode();
    const move = body.move && mode.mode !== "account" && (await hasLocalData(app));
    // Runner every time: the account signing in may not be the one this computer is paired with (finishSignIn keeps a matching pairing).
    const scopes = ["web", "runner", ...(move ? ["transfer"] : [])];
    abort?.abort();
    abort = new AbortController();
    handoff = null;
    current = { state: "waiting", move, startedAt: new Date().toISOString() };
    void runSignIn(app, base, scopes, abort.signal);
    // The start call is quick; answer once the code is known so the page can show it.
    for (let tries = 0; tries < 40 && current.state === "waiting" && !current.userCode; tries += 1) await new Promise((done) => setTimeout(done, 150));
    return accountState(app);
  });

  app.post("/api/desktop/account/cancel", async (request) => {
    requireApp(request.authVia);
    if (current.state !== "moving") {
      abort?.abort();
      abort = null;
      current = { state: "idle", move: false };
    }
    return accountState(app);
  });

  /** The window's one-time sign-in link, once: the app's start page opens it. */
  app.post("/api/desktop/account/handoff", async (request, reply) => {
    requireApp(request.authVia);
    const mode = readMode();
    const url = handoff ?? (mode.mode === "account" && mode.appUrl ? `${mode.appUrl}/today` : null);
    handoff = null;
    if (!url) return reply.code(404).send({ error: "Sign in first." });
    if (current.state === "done") current = { state: "idle", move: false };
    return { url };
  });

  /**
   * Editors on this computer (Claude Code, Cursor, Codex, VS Code…) use Ensemble through MCP without the CLI:
   * this runtime's own Node runs the Context Bridge, which finds the app through its discovery file.
   */
  app.get("/api/desktop/mcp", async (request) => {
    requireApp(request.authVia);
    const bridge = dirname(fileURLToPath(import.meta.resolve("@ensemble/context-bridge/package.json")));
    return { command: process.execPath, args: ["--import", import.meta.resolve("tsx"), join(bridge, "src", "index.ts")] };
  });

  /** Where a connected app's sign-in in the system browser lands on this computer. */
  app.get("/api/desktop/connected", async (request, reply) => {
    const query = z.object({ ok: z.string().optional(), what: z.string().max(80).optional() }).parse(request.query);
    const ok = query.ok !== "0";
    const what = (query.what ?? "").replace(/[^\w .+-]/g, "").slice(0, 60) || "The app";
    const title = ok ? `${what} is connected` : `${what} was not connected`;
    const text = ok ? "You can close this tab and go back to Ensemble." : "Close this tab, go back to Ensemble and try again.";
    reply.header("content-type", "text/html; charset=utf-8").header("cache-control", "no-store").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
    return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><body style="font:15px/1.5 system-ui,sans-serif;background:#141210;color:#f3efe6;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:420px;text-align:center"><h1 style="font-size:20px">${title}</h1><p style="color:#b9b2a5">${text}</p></main></body></html>`;
  });
}
