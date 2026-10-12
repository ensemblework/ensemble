import { z } from "zod";
import { allPlaybooks, findPlaybook } from "../skills/index.js";
import { defineTool, ToolBlockedError, toolOk } from "../types.js";

const NAMES = allPlaybooks().map((playbook) => playbook.name) as [string, ...string[]];

export const howToTools = [
  defineTool({
    name: "hub_how_to",
    area: "context",
    description:
      "Load Ensemble's built-in playbook for one area: the steps, rules and examples for that kind of request, and that area's tools for the rest of this turn. Call it before multi-step work in an area whose playbook is not already in the prompt. Names are in the Playbooks list.",
    input: z.object({ name: z.enum(NAMES) }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const playbook = findPlaybook(input.name, ctx.modules);
      if (!playbook) throw new ToolBlockedError(`The ${input.name} playbook is not available here.`, "That part of Ensemble is switched off for this space (Settings → Features).");
      return toolOk(`Loaded the ${playbook.title} playbook.`, { name: playbook.name, title: playbook.title, steps: playbook.body, tools: playbook.tools });
    },
  }),
];
