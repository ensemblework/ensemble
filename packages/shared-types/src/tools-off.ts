import { z } from "zod";

/**
 * Which connected-app tools one session, run profile or app may not use, as a list of what is switched
 * off (docs/CONTEXT_BRIDGE.md §5.5). Everything else that is connected stays on, so a newly connected
 * app is on by default. Each entry is an app's key or one tool in it:
 *
 *   "google"                 every Google Workspace tool
 *   "google/gmail_send"      one of them
 *   "mcp:custom-1a2b3c"      a server added by its address (its server id, which a rename keeps)
 *   "mcp:custom-1a2b3c/run"  one of its tools, by the server's own name for it
 *
 * The connections, their products, grants and per-server switches are the ceiling; this only narrows them.
 */
export const TOOLS_OFF_MAX = 300;
export const ToolsOff = z.array(z.string().trim().min(1).max(200)).max(TOOLS_OFF_MAX);
export type ToolsOff = z.infer<typeof ToolsOff>;

/** The entry for an app, or one tool in it. */
export function toolOffKey(app: string, tool?: string): string {
  return tool ? `${app}/${tool}` : app;
}

/** Whether a tool (or, without one, the app as a whole) is on under these entries. */
export function toolOn(off: Iterable<string> | null | undefined, app: string, tool?: string): boolean {
  if (!off) return true;
  const set = off instanceof Set ? (off as ReadonlySet<string>) : new Set(off);
  if (set.has(app)) return false;
  return !tool || !set.has(toolOffKey(app, tool));
}

/** Several layers (an app's restriction, then a session's choice) as one list, without repeats. */
export function mergeToolsOff(...layers: ReadonlyArray<readonly string[] | null | undefined>): string[] {
  return [...new Set(layers.flatMap((layer) => layer ?? []))].slice(0, TOOLS_OFF_MAX);
}

/** One tool of an app in the Tools picker's catalog (GET /api/tools). */
export interface ToolCatalogTool {
  /** The tool's own name in its app (gmail_search, or an MCP server's name for it). */
  name: string;
  /** A short, readable name. */
  title: string;
  /** The product it belongs to (Gmail, Outlook mail), for apps with several. */
  product?: string;
  write: boolean;
  /** Why it cannot be on whatever a session chooses (its product is off, changes in apps are off…). */
  blocked?: string;
}

/** One app or server in the Tools picker's catalog. */
export interface ToolCatalogApp {
  /** The key a session's off list uses for it. */
  key: string;
  name: string;
  /** Logo key for brand-logo.tsx, when the app is in the catalog. */
  logo: string | null;
  source: "connector" | "mcp";
  account: string | null;
  /** Why none of it can be used right now (sign-in not finished, not working…). */
  blocked?: string;
  tools: ToolCatalogTool[];
}

export interface ToolCatalog {
  apps: ToolCatalogApp[];
}
