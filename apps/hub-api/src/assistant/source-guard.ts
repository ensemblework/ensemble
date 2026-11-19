/**
 * Ensemble's own tools that read a connected app by name (an import, a save as a page, a relationship,
 * a contact sync) follow the caller's switched-off apps too (tool-policy.ts), on every path: the
 * registry hands out these tools already wrapped, so a turn, Apply, the bridge and runs all get the check.
 */
import { catalogEntry, toolOn } from "@ensemble/shared-types";
import { itemSource } from "../connectors/items/index.js";
import { listConnectors } from "../connectors/base.js";
import { getPreview } from "../imports/previews.js";
import { appKeyForProvider, offSet } from "./tool-policy.js";
import { ToolBlockedError, type AnyHubTool, type ToolContext } from "./types.js";

/** Import and file sources that are not catalog ids. */
const ALIAS: Record<string, string> = { jira: "atlassian" };

/** The app key a tool's `source` reaches, or null when it is not a connected app (a CSV, a file in Files). */
export function appKeyForSource(source: string): string | null {
  const id = ALIAS[source] ?? source;
  const provider = itemSource(id)?.provider ?? catalogEntry(id)?.provider;
  return provider ? appKeyForProvider(provider) : null;
}

type Input = Record<string, unknown>;
const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const present = (values: ReadonlyArray<string | null | undefined>): string[] => values.filter((value): value is string => Boolean(value));

/** Which sources a call would reach, by tool. */
const REACHES: Record<string, (ctx: ToolContext, input: Input) => Promise<string[]> | string[]> = {
  hub_import_app_file: (_ctx, input) => present([text(input.source)]),
  hub_save_app_item_as_page: (_ctx, input) => present([text(input.source)]),
  hub_import_meeting_notes: (_ctx, input) => present([text(input.source)]),
  hub_preview_board_import: (ctx, input) => present([text(input.source) ?? (text(input.previewId) ? getPreview(ctx.userId, text(input.previewId)!)?.source : null)]),
  hub_start_board_import: (ctx, input) => present([text(input.previewId) ? getPreview(ctx.userId, text(input.previewId)!)?.source : null]),
  hub_manage_app_relationship: async (ctx, input) => {
    if (text(input.source)) return [text(input.source)!];
    const linkId = text(input.linkId);
    if (!linkId) return [];
    const link = await ctx.prisma.projectLink.findFirst({ where: { id: linkId, userId: ctx.userId }, select: { source: true } });
    return link?.source ? [link.source] : [];
  },
};

async function refuseSwitchedOff(ctx: ToolContext, name: string, input: unknown): Promise<void> {
  const off = offSet(ctx);
  const reach = REACHES[name];
  if (!off || !reach) return;
  for (const source of await reach(ctx, (input ?? {}) as Input)) {
    const key = appKeyForSource(source);
    if (key && !toolOn(off, key)) throw new ToolBlockedError(`${catalogEntry(key)?.name ?? source} is switched off here, so Ensemble does not reach it.`);
  }
}

/** The contact sync syncs only the apps that are on for this caller. */
function syncableSources(ctx: ToolContext, input: Input): Input {
  const off = offSet(ctx);
  if (!off) return input;
  const asked = Array.isArray(input.sources) ? (input.sources as string[]) : listConnectors().filter((connector) => connector.sync && ctx.settings.connections[connector.id]?.enabled).map((connector) => connector.id);
  return { ...input, sources: asked.filter((id) => { const key = appKeyForSource(id); return !key || toolOn(off, key); }) };
}

export function guardSources(tool: AnyHubTool): AnyHubTool {
  if (tool.name === "hub_fetch_now") {
    return { ...tool, run: (ctx, input) => tool.run(ctx, syncableSources(ctx, (input ?? {}) as Input) as never) } as AnyHubTool;
  }
  if (!REACHES[tool.name]) return tool;
  return {
    ...tool,
    ...(tool.preview
      ? {
          preview: async (ctx: ToolContext, input: unknown) => {
            await refuseSwitchedOff(ctx, tool.name, input);
            return tool.preview!(ctx, input as never);
          },
        }
      : {}),
    run: async (ctx: ToolContext, input: unknown) => {
      await refuseSwitchedOff(ctx, tool.name, input);
      return tool.run(ctx, input as never);
    },
  } as AnyHubTool;
}
