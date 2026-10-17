import { z } from "zod";
import { PageDocument, type PageNode } from "@ensemble/shared-types";
import { editablePage, writePageContent } from "../../pages/store.js";
import { pageMarkdown } from "../../pages/markdown.js";
import { sseHub } from "../../lib/sse.js";
import { defineTool, inTransaction, toolOk } from "../types.js";
import { markdownPage, keepOwnMentions } from "./pages.js";
import { pageSchema } from "../../pages/schema.js";

const Target = z.object({ pageId: z.string().uuid().optional(), taskId: z.string().uuid().optional() }).refine(row => Boolean(row.pageId) !== Boolean(row.taskId), "Send pageId or taskId.");
const target = (input: z.infer<typeof Target>) => input.pageId ? { pageId: input.pageId } : { taskId: input.taskId! };
const text = (node: PageNode): string => pageMarkdown({ type: "doc", content: [node] }, "");
const Edit = z.object({ path: z.array(z.number().int().nonnegative()).min(1).max(16), action: z.enum(["replace", "insert_before", "insert_after", "delete", "replace_text"]), expected: z.string().max(30_000), markdown: z.string().max(30_000).default(""), find: z.string().min(1).max(10_000).optional(), replacement: z.string().max(10_000).optional() });

function listAt(doc: PageDocument, path: number[]): { rows: PageNode[]; index: number } {
  let rows = doc.content;
  for (const at of path.slice(0, -1)) { if (!rows[at]?.content) throw new Error("That block path changed. Read the page again."); rows = rows[at]!.content!; }
  const index = path.at(-1)!;
  if (!rows[index] || rows[index]!.type === "text") throw new Error("Use a block path from hub_read_page_blocks.");
  return { rows, index };
}

export function replaceBlockText(node: PageNode, find: string, replacement: string) {
  const leaves: PageNode[] = [];
  const walk = (value: PageNode) => { if (value.type === "text") leaves.push(value); else value.content?.forEach(walk); };
  walk(node);
  const joined = leaves.map(row => row.text ?? "").join("");
  const start = joined.indexOf(find);
  if (start < 0 || joined.indexOf(find, start + 1) >= 0) throw new Error("The text must match exactly once in that block.");
  let offset = 0;
  let inserted = false;
  for (const leaf of leaves) {
    const body = leaf.text ?? "";
    const a = Math.max(0, start - offset), b = Math.min(body.length, start + find.length - offset);
    if (a < b) { leaf.text = body.slice(0, a) + (inserted ? "" : replacement) + body.slice(b); inserted = true; }
    offset += body.length;
  }
  const clean = (value: PageNode) => { if (value.content) { value.content = value.content.filter(row => row.type !== "text" || Boolean(row.text)); value.content.forEach(clean); } };
  clean(node);
}

async function editedDocument(db: Parameters<typeof keepOwnMentions>[0], userId: string, doc: PageDocument, edits: z.infer<typeof Edit>[]) {
  for (const edit of edits) {
    const { rows, index } = listAt(doc, edit.path);
    if (text(rows[index]!) !== edit.expected) throw new Error("That block changed. Read the page again.");
    if (edit.action === "replace_text") { if (!edit.find) throw new Error("replace_text needs find and replacement."); replaceBlockText(rows[index]!, edit.find, edit.replacement ?? ""); continue; }
    const added = edit.action === "delete" ? [] : (await keepOwnMentions(db, userId, markdownPage(edit.markdown))).doc.content;
    rows.splice(edit.action === "insert_after" ? index + 1 : index, edit.action === "replace" || edit.action === "delete" ? 1 : 0, ...added);
  }
  if (!doc.content.length) doc.content = [{ type: "paragraph" }];
  try { pageSchema.nodeFromJSON(doc).check(); } catch { throw new Error("That edit would break a list or table. Edit its paragraph, or replace the complete list/table block."); }
  return doc;
}

export const pageEditTools = [
  defineTool({ name: "hub_read_page_blocks", area: "projects", description: "Read a document's editable blocks and revision. Paths identify nested blocks; exact Markdown is the expected value for hub_edit_page. Reads saved page/task content, not screen pixels.", input: z.object({ pageId: z.string().uuid().optional(), taskId: z.string().uuid().optional(), offset: z.number().int().nonnegative().default(0) }), isWrite: false, risk: "low", async run(ctx, input) {
    Target.parse(input);
    const { page, task } = await editablePage(ctx.prisma, ctx.userId, target(input));
    const doc = page?.content ? PageDocument.parse(page.content) : markdownPage(task?.notes ?? "");
    const blocks: Array<{ path: number[]; type: string; markdown: string }> = [];
    const walk = (rows: PageNode[], prefix: number[] = []) => rows.forEach((row, index) => { const path = [...prefix, index]; if (row.type !== "text") { blocks.push({ path, type: row.type, markdown: text(row) }); if (row.content?.some(child => child.type !== "text")) walk(row.content, path); } });
    walk(doc.content);
    const rows = blocks.slice(input.offset, input.offset + 20);
    return toolOk(`Read ${rows.length} blocks.`, { revision: page?.revision ?? 0, title: task?.title ?? page?.title, blocks: rows, ...(input.offset + rows.length < blocks.length ? { nextOffset: input.offset + rows.length } : {}) });
  } }),
  defineTool({ name: "hub_edit_page", area: "projects", description: "Edit specific document blocks without rewriting the page. Read hub_read_page_blocks; send its revision, paths and exact expected Markdown. Edits run in order. replace_text preserves formatting; find must occur once. Other actions use markdown.", input: z.object({ pageId: z.string().uuid().optional(), taskId: z.string().uuid().optional(), revision: z.number().int().nonnegative(), edits: z.array(Edit).min(1).max(30) }), isWrite: true, risk: "low", undoable: true,
    async preview(ctx, input) { Target.parse(input); const found = await editablePage(ctx.prisma, ctx.userId, target(input)); if ((found.page?.revision ?? 0) !== input.revision) throw new Error("The page changed. Read its blocks again before editing."); await editedDocument(ctx.prisma, ctx.userId, found.page?.content ? PageDocument.parse(found.page.content) : markdownPage(found.task?.notes ?? ""), input.edits); return `Edit ${input.edits.length} document block(s): ${input.edits.map(edit => `${edit.action} ${edit.path.join(".")}: ${edit.action === "replace_text" ? `${edit.find} → ${edit.replacement ?? ""}` : edit.markdown.slice(0, 160)}`).join("; ")}`; },
    async run(ctx, input) {
      Target.parse(input);
      const saved = await inTransaction(ctx, async tx => {
        const found = await editablePage(tx, ctx.userId, target(input), true);
        if ((found.page?.revision ?? 0) !== input.revision) throw new Error("The page changed. Read its blocks again before editing.");
        const doc = found.page?.content ? PageDocument.parse(found.page.content) : markdownPage(found.task?.notes ?? "");
        await editedDocument(tx, ctx.userId, doc, input.edits);
        return writePageContent(tx, ctx.userId, target(input), () => ({ content: doc }), "agent");
      });
      sseHub.publish(ctx.userId, { event: "page", data: { id: saved.id, taskId: saved.taskId, action: "save", revision: saved.revision } });
      return toolOk("Updated the selected blocks.", saved, { href: saved.taskId ? `/tasks/${saved.taskId}` : `/pages/${saved.id}`, invalidate: ["pages", "task-page"] });
    }
  }),
];
