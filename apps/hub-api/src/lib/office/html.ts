/** Markdown → HTML for Google Drive's import, which turns it into a real Google Doc. */
import { parseMarkdown, type Inline, type ListItem } from "./markdown.js";

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function inlineHtml(inlines: readonly Inline[]): string {
  return inlines
    .map((piece) => {
      let html = escapeHtml(piece.text);
      if (piece.code) html = `<code style="font-family:'Courier New',monospace">${html}</code>`;
      if (piece.bold) html = `<strong>${html}</strong>`;
      if (piece.italic) html = `<em>${html}</em>`;
      if (piece.strike) html = `<s>${html}</s>`;
      if (piece.link) html = `<a href="${escapeHtml(piece.link)}">${html}</a>`;
      return html;
    })
    .join("");
}

function listHtml(items: readonly ListItem[]): string {
  let html = "";
  const open: Array<"ul" | "ol"> = [];
  let depth = -1;
  for (const item of items) {
    const tag = item.ordered ? "ol" : "ul";
    if (item.depth > depth) {
      // Deeper item: open lists until we reach its depth.
      while (depth < item.depth) {
        html += `<${tag}>`;
        open.push(tag);
        depth += 1;
      }
    } else {
      html += "</li>";
      while (depth > item.depth) {
        html += `</${open.pop()}></li>`;
        depth -= 1;
      }
      if (open[open.length - 1] !== tag) {
        html += `</${open.pop()}><${tag}>`;
        open.push(tag);
      }
    }
    html += `<li>${inlineHtml(item.inlines)}`;
  }
  html += "</li>";
  while (open.length) {
    html += `</${open.pop()}>`;
    if (open.length) html += "</li>";
  }
  return html;
}

export function markdownToHtml(markdown: string, title = ""): string {
  const body = parseMarkdown(markdown)
    .map((block) => {
      switch (block.kind) {
        case "heading":
          return `<h${block.level}>${inlineHtml(block.inlines)}</h${block.level}>`;
        case "paragraph":
          return `<p>${inlineHtml(block.inlines)}</p>`;
        case "quote":
          return `<blockquote><p><em>${inlineHtml(block.inlines)}</em></p></blockquote>`;
        case "list":
          return listHtml(block.items);
        case "code":
          return `<pre style="font-family:'Courier New',monospace">${escapeHtml(block.text)}</pre>`;
        case "rule":
          return "<hr>";
        case "table": {
          const head = `<tr>${block.header.map((cell) => `<th>${inlineHtml(cell)}</th>`).join("")}</tr>`;
          const rows = block.rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineHtml(cell)}</td>`).join("")}</tr>`).join("");
          return `<table border="1" style="border-collapse:collapse">${head}${rows}</table>`;
        }
      }
    })
    .join("\n");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>\n${body}\n</body></html>`;
}
