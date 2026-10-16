import { Extension } from "@tiptap/core";
import { Slice, type Fragment, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { looksLikeMarkdown, markdownToNodes, restoreMentionLinks, type PageNode } from "@ensemble/shared-types";
import { pageIdFromHref, readDraggedPage } from "@/lib/page-drag";

function inlineText(node: ProseMirrorNode): string {
  let out = "";
  node.forEach((child) => {
    if (child.isText) out += child.text ?? "";
    else if (child.type.name === "hardBreak") out += "\n";
    else if (child.type.name === "mention") out += `@${String(child.attrs.label ?? "")}`;
    else out += child.textContent;
  });
  return out;
}

const indented = (text: string, indent: string) => text.split("\n").map((line) => `${indent}${line}`);

function itemLines(item: ProseMirrorNode, marker: string, indent: string): string[] {
  const lines: string[] = [];
  item.forEach((child, _offset, index) => {
    if (index === 0 && child.isTextblock) {
      const [first = "", ...rest] = inlineText(child).split("\n");
      lines.push(`${indent}${marker}${first}`, ...rest.map((line) => `${indent}${" ".repeat(marker.length)}${line}`));
    } else lines.push(...blockLines(child, `${indent}  `));
  });
  return lines.length ? lines : [`${indent}${marker}`.trimEnd()];
}

function blockLines(node: ProseMirrorNode, indent = ""): string[] {
  switch (node.type.name) {
    case "codeBlock":
      return indented(node.textContent, indent);
    case "horizontalRule":
      return [`${indent}---`];
    case "bulletList":
    case "orderedList":
    case "taskList": {
      const start = Number(node.attrs.start ?? 1) || 1;
      const lines: string[] = [];
      node.forEach((item, _offset, index) => {
        const marker = node.type.name === "orderedList" ? `${start + index}. ` : node.type.name === "taskList" ? (item.attrs.checked ? "- [x] " : "- [ ] ") : "- ";
        lines.push(...itemLines(item, marker, indent));
      });
      return lines;
    }
    case "blockquote":
      return blocksText(node.content).split("\n").map((line) => `${indent}> ${line}`.trimEnd());
    case "table": {
      const rows: string[] = [];
      node.forEach((row) => {
        const cells: string[] = [];
        row.forEach((cell) => cells.push(blocksText(cell.content).replace(/\s*\n+\s*/g, " ")));
        rows.push(`${indent}${cells.join("\t")}`);
      });
      return rows;
    }
    case "image":
      return [`${indent}${String(node.attrs.alt || node.attrs.src || "")}`];
    case "pageLink":
      return [`${indent}${String(node.attrs.label ?? "")}`];
    default:
      if (node.isTextblock) return indented(inlineText(node), indent);
      if (node.isLeaf) return node.textContent ? [`${indent}${node.textContent}`] : [];
      return blocksText(node.content).split("\n").map((line) => (line ? `${indent}${line}` : line));
  }
}

/** Blocks as plain text: one blank line between blocks, list markers, `[x]` and `---` kept. */
export function blocksText(content: Fragment): string {
  const blocks: string[] = [];
  content.forEach((node) => {
    const text = node.isInline ? (node.isText ? node.text ?? "" : node.textContent) : blockLines(node).join("\n");
    if (text.trim()) blocks.push(text.replace(/\s+$/, ""));
  });
  return blocks.join("\n\n");
}

/** The text/plain side of a copy. Part of one line copies as just that text. */
export function plainTextOf(slice: Slice): string {
  const textblocks: ProseMirrorNode[] = [];
  let other = false;
  slice.content.descendants((node) => {
    if (node.isTextblock) {
      textblocks.push(node);
      return false;
    }
    if (node.isLeaf && !node.isInline) other = true;
    return true;
  });
  if (textblocks.length === 1 && !other) return textblocks[0]!.type.spec.code ? textblocks[0]!.textContent : inlineText(textblocks[0]!);
  return blocksText(slice.content);
}

/** Markdown as page blocks for this editor, or null when it does not fit the schema. */
export function markdownFragment(schema: Schema, markdown: string, options: { lineBreaks?: boolean } = {}): Fragment | null {
  const nodes = markdownToNodes(markdown, options);
  // A link to something this editor has no block for (an ensemble://ask link) stays a link.
  for (const content of [restoreMentionLinks({ type: "doc", content: nodes }).content, nodes] as PageNode[][]) {
    try {
      const doc = schema.nodeFromJSON({ type: "doc", content });
      doc.check();
      return doc.content;
    } catch {
      // try the next form
    }
  }
  return null;
}

/**
 * HTML from outside the editor: a link to a page in this app on its own (a row dragged from the
 * Pages browser) becomes a link-to-page block rather than the row's styled text, and other
 * addresses on this origin become paths so they work on any host the app runs on.
 */
export function pastedPageHtml(html: string, origin: string): string {
  if (!/<a\s/i.test(html) || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (doc.querySelector("[data-pm-slice]")) return html;
  const anchors = Array.from(doc.body.querySelectorAll<HTMLAnchorElement>("a[href]"));
  const only = anchors.length === 1 ? anchors[0]! : null;
  const id = only ? pageIdFromHref(only.getAttribute("href") ?? "", origin) : null;
  if (only && id && (doc.body.textContent ?? "").trim() === (only.textContent ?? "").trim()) {
    const block = doc.createElement("a");
    block.setAttribute("data-type", "pageLink");
    block.setAttribute("pageid", id);
    block.setAttribute("label", (only.getAttribute("title") || only.textContent || "").replace(/\s+/g, " ").trim() || "Untitled");
    return block.outerHTML;
  }
  let changed = false;
  for (const anchor of anchors) {
    const href = anchor.getAttribute("href") ?? "";
    if (origin && href.startsWith(`${origin}/`)) {
      anchor.setAttribute("href", href.slice(origin.length));
      changed = true;
    }
  }
  return changed ? doc.body.innerHTML : html;
}

/**
 * Clipboard and drop handling for page bodies: Markdown pasted as plain text becomes blocks
 * (Cmd/Ctrl+Shift+V keeps it as text), copied blocks read well as plain text, and links to
 * pages in this app stay in-app links.
 */
export const PageClipboard = Extension.create({
  name: "pageClipboard",
  priority: 1000,
  addProseMirrorPlugins() {
    const origin = () => (typeof window === "undefined" ? "" : window.location.origin);
    return [
      new Plugin({
        key: new PluginKey("pageClipboard"),
        props: {
          clipboardTextSerializer: (slice) => plainTextOf(slice),
          clipboardTextParser: (text, $context, plain, view) => {
            if (plain || $context.parent.type.spec.code || !looksLikeMarkdown(text)) return null as unknown as Slice;
            // Pasted text keeps its line breaks (logs, commands); only block syntax starts a new block.
            const fragment = markdownFragment(view.state.schema, text, { lineBreaks: true });
            return (fragment ? new Slice(fragment, 0, 0) : null) as Slice;
          },
          transformPastedHTML: (html) => pastedPageHtml(html, origin()),
          handleDrop: (view, event) => {
            const page = readDraggedPage((event as DragEvent).dataTransfer);
            const type = view.state.schema.nodes.pageLink;
            if (!page || !type || !view.editable) return false;
            let pos = view.state.selection.from;
            try {
              pos = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })?.pos ?? pos;
            } catch {
              // No layout to place the drop by: it goes where the caret is.
            }
            event.preventDefault();
            view.dispatch(view.state.tr.replaceRangeWith(pos, pos, type.create({ pageId: page.id, label: page.title || "Untitled" })).scrollIntoView());
            view.focus();
            return true;
          },
        },
      }),
    ];
  },
});
