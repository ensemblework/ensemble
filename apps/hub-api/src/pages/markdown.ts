/**
 * Markdown from a model → page blocks, and the agent block a job owns.
 *
 * The agent never edits the engineer's own blocks. Its output lives in one
 * `agentBlock` per job, which the page renders tinted and labelled. Writing
 * again replaces that block in place; the engineer's edits elsewhere stay.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { PageDocument, type PageNode } from "@ensemble/shared-types";
import { sseHub } from "../lib/sse.js";

type Mark = { type: string; attrs?: Record<string, unknown> };

function inline(text: string): PageNode[] {
  const out: PageNode[] = [];
  const pattern = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)<>]+))/g;
  let last = 0;
  const push = (value: string, marks?: Mark[]) => {
    if (!value) return;
    out.push(marks?.length ? { type: "text", text: value, marks } : { type: "text", text: value });
  };
  for (const match of text.matchAll(pattern)) {
    push(text.slice(last, match.index));
    if (match[2] ?? match[3]) push((match[2] ?? match[3])!, [{ type: "bold" }]);
    else if (match[4] ?? match[5]) push((match[4] ?? match[5])!, [{ type: "italic" }]);
    else if (match[6]) push(match[6], [{ type: "code" }]);
    else if (match[7]) push(match[7], [{ type: "link", attrs: { href: match[8] } }]);
    else if (match[9]) push(match[9], [{ type: "link", attrs: { href: match[9] } }]);
    last = match.index! + match[0].length;
  }
  push(text.slice(last));
  return out;
}

const paragraph = (text: string): PageNode => {
  const content = inline(text);
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
};

function tableNode(rows: string[][]): PageNode {
  const width = Math.max(...rows.map((row) => row.length));
  return {
    type: "table",
    content: rows.map((row, index) => ({
      type: "tableRow",
      content: Array.from({ length: width }, (_, column) => ({
        type: index === 0 ? "tableHeader" : "tableCell",
        content: [paragraph(row[column] ?? "")],
      })),
    })),
  };
}

export function markdownToNodes(markdown: string): PageNode[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const nodes: PageNode[] = [];
  let i = 0;
  const isList = (line: string) => /^\s*([-*+]|\d+[.)])\s+/.test(line);
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i += 1;
      nodes.push({ type: "codeBlock", attrs: { language: fence[1] || null }, content: body.length ? [{ type: "text", text: body.join("\n") }] : [] });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      nodes.push({ type: "heading", attrs: { level: Math.min(heading[1]!.length, 3) }, content: inline(heading[2]!.trim()) });
      i += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      nodes.push({ type: "horizontalRule" });
      i += 1;
      continue;
    }
    if (line.trim().startsWith("|") && lines[i + 1]?.match(/^\s*\|?\s*:?-{2,}/)) {
      const rows: string[][] = [];
      const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
      rows.push(cells(line));
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(cells(lines[i++]!));
      nodes.push(tableNode(rows));
      continue;
    }
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) body.push(lines[i++]!.replace(/^>\s?/, ""));
      nodes.push({ type: "blockquote", content: markdownToNodes(body.join("\n")) });
      continue;
    }
    if (isList(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const checklist = /^\s*[-*+]\s+\[[ xX]\]/.test(line);
      const items: PageNode[] = [];
      while (i < lines.length && isList(lines[i]!) && /^\s*\d+[.)]/.test(lines[i]!) === ordered) {
        const text = lines[i]!.replace(/^\s*([-*+]|\d+[.)])\s+/, "");
        const check = text.match(/^\[([ xX])\]\s*(.*)$/);
        i += 1;
        const extra: string[] = [];
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !isList(lines[i]!)) extra.push(lines[i++]!.trim());
        const body = [check ? check[2]! : text, ...extra].join(" ");
        items.push(
          checklist
            ? { type: "taskItem", attrs: { checked: Boolean(check && check[1] !== " ") }, content: [paragraph(body)] }
            : { type: "listItem", content: [paragraph(body)] },
        );
      }
      nodes.push({ type: checklist ? "taskList" : ordered ? "orderedList" : "bulletList", content: items });
      continue;
    }
    const body: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s|\|)/.test(lines[i]!)) body.push(lines[i++]!.trim());
    nodes.push(paragraph(body.join(" ")));
  }
  return nodes.length ? nodes : [{ type: "paragraph" }];
}

function textOf(node: PageNode): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(textOf).join(node.type === "paragraph" || node.type === "heading" ? "" : "\n");
}

/** Title plus body, replaced on every save so context search does not keep old text. */
export function pageSearchText(title: string, doc: PageDocument | null, notes: string): string {
  const body = pageText(doc, notes).trim();
  return [title.trim(), body].filter(Boolean).join("\n").slice(0, 100_000);
}

/** Plain text of the page as the engineer sees it, for the agent to read. */
export function pageText(doc: PageDocument | null, notes: string): string {
  if (!doc) return notes;
  return doc.content
    .map((node) => {
      const text = textOf(node).trim();
      if (node.type === "heading") return `${"#".repeat(Number(node.attrs?.level ?? 2))} ${text}`;
      if (node.type === "agentBlock") return `[Earlier agent output]\n${text}`;
      return text;
    })
    .filter(Boolean)
    .join("\n\n");
}

export interface AgentBlockMeta {
  jobId: string;
  runId: string | null;
  model: string;
  title?: string;
}

/**
 * Puts the job's output on the task page, replacing its previous block.
 * Retries on a revision race with the engineer's own save.
 */
/** Matches the editor's fingerprint of node.textContent (all text, no separators). */
function fingerprint(nodes: PageNode[]): string {
  const flat = (node: PageNode): string => (node.type === "text" ? node.text ?? "" : (node.content ?? []).map(flat).join(""));
  const text = nodes.map(flat).join("");
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

export async function writeAgentBlock(prisma: PrismaClient, userId: string, taskId: string, markdown: string, meta: AgentBlockMeta): Promise<void> {
  const content = markdownToNodes(markdown);
  const block: PageNode = {
    type: "agentBlock",
    attrs: {
      jobId: meta.jobId,
      runId: meta.runId,
      model: meta.model,
      title: meta.title ?? "",
      at: new Date().toISOString(),
      fingerprint: fingerprint(content),
    },
    content,
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await prisma.$transaction(
        async (db) => {
          const task = await db.task.findFirst({ where: { id: taskId, userId }, select: { notes: true, title: true } });
          if (!task) return;
          const page = await db.taskPage.findFirst({ where: { userId, taskId } });
          const current = page?.content ? PageDocument.parse(page.content) : null;
          const base: PageNode[] = current?.content ?? (task.notes.trim() ? markdownToNodes(task.notes) : []);
          const kept = base.filter((node) => !(node.type === "paragraph" && !node.content?.length && base.length === 1));
          const index = kept.findIndex((node) => node.type === "agentBlock" && node.attrs?.jobId === meta.jobId);
          const next = index >= 0 ? kept.map((node, at) => (at === index ? block : node)) : [...kept, block];
          const parsed = PageDocument.parse({ type: "doc", content: next });
          const doc = parsed as Prisma.InputJsonValue;
          const searchText = pageSearchText(page?.title || task.title, parsed, task.notes);
          if (page) {
            await db.taskPage.update({ where: { id: page.id }, data: { content: doc, revision: page.revision + 1, searchText } });
          } else {
            await db.taskPage.create({
              data: { userId, taskId, content: doc, revision: 1, annotations: [], notesSnapshot: task.notes, searchText },
            });
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      sseHub.publish(userId, { event: "page", data: { taskId, by: "agent" } });
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}
