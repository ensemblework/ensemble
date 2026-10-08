import { Extension, mergeAttributes } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import Mention, { type MentionOptions } from "@tiptap/extension-mention";
import { api } from "@/lib/api";
import { mountDiagramCard, mountDiagramOff } from "../diagrams/diagram-card";
import { mountPlotCard, mountPlotOff } from "../plots/plot-card";
import { storedEmbedHeight } from "./embed-resize";
import Placeholder from "@tiptap/extension-placeholder";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { PluginKey } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import Suggestion from "@tiptap/suggestion";
import type { PageDocument, PageMention, PageNode } from "@ensemble/shared-types";
import { isoDate } from "@/lib/format";
import {
  applyBlock,
  dateMention,
  matchCommands,
  mentionHref,
  type BlockCommandId,
} from "./editor-commands";
import { AgentBlock } from "./agent-block";
import { CommentMark } from "./comment-mark";
import { EnsembleReply } from "./ensemble-node";
import { menuRenderer, type MenuItem } from "./suggestion-menu";
import { mentionItems, type EntitySource } from "./mention-items";
export type { EntitySource } from "./mention-items";
export const ENTITY_MENTION_KEY = new PluginKey<{ active: boolean; query: string }>("entityMention");

const SlashCommand = Extension.create({
  name: "slashCommand",
  addProseMirrorPlugins() {
    return [
      Suggestion<MenuItem>({
        editor: this.editor,
        pluginKey: new PluginKey("slashCommand"),
        char: "/",
        items: ({ query }) =>
          matchCommands(query).map((command) => ({
            type: "block" as const,
            id: command.id,
            label: command.label,
            detail: command.detail,
            symbol: command.symbol,
          })),
        command: ({ editor, range, props }) => {
          if (props.type === "block") applyBlock(editor, range, props.id as BlockCommandId);
        },
        render: menuRenderer("Blocks"),
      }),
    ];
  },
});

function dateItems(search: string): MenuItem[] {
  const today = new Date();
  const add = (days: number) => {
    const date = new Date(today);
    date.setDate(date.getDate() + days);
    return date;
  };
  const nextMonday = add(((8 - today.getDay()) % 7) || 7);
  const presets: Array<[string, Date]> = [
    ["Today", today],
    ["Tomorrow", add(1)],
    ["Next Monday", nextMonday],
    ["In a week", add(7)],
  ];
  const items: MenuItem[] = [];
  const typed = dateMention(search.trim());
  if (typed) items.push({ type: "entity", kind: "date", id: typed.id, label: typed.label, detail: "The date you typed" });
  for (const [name, date] of presets) {
    if (search && !name.toLowerCase().includes(search.toLowerCase())) continue;
    const mention = dateMention(isoDate(date));
    if (mention) items.push({ type: "entity", kind: "date", id: mention.id, label: mention.label, detail: name });
  }
  if (!items.length) items.push({ type: "group", kind: "date", label: "Type a date", detail: "YYYY-MM-DD or YYYY-MM-DD HH:MM" });
  return items;
}

export function diagramMentionIds(doc: PageDocument): string[] {
  const ids: string[] = [];
  const walk = (node: PageNode) => {
    if (node.type === "mention" && node.attrs?.kind === "diagram" && typeof node.attrs.id === "string") ids.push(node.attrs.id);
    node.content?.forEach(walk);
  };
  doc.content?.forEach(walk);
  return [...new Set(ids)];
}

const EntityMention = Mention.extend<MentionOptions & { diagramsOn: () => boolean | null; plotsOn: () => boolean | null }>({
  addOptions() {
    // Tiptap calls this once before the parent is attached, so the parent is optional here.
    return { ...(this.parent?.() as MentionOptions), diagramsOn: () => true, plotsOn: () => true };
  },
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-id"),
        renderHTML: (attributes) => ({ "data-id": attributes.id }),
      },
      label: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-label"),
        renderHTML: (attributes) => ({ "data-label": attributes.label }),
      },
      kind: {
        default: "people",
        parseHTML: (element) => element.getAttribute("data-kind"),
        renderHTML: (attributes) => ({ "data-kind": attributes.kind }),
      },
      height: {
        default: null,
        parseHTML: (element) => storedEmbedHeight(element.getAttribute("data-height")),
        renderHTML: (attributes) => (attributes.height ? { "data-height": String(attributes.height) } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "a.mention[data-id]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const href = mentionHref(node.attrs as PageMention) ?? "#";
    return ["a", mergeAttributes({ class: "mention", href }, HTMLAttributes), `@${node.attrs.label ?? ""}`];
  },
  renderText({ node }) {
    return `@${node.attrs.label ?? ""}`;
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const kind = String(node.attrs.kind ?? "");
      if (kind !== "diagram" && kind !== "plot") {
        const dom = document.createElement("a");
        dom.className = "mention";
        dom.href = mentionHref(node.attrs as PageMention) ?? "#";
        dom.dataset.id = String(node.attrs.id ?? "");
        dom.dataset.kind = kind;
        dom.dataset.label = String(node.attrs.label ?? "");
        dom.textContent = `@${node.attrs.label ?? ""}`;
        return { dom };
      }
      const dom = document.createElement("span");
      const same = (next: typeof node) =>
        next.type === node.type && next.attrs.kind === node.attrs.kind && next.attrs.id === node.attrs.id && next.attrs.label === node.attrs.label;
      // The height lives on the mention so it saves with the page. Undo restores it too.
      const resize = editor.isEditable
        ? (height: number) => {
            const pos = getPos();
            if (typeof pos !== "number") return;
            const current = editor.state.doc.nodeAt(pos);
            if (!current || current.attrs.height === height) return;
            editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, height }));
          }
        : undefined;
      if (kind === "plot") {
        if (this.options.plotsOn() === false) {
          mountPlotOff(dom, String(node.attrs.label ?? ""));
          return { dom };
        }
        const card = mountPlotCard(dom, String(node.attrs.id ?? ""), String(node.attrs.label ?? ""), editor.isEditable ? () => {
          const pos = getPos();
          if (typeof pos === "number") editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
        } : undefined, { height: storedEmbedHeight(node.attrs.height), onResize: resize });
        return {
          dom,
          destroy: card.destroy,
          update: (next) => {
            if (!same(next)) return false;
            card.setHeight(storedEmbedHeight(next.attrs.height));
            return true;
          },
          stopEvent: (event) => Boolean((event.target as HTMLElement | null)?.closest?.(".embed-resize")),
          ignoreMutation: (mutation) => mutation.type !== "selection",
        };
      }
      if (this.options.diagramsOn() === false) {
        mountDiagramOff(dom, String(node.attrs.label ?? ""));
        return { dom };
      }
      const card = mountDiagramCard(dom, String(node.attrs.id ?? ""), String(node.attrs.label ?? ""), {
        height: storedEmbedHeight(node.attrs.height),
        onResize: resize,
      });
      return {
        dom,
        destroy: card.destroy,
        update: (next) => {
          if (!same(next)) return false;
          card.setHeight(storedEmbedHeight(next.attrs.height));
          return true;
        },
        stopEvent: (event) => Boolean((event.target as HTMLElement | null)?.closest?.(".embed-resize, .diagram-inline-stage, button")),
        ignoreMutation: (mutation) => mutation.type !== "selection",
      };
    };
  },
});

/**
 * `diagramsOn` is read on every keystroke and every card mount, so it follows the
 * diagrams module after the shell loads. Null means the shell has not loaded yet.
 */
export function editorExtensions(entities: EntitySource, placeholder: string, diagramsOn: () => boolean | null = () => true, plotsOn: () => boolean | null = () => true) {
  return [
    StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
    Placeholder.configure({
      placeholder: ({ node }) => (node.type.name === "heading" ? "Heading" : placeholder),
    }),
    Link.configure({ openOnClick: false, autolink: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
    AgentBlock,
    CommentMark,
    EnsembleReply,
    SlashCommand,
    EntityMention.configure({
      diagramsOn,
      plotsOn,
      suggestion: {
        char: "@",
        pluginKey: ENTITY_MENTION_KEY,
        allowSpaces: true,
        items: ({ query }) => {
          const scoped = query.match(/^date:(.*)$/i);
          return scoped ? dateItems(scoped[1]!) : mentionItems(query, entities, diagramsOn, plotsOn);
        },
        command: ({ editor, range, props }) => {
          const item = props as unknown as MenuItem;
          if (item.type === "action") {
            editor.chain().focus().insertContentAt(range, "@ensemble ").run();
            return;
          }
          if (item.type === "create") {
            const insert = (id: string, label: string, kind: string) => {
              editor
                .chain()
                .focus()
                .insertContentAt(range, [
                  { type: "mention", attrs: { id, label, kind } },
                  { type: "text", text: " " },
                ])
                .run();
            };
            void api.createDiagram().then(({ diagram }) => insert(diagram.id, diagram.title, "diagram"));
            return;
          }
          if (item.type === "group") {
            if (item.label === "Type a date") return;
            editor.chain().focus().insertContentAt(range, `@${item.prefix ?? `${item.kind}:`}`).run();
            return;
          }
          if (item.type === "entity") {
            editor
              .chain()
              .focus()
              .insertContentAt(range, [
                { type: "mention", attrs: { id: item.id, label: item.label, kind: item.kind } },
                { type: "text", text: " " },
              ])
              .run();
          }
        },
        render: menuRenderer("Mentions") as never,
      },
    }),
  ];
}
