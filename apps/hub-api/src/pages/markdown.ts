/**
 * Pages as text and Markdown for agents, and the agent block a job owns. Markdown → page
 * blocks is `markdownToNodes` in shared-types (page-markdown.ts), re-exported here.
 *
 * The agent never edits the engineer's own blocks. Its output lives in one
 * `agentBlock` per job, which the page renders tinted and labelled. Writing
 * again replaces that block in place; the engineer's edits elsewhere stay.
 */
import { checkpointPage, pageEditor } from "./history.js";
import { Prisma, type PrismaClient } from "@prisma/client";
import { markdownToNodes, PageDocument, type PageNode } from "@ensemble/shared-types";
import { sseHub } from "../lib/sse.js";

export { markdownToNodes };

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
      return children.map((item, index) => nested(item, `${index + Number(node.attrs?.start ?? 1)}. `)).join("\n");
    case "taskList":
      return children.map((item) => nested(item, item.attrs?.checked ? "- [x] " : "- [ ] ")).join("\n");
    case "codeBlock":
      return [`\`\`\`${String(node.attrs?.language ?? "")}`, children.map((child) => child.text ?? "").join(""), "```"].join("\n").split("\n").map((line) => `${indent}${line}`).join("\n");
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
    case "pageLink":
      return `[${String(node.attrs?.label ?? "Page")}](${node.attrs?.pageId ? `/pages/${String(node.attrs.pageId)}` : `https://www.notion.so/${String(node.attrs?.externalPageId ?? "")}`})`;
    case "toggleBlock": {
      const [summary, ...body] = children;
      return `<details${node.attrs?.collapsed ? "" : " open"}>\n<summary>${inlineMarkdown(summary?.content)}</summary>\n\n${body.map((child) => blockMarkdown(child)).join("\n\n")}\n</details>`;
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
            await checkpointPage(db, page, page.title || task.title);
            await db.taskPage.update({ where: { id: page.id }, data: { content: doc, revision: page.revision + 1, searchText, editorAccountId: await pageEditor(db, userId) } });
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
