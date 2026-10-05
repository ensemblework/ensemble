import { z } from "zod";
import { connectionState, listConnectors } from "../../connectors/base.js";
import { syncConnector } from "../../connectors/sync.js";
import { defineTool, toolOk } from "../types.js";

export const fetchTools = [
  defineTool({
    name: "hub_fetch_now",
    area: "context",
    description:
      "Read connected sources now (gmail, google_calendar, github, slack, linear) and propose todos from anything that asks something of the user. Call this instead of promising to look. Omit sources to read every switched-on source.",
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
      const proposed = results.reduce((sum, row) => sum + (row.proposed ?? 0), 0);
      return toolOk(`Read ${ready.length} source(s); ${proposed} new proposed todo(s) on Today.`, { results }, { href: "/today" });
    },
  }),
];
