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
  // `ensemble://<kind>/<id>` links stay links here; restoreMentionLinks turns them into mentions.
  const pattern = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|`([^`]+)`|\[([^\]]+)\]\(((?:https?|ensemble):\/\/[^\s)]+)\)|(https?:\/\/[^\s)<>]+))/g;
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

/** `forAgents`: a file on the page names its id, so an agent can read the file. */
function textOf(node: PageNode, forAgents: boolean): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "mention") {
    const label = String(node.attrs?.label ?? "");
    if (forAgents && node.attrs?.kind === "file" && node.attrs.id) return `[file: ${label} (id ${String(node.attrs.id)})]`;
    return `@${label}`;
  }
  if (forAgents && typeof node.attrs?.fileId === "string" && node.attrs.fileId) {
    return `[file: ${String(node.attrs.label ?? node.attrs.filename ?? "file")} (id ${node.attrs.fileId})]`;
  }
  return (node.content ?? []).map((child) => textOf(child, forAgents)).join(node.type === "paragraph" || node.type === "heading" ? "" : "\n");
}

/** Title plus body, replaced on every save so context search does not keep old text. */
export function pageSearchText(title: string, doc: PageDocument | null, notes: string): string {
  const body = documentText(doc, notes, false).trim();
  return [title.trim(), body].filter(Boolean).join("\n").slice(0, 100_000);
}

/** Plain text of the page as the engineer sees it, for the agent to read. */
export function pageText(doc: PageDocument | null, notes: string): string {
  return documentText(doc, notes, true);
}

function documentText(doc: PageDocument | null, notes: string, forAgents: boolean): string {
  if (!doc) return notes;
  return doc.content
    .map((node) => {
      const text = textOf(node, forAgents).trim();
      if (node.type === "heading") return `${"#".repeat(Number(node.attrs?.level ?? 2))} ${text}`;
      if (node.type === "agentBlock") return `[Earlier agent output]\n${text}`;
      return text;
    })
    .filter(Boolean)
    .join("\n\n");
}

/** `[@Label](ensemble://kind/id)`: the form markdownToNodes and restoreMentionLinks read back as a mention. */
function mentionLink(kind: string, id: string, label: string): string {
  return `[@${label.replace(/^@+/, "").replace(/[[\]]/g, "") || kind}](ensemble://${kind}/${encodeURIComponent(id)})`;
}

function inlineMarkdown(nodes: readonly PageNode[] | undefined): string {
  return (nodes ?? [])
    .map((node) => {
      if (node.type === "hardBreak") return "\n";
      if (node.type === "mention") {
        const kind = String(node.attrs?.kind ?? "people");
        const label = String(node.attrs?.label ?? "");
        return kind === "date" || !node.attrs?.id ? label : mentionLink(kind, String(node.attrs.id), label);
      }
      if (node.type !== "text") return inlineMarkdown(node.content);
      let text = node.text ?? "";
      const marks = new Set((node.marks ?? []).map((mark) => mark.type));
      if (marks.has("code")) text = `\`${text}\``;
      if (marks.has("bold")) text = `**${text}**`;
      if (marks.has("italic")) text = `*${text}*`;
      if (marks.has("strike")) text = `~~${text}~~`;
      const href = node.marks?.find((mark) => mark.type === "link")?.attrs?.href;
      return typeof href === "string" && href ? `[${text}](${href})` : text;
    })
    .join("");
}

function blockMarkdown(node: PageNode, indent = ""): string {
  const children = node.content ?? [];
  const nested = (child: PageNode, prefix: string) => {
    const [first, ...rest] = child.content ?? [];
    const head = first ? blockMarkdown(first, `${indent}  `).trimStart() : "";
    const tail = rest.map((part) => blockMarkdown(part, `${indent}  `)).filter(Boolean);
    return [`${indent}${prefix}${head}`, ...tail].join("\n");
  };
  switch (node.type) {
    case "paragraph":
      return `${indent}${inlineMarkdown(children)}`;
    case "heading":
      return `${"#".repeat(Math.min(6, Math.max(1, Number(node.attrs?.level ?? 2))))} ${inlineMarkdown(children)}`;
    case "bulletList":
      return children.map((item) => nested(item, "- ")).join("\n");
    case "orderedList":
      return children.map((item, index) => nested(item, `${index + 1}. `)).join("\n");
    case "taskList":
      return children.map((item) => nested(item, item.attrs?.checked ? "- [x] " : "- [ ] ")).join("\n");
    case "codeBlock":
      return `\`\`\`${String(node.attrs?.language ?? "")}\n${children.map((child) => child.text ?? "").join("")}\n\`\`\``;
    case "blockquote":
      return children.map((child) => blockMarkdown(child)).join("\n\n").split("\n").map((line) => `> ${line}`).join("\n");
    case "horizontalRule":
      return "---";
    case "image":
      return `![${String(node.attrs?.alt ?? "")}](${String(node.attrs?.src ?? "")})`;
    case "table": {
      const rows = children.map((row) => (row.content ?? []).map((cell) => (cell.content ?? []).map((part) => inlineMarkdown(part.content)).join(" ").replace(/\|/g, "\\|").trim()));
      if (!rows.length) return "";
      const width = Math.max(...rows.map((row) => row.length));
      const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
      return [line(rows[0]!), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
    }
    case "agentBlock":
      return [`*Earlier agent output${node.attrs?.title ? `: ${String(node.attrs.title)}` : ""}*`, ...children.map((child) => blockMarkdown(child))].join("\n\n");
    default:
      if (typeof node.attrs?.fileId === "string" && node.attrs.fileId) return mentionLink("file", node.attrs.fileId, String(node.attrs.label ?? node.attrs.filename ?? "file"));
      return children.length ? children.map((child) => (child.type === "text" || child.type === "mention" ? inlineMarkdown([child]) : blockMarkdown(child, indent))).join(children.some((child) => child.type === "text") ? "" : "\n\n") : "";
  }
}

/**
 * A page as Markdown for agents that may write it back: lists, checklists, tables and code keep
 * their shape, and mentions (files, people, diagrams…) come out as `[@Label](ensemble://kind/id)`
 * so a rewrite keeps them. A task with no page yet reads as its notes.
 */
export function pageMarkdown(doc: PageDocument | null, notes: string): string {
  if (!doc) return notes;
  return doc.content
    .map((node) => blockMarkdown(node).replace(/\s+$/, ""))
    .filter((block) => block.trim())
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
