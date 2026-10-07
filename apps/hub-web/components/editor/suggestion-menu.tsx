"use client";

import { placeAnchoredPanel, type Side } from "@/lib/place-layer";
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import { AtSign, Calendar, ChartSpline, CheckSquare, FolderKanban, GitBranch, Target, User, Wand2, Waypoints } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export type MenuItem =
  | { type: "block"; id: string; label: string; detail: string; symbol: string }
  | { type: "group"; kind: string; label: string; detail: string; prefix?: string }
  | { type: "action"; kind: "ensemble"; id: string; label: string; detail: string }
  | { type: "entity"; kind: string; id: string; label: string; detail: string }
  | { type: "create"; kind: string; id: string; label: string; detail: string };

export type MenuHandle = { onKeyDown: (event: KeyboardEvent) => boolean };

type Props = SuggestionProps<MenuItem> & { title: string };

const KIND_ICON: Record<string, typeof User> = {
  people: User,
  project: FolderKanban,
  repo: GitBranch,
  task: CheckSquare,
  deliverable: Target,
  skill: Wand2,
  diagram: Waypoints,
  plot: ChartSpline,
  "plot-space": ChartSpline,
  dataset: ChartSpline,
  ensemble: Wand2,
  date: Calendar,
};

export const SuggestionMenu = forwardRef<MenuHandle, Props>(function SuggestionMenu(props, ref) {
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => setSelected(0), [props.items]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

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
        {props.items.length === 0 ? (
          <div className="px-2 py-3 text-[13px] text-muted">No matches. Keep typing, or press Esc.</div>
        ) : (
          props.items.map((item, index) => {
            const Icon = item.type === "block" ? null : KIND_ICON[item.kind] ?? AtSign;
            return (
              <button
                key={`${item.type}-${"id" in item ? item.id : item.prefix ?? item.kind}`}
                type="button"
                data-index={index}
                data-active={index === selected}
                onMouseEnter={() => setSelected(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(index);
                }}
                className="row-tile flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line bg-panel text-[12.5px] font-semibold text-muted">
                  {item.type === "block" ? item.symbol : item.type === "group" ? "@" : Icon ? <Icon size={14} /> : "@"}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13.5px] font-medium">{item.label}</span>
                  {item.detail ? <span className="block truncate text-[12px] text-muted">{item.detail}</span> : null}
                </span>
              </button>
            );
          })
        )}
      </div>
      <div className="flex items-center justify-between border-t border-line px-3 py-1.5 text-[11.5px] text-faint">
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
    const visibility = (props: SuggestionProps<MenuItem>) => {
      if (renderer) (renderer.element as HTMLElement).hidden = title === "Mentions" && /^ensemble(?:\s|:)/i.test(props.query);
    };
    const destroy = () => {
      renderer?.element.remove();
      renderer?.destroy();
      renderer = null;
    };
    return {
      onStart(props: SuggestionProps<MenuItem>) {
        renderer = new ReactRenderer(SuggestionMenu, { props: { ...props, title }, editor: props.editor });
        document.body.appendChild(renderer.element);
        visibility(props);
        requestAnimationFrame(() => place(props));
      },
      onUpdate(props: SuggestionProps<MenuItem>) {
        renderer?.updateProps({ ...props, title });
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
