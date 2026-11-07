/**
 * Ensemble's right-click menu (components/context-menu/context-menu.tsx): what a menu holds, the one
 * menu open at a time, and when the browser's own menu is left alone. A surface opens its menu with
 * `openContextMenu(event, build)` from its `onContextMenu`; the nearest one wins (it prevents the
 * default, so the ones around it and the page-wide menu stand back).
 *
 * The browser's menu stays: in plain form fields (inputs, text areas, code editors), with Shift held, on a
 * second right-click at the same spot or on the "Browser menu" row while ours is open, for the one
 * right-click after "Browser menu" is clicked, and everywhere when Settings › Appearance turns ours off.
 */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export type MenuConfirm = { title: string; body?: string; action: string; danger?: boolean };

export type MenuSubmenu = {
  sections?: MenuSection[];
  /** A search field on top, with this placeholder: the items filter as you type. */
  search?: string;
  /** Something of its own instead of items (a calendar). */
  render?: (close: () => void) => ReactNode;
  width?: number;
};

export type MenuAction = {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** A shortcut, shown on the right. */
  hint?: string;
  /** Words it is also found by in a searchable submenu. */
  keywords?: string;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  run?: () => unknown;
  /** Asked in the menu first; null goes straight on. */
  confirm?: () => MenuConfirm | null | Promise<MenuConfirm | null>;
  /** Opens a menu beside it, built when it opens. */
  submenu?: () => MenuSubmenu | Promise<MenuSubmenu>;
};

/** A few actions side by side in one row (Cut · Copy · Paste). */
export type MenuRow = { id: string; row: Array<{ id: string; label: string; icon: LucideIcon; run: () => unknown; disabled?: boolean; hint?: string }> };

export type MenuEntry = MenuAction | MenuRow;
export type MenuSection = { label?: string; items: MenuEntry[] };
/** The mini toolbar on top (bold, italic, link…), as in Word. */
export type MenuTool = { id: string; label: string; icon: LucideIcon; active?: boolean; run: () => unknown; hint?: string };
export type MenuSpec = { title?: string; toolbar?: MenuTool[]; sections: MenuSection[] };

export const isRow = (entry: MenuEntry): entry is MenuRow => "row" in entry;

export type OpenMenu = { spec: MenuSpec; x: number; y: number; touch: boolean; restore: HTMLElement | null; key: number };

let current: OpenMenu | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
export const menuStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  get: () => current,
};

let count = 0;
export function showMenu(spec: MenuSpec, at: { x: number; y: number }, touch: boolean): void {
  const active = document.activeElement;
  current = { spec, x: at.x, y: at.y, touch, restore: active instanceof HTMLElement && active !== document.body ? active : null, key: ++count };
  emit();
}

export function closeMenu(): void {
  if (!current) return;
  current = null;
  emit();
}

let mounted = false;
/** The shell's host is up (not on a public link or a full-screen flow): only then is a right-click taken. */
export function setHostMounted(value: boolean): void {
  mounted = value;
}

let enabled = true;
/** Settings › Appearance › "Ensemble's right-click menu". */
export function setMenusEnabled(value: boolean): void {
  enabled = value;
}

let browserNextUntil = 0;
/** A page cannot open the browser's own menu, so the next right-click (within `ms`) is left to it. */
export function armBrowserMenu(ms = 15_000): void {
  browserNextUntil = Date.now() + ms;
}

/** Within a few pixels of where the open menu was asked for: a second right-click there wants the browser's. */
export function nearMenuOrigin(x: number, y: number): boolean {
  return Boolean(current && !current.touch && Math.hypot(x - current.x, y - current.y) <= 24);
}

let pointer: "mouse" | "touch" | "pen" = "mouse";
/** The kind of pointer that last went down (the host records it): a touch long-press gets the bottom sheet. */
export function notePointer(kind: string): void {
  pointer = kind === "touch" ? "touch" : kind === "pen" ? "pen" : "mouse";
}
export const lastPointer = () => pointer;

/** Text boxes keep the browser's menu (spelling suggestions, autofill); the page editor is ours. */
export function plainField(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!element) return false;
  if (element.closest("[data-cm-native]")) return true;
  if (element.closest("input, textarea, select")) return true;
  const editable = element.closest("[contenteditable='true'], [contenteditable='']");
  return Boolean(editable && !editable.classList.contains("ProseMirror"));
}

const passed = new WeakSet<Event>();
/** Whether this right-click goes to the browser's menu (answered once per event). */
export function passesThrough(event: MouseEvent, inFields = false): boolean {
  if (passed.has(event)) return true;
  let pass = !enabled || event.shiftKey || (!inFields && plainField(event.target));
  if (!pass && Date.now() < browserNextUntil) {
    browserNextUntil = 0;
    pass = true;
  }
  if (pass) passed.add(event);
  return pass;
}

/** Where the menu opens: at the pointer, or (opened from the keyboard) at the caret or the focused thing. */
export function menuPoint(event: MouseEvent): { x: number; y: number } {
  if (event.clientX > 0 || event.clientY > 0) return { x: event.clientX, y: event.clientY };
  const selection = window.getSelection();
  const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
  const rect = range?.getClientRects()[0] ?? (event.target instanceof Element ? event.target.getBoundingClientRect() : null);
  return rect ? { x: rect.left, y: rect.bottom } : { x: window.innerWidth / 2, y: window.innerHeight / 3 };
}

/**
 * Opens a menu for this right-click unless a nearer one already did, the browser's menu is wanted, or
 * `build` has nothing for here. True when it opened.
 */
/** `inFields`: this surface is a text editor that wants Ensemble's menu (the Code editor), not the browser's. */
export function openContextMenu(event: { nativeEvent?: MouseEvent; preventDefault: () => void } | MouseEvent, build: () => MenuSpec | null, options: { inFields?: boolean } = {}): boolean {
  const native = ("nativeEvent" in event && event.nativeEvent ? event.nativeEvent : event) as MouseEvent;
  if (!mounted || native.defaultPrevented || passesThrough(native, options.inFields)) return false;
  const spec = build();
  if (!spec || !spec.sections.some((section) => section.items.length)) return false;
  event.preventDefault();
  native.preventDefault();
  showMenu(spec, menuPoint(native), pointer === "touch");
  return true;
}

/** The last few picks of a submenu ("Assign to", "Move to"), first in it next time. */
export function recentPicks(key: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(`ensemble.menu.recent.${key}`) || "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}

export function rememberPick(key: string, id: string): void {
  try {
    localStorage.setItem(`ensemble.menu.recent.${key}`, JSON.stringify([id, ...recentPicks(key).filter((value) => value !== id)].slice(0, 5)));
  } catch {
    // Private mode: nothing kept.
  }
}

/** A pick list with its recent picks first (under "Recent" when the list is long), then the rest. */
export function withRecent<T extends { id: string }>(key: string, items: T[], toEntry: (item: T) => MenuAction): MenuSection[] {
  const recent = recentPicks(key);
  const first = recent.map((id) => items.find((item) => item.id === id)).filter((item): item is T => Boolean(item));
  const rest = items.filter((item) => !recent.includes(item.id));
  if (first.length && items.length > 6) return [{ label: "Recent", items: first.map(toEntry) }, { label: "All", items: rest.map(toEntry) }];
  return [{ items: [...first, ...rest].map(toEntry) }];
}
