"use client";

/**
 * The window parts Code's Welcome (`code-home.tsx`) and its editor (`ide.tsx`) share: the activity bar,
 * the resizable side panel and terminal panel, and the status bar. Sizes and which panels are open are
 * remembered in this browser (`ensemble.code.*`), never anything about the code. Styles: `code.css`.
 */
import { Minus, Plus } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { cx } from "@/components/ui";
import { usePersistentState } from "@/lib/prefs";

export const SIDEBAR_DEFAULT = 260;
export const SIDEBAR_MIN = 200;
export const TERMINAL_DEFAULT = 280;
export const TERMINAL_MIN = 140;
/** The terminal never takes more than this share of the window's height, so the editor stays usable. */
export const TERMINAL_MAX_SHARE = 0.75;
export const FONT_DEFAULT = 13;
export const FONT_MIN = 10;
export const FONT_MAX = 24;

export type IdeLayout = ReturnType<typeof useIdeLayout>;

export function useIdeLayout() {
  const [sidebar, setSidebar] = usePersistentState("ensemble.code.panel", true);
  const [phone, setPhone] = useState(false);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  // On a phone the panel is an overlay that starts closed; its desktop preference is left alone.
  const sideOpen = phone ? mobileSidebar : sidebar;
  const setSideOpen = useCallback(
    (open: boolean) => {
      if (phone) setMobileSidebar(open);
      else setSidebar(open);
    },
    [phone, setSidebar],
  );
  const closeOverlay = useCallback(() => setMobileSidebar(false), []);
  /** Opens the panel; safe before the phone check has run (a link that names a panel). */
  const showSide = useCallback(() => {
    if (window.matchMedia("(max-width: 767px)").matches) setMobileSidebar(true);
    else setSidebar(true);
  }, [setSidebar]);
  const [width, setWidth] = usePersistentState("ensemble.code.sidebarWidth", SIDEBAR_DEFAULT);
  const [terminal, setTerminal] = usePersistentState("ensemble.code.terminal", false);
  const [terminalHeight, setTerminalHeight] = usePersistentState("ensemble.code.terminalHeight", TERMINAL_DEFAULT);
  const [fontSize, setFontSize] = usePersistentState("ensemble.code.fontSize", FONT_DEFAULT);
  return { phone, sideOpen, setSideOpen, showSide, closeOverlay, width, setWidth, terminal, setTerminal, terminalHeight, setTerminalHeight, fontSize, setFontSize };
}

/** Keys both windows answer to. None is a bare letter: every letter types. */
export function useIdeKeys(layout: IdeLayout) {
  const { terminal, setTerminal, sideOpen, setSideOpen, fontSize, setFontSize } = layout;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      if (event.key === "`") setTerminal(!terminal);
      else if (!event.shiftKey && !event.altKey && event.key.toLowerCase() === "b") setSideOpen(!sideOpen);
      else if (event.shiftKey && (event.key === "+" || event.key === "=")) setFontSize(Math.min(FONT_MAX, fontSize + 1));
      else if (event.shiftKey && (event.key === "_" || event.key === "-")) setFontSize(Math.max(FONT_MIN, fontSize - 1));
      else if (event.shiftKey && (event.key === ")" || event.key === "0")) setFontSize(FONT_DEFAULT);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [terminal, setTerminal, sideOpen, setSideOpen, fontSize, setFontSize]);
}

/** A size shown live while it is dragged and saved when the drag ends. */
function useLiveSize(saved: number, save: (value: number) => void): [number, (value: number, done: boolean) => void] {
  const [live, setLive] = useState<number | null>(null);
  const change = useCallback(
    (value: number, done: boolean) => {
      if (done) {
        setLive(null);
        save(value);
      } else setLive(value);
    },
    [save],
  );
  return [live ?? saved, change];
}

/**
 * A drag handle like VS Code's sash: a thin line that lights up on hover and while dragged. Double-click
 * puts the default back; arrow keys move it by 16 px (48 with Shift) when it has focus.
 */
export function Sash({
  orientation,
  value,
  min,
  max,
  reset,
  onChange,
  label,
}: {
  /** `vertical`: a side panel's right edge. `horizontal`: a bottom panel's top edge. */
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: () => number;
  reset: number;
  onChange: (value: number, done: boolean) => void;
  label: string;
}) {
  const drag = useRef<{ pointer: number; from: number; start: number; last: number } | null>(null);
  const [active, setActive] = useState(false);
  const vertical = orientation === "vertical";
  const clamp = (next: number) => Math.round(Math.min(Math.max(min, max()), Math.max(min, next)));
  const end = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null;
    setActive(false);
    delete document.documentElement.dataset.ideResizing;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    onChange(current.last, true);
  };
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      tabIndex={0}
      title={`${label} (double-click resets)`}
      data-active={active || undefined}
      className="ide-sash"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { pointer: event.pointerId, from: vertical ? event.clientX : event.clientY, start: value, last: value };
        setActive(true);
        document.documentElement.dataset.ideResizing = orientation;
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.pointer !== event.pointerId) return;
        const delta = vertical ? event.clientX - current.from : current.from - event.clientY;
        const next = clamp(current.start + delta);
        if (next === current.last) return;
        current.last = next;
        onChange(next, false);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => onChange(clamp(reset), true)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 16;
        const grow = vertical ? "ArrowRight" : "ArrowUp";
        const shrink = vertical ? "ArrowLeft" : "ArrowDown";
        if (event.key === grow) onChange(clamp(value + step), true);
        else if (event.key === shrink) onChange(clamp(value - step), true);
        else return;
        event.preventDefault();
      }}
    />
  );
}

export type ActivityItem = {
  id: string;
  icon: ComponentType<{ size?: number }>;
  label: string;
  active?: boolean;
  /** A small count on the icon (changes to review). */
  badge?: number;
  href?: string;
  onClick?: () => void;
};

/** The slim bar on the left; `bottom` items sit at its foot (the terminal). */
export function ActivityBar({ items, bottom = [] }: { items: ActivityItem[]; bottom?: ActivityItem[] }) {
  return (
    <nav className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-sidebar py-2" aria-label="Code views">
      {items.map((item) => (
        <ActivityButton key={item.id} item={item} />
      ))}
      <div className="flex-1" />
      {bottom.map((item) => (
        <ActivityButton key={item.id} item={item} />
      ))}
    </nav>
  );
}

function ActivityButton({ item }: { item: ActivityItem }) {
  const Icon = item.icon;
  const className = cx("ide-activity relative flex h-9 w-9 items-center justify-center rounded-md text-muted hover:text-ink", item.active && "bg-hover text-ink");
  const content = (
    <>
      <Icon size={17} />
      {item.badge ? (
        <span className="on-accent absolute -right-0.5 -top-0.5 min-w-[15px] rounded-full px-1 text-center text-[9.5px] font-semibold leading-[15px] tabular-nums" aria-hidden>
          {item.badge > 99 ? "99+" : item.badge}
        </span>
      ) : null}
    </>
  );
  const label = item.badge ? `${item.label} (${item.badge})` : item.label;
  if (item.href) {
    return (
      <Link href={item.href} title={item.label} aria-label={label} data-active={item.active || undefined} className={className}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" title={item.label} aria-label={item.label} aria-pressed={Boolean(item.active)} data-active={item.active || undefined} onClick={item.onClick} className={className}>
      {content}
    </button>
  );
}

/** The side panel: resizable on a computer, an overlay that closes on a tap outside on a phone. */
export function SidePanel({ layout, children }: { layout: IdeLayout; children: ReactNode }) {
  const [width, change] = useLiveSize(layout.width, layout.setWidth);
  if (!layout.sideOpen) return null;
  const shown = Math.max(SIDEBAR_MIN, width);
  return (
    <>
      {layout.phone ? <button type="button" className="absolute inset-y-0 left-11 right-0 z-10 bg-black/40" aria-label="Close code panel" onClick={layout.closeOverlay} /> : null}
      <aside
        className="relative flex min-w-0 shrink-0 flex-col border-r border-line bg-sidebar max-md:absolute max-md:inset-y-0 max-md:left-11 max-md:z-20 max-md:max-w-[calc(100%-44px)] max-md:shadow-xl"
        style={{ width: shown }}
        aria-label="Side panel"
      >
        {children}
        {layout.phone ? null : (
          <Sash
            orientation="vertical"
            value={shown}
            min={SIDEBAR_MIN}
            max={() => Math.max(SIDEBAR_MIN, Math.floor(window.innerWidth / 2))}
            reset={SIDEBAR_DEFAULT}
            onChange={change}
            label="Resize the side panel"
          />
        )}
      </aside>
    </>
  );
}

/** A side panel's heading row, VS Code style: a small capital label and its actions. */
export function PanelHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 pl-3 pr-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {children}
    </div>
  );
}

/**
 * The terminal's panel under the editor, resized from its top edge: at least 140 px, at most three
 * quarters of the window (`[data-ide-root]`), double-click for the default.
 */
export function BottomPanel({ layout, children }: { layout: IdeLayout; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [height, change] = useLiveSize(layout.terminalHeight, layout.setTerminalHeight);
  const max = useCallback(() => {
    const ide = box.current?.closest<HTMLElement>("[data-ide-root]");
    const total = ide?.clientHeight || window.innerHeight;
    return Math.max(TERMINAL_MIN, Math.floor(total * TERMINAL_MAX_SHARE));
  }, []);
  // A window made smaller since the height was chosen still leaves the editor its room.
  const [cap, setCap] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setCap(max());
    update();
    const ide = box.current?.closest<HTMLElement>("[data-ide-root]");
    if (ide && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(update);
      observer.observe(ide);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [max]);
  const shown = Math.round(Math.max(TERMINAL_MIN, Math.min(height, cap ?? Number.POSITIVE_INFINITY)));
  return (
    <div ref={box} className="relative flex min-h-0 shrink-0 flex-col" style={{ height: shown }} data-testid="ide-bottom-panel">
      <Sash orientation="horizontal" value={shown} min={TERMINAL_MIN} max={max} reset={TERMINAL_DEFAULT} onChange={change} label="Resize the terminal" />
      {children}
    </div>
  );
}

export function StatusBar({ children }: { children: ReactNode }) {
  return (
    <div className="ide-statusbar flex h-6 shrink-0 items-center gap-1 overflow-x-auto whitespace-nowrap border-t border-line bg-sidebar px-1.5 text-[11.5px] text-muted" data-testid="ide-statusbar">
      {children}
    </div>
  );
}

/** One status bar entry; a button or a link when it does something. */
export function StatusItem({ icon: Icon, children, title, onClick, href, className }: { icon?: ComponentType<{ size?: number; className?: string }>; children: ReactNode; title?: string; onClick?: () => void; href?: string; className?: string }) {
  const body = (
    <>
      {Icon ? <Icon size={11} className="shrink-0" /> : null}
      {children}
    </>
  );
  const base = cx("flex h-full shrink-0 items-center gap-1 rounded-sm px-1.5", className);
  if (href) return <Link href={href} title={title} className={cx(base, "hover:bg-hover hover:text-ink")}>{body}</Link>;
  if (onClick) return <button type="button" title={title} onClick={onClick} className={cx(base, "hover:bg-hover hover:text-ink")}>{body}</button>;
  return <span title={title} className={base}>{body}</span>;
}

export function FontSizeControl({ fontSize, setFontSize }: { fontSize: number; setFontSize: (size: number) => void }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Code text size">
      <button type="button" className="icon-btn h-5 w-5" title="Smaller code (Ctrl+Shift+-)" aria-label="Smaller code" onClick={() => setFontSize(Math.max(FONT_MIN, fontSize - 1))}>
        <Minus size={10} />
      </button>
      <button type="button" className="tabular-nums hover:text-ink" title="Reset code size (Ctrl+Shift+0)" onClick={() => setFontSize(FONT_DEFAULT)}>
        {fontSize}px
      </button>
      <button type="button" className="icon-btn h-5 w-5" title="Bigger code (Ctrl+Shift+=)" aria-label="Bigger code" onClick={() => setFontSize(Math.min(FONT_MAX, fontSize + 1))}>
        <Plus size={10} />
      </button>
    </span>
  );
}

/** A small dot for online / offline. */
export function OnlineDot({ online }: { online: boolean }) {
  return <span className={cx("inline-block h-1.5 w-1.5 shrink-0 rounded-full", online ? "bg-ok" : "bg-faint")} aria-hidden />;
}
