import { Extension } from "@tiptap/core";
import { Fragment, Slice, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { inlineMathMatch, inlineMathPattern, markdownToNodes, restoreMentionLinks, textToPageNodes, type PageNode } from "@ensemble/shared-types";
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

/** Page nodes as blocks for this editor, or null when they do not fit the schema. */
function fitted(schema: Schema, nodes: PageNode[]): Fragment | null {
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

/** Markdown as page blocks for this editor, or null when it does not fit the schema. */
export function markdownFragment(schema: Schema, markdown: string, options: { lineBreaks?: boolean } = {}): Fragment | null {
  return fitted(schema, markdownToNodes(markdown, options));
}

/**
 * Pasted plain text as page blocks (`textToPageNodes`: Markdown, a LaTeX document, or text with
 * equations, each line kept), or null for ordinary text, which pastes as it is.
 */
export function pastedTextFragment(schema: Schema, text: string): Fragment | null {
  const nodes = textToPageNodes(text);
  return nodes ? fitted(schema, nodes) : null;
}

/** VS Code languages whose text is read as page text; other code pastes as a code block. */
const TEXT_MODES = new Set(["markdown", "latex", "tex", "plaintext"]);
/** VS Code language ids as code block languages, where they differ. */
const CODE_LANGUAGE: Record<string, string> = { typescriptreact: "tsx", javascriptreact: "jsx", shellscript: "bash", "jsonc": "json" };

/** The language VS Code says copied text is in (`vscode-editor-data`), or null when it did not say. */
export function vscodeMode(data: Pick<DataTransfer, "getData" | "types">): string | null {
  if (!Array.from(data.types ?? []).includes("vscode-editor-data")) return null;
  try {
    const mode = (JSON.parse(data.getData("vscode-editor-data")) as { mode?: unknown }).mode;
    return typeof mode === "string" && mode ? mode : "plaintext";
  } catch {
    return "plaintext";
  }
}

/** One pasted paragraph joins the line at the caret; several blocks land as blocks. */
export function pastedSlice(fragment: Fragment): Slice {
  const single = fragment.childCount === 1 && fragment.firstChild!.type.name === "paragraph";
  return new Slice(fragment, single ? 1 : 0, single ? 1 : 0);
}

/** Elements that make pasted HTML formatted content rather than text wrapped in styled boxes. */
const FORMATTED = "p,pre,h1,h2,h3,h4,h5,h6,ul,ol,li,table,img,a[href],strong,b,em,i,u,s,del,strike,blockquote,hr,code,math,.katex,figure,video,iframe,[data-pm-slice]";

/**
 * Whether pasted HTML is only plain text in `div`/`span` boxes, as some editors and terminals put
 * it on the clipboard: then its plain text is read for Markdown and equations. A `pre` is code
 * and pastes as a code block.
 */
export function plainTextHtml(html: string): boolean {
  if (typeof DOMParser === "undefined") return false;
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Boolean(doc.body.textContent?.trim()) && !doc.body.querySelector(FORMATTED);
}

/** Text runs with `$…$` and `\(…\)` as equations (page-math.ts rules); the same fragment when none. */
function inlineWithMath(content: Fragment, schema: Schema): Fragment {
  const type = schema.nodes.inlineMath;
  if (!type) return content;
  const out: ProseMirrorNode[] = [];
  let changed = false;
  content.forEach((child) => {
    const text = child.isText ? child.text ?? "" : "";
    if (!text || child.marks.some((mark) => mark.type.spec.code) || (!text.includes("$") && !text.includes("\\("))) {
      out.push(child);
      return;
    }
    const parts: ProseMirrorNode[] = [];
    let at = 0;
    for (const found of text.matchAll(inlineMathPattern())) {
      const math = inlineMathMatch(found[1], found[2], found[3]);
      if (!math) continue;
      if (found.index! > at) parts.push(schema.text(text.slice(at, found.index), child.marks));
      parts.push(type.create({ latex: math.latex, display: math.display }));
      at = found.index! + found[0].length;
    }
    if (!parts.length) {
      out.push(child);
      return;
    }
    if (at < text.length) parts.push(schema.text(text.slice(at), child.marks));
    out.push(...parts);
    changed = true;
  });
  return changed ? Fragment.from(out) : content;
}

/**
 * Pasted formatted content (a web page, a doc) with the TeX in its text as equations: `$x$` and
 * `$$…$$` become math nodes where the block allows them; code and everything else stay as pasted.
 */
export function withPastedMath(fragment: Fragment, schema: Schema): Fragment {
  const nodes: ProseMirrorNode[] = [];
  let changed = false;
  fragment.forEach((node) => {
    let next = node;
    if (node.type.spec.code || node.isLeaf) next = node;
    else if (node.isTextblock) {
      const content = inlineWithMath(node.content, schema);
      if (content !== node.content && node.type.validContent(content)) next = node.copy(content);
    } else {
      const content = withPastedMath(node.content, schema);
      if (content !== node.content) next = node.copy(content);
    }
    if (next !== node) changed = true;
    nodes.push(next);
  });
  return changed ? Fragment.from(nodes) : fragment;
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
 * Clipboard and drop handling for page bodies: Markdown, a LaTeX document or equations pasted as
 * plain text become blocks (Cmd/Ctrl+Shift+V keeps it as text), copied blocks read well as plain
 * text, and links to pages in this app stay in-app links.
 */
export const PageClipboard = Extension.create({
  name: "pageClipboard",
  priority: 1000,
  addProseMirrorPlugins() {
    const origin = () => (typeof window === "undefined" ? "" : window.location.origin);
    /** Set while ProseMirror reads HTML copied from a page in this app, for `transformPasted`. */
    let fromThisApp = false;
    return [
      new Plugin({
        key: new PluginKey("pageClipboard"),
        props: {
          clipboardTextSerializer: (slice) => plainTextOf(slice),
          clipboardTextParser: (text, $context, plain, view) => {
            if (plain || $context.parent.type.spec.code) return null as unknown as Slice;
            // Pasted text keeps its line breaks (logs, commands); only block syntax starts a new block.
            const fragment = pastedTextFragment(view.state.schema, text);
            return (fragment ? pastedSlice(fragment) : null) as Slice;
          },
          // Text copied from a code editor or terminal comes as HTML that only wraps the text, so its
          // plain text is read here (Markdown and equations become blocks, code a code block).
          handlePaste: (view, event) => {
            const data = (event as ClipboardEvent).clipboardData;
            if (!data || !view.editable || view.state.selection.$from.parent.type.spec.code || data.files?.length) return false;
            const text = data.getData("text/plain");
            const html = data.getData("text/html");
            // Cmd/Ctrl+Shift+V keeps the text as typed.
            const shift = Boolean((view as unknown as { input?: { shiftKey?: boolean } }).input?.shiftKey);
            const mode = vscodeMode(data);
            if (mode && text) {
              // VS Code says which language it copied. TipTap's code block would take every such paste
              // as code, so this decides: Markdown, LaTeX and plain text are page text, a line of code
              // joins the line, and more than a line of code is a code block.
              if (shift) return view.pasteText(text);
              if (!TEXT_MODES.has(mode)) {
                const code = view.state.schema.nodes.codeBlock;
                if (!text.includes("\n") || !code) view.dispatch(view.state.tr.insertText(text).scrollIntoView().setMeta("uiEvent", "paste"));
                else view.dispatch(view.state.tr.replaceSelectionWith(code.create({ language: CODE_LANGUAGE[mode] ?? mode }, view.state.schema.text(text.replace(/\r\n?/g, "\n")))).scrollIntoView().setMeta("uiEvent", "paste"));
                return true;
              }
              const fragment = pastedTextFragment(view.state.schema, text);
              if (!fragment) return view.pasteText(text);
              view.dispatch(view.state.tr.replaceSelection(pastedSlice(fragment)).scrollIntoView().setMeta("uiEvent", "paste"));
              return true;
            }
            // Other editors and terminals wrap copied text in plain boxes: read its plain text.
            if (shift || !html || !text.trim() || !plainTextHtml(html)) return false;
            const fragment = pastedTextFragment(view.state.schema, text);
            if (!fragment) return false;
            view.dispatch(view.state.tr.replaceSelection(pastedSlice(fragment)).scrollIntoView().setMeta("uiEvent", "paste"));
            return true;
          },
          transformPastedHTML: (html) => {
            fromThisApp = html.includes("data-pm-slice");
            return pastedPageHtml(html, origin());
          },
          // TeX in pasted formatted text becomes equations; never in a plain paste, a copy from a
          // page here (its blocks are already what they were) or a dragged block.
          transformPasted: (slice, view, plain) => {
            const internal = fromThisApp;
            fromThisApp = false;
            if (plain || internal || view.dragging) return slice;
            const content = withPastedMath(slice.content, view.state.schema);
            return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
          },
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
