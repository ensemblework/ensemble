/**
 * One small document model every export goes through: pages, tasks, meeting notes and skills
 * become `ExportDoc`, then Markdown, HTML, plain text, PDF or Word. All of it runs in the
 * browser, so exporting never costs the server anything.
 */

export type Run = { text: string; bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; href?: string };
/** A table cell's text. A "\n" run is a line break inside the cell. */
export type Cell = Run[];
export type Block =
  | { type: "heading"; level: 1 | 2 | 3; runs: Run[] }
  | { type: "paragraph"; runs: Run[] }
  | { type: "list"; ordered: boolean; items: Run[][] }
  | { type: "todo"; items: Array<{ checked: boolean; runs: Run[] }> }
  | { type: "quote"; runs: Run[] }
  | { type: "code"; text: string }
  /** The first row is the header. */
  | { type: "table"; rows: Cell[][] }
  | { type: "rule" };

export type ExportDoc = {
  title: string;
  /** Property rows shown under the title, e.g. Status, Priority, Due. */
  meta?: Array<[string, string]>;
  blocks: Block[];
};

type Json = { type?: string; text?: string; attrs?: Record<string, unknown>; marks?: Array<{ type: string; attrs?: Record<string, unknown> }>; content?: Json[] };

function runsOf(node: Json | undefined): Run[] {
  const runs: Run[] = [];
  const walk = (child: Json) => {
    if (child.type === "text") {
      const marks = new Set((child.marks ?? []).map((mark) => mark.type));
      const href = (child.marks ?? []).find((mark) => mark.type === "link")?.attrs?.href;
      runs.push({
        text: child.text ?? "",
        bold: marks.has("bold") || undefined,
        italic: marks.has("italic") || undefined,
        code: marks.has("code") || undefined,
        strike: marks.has("strike") || undefined,
        href: typeof href === "string" ? href : undefined,
      });
      return;
    }
    if (child.type === "mention") {
      const label = child.attrs?.label ?? child.attrs?.id ?? "";
      runs.push({ text: `@${String(label)}` });
      return;
    }
    if (child.type === "hardBreak") {
      runs.push({ text: "\n" });
      return;
    }
    for (const next of child.content ?? []) walk(next);
  };
  for (const child of node?.content ?? []) walk(child);
  return runs;
}

/** A cell's paragraphs, list items and so on, each on its own line. */
function cellRuns(cell: Json): Cell {
  const lines: Run[][] = [];
  const visit = (node: Json) => {
    if (node.content?.some((child) => child.type === "text" || child.type === "mention" || child.type === "hardBreak")) lines.push(runsOf(node));
    else for (const child of node.content ?? []) visit(child);
  };
  visit(cell);
  return lines.flatMap((runs, index) => (index ? [{ text: "\n" }, ...runs] : runs));
}

export function plainText(runs: Run[]): string {
  return runs.map((run) => run.text).join("");
}

/** Links that stay links in an export: web and email addresses. Anything else (javascript:, app paths) is plain text. */
export function safeHref(href: string | undefined): string | undefined {
  const value = href?.trim();
  return value && /^(https?:\/\/|mailto:)/i.test(value) ? value : undefined;
}

const BARE_URL = /https?:\/\/[^\s<>"]+/g;

/** A URL's end without the sentence around it: trailing punctuation, and a ) or ] it does not open. */
function trimUrl(url: string): string {
  let end = url.length;
  const count = (text: string, char: string) => text.split(char).length - 1;
  while (end > 0) {
    const char = url[end - 1]!;
    if (/[.,;:!?'*_]/.test(char)) end -= 1;
    else if ((char === ")" || char === "]") && count(url.slice(0, end), char) > count(url.slice(0, end), char === ")" ? "(" : "[")) end -= 1;
    else break;
  }
  return url.slice(0, end);
}

/** Runs with every bare http(s) address in their text turned into a link run, keeping the run's formatting. */
export function linkRuns(runs: Run[]): Run[] {
  return runs.flatMap((run) => {
    if (run.href || run.code || !run.text.includes("://")) return [run];
    const out: Run[] = [];
    let last = 0;
    for (const match of run.text.matchAll(BARE_URL)) {
      const url = trimUrl(match[0]);
      if (!/^https?:\/\/[^/]/.test(url)) continue;
      if (match.index! > last) out.push({ ...run, text: run.text.slice(last, match.index) });
      out.push({ ...run, text: url, href: url });
      last = match.index! + url.length;
    }
    if (last < run.text.length) out.push({ ...run, text: run.text.slice(last) });
    return out;
  });
}

/** A page body (TipTap JSON) as blocks. Embeds without text become a short line naming them. */
export function blocksFromPage(doc: unknown): Block[] {
  const blocks: Block[] = [];
  const visit = (node: Json) => {
    switch (node.type) {
      case "heading": {
        const level = Math.min(3, Math.max(1, Number(node.attrs?.level ?? 2))) as 1 | 2 | 3;
        blocks.push({ type: "heading", level, runs: runsOf(node) });
        return;
      }
      case "paragraph": {
        const runs = runsOf(node);
        if (runs.length) blocks.push({ type: "paragraph", runs });
        return;
      }
      case "bulletList":
      case "orderedList":
        blocks.push({ type: "list", ordered: node.type === "orderedList", items: (node.content ?? []).map((item) => (item.content ?? []).flatMap((child) => runsOf(child).concat([{ text: " " }])).slice(0, -1)) });
        return;
      case "taskList":
        blocks.push({ type: "todo", items: (node.content ?? []).map((item) => ({ checked: Boolean(item.attrs?.checked), runs: (item.content ?? []).flatMap((child) => runsOf(child)) })) });
        return;
      case "blockquote":
        blocks.push({ type: "quote", runs: (node.content ?? []).flatMap((child) => runsOf(child).concat([{ text: "\n" }])).slice(0, -1) });
        return;
      case "codeBlock":
        blocks.push({ type: "code", text: plainText(runsOf(node)) });
        return;
      case "horizontalRule":
        blocks.push({ type: "rule" });
        return;
      case "table": {
        const rows = (node.content ?? []).map((row) => (row.content ?? []).map(cellRuns));
        if (rows.length) blocks.push({ type: "table", rows });
        return;
      }
      case "ensembleReply": {
        const text = typeof node.attrs?.text === "string" ? node.attrs.text : typeof node.attrs?.answer === "string" ? node.attrs.answer : "";
        if (text) blocks.push(...blocksFromMarkdown(text));
        return;
      }
      default:
        if (node.content?.length) for (const child of node.content) visit(child);
    }
  };
  const root = (doc ?? {}) as Json;
  for (const node of root.content ?? []) visit(node);
  return blocks;
}

// Emphasis needs text right inside its markers, so `2 * 3 * 4` stays text, and underscores only
// count at word edges, so snake_case does too. Bare URLs are kept whole so nothing inside them
// reads as emphasis; the writers turn them into links.
const INLINE =
  /\\([\\`*_{}\[\]()#+\-.!|~<>])|`([^`]+)`|(https?:\/\/[^\s<>]+)|\*\*\*(?=[^\s*])(.+?)(?<=[^\s*])\*\*\*|\*\*(?=[^\s*])(.+?)(?<=[^\s*])\*\*|(?<![\p{L}\p{N}_])__(?=[^\s_])(.+?)(?<=[^\s_])__(?![\p{L}\p{N}_])|~~(?=[^\s~])(.+?)(?<=[^\s~])~~|\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*|(?<![\p{L}\p{N}_])_(?=[^\s_])([^_]+?)(?<=[^\s_])_(?![\p{L}\p{N}_])|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|<((?:https?:\/\/|mailto:)[^>\s]+)>/gu;

function inline(text: string): Run[] {
  const runs: Run[] = [];
  const styled = (inner: string, style: Omit<Run, "text">) => inline(inner).map((run) => ({ ...run, ...style }));
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index! > last) runs.push({ text: text.slice(last, match.index) });
    const [, escaped, code, url, boldItalic, bold, underBold, strike, italic, underItalic, label, href, autolink] = match;
    if (escaped !== undefined) runs.push({ text: escaped });
    else if (code !== undefined) runs.push({ text: code, code: true });
    else if (url !== undefined) runs.push({ text: url });
    else if (boldItalic !== undefined) runs.push(...styled(boldItalic, { bold: true, italic: true }));
    else if ((bold ?? underBold) !== undefined) runs.push(...styled((bold ?? underBold)!, { bold: true }));
    else if (strike !== undefined) runs.push(...styled(strike, { strike: true }));
    else if ((italic ?? underItalic) !== undefined) runs.push(...styled((italic ?? underItalic)!, { italic: true }));
    else if (label !== undefined) runs.push(...styled(label, { href }));
    else if (autolink !== undefined) runs.push({ text: autolink.replace(/^mailto:/i, ""), href: autolink });
    last = match.index! + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs;
}

/** A table's header rule: `| --- | :-: |` or `--- | ---`. */
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function tableCells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/** Plain or Markdown text (meeting notes, skills, task descriptions, Ensemble answers) as blocks. */
export function blocksFromMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: Run[][] } | null = null;
  let todo: Array<{ checked: boolean; runs: Run[] }> | null = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", runs: inline(paragraph.join(" ")) });
    paragraph = [];
    if (list) blocks.push({ type: "list", ...list });
    list = null;
    if (todo) blocks.push({ type: "todo", items: todo });
    todo = null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("```")) {
      flush();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.startsWith("```")) code.push(lines[index++]!);
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const task = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) flush();
    else if (heading) {
      flush();
      blocks.push({ type: "heading", level: Math.min(3, heading[1]!.length) as 1 | 2 | 3, runs: inline(heading[2]!) });
    } else if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flush();
      blocks.push({ type: "rule" });
    } else if (line.includes("|") && lines[index + 1]?.includes("|") && TABLE_RULE.test(lines[index + 1]!)) {
      flush();
      const rows = [tableCells(line)];
      index += 2;
      while (index < lines.length && lines[index]!.trim() && lines[index]!.includes("|")) rows.push(tableCells(lines[index++]!));
      index -= 1;
      const width = Math.max(...rows.map((row) => row.length));
      blocks.push({ type: "table", rows: rows.map((row) => Array.from({ length: width }, (_, column) => inline((row[column] ?? "").replace(/<br\s*\/?>/gi, "\n")))) });
    } else if (task) {
      if (!todo) flush();
      todo ??= [];
      todo.push({ checked: task[1]!.toLowerCase() === "x", runs: inline(task[2]!) });
    } else if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push(inline((bullet ?? numbered)![1]!));
    } else if (line.startsWith(">")) {
      flush();
      blocks.push({ type: "quote", runs: inline(line.replace(/^>\s?/, "")) });
    } else {
      if (list || todo) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}

/** Markdown keeps web and email links, and Ensemble's own page links so a copy pastes back as links. */
const markdownHref = (href: string | undefined) => safeHref(href) ?? (href && /^(\/pages\/|ensemble:\/\/)/.test(href) ? href : undefined);

function mdRuns(runs: Run[]): string {
  return runs
    .map((run) => {
      // Markers hug the text: `**word** ` reads as bold where `**word **` does not.
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(run.text)!;
      if (!core) return run.text;
      let text = core;
      if (run.code) text = `\`${text}\``;
      else {
        if (run.bold) text = `**${text}**`;
        if (run.italic) text = `*${text}*`;
        if (run.strike) text = `~~${text}~~`;
      }
      const href = markdownHref(run.href);
      if (href) text = `[${text}](${href})`;
      return `${lead}${text}${trail}`;
    })
    .join("");
}

const tableWidth = (rows: Cell[][]) => Math.max(1, ...rows.map((row) => row.length));

export function toMarkdown(doc: ExportDoc): string {
  const out: string[] = [`# ${doc.title}`, ""];
  if (doc.meta?.length) {
    for (const [label, value] of doc.meta) out.push(`- **${label}:** ${value}`);
    out.push("");
  }
  for (const block of doc.blocks) {
    switch (block.type) {
      case "heading":
        out.push(`${"#".repeat(block.level + 1)} ${mdRuns(block.runs)}`, "");
        break;
      case "paragraph":
        out.push(mdRuns(block.runs), "");
        break;
      case "list":
        block.items.forEach((item, index) => out.push(`${block.ordered ? `${index + 1}.` : "-"} ${mdRuns(item)}`));
        out.push("");
        break;
      case "todo":
        for (const item of block.items) out.push(`- [${item.checked ? "x" : " "}] ${mdRuns(item.runs)}`);
        out.push("");
        break;
      case "quote":
        out.push(...mdRuns(block.runs).split("\n").map((line) => `> ${line}`), "");
        break;
      case "code":
        out.push("```", block.text, "```", "");
        break;
      case "table":
        if (block.rows.length) {
          const width = tableWidth(block.rows);
          const cell = (value: Cell | undefined) => mdRuns(value ?? []).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
          const row = (cells: Cell[]) => `| ${Array.from({ length: width }, (_, index) => cell(cells[index])).join(" | ")} |`;
          out.push(row(block.rows[0]!), `|${" --- |".repeat(width)}`, ...block.rows.slice(1).map(row), "");
        }
        break;
      case "rule":
        out.push("---", "");
        break;
    }
  }
  return `${out.join("\n").trim()}\n`;
}

function textRuns(runs: Run[]): string {
  return runs
    .map((run) => {
      const href = safeHref(run.href);
      return href && href !== run.text && href !== `mailto:${run.text}` ? `${run.text} (${href})` : run.text;
    })
    .join("");
}

/** A table as padded columns, the header ruled off. */
function textTable(rows: Cell[][]): string[] {
  const width = tableWidth(rows);
  const cells = rows.map((row) => Array.from({ length: width }, (_, index) => textRuns(row[index] ?? []).replace(/\s*\n\s*/g, " / ")));
  const widths = Array.from({ length: width }, (_, index) => Math.max(3, ...cells.map((row) => Array.from(row[index]!).length)));
  const line = (row: string[]) => row.map((cell, index) => cell + " ".repeat(widths[index]! - Array.from(cell).length)).join(" | ").trimEnd();
  return [line(cells[0]!), widths.map((size) => "-".repeat(size)).join(" | "), ...cells.slice(1).map(line)];
}

export function toText(doc: ExportDoc): string {
  const out: string[] = [doc.title, ""];
  if (doc.meta?.length) out.push(...doc.meta.map(([label, value]) => `${label}: ${value}`), "");
  for (const block of doc.blocks) {
    switch (block.type) {
      case "heading":
      case "paragraph":
        out.push(textRuns(block.runs), "");
        break;
      case "list":
        out.push(...block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : "-"} ${textRuns(item)}`), "");
        break;
      case "todo":
        out.push(...block.items.map((item) => `[${item.checked ? "x" : " "}] ${textRuns(item.runs)}`), "");
        break;
      case "quote":
        out.push(...textRuns(block.runs).split("\n").map((line) => `> ${line}`), "");
        break;
      case "code":
        out.push(block.text, "");
        break;
      case "table":
        if (block.rows.length) out.push(...textTable(block.rows), "");
        break;
      case "rule":
        out.push("---", "");
        break;
    }
  }
  return `${out.join("\n").trim()}\n`;
}

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function htmlRuns(runs: Run[]): string {
  return linkRuns(runs)
    .map((run) => {
      let text = escape(run.text).replace(/\n/g, "<br>");
      if (run.code) text = `<code>${text}</code>`;
      if (run.bold) text = `<strong>${text}</strong>`;
      if (run.italic) text = `<em>${text}</em>`;
      if (run.strike) text = `<s>${text}</s>`;
      const href = safeHref(run.href);
      if (href) text = `<a href="${escape(href)}" target="_blank" rel="noopener">${text}</a>`;
      return text;
    })
    .join("");
}

function htmlTable(rows: Cell[][]): string {
  const width = tableWidth(rows);
  const row = (cells: Cell[], tag: "th" | "td") => `<tr>${Array.from({ length: width }, (_, index) => `<${tag}${tag === "th" ? ' scope="col"' : ""}>${htmlRuns(cells[index] ?? [])}</${tag}>`).join("")}</tr>`;
  const body = rows.slice(1);
  return `<table class="grid"><thead>${row(rows[0]!, "th")}</thead>${body.length ? `<tbody>${body.map((cells) => row(cells, "td")).join("")}</tbody>` : ""}</table>`;
}

export function toHtml(doc: ExportDoc): string {
  const body: string[] = [`<h1>${escape(doc.title)}</h1>`];
  if (doc.meta?.length) body.push(`<table class="meta">${doc.meta.map(([label, value]) => `<tr><th>${escape(label)}</th><td>${htmlRuns([{ text: value }])}</td></tr>`).join("")}</table>`);
  for (const block of doc.blocks) {
    switch (block.type) {
      case "heading":
        body.push(`<h${block.level + 1}>${htmlRuns(block.runs)}</h${block.level + 1}>`);
        break;
      case "paragraph":
        body.push(`<p>${htmlRuns(block.runs)}</p>`);
        break;
      case "list":
        body.push(`<${block.ordered ? "ol" : "ul"}>${block.items.map((item) => `<li>${htmlRuns(item)}</li>`).join("")}</${block.ordered ? "ol" : "ul"}>`);
        break;
      case "todo":
        body.push(`<ul class="todo">${block.items.map((item) => `<li>${item.checked ? "☑" : "☐"} ${htmlRuns(item.runs)}</li>`).join("")}</ul>`);
        break;
      case "quote":
        body.push(`<blockquote>${htmlRuns(block.runs)}</blockquote>`);
        break;
      case "code":
        body.push(`<pre><code>${escape(block.text)}</code></pre>`);
        break;
      case "table":
        if (block.rows.length) body.push(htmlTable(block.rows));
        break;
      case "rule":
        body.push("<hr>");
        break;
    }
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escape(doc.title)}</title>
<style>
body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;max-width:760px;margin:48px auto;padding:0 24px;color:#1c1915}
h1{font-size:30px;margin:0 0 16px}h2{font-size:21px;margin:28px 0 8px}h3{font-size:17px;margin:22px 0 6px}
a{color:#2563eb}
table.meta{border-collapse:collapse;margin:12px 0}table.meta th{color:#6b655c;font-weight:500;text-align:left;padding:2px 16px 2px 0}table.meta td{padding:2px 0}
table.grid{width:100%;border-collapse:collapse;margin:14px 0;font-size:13.5px;line-height:1.45}
table.grid th,table.grid td{border:1px solid #ddd6cc;padding:6px 10px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
table.grid thead th{background:#f1ede5;font-weight:600}table.grid tbody tr:nth-child(even) td{background:#fbf9f5}
pre{background:#f4f1ea;padding:12px;border-radius:6px;overflow:auto}code{font:13px ui-monospace,Menlo,monospace}
blockquote{border-left:3px solid #ddd;margin:12px 0;padding-left:12px;color:#555}ul.todo{list-style:none;padding-left:4px}
@media print{body{margin:0;max-width:none;padding:0}table.grid thead{display:table-header-group}table.grid tr{break-inside:avoid;page-break-inside:avoid}table.grid th,table.grid td{-webkit-print-color-adjust:exact;print-color-adjust:exact}pre{white-space:pre-wrap}}
</style></head><body>
${body.join("\n")}
</body></html>
`;
}
