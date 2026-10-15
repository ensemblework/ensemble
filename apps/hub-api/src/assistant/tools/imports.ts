/**
 * Bringing things in from connected apps, for the assistant: a file or email attachment into
 * Files (files/import.ts, the same as POST /api/documents/import), and an app item (a Notion
 * page, a GitHub issue, a Confluence page…) as an Ensemble page through the items registry
 * (connectors/items). Both call the vendor, so on Apply they run after the batch's transaction.
 */
import { z } from "zod";
import { APP_ITEM_KIND_LABEL, type AppItemKind } from "@ensemble/shared-types";
import { itemSource, readItem, readNotionPages } from "../../connectors/items/index.js";
import { finishPageImport, newWriterState, writePages } from "../../imports/apply.js";
import { emptyCounts } from "../../imports/types.js";
import { MAX_ITEM_TEXT } from "../../connectors/items/types.js";
import { importFromApp, importSources } from "../../files/import.js";
import { describeFile } from "../../files/attached.js";
import { fileUsage } from "../../files/store.js";
import { requireVerifiedUser } from "../../lib/hosted-access.js";
import { HostedLimitError, sizeLabel } from "../../lib/hosted-limits.js";
import { sseHub } from "../../lib/sse.js";
import { lastUndoId, recordUndoInTransaction, withUndoGroup } from "../../lib/undo.js";
import { createStandalonePage } from "../../pages/store.js";
import { defineTool, toolOk, type ToolContext } from "../types.js";
import { keepOwnMentions, markdownPage } from "./pages.js";

const FILE_SOURCES = ["google_workspace", "microsoft_365", "dropbox", "box"] as const;
const ITEM_KINDS = (Object.keys(APP_ITEM_KIND_LABEL) as AppItemKind[]).filter((kind) => kind !== "person") as [AppItemKind, ...AppItemKind[]];
const PAGE_SOURCE = "app-item";

function refused(message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { statusCode });
}

/** Refuses before Apply when the app cannot be used yet, with what to do about it. */
async function assertImportable(ctx: ToolContext, ref: { source: string; kind: "file" | "attachment" }): Promise<string> {
  const sources = await importSources(ctx.prisma, ctx.userId);
  const spec = sources.find((row) => row.itemSource === ref.source && row.kind === ref.kind);
  if (!spec) throw refused(ref.kind === "attachment" ? "Email attachments come from Gmail (google_workspace) or Outlook (microsoft_365)." : "Files come from Google Drive (google_workspace), OneDrive (microsoft_365), Dropbox or Box.");
  if (spec.state !== "ready") throw refused(`${spec.message}${spec.steps?.length ? ` Steps: ${spec.steps.join(" ")}` : ""} (${spec.action?.href ?? "/settings?tab=connections"})`, 409);
  return spec.name;
}

/** Hosted accounts keep a few files; say so before Apply rather than after a download. */
async function assertRoom(ctx: ToolContext): Promise<void> {
  const usage = await fileUsage(ctx.prisma, ctx.userId);
  if (usage.maxCount !== null && usage.count >= usage.maxCount) {
    throw refused(`This account keeps ${usage.count} of ${usage.maxCount} files allowed on the hosted plan (${sizeLabel(usage.bytes)} of ${sizeLabel(usage.maxBytes ?? 0)}). Remove a file in Files (/files) to bring another in.`, 429);
  }
}

const itemHref = (url: string | undefined) => (url && /^https:\/\//i.test(url) ? url : undefined);

/** The item's Markdown without its own leading `# Title`, which the page title already says. */
function itemBody(title: string, text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.replace(/^#\s+/, "").trim() === title.trim()) lines.shift();
  return lines.join("\n").trim();
}

async function saveNotion(ctx: ToolContext, input: { id: string; kind: "page" | "database"; title?: string }) {
  const items = await readNotionPages(ctx.userId, input);
  if (!items.length) throw refused("That Notion page is archived or has no accessible content.");
  if (input.title) items[0]!.title = input.title;
  const state = newWriterState(ctx.userId, { externalSource: "notion", sourceKind: "notion", sourceLabel: "Notion", statusMap: {}, importAs: { pages: "pages" } }, emptyCounts());
  const result = await ctx.prisma.$transaction(async (tx) => {
    const before = await tx.taskPage.findMany({ where: { userId: ctx.userId, externalSource: "notion", externalId: { in: items.map((item) => item.externalId) } } });
    return withUndoGroup(tx, { userId: ctx.userId, actor: "agent", subject: "page" }, async () => {
      await writePages(tx, state, items);
      await finishPageImport(tx, state);
      for (const id of state.created.pages) {
        const page = await tx.taskPage.findUniqueOrThrow({ where: { id } });
        const op = { op: "create" as const, model: "taskPage" as const, id, data: { updatedAt: page.updatedAt } };
        await recordUndoInTransaction(tx, { userId: ctx.userId, label: `Imported “${page.title}”`, kind: "create", actor: "agent", subject: "page", inverse: op, forward: op });
      }
      for (const previous of before) {
        const after = await tx.taskPage.findUniqueOrThrow({ where: { id: previous.id } });
        if (after.updatedAt.getTime() === previous.updatedAt.getTime()) continue;
        const op = { op: "update" as const, model: "taskPage" as const, id: previous.id, before: { title: previous.title, content: previous.content, revision: previous.revision, annotations: previous.annotations, searchText: previous.searchText, parentId: previous.parentId }, after: { title: after.title, content: after.content, revision: after.revision, annotations: after.annotations, searchText: after.searchText, parentId: after.parentId, updatedAt: after.updatedAt } };
        await recordUndoInTransaction(tx, { userId: ctx.userId, label: `Updated “${after.title}” from Notion`, kind: "update", actor: "agent", subject: "page", inverse: op, forward: op });
      }
      const page = await tx.taskPage.findFirstOrThrow({ where: { userId: ctx.userId, externalSource: "notion", externalId: items[0]!.externalId }, include: { task: { select: { title: true, deletedAt: true } } } });
      if (page.deletedAt || page.task?.deletedAt) throw refused("This imported page is in Trash. Restore it before importing it again.", 409);
      return { id: page.id, title: page.task?.title ?? page.title, taskId: page.taskId };
    });
  }, { timeout: 120_000 });
  const href = result.result.taskId ? `/tasks/${result.result.taskId}` : `/pages/${result.result.id}`;
  sseHub.publish(ctx.userId, { event: "page", data: { id: result.result.id, action: "import" } });
  return toolOk(`Imported “${result.result.title}” and its nested pages from Notion. Tables and formatting are preserved.`, { ...result.result, href, pages: items.length, counts: state.counts }, { href, invalidate: ["pages"], ...(result.undoEntryId ? { undoEntryId: result.undoEntryId } : {}) });
}

export const importTools = [
  defineTool({
    name: "hub_import_app_file",
    area: "context",
    description:
      "Save a copy of a file from a connected app in Files: a Drive, OneDrive, Dropbox or Box file (kind file) or a Gmail or Outlook attachment (kind attachment). source, kind and id come from an apps_search hit (source google_workspace, microsoft_365, dropbox or box). Returns the file id and link. Hosted accounts keep at most 10 files and 50 MB.",
    input: z.object({
      source: z.enum(FILE_SOURCES),
      kind: z.enum(["file", "attachment"]),
      id: z.string().trim().min(1).max(300),
      name: z.string().trim().max(300).optional().describe("The file name from the search hit, for the preview."),
    }),
    isWrite: true,
    risk: "low",
    outsideTransaction: true,
    async preview(ctx, input) {
      const app = await assertImportable(ctx, input);
      await assertRoom(ctx);
      return `Bring ${input.name ? `“${input.name}”` : `the ${input.kind === "attachment" ? "attachment" : "file"} ${input.id}`} from ${app} into Files`;
    },
    async run(ctx, input) {
      await requireVerifiedUser(ctx.userId);
      const app = await assertImportable(ctx, input);
      let imported;
      try {
        imported = await importFromApp(ctx.prisma, ctx.userId, { source: input.source, kind: input.kind, id: input.id });
      } catch (error) {
        if (error instanceof HostedLimitError) throw refused(`${error.message} Remove a file in Files (/files) to make room.`, 429);
        throw error;
      }
      const { file, existing } = imported;
      const details = describeFile({ filename: file.filename, byteSize: file.byteSize, pageCount: file.pageCount });
      return toolOk(existing ? `“${file.filename}” was already in Files.` : `Saved “${file.filename}” from ${app} in Files.`, {
        id: file.id,
        name: file.filename,
        details,
        text: file.textStatus,
        existing,
        href: `/files/${file.id}`,
        ...(file.textStatus === "queued" ? { note: "Ensemble is still reading its text; hub_read_file works in a minute." } : {}),
      }, { href: `/files/${file.id}`, invalidate: ["documents"] });
    },
  }),
  defineTool({
    name: "hub_save_app_item_as_page",
    area: "context",
    description:
      "Save an item from a connected app as an Ensemble page. Notion pages include nested pages and native formatting; Notion databases become ordinary editable tables with linked row pages. source, kind and id come from apps_search; title overrides the root title. Re-imports keep local edits and avoid copies.",
    input: z.object({
      source: z.string().trim().min(1).max(40).regex(/^[a-z0-9_]+$/).describe("The app id from apps_search, e.g. notion, github, atlassian."),
      kind: z.enum(ITEM_KINDS),
      id: z.string().trim().min(1).max(300),
      title: z.string().trim().min(1).max(200).optional(),
    }),
    isWrite: true,
    risk: "low",
    undoable: true,
    outsideTransaction: true,
    async preview(ctx, input) {
      const app = itemSource(input.source);
      if (!app) throw refused(`Ensemble cannot read ${input.source}. Use the app id from apps_search.`);
      if (!app.kinds.includes(input.kind)) throw refused(`${app.label} has no ${APP_ITEM_KIND_LABEL[input.kind].toLowerCase()} items. Use the kind from apps_search.`);
      return `Save the ${app.label} ${APP_ITEM_KIND_LABEL[input.kind].toLowerCase()} ${input.title ? `“${input.title}”` : input.id} as a page`;
    },
    async run(ctx, input) {
      if (input.source === "notion" && (input.kind === "page" || input.kind === "database")) return saveNotion(ctx, { ...input, kind: input.kind });
      const externalId = `${input.source}:${input.kind}:${input.id}`.slice(0, 500);
      const kept = await ctx.prisma.taskPage.findFirst({ where: { userId: ctx.userId, externalSource: PAGE_SOURCE, externalId }, select: { id: true, title: true, deletedAt: true, taskId: true } });
      if (kept && !kept.deletedAt) {
        const href = kept.taskId ? `/tasks/${kept.taskId}` : `/pages/${kept.id}`;
        return toolOk(`“${kept.title || "That item"}” was already saved${kept.taskId ? " (it is a task's page now)" : " as a page"}.`, { id: kept.id, title: kept.title, existing: true, href }, { href });
      }
      const label = itemSource(input.source)?.label ?? input.source;
      const item = await readItem(ctx.userId, { source: input.source, kind: input.kind, id: input.id });
      const title = (input.title ?? item.title).slice(0, 200) || "Untitled";
      const url = itemHref(item.url);
      const body = itemBody(item.title, item.text);
      const cut = item.text.length >= MAX_ITEM_TEXT ? `\n\n*Ensemble kept the first ${MAX_ITEM_TEXT.toLocaleString("en-US")} characters; open the original for the rest.*` : "";
      const markdown = `*From ${label}*${url ? ` · [Open in ${label}](${url})` : ""}\n\n${body}${cut}`;
      const created = await ctx.prisma.$transaction(async (tx) => {
        const { doc } = await keepOwnMentions(tx, ctx.userId, markdownPage(markdown));
        // A copy in Trash gives up the link to the item, so saving again makes a fresh page.
        if (kept) await tx.taskPage.update({ where: { id: kept.id }, data: { externalSource: null, externalId: null } });
        const page = await createStandalonePage(tx, ctx.userId, { title, content: doc, sourceFileId: null, externalSource: PAGE_SOURCE, externalId });
        const op = { op: "create" as const, model: "taskPage" as const, id: page.id, data: { updatedAt: page.updatedAt } };
        await recordUndoInTransaction(tx, { userId: ctx.userId, label: `Saved “${page.title}” from ${label}`, kind: "create", actor: "agent", subject: "page", href: `/pages/${page.id}`, inverse: op, forward: op });
        return { page, undoEntryId: lastUndoId(tx) };
      });
      sseHub.publish(ctx.userId, { event: "page", data: { id: created.page.id, action: "create" } });
      return toolOk(`Saved “${created.page.title}” from ${label} as a page.`, { id: created.page.id, title: created.page.title, href: `/pages/${created.page.id}`, ...(url ? { original: url } : {}) }, {
        href: `/pages/${created.page.id}`,
        invalidate: ["pages"],
        ...(created.undoEntryId ? { undoEntryId: created.undoEntryId } : {}),
      });
    },
  }),
];
