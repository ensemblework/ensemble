"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import type { PageMention } from "@ensemble/shared-types";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { inItemView } from "@/lib/api";
import { useEntities } from "@/lib/entities";
import { mentionInsertText, mentionItems, type MentionMenuItem } from "@/lib/mentions/menu";
import { keptMentions, mentionAt, replaceMention } from "@/lib/mentions/text";
import { placeAnchoredPanel, type Side } from "@/lib/place-layer";
import { useModuleState } from "@/lib/use-module";
import { useLayerZ } from "../ui";
import { mentionBadge, mentionIcon } from "./mention-icons";

type Field = HTMLTextAreaElement | HTMLInputElement;

export type MentionMenu<T extends Field = Field> = ReturnType<typeof useMentionMenu<T>>;

/**
 * The @ menu for a plain `textarea` or `input`. Spread `inputProps` on the box,
 * call `onKeyDown` first in the box's own key handler (it returns true when the
 * menu used the key), and render `<MentionPopover menu={…} />` next to it.
 * Picking writes `@people:Mira Chen ` into the text; `takeMentions(text)` gives
 * back the ids of the picked mentions still in it.
 */
export function useMentionMenu<T extends Field = HTMLTextAreaElement>(options: {
  value: string;
  onValue: (value: string) => void;
  inputRef?: RefObject<T | null>;
}) {
  const { value, onValue } = options;
  const own = useRef<T>(null);
  const ref = options.inputRef ?? own;
  const [caret, setCaret] = useState<number | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [activeState, setActiveState] = useState({ key: "", index: 0 });
  const picked = useRef<PageMention[]>([]);
  const openAt = useRef<number | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const listId = useId();

  // A shared item or public link cannot list the owner's space, so it has no @ menu.
  const token = caret === null || inItemView() ? null : mentionAt(value, caret);
  const entities = useEntities(Boolean(token));
  const diagrams = useModuleState("diagrams");
  const plots = useModuleState("plots");
  const query = token?.query ?? null;
  const items = useMemo<MentionMenuItem[]>(
    () => (query === null ? [] : mentionItems(query, () => entities.entities, () => diagrams, () => plots)),
    [query, entities.entities, diagrams, plots],
  );
  // A scoped token keeps its spaces (`@people:Anika Rao`) only while its menu is already open.
  const open = Boolean(token && items.length && token.at !== dismissedAt && (!token.spaced || openAt.current === token.at));
  const key = token ? `${token.at}:${token.query}` : "";
  const active = activeState.key === key ? Math.min(activeState.index, Math.max(items.length - 1, 0)) : 0;

  useEffect(() => {
    openAt.current = open && token ? token.at : null;
  });
  useEffect(() => {
    if (dismissedAt !== null && token?.at !== dismissedAt) setDismissedAt(null);
  }, [dismissedAt, token?.at]);
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    const field = ref.current;
    if (at === null || !field) return;
    pendingCaret.current = null;
    field.focus();
    field.setSelectionRange(at, at);
  });

  const readCaret = (field: Field) => setCaret(field.selectionStart === field.selectionEnd ? field.selectionStart : null);

  const pick = (index: number) => {
    const item = items[index];
    if (!item || !token || caret === null) return;
    const text = mentionInsertText(item);
    if (text === null) return;
    const next = replaceMention(value, token, caret, text);
    if (item.type === "entity") picked.current = [...picked.current, { kind: item.kind as PageMention["kind"], id: item.id, label: item.label }];
    if (item.type !== "group") setDismissedAt(token.at);
    pendingCaret.current = next.caret;
    setCaret(next.caret);
    onValue(next.value);
  };

  const move = (step: number) => setActiveState({ key, index: (active + step + items.length) % items.length });

  return {
    ref,
    open,
    items,
    active,
    listId,
    optionId: (index: number) => `${listId}-option-${index}`,
    setActive: (index: number) => setActiveState({ key, index }),
    pick,
    inputProps: {
      onChange: (event: SyntheticEvent<T>) => {
        onValue(event.currentTarget.value);
        readCaret(event.currentTarget);
      },
      onSelect: (event: SyntheticEvent<T>) => readCaret(event.currentTarget),
      onBlur: () => setCaret(null),
      "aria-autocomplete": "list" as const,
      "aria-controls": open ? listId : undefined,
      "aria-activedescendant": open ? `${listId}-option-${active}` : undefined,
    },
    /** True when the menu handled the key; the box's own Enter (send, save) runs only when this is false. */
    onKeyDown: (event: KeyboardEvent<T>): boolean => {
      if (!open || !token || event.nativeEvent.isComposing) return false;
      const plain = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        move(event.key === "ArrowDown" ? 1 : -1);
        return true;
      }
      if ((event.key === "Enter" || event.key === "Tab") && plain) {
        event.preventDefault();
        pick(active);
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissedAt(token.at);
        return true;
      }
      return false;
    },
    /** The picked mentions still written in `text`. */
    takeMentions: (text = value) => keptMentions(text, picked.current),
    /** Forget picked mentions, after the text was sent. */
    clear: () => {
      picked.current = [];
    },
  };
}

const PANEL_WIDTH = 340;

/** The menu's list, fixed to the viewport above its box (below when there is no room). */
export function MentionPopover<T extends Field>({ menu }: { menu: MentionMenu<T> }) {
  const panel = useRef<HTMLDivElement>(null);
  const side = useRef<Side | null>(null);
  const [place, setPlace] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const { open, items, active, ref } = menu;
  const z = useLayerZ(90);

  useLayoutEffect(() => {
    if (!open) {
      side.current = null;
      return;
    }
    const measure = () => {
      const field = ref.current;
      if (!field) return;
      const next = placeAnchoredPanel({
        anchor: field.getBoundingClientRect(),
        panelWidth: PANEL_WIDTH,
        panelHeight: panel.current?.scrollHeight || 300,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        previousSide: side.current ?? "above",
        gap: 6,
      });
      side.current = next.side;
      setPlace((current) => (current && current.top === next.top && current.left === next.left && current.maxHeight === next.maxHeight ? current : { top: next.top, left: next.left, maxHeight: next.maxHeight }));
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, items.length, ref]);

  useEffect(() => {
    if (open) document.getElementById(menu.optionId(active))?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, menu]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={panel}
      className="pop-in fixed flex flex-col overflow-hidden rounded-lg bg-raised shadow-pop"
      style={{ zIndex: z, width: PANEL_WIDTH, maxWidth: "calc(100vw - 16px)", top: place?.top ?? -9999, left: place?.left ?? 0, maxHeight: Math.min(place?.maxHeight ?? 340, 340) }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div id={menu.listId} role="listbox" aria-label="Mentions" className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {items.map((item, index) => {
          const Icon = mentionIcon(item);
          const badge = mentionBadge(item);
          return (
            <div
              key={`${item.type}-${"id" in item ? item.id : "prefix" in item ? item.prefix : `${item.kind}-${item.label}`}`}
              id={menu.optionId(index)}
              role="option"
              aria-selected={index === active}
              data-active={index === active}
              onMouseEnter={() => menu.setActive(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                menu.pick(index);
              }}
              className="row-tile flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-panel text-[12px] font-semibold text-muted">
                {Icon ? <Icon size={13} /> : "@"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{item.label}</span>
                {item.detail ? <span className="block truncate text-[11.5px] text-muted">{item.detail}</span> : null}
              </span>
              {badge ? <span className="shrink-0 text-[11.5px] text-faint">{badge}</span> : null}
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between border-t border-line px-3 py-1.5 text-[11.5px] text-faint">
        <span>↑↓ · Enter to insert</span>
        <span>Esc · Close</span>
      </div>
    </div>,
    document.body,
  );
}
