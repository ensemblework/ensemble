/**
 * `browser_snapshot` with `mode: "interactive"`: the accessibility snapshot cut down to what a small
 * model acts on: interactive elements with their refs (links with where they go), headings, landmarks
 * and short texts, flat and at most 8,000 characters. Subtrees hidden from assistive technology go.
 */

const INTERACTIVE = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "treeitem",
  "gridcell",
]);
const LANDMARKS = new Set(["banner", "navigation", "main", "contentinfo", "complementary", "search", "form", "region", "dialog", "alertdialog", "table", "list"]);
const TEXTS = new Set(["text", "paragraph", "generic", "cell", "listitem", "strong", "emphasis", "status", "alert", "img", "caption", "term", "definition"]);

const LINE = /^(\s*)- '?([a-z/][a-z]*)\b(?::)?(.*)$/;

/** The interactive view of an aria snapshot (Playwright's `ai` mode lines). */
export function interactiveSnapshot(snapshot: string, limit = 8_000): { text: string; truncated: boolean; lines: number } {
  const lines = snapshot.split("\n");
  const out: string[] = [];
  let hiddenBelow = -1;
  let lastLink = -1;
  let lastLabel = "";
  let options = 0;
  for (const raw of lines) {
    const match = LINE.exec(raw);
    if (!match) continue;
    const indent = match[1]!.length;
    if (hiddenBelow >= 0) {
      if (indent > hiddenBelow) continue;
      hiddenBelow = -1;
    }
    const role = match[2]!;
    const rest = match[3]!.replace(/\s*\[cursor=pointer\]/g, "").replace(/'\s*(\[|:|$)/, " $1");
    if (/\[aria-hidden\]/.test(rest)) {
      hiddenBelow = indent;
      continue;
    }
    if (role === "/url") {
      const url = rest.replace(/^:?\s*/, "").replace(/^"|"$/g, "").trim();
      if (lastLink >= 0 && url && !/^(?:javascript:|#)/i.test(url)) out[lastLink] = `${out[lastLink]} → ${url.length > 90 ? `${url.slice(0, 90)}…` : url}`;
      lastLink = -1;
      continue;
    }
    if (role.startsWith("/")) continue;
    const ref = /\[ref=([a-z0-9]+)\]/.exec(rest)?.[1];
    const name = /^\s*"((?:[^"\\]|\\.)*)"/.exec(rest)?.[1] ?? "";
    const value = /\]:\s*(.+)$/.exec(rest)?.[1]?.trim() ?? (/^\s*:\s*(.+)$/.exec(rest)?.[1]?.trim() ?? "");
    const depth = "  ".repeat(Math.min(3, Math.floor(indent / 4)));
    lastLink = -1;
    if (INTERACTIVE.has(role) && ref) {
      if (role === "option" && (options += 1) > 40) continue;
      const states = [...rest.matchAll(/\[(checked|disabled|expanded|selected|pressed)(?:=[a-z]+)?\]/g)].map((state) => state[0]).join(" ");
      const label = name || (value.length <= 80 ? value : `${value.slice(0, 80)}…`);
      out.push(`${depth}- ${role}${label ? ` "${label}"` : ""}${states ? ` ${states}` : ""} [ref=${ref}]${value && name && value.length <= 60 && role !== "link" ? `: ${value}` : ""}`);
      lastLabel = label.toLowerCase();
      if (role === "link") lastLink = out.length - 1;
      continue;
    }
    if (role === "heading") {
      lastLabel = "";
      const level = /\[level=(\d)\]/.exec(rest)?.[1];
      if (name || value) out.push(`${depth}- heading${level ? ` ${level}` : ""} "${name || value}"${ref ? ` [ref=${ref}]` : ""}`);
      continue;
    }
    if (LANDMARKS.has(role)) {
      if (role === "list" && !name) continue;
      out.push(`${depth}- ${role}${name ? ` "${name}"` : ""}`);
      continue;
    }
    if (TEXTS.has(role)) {
      const text = role === "text" ? rest.replace(/^:?\s*/, "").trim() : value || name;
      // The text of the link or button just above says nothing new.
      if (text.length >= 3 && text.length <= 100 && /[\p{L}\p{N}]/u.test(text) && !lastLabel.includes(text.toLowerCase().replace(/^"|"$/g, ""))) out.push(`${depth}  ${text}`);
    }
  }
  // Runs of the same short text (menus repeated, "+" between keys) say nothing new.
  const compact: string[] = [];
  for (const line of out) if (compact[compact.length - 1] !== line) compact.push(line);
  let text = compact.join("\n");
  let truncated = false;
  if (text.length > limit) {
    const cut = text.lastIndexOf("\n", limit);
    const rest = text.slice(cut > 0 ? cut : limit).split("\n").filter(Boolean).length;
    text = `${text.slice(0, cut > 0 ? cut : limit)}\n- note: ${rest} more lines not shown`;
    truncated = true;
  }
  return { text, truncated, lines: compact.length };
}
