import { z } from "zod";
import { allPlaybooks, appMap, findPlaybook } from "../skills/index.js";
import { defineTool, ToolBlockedError, toolOk } from "../types.js";

const NAMES = ["map", ...allPlaybooks().map((playbook) => playbook.name)] as [string, ...string[]];

/** Each playbook's name and what it covers, for the tool's description: the model picks from here. */
const INDEX = [...allPlaybooks().map((playbook) => `${playbook.name}: ${playbook.when}`), "map: where each screen and setting is in the app, with its link"].join("\n");

export const howToTools = [
  defineTool({
    name: "hub_how_to",
    area: "context",
    description: `How one area of Ensemble works: its steps, rules and examples, and that area's tools for the rest of this turn. Call it before work in an area you have no tools for yet (skip it when a guide for the area is already in the message).\n${INDEX}`,
    input: z.object({ name: z.enum(NAMES) }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      if (input.name === "map") return toolOk("Loaded the map of Ensemble.", { name: "map", title: "Map of Ensemble", steps: appMap(), tools: [] });
      const playbook = findPlaybook(input.name, ctx.modules);
      if (!playbook) throw new ToolBlockedError(`The ${input.name} playbook is not available here.`, "That part of Ensemble is switched off for this space (Settings → Features).");
      return toolOk(`Loaded the ${playbook.title} playbook.`, { name: playbook.name, title: playbook.title, steps: playbook.body, tools: playbook.tools });
    },
  }),
];
