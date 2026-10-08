/**
 * One small document model every export goes through: pages, tasks, meeting notes and skills
 * become `ExportDoc`, then Markdown, HTML, plain text, PDF or Word. All of it runs in the
 * browser, so exporting never costs the server anything.
 */

export type Run = { text: string; bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; href?: string };
export type Block =
  | { type: "heading"; level: 1 | 2 | 3; runs: Run[] }
  | { type: "paragraph"; runs: Run[] }
  | { type: "list"; ordered: boolean; items: Run[][] }
  | { type: "todo"; items: Array<{ checked: boolean; runs: Run[] }> }
  | { type: "quote"; runs: Run[] }
  | { type: "code"; text: string }
  | { type: "table"; rows: string[][] }
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

export function plainText(runs: Run[]): string {
  return runs.map((run) => run.text).join("");
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
      case "table":
        blocks.push({
          type: "table",
          rows: (node.content ?? []).map((row) => (row.content ?? []).map((cell) => (cell.content ?? []).map((child) => plainText(runsOf(child))).join(" "))),
        });
        return;
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

function inline(text: string): Run[] {
  const runs: Run[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last) runs.push({ text: text.slice(last, match.index) });
    const token = match[0];
    if (token.startsWith("**")) runs.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith("`")) runs.push({ text: token.slice(1, -1), code: true });
    else if (token.startsWith("[")) {
      const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(token)!;
      runs.push({ text: link[1]!, href: link[2] });
    } else runs.push({ text: token.slice(1, -1), italic: true });
    last = match.index! + token.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs;
}

/** Plain or Markdown text (meeting notes, skills) as blocks. */
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

function mdRuns(runs: Run[]): string {
  return runs
    .map((run) => {
      let text = run.text;
      if (run.code) return `\`${text}\``;
      if (run.bold) text = `**${text}**`;
      if (run.italic) text = `*${text}*`;
      if (run.strike) text = `~~${text}~~`;
      if (run.href) text = `[${text}](${run.href})`;
      return text;
    })
    .join("");
}

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
          const width = Math.max(...block.rows.map((row) => row.length));
          const pad = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => (row[index] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
          out.push(pad(block.rows[0]!), `|${" --- |".repeat(width)}`, ...block.rows.slice(1).map(pad), "");
        }
        break;
      case "rule":
        out.push("---", "");
        break;
    }
  }
  return `${out.join("\n").trim()}\n`;
}

export function toText(doc: ExportDoc): string {
  return toMarkdown(doc)
    .replace(/^#+\s/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(?<!\*)\*(?!\*)(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
}

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function htmlRuns(runs: Run[]): string {
  return runs
    .map((run) => {
      let text = escape(run.text).replace(/\n/g, "<br>");
      if (run.code) text = `<code>${text}</code>`;
      if (run.bold) text = `<strong>${text}</strong>`;
      if (run.italic) text = `<em>${text}</em>`;
      if (run.strike) text = `<s>${text}</s>`;
      if (run.href) text = `<a href="${escape(run.href)}">${text}</a>`;
      return text;
    })
    .join("");
}

export function toHtml(doc: ExportDoc): string {
  const body: string[] = [`<h1>${escape(doc.title)}</h1>`];
  if (doc.meta?.length) body.push(`<table class="meta">${doc.meta.map(([label, value]) => `<tr><th>${escape(label)}</th><td>${escape(value)}</td></tr>`).join("")}</table>`);
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
        body.push(`<table>${block.rows.map((row, index) => `<tr>${row.map((cell) => (index === 0 ? `<th>${escape(cell)}</th>` : `<td>${escape(cell)}</td>`)).join("")}</tr>`).join("")}</table>`);
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
table{border-collapse:collapse;margin:12px 0}td,th{border:1px solid #ddd;padding:6px 10px;text-align:left}
table.meta th{color:#6b655c;font-weight:500;border:0;padding:2px 16px 2px 0}table.meta td{border:0;padding:2px 0}
pre{background:#f4f1ea;padding:12px;border-radius:6px;overflow:auto}code{font:13px ui-monospace,Menlo,monospace}
blockquote{border-left:3px solid #ddd;margin:12px 0;padding-left:12px;color:#555}ul.todo{list-style:none;padding-left:4px}
</style></head><body>
${body.join("\n")}
</body></html>
`;
}
