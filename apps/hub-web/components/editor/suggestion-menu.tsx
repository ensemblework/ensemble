"use client";

import { placeAnchoredPanel, type Side } from "@/lib/place-layer";
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import { Paperclip, type LucideIcon } from "lucide-react";
import type { MentionMenuItem } from "@/lib/mentions/menu";
import { mentionBadge, mentionIcon } from "../mentions/mention-icons";
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";

export type MenuItem = { type: "block"; id: string; label: string; detail: string; symbol: string } | MentionMenuItem;

export type MenuHandle = { onKeyDown: (event: KeyboardEvent) => boolean };

type Props = SuggestionProps<MenuItem> & { title: string; hidden?: boolean };

/** What the editor says about an open menu: the listbox it controls and its active option. */
const COMBO_ATTRIBUTES = ["aria-controls", "aria-activedescendant", "aria-autocomplete", "aria-haspopup"] as const;

const BLOCK_ICON: Record<string, LucideIcon> = { file: Paperclip };

function itemIcon(item: MenuItem): LucideIcon | null {
  if (item.type === "block") return BLOCK_ICON[item.id] ?? null;
  return mentionIcon(item);
}

export const SuggestionMenu = forwardRef<MenuHandle, Props>(function SuggestionMenu(props, ref) {
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const listId = `${id}listbox`;
  const optionId = (index: number) => `${id}option-${index}`;
  const active = props.items.length ? Math.min(selected, props.items.length - 1) : -1;

  useEffect(() => setSelected(0), [props.items]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Focus stays in the editor (combobox pattern): it names the listbox and its active option,
  // which is what a screen reader announces as the arrows move.
  const editorDom = props.editor.view.dom;
  useEffect(() => {
    if (props.hidden) return;
    editorDom.setAttribute("aria-controls", listId);
    editorDom.setAttribute("aria-autocomplete", "list");
    editorDom.setAttribute("aria-haspopup", "listbox");
    if (active >= 0) editorDom.setAttribute("aria-activedescendant", optionId(active));
    else editorDom.removeAttribute("aria-activedescendant");
    return () => {
      for (const name of COMBO_ATTRIBUTES) editorDom.removeAttribute(name);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorDom, listId, active, props.hidden]);

  const choose = (index: number) => {
    const item = props.items[index];
    if (item) props.command(item);
  };

  useImperativeHandle(ref, () => ({
    onKeyDown(event) {
      if (!props.items.length) return false;
      if (event.key === "ArrowDown") {
        setSelected((value) => (value + 1) % props.items.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        setSelected((value) => (value - 1 + props.items.length) % props.items.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        choose(selected);
        return true;
      }
      return false;
    },
  }));

  return (
    <div className="pop-in w-[340px] overflow-hidden rounded-lg bg-raised shadow-pop">
      <div className="px-3 pb-1 pt-2.5 text-[12px] font-medium text-muted">{props.title}</div>
      <div ref={list} className="max-h-[300px] overflow-y-auto px-1.5 pb-1.5">
        {props.items.length === 0 ? <div role="status" className="px-2 py-3 text-[13px] text-muted">No matches. Keep typing, or press Esc.</div> : null}
        <div id={listId} role="listbox" aria-label={props.title}>
          {props.items.map((item, index) => {
            const Icon = itemIcon(item);
            const badge = item.type === "block" ? null : mentionBadge(item);
            return (
              <button
                key={`${item.type}-${"id" in item ? item.id : "prefix" in item ? item.prefix : `${item.kind}-${item.label}`}`}
                id={optionId(index)}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === active}
                data-index={index}
                data-active={index === selected}
                onMouseEnter={() => setSelected(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(index);
                }}
                className="row-tile flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left"
              >
                <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line bg-panel text-[12.5px] font-semibold text-muted">
                  {Icon ? <Icon size={14} /> : item.type === "block" ? item.symbol : "@"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">{item.label}</span>
                  {item.detail ? <span className="block truncate text-[12px] text-muted">{item.detail}</span> : null}
                </span>
                {badge ? <span className="shrink-0 text-[11.5px] text-faint">{badge}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
      <div aria-hidden className="flex items-center justify-between border-t border-line px-3 py-1.5 text-[11.5px] text-faint">
        <span>↑↓ to select · Enter to insert</span>
        <span>Esc · Close</span>
      </div>
    </div>
  );
});

/** Glue between TipTap's suggestion plugin and the React menu, positioned under the caret. */
export function menuRenderer(title: string) {
  return () => {
    let renderer: ReactRenderer<MenuHandle, Props> | null = null;
    let side: Side | null = null;
    const place = (props: SuggestionProps<MenuItem>) => {
      const rect = props.clientRect?.();
      if (!renderer || !rect) return;
      const element = renderer.element as HTMLElement;
      const next = placeAnchoredPanel({
        anchor: rect,
        panelWidth: 340,
        panelHeight: element.scrollHeight || 360,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        previousSide: side,
        gap: 6,
      });
      side = next.side;
      element.style.position = "fixed";
      element.style.zIndex = "90";
      element.style.left = `${next.left}px`;
      element.style.top = `${next.top}px`;
      element.style.maxHeight = `${Math.min(next.maxHeight, 360)}px`;
    };
    // `@ensemble …` is a request, not a mention, so the menu steps aside while it is typed.
    const hiddenFor = (props: SuggestionProps<MenuItem>) => title === "Mentions" && /^ensemble(?:\s|:)/i.test(props.query);
    const visibility = (props: SuggestionProps<MenuItem>) => {
      if (renderer) (renderer.element as HTMLElement).hidden = hiddenFor(props);
    };
    const destroy = () => {
      renderer?.element.remove();
      renderer?.destroy();
      renderer = null;
    };
    return {
      onStart(props: SuggestionProps<MenuItem>) {
        renderer = new ReactRenderer(SuggestionMenu, { props: { ...props, title, hidden: hiddenFor(props) }, editor: props.editor });
        document.body.appendChild(renderer.element);
        visibility(props);
        requestAnimationFrame(() => place(props));
      },
      onUpdate(props: SuggestionProps<MenuItem>) {
        renderer?.updateProps({ ...props, title, hidden: hiddenFor(props) });
        visibility(props);
        requestAnimationFrame(() => place(props));
      },
      onKeyDown(props: SuggestionKeyDownProps) {
        if (props.event.key === "Escape") {
          destroy();
          return true;
        }
        return renderer?.ref?.onKeyDown(props.event) ?? false;
      },
      onExit() {
        destroy();
      },
    };
  };
}
