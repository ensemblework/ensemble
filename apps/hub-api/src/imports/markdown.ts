/**
 * Other apps' rich text → Markdown. The Markdown then becomes page blocks via
 * pages/markdown.ts, so these only need the subset that reader understands:
 * headings, lists, task lists, code, quotes, tables, rules and links.
 */

type Json = Record<string, unknown>;

const asArray = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);
const asString = (value: unknown): string => (typeof value === "string" ? value : "");

function wrap(text: string, mark: string): string {
  if (!text.trim()) return text;
  const lead = text.match(/^\s*/)![0];
  const trail = text.match(/\s*$/)![0];
  return `${lead}${mark}${text.trim()}${mark}${trail}`;
}

function link(text: string, href: string): string {
  if (!/^https?:\/\//i.test(href)) return text;
  return `[${text.replace(/[[\]]/g, "") || href}](${href.replace(/\)/g, "%29")})`;
}

// ── Notion ──────────────────────────────────────────────────────────────────

export function notionRichText(parts: unknown): string {
  return asArray(parts)
    .map((part) => {
      let text = asString(part.plain_text);
      const annotations = (part.annotations ?? {}) as Record<string, boolean>;
      if (annotations.code) text = wrap(text, "`");
      else {
        if (annotations.bold) text = wrap(text, "**");
        if (annotations.italic) text = wrap(text, "*");
      }
      const href = asString(part.href);
      return href ? link(text, href) : text;
    })
    .join("");
}

export function notionPlain(parts: unknown): string {
  return asArray(parts).map((part) => asString(part.plain_text)).join("");
}

export interface NotionBlock extends Json {
  type: string;
  has_children?: boolean;
  /** Filled by the importer when has_children is true. */
  children?: NotionBlock[];
}

function fileUrl(value: unknown): string {
  const file = (value ?? {}) as Json;
  const inner = (file[asString(file.type)] ?? {}) as Json;
  return asString(inner.url) || asString(file.url);
}

/** Notion blocks (with children attached) → Markdown. */
const LIST_BLOCKS = new Set(["bulleted_list_item", "numbered_list_item", "to_do"]);

export function notionBlocksToMarkdown(blocks: NotionBlock[], depth = 0): string {
  const out: string[] = [];
  const indent = "  ".repeat(Math.min(depth, 4));
  let numbered = 0;
  for (const block of blocks) {
    const data = (block[block.type] ?? {}) as Json;
    const text = notionRichText(data.rich_text);
    const children = block.children ?? [];
    const nested = () => (children.length ? notionBlocksToMarkdown(children, depth + 1) : "");
    if (block.type !== "numbered_list_item") numbered = 0;
    if (!LIST_BLOCKS.has(block.type) && out.length && out[out.length - 1] !== "") out.push("");
    switch (block.type) {
      case "paragraph":
        out.push(text ? `${indent}${text}` : "");
        if (children.length) out.push(nested());
        break;
      case "heading_1":
      case "heading_2":
      case "heading_3":
      case "heading_4":
        out.push(`${"#".repeat(Number(block.type.slice(-1)))} ${text}`);
        if (children.length) out.push(notionBlocksToMarkdown(children, depth));
        break;
      case "bulleted_list_item":
        out.push(`${indent}- ${text}`);
        if (children.length) out.push(nested());
        continue;
      case "numbered_list_item":
        numbered += 1;
        out.push(`${indent}${numbered}. ${text}`);
        if (children.length) out.push(nested());
        continue;
      case "to_do":
        out.push(`${indent}- [${data.checked ? "x" : " "}] ${text}`);
        if (children.length) out.push(nested());
        continue;
      case "toggle":
        out.push(`${indent}**${notionPlain(data.rich_text).trim() || "Details"}**`, "");
        if (children.length) out.push(notionBlocksToMarkdown(children, depth));
        break;
      case "quote":
        out.push(`> ${text}`);
        if (children.length) out.push(notionBlocksToMarkdown(children, depth).split("\n").map((line) => `> ${line}`).join("\n"));
        break;
      case "callout": {
        const icon = (data.icon ?? {}) as Json;
        const emoji = asString(icon.emoji);
        out.push(`> ${emoji ? `${emoji} ` : ""}${text}`);
        if (children.length) out.push(notionBlocksToMarkdown(children, depth).split("\n").map((line) => `> ${line}`).join("\n"));
        break;
      }
      case "code":
        out.push(`\`\`\`${asString(data.language).replace(/\s+/g, "") || ""}\n${notionPlain(data.rich_text)}\n\`\`\``);
        break;
      case "equation":
        out.push(`\`${asString(data.expression)}\``);
        break;
      case "divider":
        out.push("---");
        break;
      case "table": {
        const rows = children.filter((row) => row.type === "table_row").map((row) => asArray(((row.table_row ?? {}) as Json).cells).map((cell) => notionRichText(cell).replace(/\|/g, "\\|").replace(/\n/g, " ")));
        if (rows.length) {
          const width = Math.max(...rows.map((row) => row.length));
          const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
          out.push([line(rows[0]!), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n"));
        }
        break;
      }
      case "image":
      case "video":
      case "file":
      case "pdf":
      case "audio": {
        const url = fileUrl(data);
        const caption = notionPlain(data.caption).trim() || asString(data.name) || block.type;
        if (url) out.push(`${indent}${link(`${block.type === "image" ? "Image" : "File"}: ${caption}`, url)}`);
        break;
      }
      case "bookmark":
      case "embed":
      case "link_preview": {
        const url = asString(data.url);
        if (url) out.push(`${indent}${link(notionPlain(data.caption).trim() || url, url)}`);
        break;
      }
      case "child_page":
        out.push(`${indent}📄 ${asString(data.title) || "Untitled page"}`);
        break;
      case "child_database":
        out.push(`${indent}🗂 ${asString(data.title) || "Untitled database"}`);
        break;
      case "column_list":
      case "column":
      case "synced_block":
      case "template":
        if (children.length) out.push(notionBlocksToMarkdown(children, depth));
        break;
      case "table_of_contents":
      case "breadcrumb":
      case "unsupported":
        break;
      default:
        if (text) out.push(`${indent}${text}`);
        if (children.length) out.push(nested());
    }
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── Atlassian Document Format (Jira) ────────────────────────────────────────

function adfInline(nodes: unknown): string {
  return asArray(nodes)
    .map((node) => {
      const attrs = (node.attrs ?? {}) as Json;
      switch (node.type) {
        case "text": {
          let text = asString(node.text);
          let href = "";
          for (const mark of asArray(node.marks)) {
            if (mark.type === "code") text = wrap(text, "`");
            else if (mark.type === "strong") text = wrap(text, "**");
            else if (mark.type === "em") text = wrap(text, "*");
            else if (mark.type === "link") href = asString(((mark.attrs ?? {}) as Json).href);
          }
          return href ? link(text, href) : text;
        }
        case "hardBreak":
          return " ";
        case "mention":
          return asString(attrs.text) || "@someone";
        case "emoji":
          return asString(attrs.text) || asString(attrs.shortName);
        case "inlineCard":
        case "blockCard":
          return asString(attrs.url) ? link(asString(attrs.url), asString(attrs.url)) : "";
        case "date": {
          const ms = Number(attrs.timestamp);
          return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
        }
        case "status":
          return asString(attrs.text) ? `[${asString(attrs.text)}]` : "";
        default:
          return adfInline(node.content);
      }
    })
    .join("");
}

function adfBlocks(nodes: unknown, depth = 0): string[] {
  const out: string[] = [];
  const indent = "  ".repeat(Math.min(depth, 4));
  for (const node of asArray(nodes)) {
    const attrs = (node.attrs ?? {}) as Json;
    switch (node.type) {
      case "paragraph":
        out.push(`${indent}${adfInline(node.content)}`, "");
        break;
      case "heading":
        out.push(`${"#".repeat(Math.min(Math.max(Number(attrs.level) || 2, 1), 6))} ${adfInline(node.content)}`, "");
        break;
      case "bulletList":
      case "orderedList":
        asArray(node.content).forEach((item, index) => {
          const [first, ...rest] = asArray(item.content);
          const marker = node.type === "orderedList" ? `${index + 1}.` : "-";
          out.push(`${indent}${marker} ${first ? adfInline(first.content) : ""}`);
          for (const child of rest) out.push(...adfBlocks([child], depth + 1).filter(Boolean));
        });
        out.push("");
        break;
      case "taskList":
        for (const item of asArray(node.content)) {
          out.push(`${indent}- [${((item.attrs ?? {}) as Json).state === "DONE" ? "x" : " "}] ${adfInline(item.content)}`);
        }
        out.push("");
        break;
      case "codeBlock":
        out.push(`\`\`\`${asString(attrs.language)}`, asArray(node.content).map((child) => asString(child.text)).join(""), "```", "");
        break;
      case "blockquote":
      case "panel":
        out.push(...adfBlocks(node.content, depth).filter(Boolean).map((line) => `> ${line}`), "");
        break;
      case "rule":
        out.push("---", "");
        break;
      case "expand":
      case "nestedExpand":
        if (asString(attrs.title)) out.push(`**${asString(attrs.title)}**`, "");
        out.push(...adfBlocks(node.content, depth));
        break;
      case "table": {
        const rows = asArray(node.content).map((row) =>
          asArray(row.content).map((cell) => adfBlocks(cell.content).filter(Boolean).join(" ").replace(/\|/g, "\\|")),
        );
        if (rows.length) {
          const width = Math.max(...rows.map((row) => row.length));
          const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
          out.push(line(rows[0]!), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rows.slice(1).map(line), "");
        }
        break;
      }
      case "mediaSingle":
      case "mediaGroup":
      case "media":
        out.push(`${indent}(attachment)`, "");
        break;
      default:
        if (node.content) out.push(...adfBlocks(node.content, depth));
        else if (node.text) out.push(asString(node.text));
    }
  }
  return out;
}

export function adfToMarkdown(doc: unknown): string {
  if (typeof doc === "string") return doc.trim();
  if (!doc || typeof doc !== "object") return "";
  return adfBlocks((doc as Json).content).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The page reader takes a list's kind from its first line, so a to-do after a bullet needs its own list. */
export function separateLists(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  const kind = (line: string) => (/^\s*[-*+]\s+\[[ xX]\]/.test(line) ? "todo" : /^\s*[-*+]\s+/.test(line) ? "bullet" : /^\s*\d+[.)]\s+/.test(line) ? "ordered" : null);
  let previous: string | null = null;
  for (const line of lines) {
    const current = kind(line);
    if (current && previous && current !== previous) out.push("");
    out.push(line);
    previous = current ?? (line.trim() ? null : previous);
  }
  return out.join("\n");
}
