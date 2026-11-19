/**
 * The Tools picker's catalog (GET /api/tools): every app and remote MCP server connected in this space
 * with its tools, each with the key a session's off list uses (tool-policy.ts) and, when the connection
 * itself rules it out, why. Sessions, profiles and outside apps choose within this; nothing here is
 * secret, and nothing is fetched from the apps: MCP tools come from the list saved when the server connected.
 */
import { CONNECTOR_CATALOG, catalogEntry, type ToolCatalog, type ToolCatalogApp } from "@ensemble/shared-types";
import { connectedItemSources, itemSource } from "../connectors/items/index.js";
import { cachedTools, toolReadOnly, toolTitle } from "../connectors/mcp/store.js";
import { isGuestIn } from "../sharing/context.js";
import { BUILTIN_APP_TOOLS, loadAppGrants, productOn } from "./apps.js";
import { appKeyForProvider, mcpAppKey } from "./tool-policy.js";
import { SUITE_LABEL, type AppProvider } from "./tools/apps-common.js";
import type { ToolContext } from "./types.js";

const MCP_STATE: Record<string, string> = { pending: "Sign-in not finished", error: "Not working right now", disabled: "Switched off in Settings › Connections" };
const WRITES_OFF = "Changes in apps are off in Settings › Assistant";

/** "outlook_calendar_list_events" under "Outlook calendar" → "List events". */
export function builtinTitle(name: string, product: string): string {
  const own = new Set(product.toLowerCase().split(/\s+/));
  const words = name.split("_");
  while (words.length > 1 && own.has(words[0]!)) words.shift();
  const text = words.join(" ").replace(/^free busy$/, "free or busy times");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const ITEM_TOOLS = [
  { name: "apps_search", title: "Search", write: false },
  { name: "apps_read", title: "Read an item", write: false },
  { name: "apps_post_update", title: "Comment on a linked item", write: true },
] as const;

export async function toolCatalog(ctx: Pick<ToolContext, "prisma" | "userId" | "settings">): Promise<ToolCatalog> {
  // The owner's connected apps are theirs alone.
  if (isGuestIn(ctx.userId)) return { apps: [] };
  const writes = ctx.settings.assistant.connectedAppWrites;
  const [grants, servers, sources] = await Promise.all([
    loadAppGrants(ctx),
    ctx.prisma.mcpConnection.findMany({ where: { userId: ctx.userId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }).catch(() => []),
    connectedItemSources(ctx.userId, ctx.prisma),
  ]);
  const apps = new Map<string, ToolCatalogApp>();
  const group = (key: string, name: string, logo: string | null, source: ToolCatalogApp["source"], account: string | null = null): ToolCatalogApp => {
    let row = apps.get(key);
    if (!row) {
      row = { key, name, logo, source, account, tools: [] };
      apps.set(key, row);
    }
    return row;
  };
  const entryFor = (provider: string) => CONNECTOR_CATALOG.find((entry) => entry.provider === provider);

  for (const grant of grants) {
    const entry = entryFor(grant.provider);
    const row = group(appKeyForProvider(grant.provider), entry?.name ?? SUITE_LABEL[grant.provider as AppProvider] ?? grant.provider, entry?.logo ?? null, "connector", grant.account);
    for (const tool of BUILTIN_APP_TOOLS.filter((item) => item.app?.provider === grant.provider)) {
      const meta = tool.app!;
      const blocked = !productOn(meta, ctx.settings) ? `${meta.label} is off in Settings › Connections` : tool.isWrite && !writes ? WRITES_OFF : undefined;
      row.tools.push({ name: tool.name, title: builtinTitle(tool.name, meta.label), product: meta.label, write: tool.isWrite, ...(blocked ? { blocked } : {}) });
    }
  }

  for (const source of sources) {
    const provider = itemSource(source.id)?.provider ?? source.id;
    const entry = entryFor(provider) ?? catalogEntry(source.id);
    const row = group(appKeyForProvider(provider), entry?.name ?? source.name, entry?.logo ?? source.logo ?? null, "connector");
    for (const tool of ITEM_TOOLS) {
      if (tool.name === "apps_post_update" && !source.comments) continue;
      if (row.tools.some((item) => item.name === tool.name)) continue;
      row.tools.push({ name: tool.name, title: tool.title, write: tool.write, ...(tool.write && !writes ? { blocked: WRITES_OFF } : {}) });
    }
  }

  for (const server of servers) {
    const entry = server.serverId.startsWith("custom-") ? undefined : catalogEntry(server.serverId);
    const row = group(mcpAppKey(server), entry?.name ?? server.name, entry?.logo ?? null, "mcp");
    if (server.status !== "connected" && !row.tools.length) row.blocked = MCP_STATE[server.status] ?? "Not working right now";
    const off = new Set(server.disabledTools);
    for (const spec of cachedTools(server)) {
      if (row.tools.some((item) => item.name === spec.name)) continue;
      const write = !toolReadOnly(spec);
      const blocked = server.status !== "connected" ? (MCP_STATE[server.status] ?? "Not working right now") : off.has(spec.name) ? "Off in this server's settings" : write && !writes ? WRITES_OFF : undefined;
      row.tools.push({ name: spec.name, title: toolTitle(spec), write, ...(blocked ? { blocked } : {}) });
    }
  }

  const order = (key: string) => {
    const index = CONNECTOR_CATALOG.findIndex((entry) => entry.id === key);
    return index < 0 ? CONNECTOR_CATALOG.length : index;
  };
  return { apps: [...apps.values()].sort((a, b) => order(a.key) - order(b.key) || a.name.localeCompare(b.name)) };
}
