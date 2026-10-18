/**
 * The apps connected in this space, as the assistant sees them: each by its catalog name,
 * how it is connected, the account, and which tools reach it. One list feeds the
 * "Connected apps" block of every prompt (apps.appsPrompt), routing (a message that names a
 * connected app loads the apps playbook) and hub_list_connections.
 *
 * Reads the non-secret columns, and the sealed MCP envelope only for how a server signs in.
 * In a space shared with you the owner's connections are private, so the list is empty.
 */
import type { McpConnection, PrismaClient } from "@prisma/client";
import { APP_ITEM_KIND_LABEL, CONNECTOR_CATALOG, catalogEntry, type AppItemKind, type ConnectorCatalogEntry } from "@ensemble/shared-types";
import { connectedItemSources, itemSource } from "../connectors/items/index.js";
import { isMeetingVendor } from "../connectors/meetings/types.js";
import { cachedTools, readEnvelope } from "../connectors/mcp/store.js";
import { isGuestIn } from "../sharing/context.js";
import { MCP_TOOL_PREFIX, serverSlug, type McpHubTool } from "./mcp-tools.js";
import { namesApp } from "./skills/index.js";
import { APP_PROVIDERS, SUITE_LABEL, type AppProvider } from "./tools/apps-common.js";
import type { AnyHubTool } from "./types.js";

export interface AppConnection {
  /** Catalog id ("vercel"), or "mcp:<slug>" for a server added by its address. */
  id: string;
  name: string;
  /** How it is connected: "sign-in", "token", "MCP sign-in", "MCP token", "MCP without sign-in, so public data only"… */
  via: string[];
  account: string | null;
  /** What the assistant can do with it, one short clause each. */
  uses: string[];
  /** Tool names; a server's own tools as their prefix ending in "*". */
  tools: string[];
  /** Reached only through an MCP server that has no sign-in, so only public data. */
  publicOnly: boolean;
  /** A meeting-notes app. */
  meetings: boolean;
  /** Lowercase names a message may call it by. */
  names: string[];
}

/** An MCP server that was added but does not work right now. */
export interface BrokenConnection {
  name: string;
  status: string;
  message: string | null;
}

export interface Connections {
  connected: AppConnection[];
  broken: BrokenConnection[];
}

export const NO_CONNECTIONS: Connections = { connected: [], broken: [] };

const PRODUCT_ORDER = ["Gmail", "Google Calendar", "Google Drive", "Google Docs", "Google Sheets", "Google Slides", "Outlook mail", "Outlook calendar", "Microsoft Teams", "OneDrive", "Word", "Excel", "PowerPoint"];

/** What the read-only built-in connections offer; they have no products to list. */
const READS: Partial<Record<AppProvider, string>> = {
  zoom: "meetings, cloud recordings, transcripts and AI Companion summaries (read only)",
  docusign: "envelopes and who still has to sign (read only)",
  atlassian: "Jira issues by JQL, with descriptions and comments (read only)",
};

const MCP_STATUS: Record<string, string> = { pending: "sign-in not finished", error: "not working", disabled: "switched off" };

/** The words a message may use for a catalog app: its name, id, vendor, and the parts of a combined name. */
export function appNames(entry: Pick<ConnectorCatalogEntry, "id" | "name" | "vendor" | "provider">): string[] {
  const out = new Set<string>();
  const add = (value: string | undefined) => {
    const name = value?.toLowerCase().replace(/\s+/g, " ").trim();
    if (name && name.length >= 3) out.add(name);
  };
  add(entry.name);
  add(entry.id);
  add(entry.id.replace(/_/g, " "));
  add(entry.vendor);
  add(entry.provider);
  for (const part of entry.name.split(/\s*(?:&|\/|,|\band\b)\s*/i)) add(part);
  add(entry.name.replace(/\.(ai|com|io|app|dev)$/i, ""));
  add(entry.name.replace(/[^\p{L}\p{N}]+/gu, ""));
  return [...out];
}

function plural(kind: AppItemKind): string {
  const label = (APP_ITEM_KIND_LABEL[kind] ?? kind.replace(/_/g, " ")).toLowerCase();
  if (label === "person") return "people";
  return /[^aeiou]y$/.test(label) ? `${label.slice(0, -1)}ies` : `${label}s`;
}

function words(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? "");
}

type ServerRow = Pick<McpConnection, "id" | "serverId" | "name" | "status" | "clientInfo" | "tools" | "disabledTools" | "lastError">;

function mcpVia(row: ServerRow): { via: string; open: boolean } {
  const envelope = readEnvelope(row);
  if (envelope.auth === "none") return { via: "MCP without sign-in, so public data only", open: true };
  if (envelope.auth === "bearer") return { via: "MCP token", open: false };
  if (envelope.auth === "connection") {
    const provider = envelope.provider ? (CONNECTOR_CATALOG.find((entry) => entry.provider === envelope.provider)?.name ?? envelope.provider) : "existing";
    return { via: `MCP through the ${provider} connection`, open: false };
  }
  return { via: "MCP sign-in", open: false };
}

const order = (id: string) => {
  const index = CONNECTOR_CATALOG.findIndex((entry) => entry.id === id);
  return index < 0 ? CONNECTOR_CATALOG.length : index;
};

/**
 * Every app connected in this space. `offered` is the turn's tool list (toolsForTurn or
 * appToolsFor): it names the products switched on and how many of a server's tools are offered.
 */
export async function loadConnections(ctx: { prisma: PrismaClient; userId: string }, offered: readonly AnyHubTool[]): Promise<Connections> {
  if (isGuestIn(ctx.userId)) return NO_CONNECTIONS;
  const [tokens, servers, searchable] = await Promise.all([
    ctx.prisma.authToken.findMany({ where: { userId: ctx.userId }, select: { provider: true, account: true, scopes: true, meta: true } }),
    ctx.prisma.mcpConnection
      .findMany({
        where: { userId: ctx.userId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, serverId: true, name: true, status: true, clientInfo: true, tools: true, disabledTools: true, lastError: true },
      })
      .catch(() => [] as ServerRow[]),
    connectedItemSources(ctx.userId, ctx.prisma),
  ]);
  const apps = new Map<string, AppConnection>();
  const broken: BrokenConnection[] = [];
  const open = new Map<string, boolean>();
  const slot = (id: string, name: string, names: string[]): AppConnection => {
    let row = apps.get(id);
    if (!row) {
      row = { id, name, via: [], account: null, uses: [], tools: [], publicOnly: false, meetings: false, names };
      apps.set(id, row);
    }
    return row;
  };

  for (const token of tokens ?? []) {
    const entry = CONNECTOR_CATALOG.find((row) => row.provider === token.provider);
    const provider = token.provider as AppProvider;
    const row = slot(entry?.id ?? token.provider, entry?.name ?? SUITE_LABEL[provider] ?? token.provider, entry ? appNames(entry) : [token.provider.toLowerCase()]);
    const meta = (token.meta ?? {}) as Record<string, unknown>;
    const signedIn = meta.via === "oauth" || (token.scopes ?? []).length > 0 || !entry?.auth.includes("token");
    row.via.push(signedIn ? "sign-in" : "token");
    row.account = token.account ?? null;
    open.set(row.id, false);
    if ((APP_PROVIDERS as readonly string[]).includes(token.provider)) {
      const own = offered.filter((tool) => tool.app?.provider === token.provider);
      const prefixes = [...new Set(own.map((tool) => `${tool.name.split("_")[0]}_*`))];
      const reads = READS[provider];
      if (reads) {
        row.uses.push(`${reads} via ${prefixes.join(" ") || "its own tools"}`);
      } else {
        const labels = [...new Set(own.map((tool) => tool.app!.label))].sort((a, b) => PRODUCT_ORDER.indexOf(a) - PRODUCT_ORDER.indexOf(b));
        row.uses.push(labels.length ? `${labels.join(", ")} via ${prefixes.join(" ")}` : "none of its products are switched on (Settings → Connections)");
      }
      row.tools.push(...prefixes);
    }
    if (isMeetingVendor(token.provider)) {
      row.meetings = true;
      row.uses.push(`import its notes into Meeting notes via hub_import_meeting_notes source "${token.provider}"`);
      row.tools.push("hub_import_meeting_notes");
    }
  }

  for (const info of searchable) {
    const provider = itemSource(info.id)?.provider;
    const entryId = provider ? CONNECTOR_CATALOG.find((entry) => entry.provider === provider)?.id : undefined;
    const row = apps.get(info.id) ?? (entryId ? apps.get(entryId) : undefined) ?? (provider ? apps.get(provider) : undefined);
    if (!row) continue;
    row.uses.push(`${words(info.kinds.map(plural))} via apps_search/apps_read app "${info.id}"`);
    row.tools.push("apps_search", "apps_read");
    if (info.comments) {
      row.uses.push("comments on a task's linked item via apps_post_update");
      row.tools.push("apps_post_update");
    }
  }

  for (const server of servers ?? []) {
    const entry = server.serverId.startsWith("custom-") ? undefined : catalogEntry(server.serverId);
    const name = entry?.name ?? server.name;
    if (server.status !== "connected") {
      broken.push({ name, status: MCP_STATUS[server.status] ?? server.status, message: server.lastError ? server.lastError.slice(0, 200) : null });
      continue;
    }
    const slug = serverSlug(server);
    const row = slot(entry?.id ?? `mcp:${slug}`, name, entry ? appNames(entry) : [server.name.toLowerCase().trim()].filter((word) => word.length >= 3));
    const how = mcpVia(server);
    row.via.push(how.via);
    if (!open.has(row.id)) open.set(row.id, how.open);
    else if (!how.open) open.set(row.id, false);
    if (entry?.category === "meetings") row.meetings = true;
    const off = new Set(server.disabledTools);
    const enabled = cachedTools(server).filter((tool) => !off.has(tool.name)).length;
    const shown = offered.filter((tool) => (tool as Partial<McpHubTool>).mcp?.connectionId === server.id).length;
    const prefix = `${MCP_TOOL_PREFIX}${slug}_*`;
    if (!enabled) row.uses.push("no tools switched on for its server (Settings → Connections)");
    else if (shown < enabled) row.uses.push(`${shown} of its ${enabled} own tools are offered this turn: ${prefix}`);
    else row.uses.push(`${enabled} own tools: ${prefix}`);
    row.tools.push(prefix);
  }

  const connected = [...apps.values()]
    .map((row) => ({
      ...row,
      tools: [...new Set(row.tools)],
      uses: row.uses.length ? row.uses : ["connected, but the assistant has no tools for it yet"],
      publicOnly: open.get(row.id) === true,
    }))
    .sort((a, b) => order(a.id) - order(b.id) || a.name.localeCompare(b.name));
  return { connected, broken };
}

/** One prompt line: `- Vercel (token, as mira): …`. */
export function connectionLine(app: AppConnection): string {
  const how = [app.via.join(" + "), app.account ? `as ${app.account}` : ""].filter(Boolean).join(", ");
  const line = `- ${app.name} (${how}): ${app.uses.join("; ")}.`;
  return line.length > 400 ? `${line.slice(0, 399)}…` : line;
}

/** What hub_list_connections returns for one app. Never a token. */
export function connectionView(app: AppConnection) {
  return {
    app: app.name,
    id: app.id,
    connected: app.via,
    account: app.account,
    canUse: app.uses,
    tools: app.tools,
    ...(app.publicOnly ? { publicDataOnly: true } : {}),
  };
}

/** The connections a name refers to ("Vercel", "jira"). */
export function findConnections(connections: Connections, name: string): { connected: AppConnection[]; broken: BrokenConnection[] } {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return connections;
  return {
    connected: connections.connected.filter((app) => app.id === wanted || app.name.toLowerCase() === wanted || namesApp(wanted, app.names, true)),
    broken: connections.broken.filter((row) => row.name.toLowerCase().includes(wanted)),
  };
}
