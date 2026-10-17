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
import { MEETING_SOURCES } from "./meetings/index.js";
import { syncOutlook, syncOutlookCalendar, syncTeams } from "./microsoft.js";
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
    description: "Sync real contacts when you choose. Find and save specific messages with the assistant.",
    account: "google",
    connect: "oauth",
    setupHint: "Connect Google Workspace with Gmail switched on.",
    sync: syncGmail,
  },
  {
    id: "google_calendar",
    label: "Google Calendar",
    group: "calendar",
    description: "Sync attendee contact details when you choose. Save events only when you ask.",
    account: "google",
    connect: "oauth",
    setupHint: "Connect Google Workspace with Google Calendar switched on.",
    sync: syncCalendar,
  },
  {
    id: "github",
    label: "GitHub",
    group: "code",
    description: "Find repositories, reviews and issues when you ask. Contact sync adds people you follow.",
    account: "github",
    connect: "oauth_or_token",
    setupHint: "Sign in with GitHub, or paste a fine-grained token with read access to the repos you work in.",
    sync: syncGitHub,
  },
  {
    id: "slack",
    label: "Slack",
    group: "chat",
    description: "Sync real workspace members when you choose. Save messages only when you ask.",
    account: "slack",
    connect: "token",
    setupHint: "Paste a Slack user token (xoxp-…) with channels:history, groups:history, im:history, mpim:history, channels:read, groups:read, users:read and users:read.email.",
    sync: syncSlack,
  },
  {
    id: "linear",
    label: "Linear",
    group: "issues",
    description: "Find and save the issues you choose with the assistant.",
    account: "linear",
    connect: "token",
    setupHint: "Paste a personal API key from Linear → Settings → Security & access.",
    sync: syncLinear,
  },
  {
    id: "outlook",
    label: "Outlook mail",
    group: "mail",
    description: "Sync real contacts when you choose. Find and save specific messages with the assistant.",
    account: "microsoft",
    connect: "oauth",
    setupHint: "Connect Microsoft 365 with Outlook mail switched on.",
    sync: syncOutlook,
  },
  {
    id: "outlook_calendar",
    label: "Outlook calendar",
    group: "calendar",
    description: "Sync attendee contact details when you choose. Save events only when you ask.",
    account: "microsoft",
    connect: "oauth",
    setupHint: "Connect Microsoft 365 with Outlook calendar switched on.",
    sync: syncOutlookCalendar,
  },
  {
    id: "teams",
    label: "Teams",
    group: "chat",
    description: "Sync people from your chats when you choose. Save messages only when you ask. Work or school accounts only.",
    account: "microsoft",
    connect: "oauth",
    setupHint: "Connect Microsoft 365 with Teams switched on (work or school account).",
    sync: syncTeams,
  },
  ...MEETING_SOURCES.map(
    (source): Connector => ({
      id: source.id,
      label: source.label,
      group: "notes",
      description: "Import the meeting notes you choose. Review any proposed action items before adding them.",
      account: source.id,
      connect: "token",
      setupHint: source.setupHint,
      sync: source.sync,
    }),
  ),
  {
    id: "meeting_notes",
    label: "Meeting notes",
    group: "notes",
    description: "Meeting notes you keep in Meetings, linked to their source.",
    account: null,
    connect: "builtin",
    setupHint: "Always on. Keep notes in Meetings.",
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
