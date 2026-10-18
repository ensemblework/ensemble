/**
 * hub_list_connections: the apps connected in this space, how, as which account, and which
 * tools reach each one. Tokens never leave connectors/tokens.ts; this reads what the prompt's
 * Connected apps block reads (assistant/connections.ts).
 */
import { z } from "zod";
import { isGuestIn } from "../../sharing/context.js";
import { connectionView, findConnections, loadConnections } from "../connections.js";
import { defineTool, toolOk } from "../types.js";

const MANAGE = "/settings?tab=connections";

function names(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? "");
}

export const connectionTools = [
  defineTool({
    name: "hub_list_connections",
    area: "context",
    description:
      "List the apps connected in this space: each app's name, how it is connected (sign-in, token, MCP sign-in, MCP without sign-in = public data only), the account, and the tools that reach it (apps_search/apps_read with its app id and kinds, its own mcp_* tools, meeting-notes import). Pass app to check one by name. Never returns tokens.",
    input: z.object({ app: z.string().trim().max(80).optional().describe("An app to check, e.g. Vercel. Leave out for every app.") }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      if (isGuestIn(ctx.userId)) {
        return toolOk("Connected apps belong to this space's owner and stay private, so none can be used here.", { connections: [] });
      }
      // apps.ts reaches the registry, which lists this tool.
      const { appToolsFor } = await import("../apps.js");
      const all = await loadConnections(ctx, await appToolsFor(ctx));
      const found = input.app ? findConnections(all, input.app) : all;
      const connections = found.connected.map(connectionView);
      const notWorking = found.broken.map((row) => ({ app: row.name, status: row.status, ...(row.message ? { message: row.message } : {}) }));
      let summary: string;
      if (input.app && !connections.length) {
        summary = notWorking.length
          ? `${notWorking[0]!.app} was added but is ${notWorking[0]!.status}; it needs reconnecting in Settings → Connections.`
          : `${input.app} is not connected in this space. It can be connected in Settings → Connections.`;
      } else if (!connections.length) {
        summary = "No apps are connected in this space. They can be connected in Settings → Connections.";
      } else {
        summary = `${connections.length} app${connections.length === 1 ? "" : "s"} connected in this space: ${names(connections.map((row) => row.app))}.`;
      }
      return toolOk(summary, { connections, ...(notWorking.length ? { notWorking } : {}), manage: MANAGE }, { href: MANAGE });
    },
  }),
];
