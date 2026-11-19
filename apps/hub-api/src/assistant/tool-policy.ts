/**
 * Which connected-app tools one caller may use (docs/CONTEXT_BRIDGE.md §5.5): the ceiling is what is
 * connected and switched on (apps.ts, a server's own tool switches, app writes); a session, a run's
 * profile or an outside app's restriction can only switch more off (`ToolContext.toolsOff`, entries
 * from @ensemble/shared-types tools-off.ts).
 *
 * The same answer drives listing, prompts, resolution and calls, so a switched-off app is neither
 * shown to the model nor reachable by name, a cached schema or a search across apps.
 */
import { CONNECTOR_CATALOG, catalogEntry, toolOn } from "@ensemble/shared-types";
import type { McpHubTool } from "./mcp-tools.js";
import type { AnyHubTool, ToolContext } from "./types.js";

/** An app's key for a built-in connection: its catalog id, as the assistant's connections name it. */
export function appKeyForProvider(provider: string): string {
  return CONNECTOR_CATALOG.find((entry) => entry.provider === provider)?.id ?? provider;
}

/** A remote MCP server's key: its catalog id, or `mcp:<server id>` for one added by its address (a rename keeps it). */
export function mcpAppKey(row: { serverId: string }): string {
  return !row.serverId.startsWith("custom-") && catalogEntry(row.serverId) ? row.serverId : `mcp:${row.serverId}`;
}

/** The connected-app tools a job's session or profile switched off (`context.toolsOff`, set by Assign). */
export function jobToolsOff(jobContext: unknown): string[] {
  const value = jobContext && typeof jobContext === "object" ? (jobContext as { toolsOff?: unknown }).toolsOff : null;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 300) : [];
}

/** The off entries in force for this caller, or null when nothing is switched off. */
export function offSet(ctx: Pick<ToolContext, "toolsOff"> | null | undefined): ReadonlySet<string> | null {
  return ctx?.toolsOff?.length ? new Set(ctx.toolsOff) : null;
}

/**
 * Where a tool sits: its app's key and its name there. Null for Ensemble's own tools and for the
 * apps_* item tools, which reach several apps and are narrowed by source (tools/app-items.ts).
 */
export function toolAddress(tool: AnyHubTool): { app: string; tool: string } | null {
  if (tool.app) return { app: appKeyForProvider(tool.app.provider), tool: tool.name };
  const mcp = (tool as Partial<McpHubTool>).mcp;
  if (mcp) return { app: mcpAppKey(mcp), tool: mcp.toolName };
  return null;
}

/** Whether this caller may be offered and may call the tool. */
export function toolAllowed(off: ReadonlySet<string> | null, tool: AnyHubTool): boolean {
  if (!off || tool.area !== "apps") return true;
  const where = toolAddress(tool);
  return !where || toolOn(off, where.app, where.tool);
}
