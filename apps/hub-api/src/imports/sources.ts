/**
 * Import sources: which apps, how each authenticates, and the connected
 * account (through connectors/tokens.ts) or a pasted token used once.
 */
import { CONNECTOR_CATALOG } from "@ensemble/shared-types";
import type { AccountProvider } from "../connectors/accounts.js";
import { providerAccessToken } from "../connectors/tokens.js";
import { asanaSource } from "./api/asana.js";
import { clickupSource } from "./api/clickup.js";
import { githubSource } from "./api/github.js";
import { jiraSiteHost, jiraSource } from "./api/jira.js";
import { linearSource } from "./api/linear.js";
import { mondaySource } from "./api/monday.js";
import { notionSource } from "./api/notion.js";
import { todoistSource } from "./api/todoist.js";
import { trelloSource } from "./api/trello.js";
import { ImportError, SOURCE_LABEL, type ApiImportSource, type ImportSourceId, type SourceAuth } from "./types.js";

export const API_SOURCES: Partial<Record<ImportSourceId, ApiImportSource>> = {
  notion: notionSource,
  linear: linearSource,
  jira: jiraSource,
  trello: trelloSource,
  asana: asanaSource,
  todoist: todoistSource,
  clickup: clickupSource,
  monday: mondaySource,
  github: githubSource,
};

/** oauth_tokens provider each importer can borrow a connection from. */
export const SOURCE_PROVIDER: Record<ImportSourceId, string | null> = {
  notion: "notion",
  linear: "linear",
  jira: "atlassian",
  trello: "trello",
  asana: "asana",
  todoist: "todoist",
  clickup: "clickup",
  monday: "monday",
  github: "github",
  csv: null,
};

/** Milliseconds between calls, under each vendor's published rate limit. */
export const SOURCE_GAP_MS: Record<ImportSourceId, number> = {
  notion: 350,
  linear: 120,
  jira: 150,
  trello: 120,
  asana: 400,
  todoist: 400,
  clickup: 650,
  monday: 300,
  github: 100,
  csv: 0,
};

/** What the token field asks for, beyond the token itself. */
export const TOKEN_FIELDS: Partial<Record<ImportSourceId, Array<"email" | "site" | "key">>> = {
  jira: ["site", "email"],
  trello: ["key"],
};

export const FILE_FORMATS: Record<ImportSourceId, string[]> = {
  notion: ["zip", "csv"],
  linear: ["csv"],
  jira: ["csv"],
  trello: ["json"],
  asana: ["csv"],
  todoist: ["csv"],
  clickup: ["csv"],
  monday: [],
  github: [],
  csv: ["csv", "tsv"],
};

/** Exactly where each app's export lives, shown next to the upload box. */
export const EXPORT_HELP: Partial<Record<ImportSourceId, string>> = {
  notion: "In Notion: Settings → General → Export all workspace content (or ••• on a page → Export), choose Markdown & CSV, include subpages, then upload the zip.",
  linear: "In Linear: Settings → Administration → Import / export → Export CSV. The file arrives by email.",
  jira: "In Jira: Filters → View all issues, pick the issues, then Export → Export CSV (all fields).",
  trello: "In Trello: open the board menu (•••) → Print, export and share → Export as JSON.",
  asana: "In Asana: open the project, click the arrow next to its name → Export/Print → CSV.",
  todoist: "In Todoist: open the project, ••• → Export as a template → Download as CSV file.",
  clickup: "In ClickUp: Settings → Import/Export → Export, or a List view's ••• → Export view → CSV.",
  csv: "Any spreadsheet saved as CSV or TSV, with a header row. Excel and Google Sheets: File → Download → CSV.",
};

export interface Credentials {
  token?: string;
  email?: string;
  site?: string;
  key?: string;
}

function catalogFor(source: ImportSourceId) {
  return CONNECTOR_CATALOG.find((entry) => entry.import?.source === source);
}

function host(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return jiraSiteHost(value);
  } catch {
    return undefined;
  }
}

export async function connectedAuth(userId: string, source: ImportSourceId): Promise<SourceAuth | null> {
  const provider = SOURCE_PROVIDER[source];
  if (!provider) return null;
  let token;
  try {
    token = await providerAccessToken(userId, provider as AccountProvider);
  } catch {
    return null;
  }
  if (!token?.token) return null;
  const extra = token.extra ?? {};
  if (source === "jira") {
    if (extra.cloudId) return { token: token.token, via: "account", cloudId: extra.cloudId, site: host(extra.site) };
    // A token connection stores "email:api-token" for Basic auth against the site.
    const split = token.token.indexOf(":");
    if (!extra.site || split < 1) return null;
    return { token: token.token.slice(split + 1), email: extra.email ?? token.token.slice(0, split), site: extra.site, via: "account" };
  }
  if (source === "trello") {
    const key = extra.key ?? extra.apiKey;
    if (!key) return null;
    return { token: token.token, via: "account", key };
  }
  return { token: token.token, via: "account" };
}

export async function resolveAuth(userId: string, source: ImportSourceId, credentials?: Credentials): Promise<SourceAuth> {
  const token = credentials?.token?.trim();
  if (token) {
    return {
      token,
      via: "token",
      ...(credentials?.email ? { email: credentials.email.trim() } : {}),
      ...(credentials?.site ? { site: credentials.site.trim() } : {}),
      ...(credentials?.key ? { key: credentials.key.trim() } : {}),
    };
  }
  const connected = await connectedAuth(userId, source);
  if (connected) return connected;
  throw new ImportError(`${SOURCE_LABEL[source]} is not connected. Connect it in Settings → Connections, paste a token, or upload an export.`, 409);
}

export async function listSources(userId: string) {
  const out = [];
  for (const source of Object.keys(SOURCE_LABEL) as ImportSourceId[]) {
    const entry = catalogFor(source);
    const api = Boolean(API_SOURCES[source]);
    out.push({
      id: source,
      name: entry?.name ?? SOURCE_LABEL[source],
      logo: entry?.logo ?? source,
      connectorId: entry?.id ?? null,
      api,
      connected: api ? Boolean(await connectedAuth(userId, source)) : false,
      tokenUrl: entry?.import?.tokenUrl ?? null,
      tokenHint: entry?.import?.tokenHint ?? null,
      tokenFields: TOKEN_FIELDS[source] ?? [],
      files: FILE_FORMATS[source],
      exportHelp: EXPORT_HELP[source] ?? null,
      brings: entry?.import?.brings ?? [],
    });
  }
  return out;
}
