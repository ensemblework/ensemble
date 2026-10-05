/**
 * Pluggable source connectors.
 *
 * None of these are required to boot the Hub. Each connector owns its own
 * sign-in and never talks to the model directly — the Context Engine ingests,
 * the Action Layer writes. Links in the Hub always point at the official
 * source (Gmail, GitHub, Slack…), never at a vendor-specific paste.
 */
import type { ConnectorId } from "@ensemble/shared-types";
import { getAccount, oauthApp, type AccountProvider } from "./accounts.js";
import { syncGitHub } from "./github.js";
import { syncCalendar, syncGmail } from "./google.js";
import { syncLinear } from "./linear.js";
import { syncSlack } from "./slack.js";
import type { SyncContext, SyncResult } from "./types.js";

export type { ConnectorId };

export interface Connector {
  id: ConnectorId;
  label: string;
  group: "mail" | "calendar" | "code" | "chat" | "notes" | "issues";
  description: string;
  /** Which oauth_tokens provider holds the sign-in, if any. */
  account: AccountProvider | null;
  /** How a person connects it from the UI. */
  connect: "oauth" | "token" | "oauth_or_token" | "builtin" | "later";
  setupHint: string;
  sync?: (ctx: SyncContext) => Promise<SyncResult>;
}

const ALL: readonly Connector[] = [
  {
    id: "gmail",
    label: "Gmail",
    group: "mail",
    description: "Threads you are on, read-only. Asks become proposed todos; replies are drafted and need your approval.",
    account: "google",
    connect: "oauth",
    setupHint: "Sign in with Google and allow read-only access. That connects Gmail and Calendar together.",
    sync: syncGmail,
  },
  {
    id: "google_calendar",
    label: "Google Calendar",
    group: "calendar",
    description: "Last week to three weeks out, for the Today calendar and meeting context.",
    account: "google",
    connect: "oauth",
    setupHint: "Included when you sign in with Google.",
    sync: syncCalendar,
  },
  {
    id: "github",
    label: "GitHub",
    group: "code",
    description: "Your open PRs, PRs waiting on your review, and issues assigned to you.",
    account: "github",
    connect: "oauth_or_token",
    setupHint: "Sign in with GitHub, or paste a fine-grained token with read access to the repos you work in.",
    sync: syncGitHub,
  },
  {
    id: "slack",
    label: "Slack",
    group: "chat",
    description: "Your DMs and group DMs, plus channels you list. Direct asks become proposed todos.",
    account: "slack",
    connect: "token",
    setupHint: "Paste a Slack user token (xoxp-…) with channels:history, groups:history, im:history, mpim:history, users:read and users:read.email.",
    sync: syncSlack,
  },
  {
    id: "linear",
    label: "Linear",
    group: "issues",
    description: "Open issues assigned to you become proposed todos.",
    account: "linear",
    connect: "token",
    setupHint: "Paste a personal API key from Linear → Settings → Security & access.",
    sync: syncLinear,
  },
  {
    id: "outlook",
    label: "Outlook mail",
    group: "mail",
    description: "Microsoft 365 mail via Graph, read-only.",
    account: "microsoft",
    connect: "later",
    setupHint: "Not built yet. Outlook, Outlook calendar and Teams come after the Google connectors.",
  },
  {
    id: "outlook_calendar",
    label: "Outlook calendar",
    group: "calendar",
    description: "Meetings and join links for the Today calendar.",
    account: "microsoft",
    connect: "later",
    setupHint: "Not built yet.",
  },
  {
    id: "teams",
    label: "Teams",
    group: "chat",
    description: "Chats and channel threads that mention you.",
    account: "microsoft",
    connect: "later",
    setupHint: "Not built yet.",
  },
  {
    id: "meeting_notes",
    label: "Meeting notes",
    group: "notes",
    description: "Notes you paste or upload in Context → Artifacts, linked to their source.",
    account: null,
    connect: "builtin",
    setupHint: "Always on. Upload notes in Context → Artifacts.",
  },
];

export function listConnectors(): readonly Connector[] {
  return ALL;
}

export function getConnector(id: string): Connector | undefined {
  return ALL.find((connector) => connector.id === id);
}

const UNCONFIGURED = { configured: false, account: null, source: null, appReady: false } as const;

type ConnectionSnapshot = {
  configured: boolean;
  account: string | null;
  source: "you" | "env" | "cli" | null;
  appReady: boolean;
};

/** Settings, the shell, and each connection row ask at once. Share one lookup. */
const inflightState = new Map<string, Promise<ConnectionSnapshot>>();

async function readConnection(userId: string, connector: Connector): Promise<ConnectionSnapshot> {
  try {
    if (connector.connect === "builtin") return { configured: true, account: null, source: null, appReady: true };
    if (connector.connect === "later" || !connector.account) return { configured: false, account: null, source: null, appReady: false };
    // Status checks skip the GitHub CLI. A keychain prompt must not stall Settings or the shell.
    const account = await getAccount(userId, connector.account, true, false);
    const appReady = connector.connect === "token" ? true : Boolean(await oauthApp(connector.account));
    return { configured: Boolean(account), account: account?.account ?? null, source: account?.source ?? null, appReady };
  } catch {
    // A missing table or a bad stored secret must not take down Settings or the shell.
    return UNCONFIGURED;
  }
}

export async function connectionState(userId: string, connector: Connector): Promise<ConnectionSnapshot> {
  const key = `${userId}:${connector.id}`;
  const pending = inflightState.get(key);
  if (pending) return pending;
  const job = readConnection(userId, connector).finally(() => {
    if (inflightState.get(key) === job) inflightState.delete(key);
  });
  inflightState.set(key, job);
  return job;
}
