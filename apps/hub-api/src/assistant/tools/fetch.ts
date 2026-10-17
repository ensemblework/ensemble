import { z } from "zod";
import { connectionState, listConnectors } from "../../connectors/base.js";
import { syncConnector } from "../../connectors/sync.js";
import { defineTool, toolOk } from "../types.js";

export const fetchTools = [
  defineTool({
    name: "hub_fetch_now",
    area: "context",
    description:
      "Sync real contact metadata from connected apps now. Saves people only; never saves messages, files or other artifacts and never proposes tasks. Use app search/import tools for specific content. Omit sources to sync switched-on contact sources.",
    input: z.object({
      sources: z.array(z.string()).optional(),
    }),
    isWrite: true,
    risk: "low",
    undoable: false,
    async run(ctx, input) {
      const connectors = listConnectors().filter(
        (connector) =>
          connector.sync &&
          (input.sources ? input.sources.includes(connector.id) : ctx.settings.connections[connector.id]?.enabled),
      );
      const ready = [];
      for (const connector of connectors) {
        if ((await connectionState(ctx.userId, connector)).configured) ready.push(connector);
      }
      if (ready.length === 0) {
        return toolOk("No connected source is switched on. Connect one in Settings → Connections.", { results: [] });
      }
      const results = [];
      for (const connector of ready) results.push(await syncConnector(ctx.app, ctx.userId, connector.id));
      const people = results.reduce((sum, row) => sum + (row.items ?? 0), 0);
      return toolOk(`Synced contacts from ${ready.length} source(s); ${people} people updated. No files or messages were saved.`, { results }, { href: "/context?tab=people" });
    },
  }),
];
