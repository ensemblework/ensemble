/**
 * Pages (standalone notes at /pages/<id>) and task pages, for the assistant: list, read as
 * Markdown in parts, create, append or replace, and move to Trash. Markdown becomes real page
 * blocks (pages/markdown.ts) and `[@Label](ensemble://kind/id)` links become mentions, kept only
 * when the id is in this space. Writes run in the Apply transaction with an undo entry.
 */
import { z } from "zod";
import { mentionAlias, PageDocument, restoreMentionLinks, type PageNode } from "@ensemble/shared-types";
import type { Prisma } from "@prisma/client";
import { separateLists } from "../../imports/markdown.js";
import { clip } from "../../lib/office/text.js";
import { sseHub } from "../../lib/sse.js";
import { lastUndoId, recordUndoInTransaction } from "../../lib/undo.js";
import { diagramSources } from "../../pages/agent-context.js";
import { filesOnPage } from "../../files/attached.js";
import { assertNewPageImages } from "../../files/page-image.js";
import { markdownToNodes, pageMarkdown } from "../../pages/markdown.js";
import { createStandalonePage, editablePage, trashStandalonePage, trashStandalonePages, writePageContent, type PageTarget } from "../../pages/store.js";
import { titlesMatch } from "../../services/tasks.js";
import { defineTool, inTransaction, toolOk, type ToolContext } from "../types.js";

type Db = ToolContext["prisma"] | Prisma.TransactionClient;

export const MAX_MARKDOWN = 100_000;
const PART = 6000;

/** Mention kinds and the table whose rows they name. A date mention names no row. */
const MENTION_TABLE: Record<string, string> = {
  people: "person",
  project: "project",
  task: "task",
  deliverable: "deliverable",
  repo: "repo",
  skill: "skill",
  diagram: "blockDiagram",
  plot: "plot",
  dataset: "plotDataset",
  file: "document",
};

const rowId = (kind: string, id: string) => (kind === "plot" ? (id.split("/")[0] ?? id) : id);

/** Markdown → a page document. `ensemble://person/…` and other aliases are read as their kind. */
export function markdownPage(markdown: string, lead: PageNode[] = []): PageDocument {
  const normalized = markdown.replace(/\]\(ensemble:\/\/([a-z_]+)\//gi, (whole, kind: string) => {
    const known = mentionAlias(kind);
    return known ? `](ensemble://${known}/` : whole;
  });
  const body = normalized.trim() ? markdownToNodes(separateLists(normalized)) : [];
  const content = [...lead, ...body];
  return restoreMentionLinks(PageDocument.parse({ type: "doc", content: content.length ? content : [{ type: "paragraph" }] }));
}

/**
 * Keeps mentions of rows in this space and turns the rest back into plain `@Label` text, so a
 * guessed or foreign id never becomes a card. Returns the labels that were dropped.
 */
export async function keepOwnMentions(db: Db, userId: string, doc: PageDocument): Promise<{ doc: PageDocument; dropped: string[] }> {
  const wanted = new Map<string, Set<string>>();
  const walk = (node: PageNode) => {
    if (node.type === "mention" && node.attrs) {
      const kind = String(node.attrs.kind ?? "");
      const id = rowId(kind, String(node.attrs.id ?? ""));
      if (MENTION_TABLE[kind] && id) wanted.set(kind, (wanted.get(kind) ?? new Set()).add(id));
    }
    node.content?.forEach(walk);
  };
  doc.content.forEach(walk);
  const owned = new Set<string>();
  for (const [kind, ids] of wanted) {
    const delegate = (db as unknown as Record<string, { findMany: (args: unknown) => Promise<Array<{ id: string }>> }>)[MENTION_TABLE[kind]!]!;
    const rows = await delegate.findMany({ where: { id: { in: [...ids].slice(0, 200) }, userId, deletedAt: null }, select: { id: true } });
    for (const row of rows) owned.add(`${kind}:${row.id}`);
  }
  const dropped: string[] = [];
  const keep = (node: PageNode): PageNode => {
    if (node.type === "mention" && node.attrs) {
      const kind = String(node.attrs.kind ?? "");
      if (kind === "date" || owned.has(`${kind}:${rowId(kind, String(node.attrs.id ?? ""))}`)) return node;
      const label = String(node.attrs.label ?? "");
      dropped.push(label || kind);
      return { type: "text", text: `@${label}` };
    }
    return node.content ? { ...node, content: node.content.map(keep) } : node;
  };
  return { doc: { type: "doc", content: doc.content.map(keep) }, dropped };
}

const droppedNote = (dropped: string[]) =>
  dropped.length ? ` ${dropped.length} link(s) did not match anything in this space and stay as text: ${dropped.slice(0, 5).join(", ")}.` : "";

const Target = {
  pageId: z.string().uuid().optional().describe("A page id from hub_list_pages (or a task page's id)."),
  taskId: z.string().uuid().optional().describe("A task id, for that task's page."),
};

function target(input: { pageId?: string; taskId?: string }): PageTarget {
  if (input.pageId && input.taskId) throw Object.assign(new Error("Pass pageId or taskId, not both."), { statusCode: 400 });
  if (input.pageId) return { pageId: input.pageId };
  if (input.taskId) return { taskId: input.taskId };
  throw Object.assign(new Error("Pass pageId (from hub_list_pages) or taskId (for a task's page)."), { statusCode: 400 });
}

const hrefOf = (page: { id: string; taskId: string | null }) => (page.taskId ? `/tasks/${page.taskId}` : `/pages/${page.id}`);

function titleGuard(matchTitle: string, title: string): void {
  if (!titlesMatch(matchTitle, title)) {
    throw Object.assign(new Error(`That page is “${title}”, not “${matchTitle}”. Call hub_list_pages with query set to the title and use the id it returns.`), { statusCode: 409 });
  }
}

/** The page's blocks now, for appending: a task with no page starts from its notes. */
function currentBlocks(content: PageDocument | null, notes: string): PageNode[] {
  const base = content?.content ?? (notes.trim() ? markdownToNodes(notes) : []);
  return base.filter((node) => !(node.type === "paragraph" && !node.content?.length && base.length === 1));
}

/**
 * Adds Markdown to the end of a task's page inside the caller's transaction. Whatever the
 * assistant writes about a task lands here; the short description stays the person's.
 */
export async function appendToTaskPage(tx: Prisma.TransactionClient, userId: string, taskId: string, markdown: string): Promise<{ dropped: string[] }> {
  if (!markdown.trim()) return { dropped: [] };
  const added = await keepOwnMentions(tx, userId, markdownPage(markdown));
  await writePageContent(tx, userId, { taskId }, (current) => ({ content: { type: "doc", content: [...currentBlocks(current.content, current.notes), ...added.doc.content] } }), "agent");
  sseHub.publish(userId, { event: "page", data: { taskId, action: "save", by: "agent" } });
  return { dropped: added.dropped };
}

export { droppedNote };

export const pageTools = [
  defineTool({
    name: "hub_list_pages",
    area: "projects",
    description: "List the person's pages (standalone notes), newest first. query matches the title and text. Read one with hub_read_page. A task's page is read with hub_read_page taskId.",
    input: z.object({
      query: z.string().max(200).default("").describe("Words in the title or text. Empty lists the newest."),
      limit: z.number().int().min(1).max(50).default(20),
      offset: z.number().int().min(0).max(1000).default(0),
    }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const query = input.query.trim();
      const where = {
        userId: ctx.userId,
        taskId: null,
        deletedAt: null,
        ...(query ? { OR: [{ title: { contains: query, mode: "insensitive" as const } }, { searchText: { contains: query, mode: "insensitive" as const } }] } : {}),
      };
      const [rows, total] = await Promise.all([
        ctx.prisma.taskPage.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], skip: input.offset, take: input.limit, select: { id: true, title: true, updatedAt: true, parentId: true } }),
        ctx.prisma.taskPage.count({ where }),
      ]);
      const pages = rows.map((row) => ({ id: row.id, parentId: row.parentId, title: row.title || "Untitled", updated: row.updatedAt.toISOString().slice(0, 10) }));
      const next = input.offset + rows.length;
      return toolOk(`Found ${rows.length} of ${total} page(s).`, { pages, total, ...(next < total ? { nextOffset: next } : {}) });
    },
  }),
  defineTool({
    name: "hub_read_page",
    area: "projects",
    description:
      "Read a page as Markdown by pageId, or a task's page by taskId. Long pages come in parts: pass nextOffset as offset. Mentions show as [@Label](ensemble://kind/id) and images as ![description](ensemble://file/id) with {width align} after; a file's id there works with hub_read_file.",
    input: z.object({ ...Target, offset: z.number().int().min(0).default(0) }),
    isWrite: false,
    risk: "low",
    async run(ctx, input) {
      const { task, page } = await editablePage(ctx.prisma, ctx.userId, target(input));
      const title = task ? task.title : page?.title || "Untitled";
      const doc = page?.content ? PageDocument.parse(page.content) : null;
      const markdown = pageMarkdown(doc, task ? task.notes : (page?.notesSnapshot ?? ""));
      const part = clip(markdown, input.offset, PART);
      const ref = { id: page?.id ?? "", taskId: task?.id ?? null };
      return toolOk(`Read “${title.slice(0, 80)}”.`, {
        pageId: page?.id ?? null,
        taskId: task?.id ?? null,
        title,
        updated: page?.updatedAt.toISOString().slice(0, 10) ?? null,
        text: part.text,
        ...(input.offset === 0 ? { diagramSources: await diagramSources(ctx.prisma, ctx.userId, doc), files: page ? await filesOnPage(ctx.prisma, ctx.userId, page.id) : [] } : {}),
        offset: part.offset,
        total: part.total,
        ...(part.nextOffset !== undefined ? { nextOffset: part.nextOffset } : {}),
        ...(page?.taskId === null && page.sourceFileId ? { madeFromFileId: page.sourceFileId } : {}),
      }, { href: hrefOf(ref) });
    },
  }),
  defineTool({
    name: "hub_create_page",
    area: "projects",
    description:
      "Create a page (standalone note) from a title and Markdown: headings, lists, - [ ] checklists, tables and fenced code become real blocks. Attach things with links like [@report.pdf](ensemble://file/<fileId>) or [@Mira](ensemble://people/<personId>); they become cards. Show an image from Files (PNG, JPEG, GIF or WebP up to 2 MB) with ![description](ensemble://file/<fileId>) on its own line. Returns the page id and link.",
    input: z.object({
      title: z.string().trim().min(1).max(200),
      markdown: z.string().max(MAX_MARKDOWN).default("").describe("The page body in Markdown."),
    }),
    isWrite: true,
    risk: "low",
    undoable: true,
    preview(_ctx, input) {
      const blocks = input.markdown.trim() ? markdownPage(input.markdown).content.length : 0;
      return `Create page “${input.title}”${blocks ? ` (${blocks} block${blocks === 1 ? "" : "s"})` : ""}`;
    },
    async run(ctx, input) {
      const created = await inTransaction(ctx, async (tx) => {
        const { doc, dropped } = await keepOwnMentions(tx, ctx.userId, markdownPage(input.markdown));
        await assertNewPageImages(tx, ctx.userId, doc, null);
        const page = await createStandalonePage(tx, ctx.userId, { title: input.title, content: doc, sourceFileId: null });
        const op = { op: "create" as const, model: "taskPage" as const, id: page.id, data: { updatedAt: page.updatedAt } };
        await recordUndoInTransaction(tx, { userId: ctx.userId, label: `Created “${page.title}”`, kind: "create", actor: "agent", subject: "page", href: `/pages/${page.id}`, inverse: op, forward: op });
        return { page, dropped, undoEntryId: lastUndoId(tx) };
      });
      sseHub.publish(ctx.userId, { event: "page", data: { id: created.page.id, action: "create" } });
      return toolOk(`Created page “${created.page.title}”.${droppedNote(created.dropped)}`, { id: created.page.id, title: created.page.title, href: `/pages/${created.page.id}` }, {
        href: `/pages/${created.page.id}`,
        invalidate: ["pages"],
        ...(created.undoEntryId ? { undoEntryId: created.undoEntryId } : {}),
      });
    },
  }),
  defineTool({
    name: "hub_update_page",
    area: "projects",
    description:
      "Add to or rewrite a page (pageId) or a task's page (taskId) with Markdown. mode append adds at the end; replace rewrites the whole page, so read it first and keep its [@Label](ensemble://kind/id) links and ![…](ensemble://file/id){…} image lines as they are. matchTitle must be the page's current title (for a task page, the task title); the write is refused when it differs. title renames a standalone page.",
    input: z.object({
      ...Target,
      matchTitle: z.string().trim().min(1).max(200).describe("The page's current title. Refused when it is not the title of that page."),
      mode: z.enum(["append", "replace"]),
      markdown: z.string().min(1).max(MAX_MARKDOWN),
      title: z.string().trim().min(1).max(200).optional().describe("A new title (standalone pages only)."),
    }),
    isWrite: true,
    risk: "medium",
    undoable: true,
    async preview(ctx, input) {
      const { task, page } = await editablePage(ctx.prisma, ctx.userId, target(input));
      const title = task ? task.title : page?.title || "Untitled";
      titleGuard(input.matchTitle, title);
      if (task && input.title) throw Object.assign(new Error("A task page keeps its task's title. Rename the task with hub_update_task."), { statusCode: 400 });
      const first = input.markdown.trim().split("\n")[0]!.replace(/^#+\s*/, "").slice(0, 80);
      const rename = input.title && input.title !== title ? `, renamed “${input.title}”` : "";
      return input.mode === "append" ? `Add to “${title}”${rename}: ${first}` : `Rewrite the whole of “${title}”${rename} (its current content is replaced)`;
    },
    async run(ctx, input) {
      const where = target(input);
      const result = await inTransaction(ctx, async (tx) => {
        const added = await keepOwnMentions(tx, ctx.userId, markdownPage(input.markdown));
        const saved = await writePageContent(
          tx,
          ctx.userId,
          where,
          (current) => {
            titleGuard(input.matchTitle, current.title);
            if (current.taskId && input.title) throw Object.assign(new Error("A task page keeps its task's title. Rename the task with hub_update_task."), { statusCode: 400 });
            const content = input.mode === "append" ? [...currentBlocks(current.content, current.notes), ...added.doc.content] : added.doc.content;
            return { content: { type: "doc", content }, title: input.title };
          },
          "agent",
        );
        return { saved, dropped: added.dropped, undoEntryId: lastUndoId(tx) };
      });
      const { saved } = result;
      sseHub.publish(ctx.userId, { event: "page", data: { id: saved.id, ...(saved.taskId ? { taskId: saved.taskId } : {}), action: "save", by: "agent" } });
      return toolOk(`${input.mode === "append" ? "Added to" : "Rewrote"} “${saved.title}”.${droppedNote(result.dropped)}`, { id: saved.id, taskId: saved.taskId, title: saved.title }, {
        href: hrefOf(saved),
        invalidate: ["pages"],
        ...(result.undoEntryId ? { undoEntryId: result.undoEntryId } : {}),
      });
    },
  }),
  defineTool({
    name: "hub_delete_page",
    area: "projects",
    description: "Move a page (standalone note) and its nested pages to Trash by pageId. One Undo restores them together. A task's page goes with its task (hub_delete_task).",
    input: z.object({ pageId: z.string().uuid() }),
    isWrite: true,
    risk: "medium",
    undoable: true,
    async preview(ctx, input) {
      const { task, page } = await editablePage(ctx.prisma, ctx.userId, { pageId: input.pageId });
      if (task) throw Object.assign(new Error(`That is the page of task “${task.title}”. Delete the task with hub_delete_task, or clear the page with hub_update_page.`), { statusCode: 400 });
      return `Move page “${page?.title || "Untitled"}” to Trash`;
    },
    async run(ctx, input) {
      const result = await inTransaction(ctx, async (tx) => {
        const { task } = await editablePage(tx, ctx.userId, { pageId: input.pageId });
        if (task) throw Object.assign(new Error(`That is the page of task “${task.title}”. Delete the task with hub_delete_task.`), { statusCode: 400 });
        const trashed = await trashStandalonePage(tx, ctx.userId, input.pageId, "agent");
        return { ...trashed, undoEntryId: lastUndoId(tx) };
      });
      sseHub.publish(ctx.userId, { event: "page", data: { id: input.pageId, action: "delete" } });
      return toolOk(`Moved “${result.title}” to Trash.`, { id: input.pageId, restore: "Undo in the app bar, or Trash (/trash), brings it back." }, {
        invalidate: ["pages"],
        ...(result.undoEntryId ? { undoEntryId: result.undoEntryId } : {}),
      });
    },
  }),
  defineTool({
    name: "hub_delete_pages",
    area: "projects",
    description: "Move multiple standalone pages and their nested pages to Trash together. Use pageIds returned by hub_list_pages. One Undo in the top bar restores the entire batch, including nesting and attachments. Task pages are deleted with their tasks.",
    input: z.object({ pageIds: z.array(z.string().uuid()).min(1).max(100) }),
    isWrite: true,
    risk: "medium",
    undoable: true,
    async preview(ctx, input) {
      const ids = [...new Set(input.pageIds)];
      const pages = await ctx.prisma.taskPage.findMany({ where: { userId: ctx.userId, id: { in: ids }, taskId: null, deletedAt: null }, select: { title: true } });
      if (pages.length !== ids.length) throw new Error("One or more pages are unavailable. Call hub_list_pages and use the returned ids.");
      return `Move ${ids.length} pages and their nested pages to Trash: ${pages.map((page) => page.title || "Untitled").join(", ")}. One Undo restores them all.`;
    },
    async run(ctx, input) {
      const result = await inTransaction(ctx, (tx) => trashStandalonePages(tx, ctx.userId, input.pageIds, "agent"));
      sseHub.publish(ctx.userId, { event: "page", data: { action: "delete", ids: result.pages.map((page) => page.id) } });
      return toolOk(`Moved ${result.pages.length} pages to Trash. One Undo restores them all.`, { pages: result.pages, restore: "Undo in the top bar restores the whole batch." }, { invalidate: ["pages"], ...(result.undoEntryId ? { undoEntryId: result.undoEntryId } : {}) });
    },
  }),
];
