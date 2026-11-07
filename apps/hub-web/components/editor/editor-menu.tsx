"use client";

/**
 * The page editor's right-click menu (pages, tasks, meeting notes: wherever `BlockEditor` is). What is
 * under the pointer decides it:
 * - inside picked text: a mini toolbar (bold, italic, underline, strike, code, link, comment), Ask
 *   Ensemble and Attach to assistant (the part, with the page it is from), Turn into task, Search, and
 *   Cut · Copy · Paste;
 * - a link, a mention, a page inside the page, an image or a table cell: what that thing can do;
 * - anywhere else on a block: Ask, Attach, Turn into, Duplicate, Comment, Copy, Delete; blocks already
 *   picked (a rectangle, Shift+click) act together.
 * The page itself is one submenu away ("Page ▸"). A right-click that only made the browser pick a word
 * (macOS does) counts as a click on the block, not as picked text.
 */
import type { Editor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import {
  ArrowUpRight,
  Bold,
  Clipboard,
  Code,
  Copy,
  CopyPlus,
  Download,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Italic,
  Link2,
  Link2Off,
  ListTodo,
  MessageSquare,
  PanelRight,
  Pencil,
  Repeat2,
  Scissors,
  Search,
  Strikethrough,
  Table2,
  Trash2,
  Underline as UnderlineIcon,
} from "lucide-react";
import { askText } from "@/components/ask-dialog";
import type { PageMention } from "@ensemble/shared-types";
import { api } from "@/lib/api";
import { attachToAssistant, type AttachSource } from "@/lib/assistant-attach";
import { askItems, copyText, openPalette } from "../context-menu/builders";
import type { MenuAction, MenuSection, MenuSpec, MenuTool } from "../context-menu/menu-store";
import { blockTargets, measureTargets, targetAt } from "./block-targets";
import { BlockSelection, duplicateBlocks, selectedBlocks } from "./block-selection";
import { deleteBlock, duplicateBlock } from "./block-move";
import { BLOCK_COMMANDS, blockKind, turnBlockInto, turnIntoChoices } from "./editor-commands";
import { loadPageImage } from "./page-image";
import { COMMENT_BLOCK_EVENT } from "./block-controls";

export type EditorMenuContext = {
  page?: { kind: string; id: string };
  title: () => string;
  editable: boolean;
  commentable: boolean;
  /** "Page ▸" / "Task ▸": the page's own menu, when the page view gives one. */
  pageMenu?: { label: string; sections: () => MenuSection[] } | null;
  /** The selection was empty when the right button went down (the browser picked a word itself). */
  pickedByClick: boolean;
  openMention: (mention: PageMention) => void;
  navigate: (href: string) => void;
  peek?: (id: string, kind: "page" | "task") => void;
  toast: (text: string, options?: { tone?: "ok" | "error"; action?: { label: string; run: () => void } }) => void;
};

const MENTION_KINDS = new Set(["people", "project", "repo", "task", "deliverable", "skill", "diagram", "plot", "dataset", "file", "date"]);

function sourceOf(context: EditorMenuContext): AttachSource {
  const kind = context.page?.kind;
  const known = kind === "page" || kind === "task" || kind === "meeting" || kind === "project" || kind === "deliverable" ? kind : null;
  return known && context.page ? { kind: known, id: context.page.id, title: context.title() } : { kind: "view", id: window.location.pathname, title: context.title() };
}

/** Whether the point is on the picked text (a little slack around each line). */
function onPicked(x: number, y: number): boolean {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || selection.isCollapsed) return false;
  for (const rect of Array.from(selection.getRangeAt(0).getClientRects())) {
    if (x >= rect.left - 3 && x <= rect.right + 3 && y >= rect.top - 3 && y <= rect.bottom + 3) return true;
  }
  return false;
}

/** A table as Markdown rows, for the assistant. */
function tableText(table: HTMLTableElement): string {
  const rows = Array.from(table.rows).map((row) => `| ${Array.from(row.cells).map((cell) => cell.innerText.replace(/\s+/g, " ").trim()).join(" | ")} |`);
  if (rows.length > 1) rows.splice(1, 0, `| ${Array.from(table.rows[0]!.cells).map(() => "---").join(" | ")} |`);
  return rows.join("\n");
}

async function imageBlob(attrs: { fileId?: string; src?: string }): Promise<Blob> {
  if (attrs.fileId) return loadPageImage(attrs.fileId);
  const response = await fetch(attrs.src ?? "");
  if (!response.ok) throw new Error("The image could not be read.");
  return response.blob();
}

const normalUrl = (value: string) => (/^(https?:|mailto:|tel:|\/|#)/i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);

export function editorMenu(editor: Editor, event: MouseEvent, context: EditorMenuContext): MenuSpec | null {
  if (editor.isDestroyed) return null;
  const view = editor.view;
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return null;
  const { editable } = context;
  const keyboard = event.clientX === 0 && event.clientY === 0;
  const source = sourceOf(context);
  const pageItem: MenuAction | null = context.pageMenu ? { id: "page-menu", label: context.pageMenu.label, icon: FileText, submenu: () => ({ sections: context.pageMenu!.sections() }) } : null;
  const tail: MenuSection[] = pageItem ? [{ items: [pageItem] }] : [];
  const handle = target.closest<HTMLElement>("[data-block-position]");
  const selection = editor.state.selection;

  // ── picked text ──
  const textPicked = !handle && selection instanceof TextSelection && !selection.empty && !context.pickedByClick && (keyboard || onPicked(event.clientX, event.clientY));
  if (textPicked) {
    const { from, to } = selection;
    const text = editor.state.doc.textBetween(from, to, "\n", " ").trim();
    const run = (command: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => () => command(editor.chain().focus()).run();
    const toolbar: MenuTool[] | undefined = editable
      ? [
          { id: "bold", label: "Bold", icon: Bold, hint: "Ctrl+B", active: editor.isActive("bold"), run: run((chain) => chain.toggleBold()) },
          { id: "italic", label: "Italic", icon: Italic, hint: "Ctrl+I", active: editor.isActive("italic"), run: run((chain) => chain.toggleItalic()) },
          { id: "underline", label: "Underline", icon: UnderlineIcon, active: editor.isActive("underline"), run: run((chain) => chain.toggleMark("underline")) },
          { id: "strike", label: "Strikethrough", icon: Strikethrough, active: editor.isActive("strike"), run: run((chain) => chain.toggleStrike()) },
          { id: "code", label: "Inline code", icon: Code, active: editor.isActive("code"), run: run((chain) => chain.toggleCode()) },
          {
            id: "link",
            label: editor.isActive("link") ? "Edit link" : "Link",
            icon: Link2,
            active: editor.isActive("link"),
            run: async () => {
              const before = String(editor.getAttributes("link").href ?? "");
              const href = await askText({ title: before ? "Edit link" : "Add a link", label: "Address", initial: before, placeholder: "https://…", confirm: "Save" });
              if (href === null || editor.isDestroyed) return;
              const chain = editor.chain().focus().extendMarkRange("link");
              (href.trim() ? chain.setLink({ href: normalUrl(href) }) : chain.unsetLink()).run();
            },
          },
          ...(context.commentable ? [{ id: "comment", label: "Comment", icon: MessageSquare, run: () => view.dom.dispatchEvent(new CustomEvent(COMMENT_BLOCK_EVENT, { detail: { from, to } })) }] : []),
        ]
      : undefined;
    const clip = (command: "copy" | "cut") => () => {
      view.focus();
      if (!document.execCommand(command) && command === "copy") void copyText(text);
    };
    const paste = async () => {
      view.focus();
      try {
        if (navigator.clipboard.read) {
          for (const item of await navigator.clipboard.read()) {
            if (item.types.includes("text/html")) {
              view.pasteHTML(await (await item.getType("text/html")).text());
              return;
            }
          }
        }
        view.pasteText(await navigator.clipboard.readText());
      } catch {
        throw new Error("The browser kept the clipboard closed. Press Ctrl+V to paste.");
      }
    };
    const firstLine = text.split("\n")[0]!.slice(0, 200);
    return {
      title: `“${text.length > 30 ? `${text.slice(0, 29)}…` : text}”`,
      toolbar,
      sections: [
        { items: askItems({ text, source }) },
        {
          items: [
            ...(context.page && context.page.kind !== "task"
              ? [
                  {
                    id: "to-task",
                    label: "Turn into task",
                    icon: ListTodo,
                    run: async () => {
                      const rest = text.slice(firstLine.length).trim();
                      const { task } = await api.createTask({ title: firstLine, ...(rest ? { description: rest } : {}) });
                      context.toast(`Task made: ${task.title}`, { tone: "ok", action: { label: "Open", run: () => context.peek?.(task.id, "task") } });
                    },
                  } satisfies MenuAction,
                ]
              : []),
            { id: "search", label: `Search for “${firstLine.length > 22 ? `${firstLine.slice(0, 21)}…` : firstLine}”`, icon: Search, run: () => openPalette(firstLine) },
          ],
        },
        {
          items: [
            {
              id: "clipboard",
              row: [
                ...(editable ? [{ id: "cut", label: "Cut", icon: Scissors, hint: "Ctrl+X", run: clip("cut") }] : []),
                { id: "copy", label: "Copy", icon: Copy, hint: "Ctrl+C", run: clip("copy") },
                ...(editable ? [{ id: "paste", label: "Paste", icon: Clipboard, hint: "Ctrl+V", run: paste, disabled: !navigator.clipboard?.readText }] : []),
              ],
            },
          ],
        },
        ...tail,
      ],
    };
  }

  // ── which block ──
  let pos: number | null = handle ? Number(handle.dataset.blockPosition) : null;
  if (pos === null || Number.isNaN(pos)) {
    if (keyboard) {
      const $from = selection.$from;
      pos = $from.depth ? $from.before(1) : null;
    } else {
      const root = view.dom;
      const found = targetAt(measureTargets(root, blockTargets(view)), event.clientY - root.getBoundingClientRect().top);
      pos = found?.pos ?? null;
    }
  }
  const node = pos !== null ? editor.state.doc.nodeAt(pos) : null;
  if (pos === null || !node) return pageItem ? { title: context.title(), sections: tail } : null;
  const at = pos;

  // A link, a mention, a page inside the page or an image under the pointer first.
  const mention = target.closest<HTMLAnchorElement>("a.mention");
  if (mention?.dataset.kind && mention.dataset.id) {
    const picked = { kind: mention.dataset.kind as PageMention["kind"], id: mention.dataset.id, label: mention.dataset.label ?? mention.innerText.replace(/^@/, "") };
    return {
      title: picked.label,
      sections: [
        {
          items: [
            { id: "mention-open", label: "Open", icon: ArrowUpRight, run: () => context.openMention(picked) },
            ...(MENTION_KINDS.has(picked.kind) && picked.kind !== "date" ? [{ id: "mention-attach", label: "Attach to assistant", icon: Repeat2, run: () => attachToAssistant({ mention: picked }) }] : []),
            { id: "mention-copy", label: "Copy name", icon: Copy, run: () => copyText(picked.label) },
          ],
        },
        ...tail,
      ],
    };
  }
  const anchor = target.closest<HTMLAnchorElement>("a[href]");
  if (anchor) {
    const href = anchor.getAttribute("href") ?? "";
    const pageId = /^\/pages\/([0-9a-f-]{36})/.exec(href)?.[1];
    const inside = href.startsWith("/");
    const markPos = view.posAtDOM(anchor, 0);
    return {
      title: anchor.innerText.trim() || href,
      sections: [
        {
          items: [
            { id: "link-open", label: pageId ? "Open page" : "Open link", icon: ArrowUpRight, run: () => (inside ? context.navigate(href) : window.open(anchor.href, "_blank", "noopener")) },
            ...(pageId && context.peek ? [{ id: "link-peek", label: "Open in side peek", icon: PanelRight, run: () => context.peek!(pageId, "page") }] : []),
            { id: "link-tab", label: "Open in new tab", icon: ExternalLink, run: () => window.open(anchor.href, "_blank", "noopener") },
            { id: "link-copy", label: "Copy link address", icon: Link2, run: () => copyText(anchor.href) },
          ],
        },
        ...(editable && !pageId
          ? [
              {
                items: [
                  {
                    id: "link-edit",
                    label: "Edit link",
                    icon: Pencil,
                    run: async () => {
                      const next = await askText({ title: "Edit link", label: "Address", initial: href, confirm: "Save" });
                      if (next === null || editor.isDestroyed) return;
                      const chain = editor.chain().focus().setTextSelection(markPos).extendMarkRange("link");
                      (next.trim() ? chain.setLink({ href: normalUrl(next) }) : chain.unsetLink()).run();
                    },
                  },
                  { id: "link-remove", label: "Remove link", icon: Link2Off, run: () => editor.chain().focus().setTextSelection(markPos).extendMarkRange("link").unsetLink().run() },
                ],
              },
            ]
          : []),
        ...tail,
      ],
    };
  }
  if (node.type.name === "image") {
    const attrs = node.attrs as { fileId?: string; src?: string; alt?: string };
    const name = attrs.alt?.trim() || "image";
    return {
      title: attrs.alt?.trim() || "Image",
      sections: [
        {
          items: [
            { id: "image-open", label: "Open image", icon: ImageIcon, run: () => (attrs.fileId ? context.navigate(`/files/${attrs.fileId}`) : window.open(attrs.src, "_blank", "noopener")) },
            {
              id: "image-copy",
              label: "Copy image",
              icon: Copy,
              run: async () => {
                const blob = await imageBlob(attrs);
                const png = blob.type === "image/png" ? blob : await toPng(blob);
                await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
              },
            },
            {
              id: "image-download",
              label: "Download",
              icon: Download,
              run: async () => {
                const blob = await imageBlob(attrs);
                const link = document.createElement("a");
                link.href = URL.createObjectURL(blob);
                link.download = `${name.replace(/[^\w.-]+/g, "-").slice(0, 60) || "image"}.${(blob.type.split("/")[1] ?? "png").replace("jpeg", "jpg")}`;
                link.click();
                window.setTimeout(() => URL.revokeObjectURL(link.href), 4000);
              },
            },
          ],
        },
        {
          items: [
            {
              id: "image-describe",
              label: "Describe with Ensemble",
              icon: FileText,
              run: () => attachToAssistant({ attachment: { text: `[Image: ${name}]`, source }, ...(attrs.fileId ? { mention: { kind: "file" as const, id: attrs.fileId, label: name } } : {}), prompt: "Describe this image.", send: true }),
            },
          ],
        },
        ...(editable ? [{ items: [{ id: "image-delete", label: "Delete image", icon: Trash2, danger: true, run: () => { const tr = deleteBlock(editor.state, at); if (tr) view.dispatch(tr); } }] }] : []),
        ...tail,
      ],
    };
  }

  // ── a block, or the blocks picked ──
  const current = editor.state.selection;
  const picked = current instanceof BlockSelection ? selectedBlocks(editor.state.doc, current.from, current.to) : [];
  const many = picked.length > 1 && picked.some((row) => row.pos === at) ? picked : null;
  if (!many && editable) {
    // As Notion does: the block the menu is for shows picked while it is open.
    const mark = BlockSelection.create(editor.state.doc, at, at);
    if (mark) view.dispatch(editor.state.tr.setSelection(mark));
  }
  const count = many?.length ?? 1;
  const blocks = many ?? [{ pos: at, node }];
  const text = blocks.map((row) => editor.state.doc.nodeAt(row.pos)?.textContent ?? "").join("\n\n").trim();
  const cell = target.closest("td, th");
  const table = cell?.closest("table");
  const tableMarkdown = table instanceof HTMLTableElement ? tableText(table) : "";
  const kind = count === 1 ? blockKind(editor.state.doc, at) : null;
  const choices = count === 1 ? turnIntoChoices(kind) : [];
  const several = (word: string) => (count > 1 ? `${word} ${count} blocks` : word);
  const inCell = (command: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => () => {
    const inside = view.posAtCoords({ left: event.clientX, top: event.clientY });
    const chain = editor.chain().focus();
    if (inside) chain.setTextSelection(inside.pos);
    command(chain).run();
  };
  const tableItem: MenuAction | null =
    editable && table
      ? {
          id: "table",
          label: "Table",
          icon: Table2,
          submenu: () => ({
            sections: [
              {
                items: [
                  { id: "row-above", label: "Insert row above", run: inCell((chain) => chain.addRowBefore()) },
                  { id: "row-below", label: "Insert row below", run: inCell((chain) => chain.addRowAfter()) },
                  { id: "col-left", label: "Insert column left", run: inCell((chain) => chain.addColumnBefore()) },
                  { id: "col-right", label: "Insert column right", run: inCell((chain) => chain.addColumnAfter()) },
                ],
              },
              { items: [{ id: "header-row", label: "Header row on or off", run: inCell((chain) => chain.toggleHeaderRow()) }] },
              {
                items: [
                  { id: "row-delete", label: "Delete row", danger: true, run: inCell((chain) => chain.deleteRow()) },
                  { id: "col-delete", label: "Delete column", danger: true, run: inCell((chain) => chain.deleteColumn()) },
                  { id: "table-delete", label: "Delete table", danger: true, run: inCell((chain) => chain.deleteTable()) },
                ],
              },
            ],
          }),
        }
      : null;
  const attachText = tableMarkdown || text;
  return {
    title: count > 1 ? `${count} blocks` : (BLOCK_COMMANDS.find((command) => command.id === kind)?.label ?? "Block"),
    sections: [
      ...(attachText ? [{ items: askItems({ text: attachText, source }, tableMarkdown ? [{ id: "plot", label: "Make a plot from this table", prompt: "Make a plot from this table." }] : []) }] : []),
      ...(editable
        ? [
            {
              items: [
                ...(tableItem ? [tableItem] : []),
                ...(choices.length
                  ? [
                      {
                        id: "turn",
                        label: "Turn into",
                        icon: Repeat2,
                        submenu: () => ({
                          sections: [
                            {
                              items: choices.map((id) => ({
                                id: `turn-${id}`,
                                label: BLOCK_COMMANDS.find((command) => command.id === id)?.label ?? id,
                                checked: id === kind,
                                run: () => {
                                  if (id !== kind && !turnBlockInto(editor, at, id)) editor.view.focus();
                                },
                              })),
                            },
                          ],
                        }),
                      } satisfies MenuAction,
                    ]
                  : []),
                {
                  id: "duplicate",
                  label: several("Duplicate"),
                  icon: CopyPlus,
                  hint: "Ctrl+D",
                  run: () => {
                    const tr = (count > 1 ? duplicateBlocks(editor.state) : null) ?? duplicateBlock(editor.state, at);
                    if (tr) view.dispatch(tr);
                  },
                },
                ...(context.commentable && count === 1 && text && !node.isLeaf
                  ? [{ id: "comment", label: "Comment", icon: MessageSquare, run: () => view.dom.dispatchEvent(new CustomEvent(COMMENT_BLOCK_EVENT, { detail: { from: at + 1, to: at + node.nodeSize - 1 } })) }]
                  : []),
              ],
            },
          ]
        : []),
      {
        items: [
          ...(attachText ? [{ id: "copy-text", label: count > 1 ? "Copy text" : tableMarkdown ? "Copy table" : "Copy text", icon: Copy, run: () => copyText(attachText) }] : []),
          ...(editable
            ? [
                {
                  id: "delete",
                  label: several("Delete"),
                  icon: Trash2,
                  danger: true,
                  hint: "Del",
                  run: () => {
                    const now = editor.state.selection;
                    const tr = count > 1 && now instanceof BlockSelection ? editor.state.tr.deleteSelection().scrollIntoView() : deleteBlock(editor.state, at);
                    if (tr) view.dispatch(tr);
                    view.focus();
                  },
                } satisfies MenuAction,
              ]
            : []),
        ],
      },
      ...tail,
    ].filter((section) => section.items.length),
  };
}

/** Clipboards take PNG: other images are drawn into one. */
async function toPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("The image could not be copied."))), "image/png"));
}

