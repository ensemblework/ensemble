import type { PageNode } from "@ensemble/shared-types";
import type { NotionBlock } from "./markdown.js";

type Json = Record<string, unknown>;
const list = (value: unknown): Json[] => Array.isArray(value) ? value as Json[] : [];
const paragraph = (content: PageNode[] = []): PageNode => ({ type: "paragraph", content });

/** Read Notion rich text directly: Markdown cannot express all combinations of these marks. */
export function notionInline(value: unknown): PageNode[] {
  return list(value).flatMap((part) => {
    const text = String(part.plain_text ?? (part.text as Json | undefined)?.content ?? (part.equation as Json | undefined)?.expression ?? "");
    if (!text) return [];
    const annotations = (part.annotations ?? {}) as Json;
    const marks: NonNullable<PageNode["marks"]> = [];
    for (const [source, type] of [["bold", "bold"], ["italic", "italic"], ["strikethrough", "strike"], ["underline", "underline"], ["code", "code"]]) {
      if (annotations[source!]) marks.push({ type: type! });
    }
    const href = part.href ?? (((part.text as Json | undefined)?.link as Json | undefined)?.url);
    if (typeof href === "string" && /^https?:\/\//i.test(href)) marks.push({ type: "link", attrs: { href } });
    const color = annotations.color;
    if (typeof color === "string" && color !== "default") marks.push({ type: "notionColor", attrs: { color } });
    return [{ type: "text", text, ...(marks.length ? { marks } : {}) }];
  });
}

/** Native page blocks. Only Notion columns lose their layout: their blocks stay in reading order. */
export function notionNodes(blocks: NotionBlock[]): PageNode[] {
  const out: PageNode[] = [];
  for (const block of blocks) {
    const data = (block[block.type] ?? {}) as Json;
    const content = notionInline(data.rich_text);
    const children = block.children?.length ? notionNodes(block.children) : [];
    if (["bulleted_list_item", "numbered_list_item", "to_do"].includes(block.type)) {
      const type = block.type === "to_do" ? "taskList" : block.type === "numbered_list_item" ? "orderedList" : "bulletList";
      const item: PageNode = { type: type === "taskList" ? "taskItem" : "listItem", ...(type === "taskList" ? { attrs: { checked: Boolean(data.checked) } } : {}), content: [paragraph(content), ...children] };
      const previous = out.at(-1);
      if (previous?.type === type) previous.content!.push(item);
      else out.push({ type, content: [item] });
      continue;
    }
    switch (block.type) {
      case "paragraph": out.push(paragraph(content), ...children); break;
      case "heading_1": case "heading_2": case "heading_3": {
        const heading: PageNode = { type: "heading", attrs: { level: Number(block.type.at(-1)) }, content };
        if (data.is_toggleable) out.push({ type: "toggleBlock", attrs: { collapsed: true }, content: [heading, ...(children.length ? children : [paragraph()])] });
        else out.push(heading, ...children);
        break;
      }
      case "toggle": out.push({ type: "toggleBlock", attrs: { collapsed: true }, content: [paragraph(content.length ? content : [{ type: "text", text: "Details" }]), ...(children.length ? children : [paragraph()])] }); break;
      case "quote": case "callout": {
        const emoji = (data.icon as Json | undefined)?.emoji;
        out.push({ type: "blockquote", content: [paragraph([...(typeof emoji === "string" ? [{ type: "text", text: `${emoji} ` }] : []), ...content]), ...children] });
        break;
      }
      case "code": out.push({ type: "codeBlock", attrs: { language: String(data.language ?? "plain text") }, content: [{ type: "text", text: list(data.rich_text).map((part) => String(part.plain_text ?? (part.text as Json | undefined)?.content ?? "")).join("") }].filter((node) => node.text) }); break;
      case "divider": out.push({ type: "horizontalRule" }); break;
      case "table": {
        const rows = (block.children ?? []).filter((row) => row.type === "table_row");
        const width = Number(data.table_width) || Math.max(0, ...rows.map((row) => list((row.table_row as Json)?.cells).length));
        if (rows.length && width) out.push({ type: "table", content: rows.map((row, i) => ({ type: "tableRow", content: Array.from({ length: width }, (_, j) => ({ type: (i === 0 && data.has_column_header) || (j === 0 && data.has_row_header) ? "tableHeader" : "tableCell", content: [paragraph(notionInline(((row.table_row as Json).cells as unknown[])?.[j]))] })) })) });
        break;
      }
      case "child_page": out.push({ type: "pageLink", attrs: { externalPageId: String(block.id ?? "").replace(/-/g, ""), label: String(data.title ?? "Untitled") } }); break;
      case "child_database":
        if (Array.isArray(block.tableContent)) out.push(...block.tableContent as PageNode[]);
        else out.push(paragraph([{ type: "text", text: String(data.title ?? "Table") }]));
        break;
      case "column_list": case "column": case "synced_block": case "template": out.push(...children); break;
      case "equation": out.push(paragraph([{ type: "text", text: String(data.expression ?? ""), marks: [{ type: "code" }] }])); break;
      case "image": case "file": case "pdf": case "video": case "audio": case "bookmark": case "embed": case "link_preview": {
        const file = (data[String(data.type)] ?? {}) as Json;
        const url = String(file.url ?? data.url ?? "");
        if (/^https?:\/\//.test(url)) {
          const label = list(data.caption).map((part) => String(part.plain_text ?? "")).join("") || String(data.name ?? block.type);
          out.push(block.type === "image" ? { type: "image", attrs: { src: url, alt: label } } : paragraph([{ type: "text", text: label, marks: [{ type: "link", attrs: { href: url } }] }]));
        }
        break;
      }
      case "table_of_contents": case "breadcrumb": break;
      default: if (content.length) out.push(paragraph(content)); out.push(...children);
    }
  }
  return out;
}

export function notionTable(columns: Array<{ name: string; type?: string }>, rows: Array<{ id: string; values: PageNode[][] }>): PageNode {
  return { type: "table", content: [
    { type: "tableRow", content: columns.map((column) => ({ type: "tableHeader", attrs: { valueType: column.type ?? "text" }, content: [paragraph([{ type: "text", text: column.name }])] })) },
    ...rows.map((row) => ({ type: "tableRow", content: columns.map((column, i) => ({ type: "tableCell", attrs: { valueType: column.type ?? "text" }, content: [paragraph(row.values[i] ?? [])] })) })),
  ] };
}
