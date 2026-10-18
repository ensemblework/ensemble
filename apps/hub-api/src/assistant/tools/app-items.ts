/**
 * Search and read across every connected app that Ensemble can search
 * (connectors/items), and post an update on a task's linked issue.
 *
 * Offered per person, like remote MCP tools: only when at least one such app is
 * connected. Reads run at once; posting an update is an outside write and waits for Apply.
 */
import { z } from "zod";
import { APP_ITEM_KIND_LABEL, type AppItemKind, type AppItemSourceInfo } from "@ensemble/shared-types";
import { connectedItemSources, postUpdate, readItem, searchItems, updateTargetFor } from "../../connectors/items/index.js";
import { clip } from "../../lib/office/text.js";
import { defineTool, toolOk, type AnyHubTool, type ToolContext } from "../types.js";
import { UNTRUSTED_NOTE, quote } from "./apps-common.js";

export const APP_ITEM_TOOL_PREFIX = "apps_";

const KINDS = ["page", "database", "repo", "issue", "pull_request", "board", "card", "project", "task", "file", "channel", "ticket", "conversation", "contact", "company", "deal", "design", "deployment", "dashboard", "work_item", "invoice", "record", "meeting", "video", "attachment", "reference", "collection"] as const satisfies readonly AppItemKind[];

function names(sources: readonly AppItemSourceInfo[]): string {
  const list = sources.map((source) => source.name);
  return list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : (list[0] ?? "");
}

/** Words that ask for a listing rather than name something to find: "all my recent projects". */
const LISTING_WORDS = new Set(["all", "any", "every", "everything", "my", "our", "the", "recent", "latest", "newest", "list", "show", "me", "items", "item", "in", "on", "from", "of", "and", "*"]);

const KIND_WORDS = new Map<string, AppItemKind>(
  (Object.keys(APP_ITEM_KIND_LABEL) as AppItemKind[]).flatMap((kind) => {
    const label = APP_ITEM_KIND_LABEL[kind].toLowerCase().replace(/ /g, "_");
    const plural = kind === "person" ? "people" : /[^aeiou]y$/.test(label) ? `${label.slice(0, -1)}ies` : `${label}s`;
    return [kind, `${kind}s`, label, plural].map((word) => [word, kind] as [string, AppItemKind]);
  }),
);
KIND_WORDS.set("prs", "pull_request");

/**
 * A query the model wrote that only asks for a listing ("projects", "all my Vercel deployments",
 * "*") is sent as an empty query, which every app answers with recent items; a single kind it
 * names becomes the kind. Null when the query has words to search for.
 */
export function listingRequest(q: string, appNames: readonly string[]): { kind?: AppItemKind } | null {
  const text = q.toLowerCase().replace(/pull[ -]requests?/g, "pull_request").replace(/work[ -]items?/g, "work_item").replace(/email attachments?/g, "attachment");
  const words = text.split(/[\s,;:!?"'()]+/).filter(Boolean);
  const kinds = new Set<AppItemKind>();
  for (const word of words) {
    const kind = KIND_WORDS.get(word);
    if (kind) kinds.add(kind);
    else if (!LISTING_WORDS.has(word) && !appNames.includes(word)) return null;
  }
  return kinds.size === 1 ? { kind: [...kinds][0] } : {};
}

export function appItemTools(sources: readonly AppItemSourceInfo[]): AnyHubTool[] {
  if (!sources.length) return [];
  const ids = sources.map((source) => source.id) as [string, ...string[]];
  const kinds = [...new Set(sources.flatMap((source) => source.kinds))].join(", ");
  const search = defineTool({
    name: "apps_search",
    area: "apps",
    description: `Search the person's connected apps (${names(sources)}) for pages, repositories, issues and more (${kinds}). Leave app empty to search them all. A link or id (a GitHub URL, ENG-42, a Notion URL) finds that item. Then read a hit with apps_read.`,
    input: z.object({
      query: z.string().max(300).describe("Words to look for, or a link or id. Empty lists recent items."),
      app: z.enum(ids).optional().describe("One app to search"),
      kind: z.enum(KINDS).optional(),
      limit: z.number().int().min(1).max(25).default(10),
    }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const scope = input.app ? sources.filter((source) => source.id === input.app) : sources;
      const listing = listingRequest(input.query, scope.flatMap((source) => [source.id, ...source.name.toLowerCase().split(/[^\p{L}\p{N}.]+/u)]));
      const kind = input.kind ?? (listing?.kind && scope.some((source) => source.kinds.includes(listing.kind!)) ? listing.kind : undefined);
      const result = await searchItems(ctx.userId, { source: input.app, q: listing ? "" : input.query, kind, limit: input.limit });
      const failed = result.errors.map((row) => `${row.source}: ${row.message}`);
      return toolOk(`Found ${result.items.length} item(s)${failed.length ? `; ${failed.length} app(s) failed` : ""}.`, {
        items: result.items,
        ...(failed.length ? { failed } : {}),
        note: UNTRUSTED_NOTE,
      });
    },
  });
  const read = defineTool({
    name: "apps_read",
    area: "apps",
    description: "Read one item from a connected app (source, kind and id from apps_search): its facts and text as Markdown. Long text comes in parts; pass nextOffset to continue.",
    input: z.object({
      app: z.enum(ids),
      kind: z.enum(KINDS),
      id: z.string().min(1).max(300),
      offset: z.number().int().min(0).default(0),
    }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const item = await readItem(ctx.userId, { source: input.app, kind: input.kind, id: input.id });
      const part = clip(item.text, input.offset, 6000);
      return toolOk(`Read ${quote(item.title)} from ${input.app}.`, {
        title: item.title,
        url: item.url,
        facts: item.facts,
        people: item.people,
        text: part.text,
        ...(part.nextOffset !== undefined ? { nextOffset: part.nextOffset } : {}),
        note: UNTRUSTED_NOTE,
      });
    },
  });
  const tools: AnyHubTool[] = [search, read];
  if (sources.some((source) => source.comments)) {
    tools.push(
      defineTool({
        name: "apps_post_update",
        area: "apps",
        description:
          "Post an update as a comment on the issue, card or ticket an Ensemble task came from (or has attached), for example what an agent finished. Waits for the person's Apply.",
        input: z.object({ taskId: z.string().uuid(), text: z.string().trim().min(1).max(5000) }),
        isWrite: true,
        risk: "medium",
        async preview(ctx: ToolContext, input) {
          const target = await updateTargetFor(ctx.userId, input.taskId);
          if (!target) return "This task is not linked to an issue Ensemble can comment on.";
          return `Comment on ${quote(target.title)} in ${target.source}: ${quote(input.text)}`;
        },
        async run(ctx, input) {
          const posted = await postUpdate(ctx.userId, input.taskId, input.text);
          return toolOk(`Posted the update in ${posted.source}.`, posted, posted.url ? { href: posted.url } : undefined);
        },
      }),
    );
  }
  return tools;
}

export async function appItemToolsForUser(ctx: Pick<ToolContext, "prisma" | "userId">): Promise<AnyHubTool[]> {
  return appItemTools(await connectedItemSources(ctx.userId, ctx.prisma));
}

export async function resolveAppItemTool(ctx: Pick<ToolContext, "prisma" | "userId">, name: string): Promise<AnyHubTool | undefined> {
  if (!name.startsWith(APP_ITEM_TOOL_PREFIX)) return undefined;
  return (await appItemToolsForUser(ctx)).find((tool) => tool.name === name);
}
