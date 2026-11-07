"use client";

/**
 * Ensemble's right-click menu (docs/02 §2): one at a time, built by whatever was right-clicked
 * (`openContextMenu` in menu-store.ts), or the page-wide menu where nothing nearer has one. A floating
 * panel at the pointer that never leaves the window (it flips at the right and bottom edges, as do its
 * submenus), with a mini toolbar on top for selected text, submenus that can be searched, a question in
 * place before anything that stops work or deletes, and the browser's own menu one click away.
 * On touch, a long-press on a card, a sidebar row, an image or a handle opens it as a bottom sheet.
 */
import { AppWindow, Check, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AppearanceSettings } from "@ensemble/shared-types";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, usePersistentState } from "@/lib/prefs";
import { useToast } from "../toast";
import { Spinner, cx } from "../ui";
import { pageWideMenu } from "./builders";
import {
  armBrowserMenu,
  closeMenu,
  isRow,
  lastPointer,
  menuPoint,
  menuStore,
  nearMenuOrigin,
  notePointer,
  passesThrough,
  setHostMounted,
  setMenusEnabled,
  showMenu,
  type MenuAction,
  type MenuConfirm,
  type MenuEntry,
  type MenuSection,
  type MenuTool,
  type OpenMenu,
} from "./menu-store";

const ROOT_WIDTH = 240;
const SUB_WIDTH = 224;
const SEARCH_WIDTH = 264;
const MARGIN = 8;
const LONG_PRESS_MS = 520;

type Anchor = { x: number; y: number } | DOMRect;
type Level = { id: string; sections: MenuSection[]; toolbar?: MenuTool[]; search?: string; render?: (close: () => void) => ReactNode; width: number; anchor: Anchor; loading?: boolean; title?: string };

const BROWSER_ID = "browser-menu";
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const BROWSER_SECTION = (onArm: () => void): MenuSection => ({
  items: [{ id: BROWSER_ID, label: "Browser menu", icon: AppWindow, hint: "Right-click here", run: onArm }],
});

const matches = (item: MenuAction, query: string) => `${item.label} ${item.keywords ?? ""}`.toLowerCase().includes(query.toLowerCase());

function filtered(sections: MenuSection[], query: string): MenuSection[] {
  const text = query.trim();
  if (!text) return sections;
  return sections
    .map((section) => ({ ...section, items: section.items.filter((entry) => !isRow(entry) && matches(entry, text)) }))
    .filter((section) => section.items.length);
}

/** Runs what was picked once the menu is gone and focus is back where it was. */
function useFinish(menu: OpenMenu) {
  const toast = useToast();
  return useCallback(
    (run?: () => unknown) => {
      const restore = menu.restore;
      closeMenu();
      if (restore?.isConnected) restore.focus({ preventScroll: true });
      if (!run) return;
      const fail = (error: unknown) => toast(error instanceof Error ? error.message : "That did not work.", { tone: "error" });
      try {
        const result = run();
        if (result instanceof Promise) result.catch(fail);
      } catch (error) {
        fail(error);
      }
    },
    [menu, toast],
  );
}

function Panel({ anchor, width, level, children, onKeyDown, onPointerEnter, label }: { anchor: Anchor; width: number; level: number; children: ReactNode; onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void; onPointerEnter?: () => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const used = Math.min(width, vw - MARGIN * 2);
    const height = Math.min(element.scrollHeight, vh - MARGIN * 2);
    let left: number;
    let top: number;
    if (anchor instanceof DOMRect) {
      // A submenu: beside its row, on the left when the right has no room.
      left = anchor.right - 3;
      if (left + used > vw - MARGIN) left = anchor.left - used + 3;
      top = anchor.top - 5;
    } else {
      left = anchor.x + 2;
      if (left + used > vw - MARGIN) left = anchor.x - used - 2;
      top = anchor.y + 2;
      if (top + height > vh - MARGIN) top = anchor.y - height - 2 >= MARGIN ? anchor.y - height - 2 : vh - MARGIN - height;
    }
    if (top + height > vh - MARGIN) top = vh - MARGIN - height;
    left = Math.max(MARGIN, Math.min(left, vw - MARGIN - used));
    top = Math.max(MARGIN, top);
    setBox((previous) => (previous && previous.left === left && previous.top === top && previous.width === used ? previous : { left, top, width: used, maxHeight: vh - MARGIN * 2 }));
  });
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      data-cm-menu=""
      data-level={level}
      className="cm-panel"
      onKeyDown={onKeyDown}
      onPointerEnter={onPointerEnter}
      onContextMenu={(event) => {
        if (!passesThrough(event.nativeEvent)) event.preventDefault();
      }}
      style={{ left: box?.left ?? -9999, top: box?.top ?? -9999, width: box?.width ?? width, maxHeight: box?.maxHeight, visibility: box ? "visible" : "hidden" }}
    >
      {children}
    </div>
  );
}

function ItemButton({ item, open, iconGap, onActivate, onHover }: { item: MenuAction; open: boolean; iconGap: boolean; onActivate: (element: HTMLElement) => void; onHover: (element: HTMLElement) => void }) {
  const Icon = item.icon;
  const role = item.checked === undefined ? "menuitem" : "menuitemradio";
  return (
    <button
      type="button"
      role={role}
      aria-checked={item.checked === undefined ? undefined : item.checked}
      aria-haspopup={item.submenu ? "menu" : undefined}
      aria-expanded={item.submenu ? open : undefined}
      aria-disabled={item.disabled || undefined}
      tabIndex={-1}
      data-cm-item=""
      data-cm-id={item.id}
      data-cm-label={item.label}
      data-open={open || undefined}
      className={cx("cm-item", item.danger && "cm-danger")}
      onClick={(event) => !item.disabled && onActivate(event.currentTarget)}
      onPointerEnter={(event) => onHover(event.currentTarget)}
    >
      {Icon ? <Icon size={14} className="cm-icon" aria-hidden /> : iconGap ? <span className="cm-icon" aria-hidden /> : null}
      <span className="cm-label">{item.label}</span>
      {item.checked ? <Check size={13} className="cm-check" aria-hidden /> : null}
      {item.hint ? <span className="cm-hint">{item.hint}</span> : null}
      {item.submenu ? <ChevronRight size={13} className="cm-chevron" aria-hidden /> : null}
    </button>
  );
}

function Entries({ sections, levelIndex, openId, onActivate, onHover }: { sections: MenuSection[]; levelIndex: number; openId: string | null; onActivate: (item: MenuAction, element: HTMLElement) => void; onHover: (item: MenuAction | null, element: HTMLElement) => void }) {
  const iconGap = sections.some((section) => section.items.some((entry) => !isRow(entry) && entry.icon));
  return (
    <>
      {sections.map((section, index) => (
        <div key={`${levelIndex}-${index}`} role="group" aria-label={section.label} className="cm-section">
          {index > 0 ? <div role="separator" className="cm-separator" /> : null}
          {section.label ? <div className="cm-section-label" aria-hidden>{section.label}</div> : null}
          {section.items.map((entry: MenuEntry) =>
            isRow(entry) ? (
              <div key={entry.id} className="cm-row" data-cm-inline="">
                {entry.row.map((part) => (
                  <button
                    key={part.id}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    data-cm-item=""
                    data-cm-label={part.label}
                    disabled={part.disabled}
                    title={part.hint ? `${part.label} · ${part.hint}` : part.label}
                    className="cm-row-part"
                    onClick={(event) => onActivate({ id: part.id, label: part.label, run: part.run }, event.currentTarget)}
                    onPointerEnter={(event) => onHover(null, event.currentTarget)}
                  >
                    <part.icon size={14} aria-hidden />
                    <span>{part.label}</span>
                  </button>
                ))}
              </div>
            ) : (
              <ItemButton key={entry.id} item={entry} open={openId === entry.id} iconGap={iconGap} onActivate={(element) => onActivate(entry, element)} onHover={(element) => onHover(entry, element)} />
            ),
          )}
        </div>
      ))}
    </>
  );
}

function Toolbar({ tools, onRun }: { tools: MenuTool[]; onRun: (tool: MenuTool) => void }) {
  return (
    <div role="group" aria-label="Format" className="cm-toolbar" data-cm-inline="">
      {tools.map((tool) => (
        <button key={tool.id} type="button" role="menuitem" tabIndex={-1} data-cm-item="" data-cm-label={tool.label} aria-pressed={tool.active || undefined} title={tool.hint ? `${tool.label} · ${tool.hint}` : tool.label} aria-label={tool.label} className="cm-tool" data-active={tool.active || undefined} onClick={() => onRun(tool)}>
          <tool.icon size={14} aria-hidden />
        </button>
      ))}
    </div>
  );
}

function ConfirmCard({ ask, onCancel, onGo }: { ask: MenuConfirm; onCancel: () => void; onGo: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus({ preventScroll: true }), []);
  return (
    <div className="cm-confirm" role="alertdialog" aria-label={ask.title}>
      <p className="text-[13px] font-medium leading-5">{ask.title}</p>
      {ask.body ? <p className="mt-0.5 text-[12px] leading-[17px] text-muted">{ask.body}</p> : null}
      <div className="mt-2.5 flex justify-end gap-1.5">
        <button ref={cancel} type="button" className="btn-ghost h-7 px-2.5 text-[12.5px]" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={cx("h-7 rounded-md px-2.5 text-[12.5px] font-medium", ask.danger ? "cm-confirm-danger" : "btn-primary")} onClick={onGo}>
          {ask.action}
        </button>
      </div>
    </div>
  );
}

/** The floating menu and its submenus. */
function FloatingMenu({ menu }: { menu: OpenMenu }) {
  const toast = useToast();
  const finish = useFinish(menu);
  const arm = useCallback(() => armBrowserMenu(), []);
  const [levels, setLevels] = useState<Level[]>(() => [{ id: "root", sections: [...menu.spec.sections, BROWSER_SECTION(arm)], toolbar: menu.spec.toolbar, width: ROOT_WIDTH, anchor: { x: menu.x, y: menu.y } }]);
  const [queries, setQueries] = useState<Record<number, string>>({});
  const [asking, setAsking] = useState<{ ask: MenuConfirm; run?: () => unknown } | null>(null);
  const hover = useRef(0);
  const panels = useRef<HTMLDivElement | null>(null);

  const panelAt = (level: number) => panels.current?.querySelector<HTMLDivElement>(`[data-level="${level}"]`) ?? null;
  const itemsAt = (level: number) => Array.from(panelAt(level)?.querySelectorAll<HTMLElement>("[data-cm-item]:not([disabled]):not([aria-disabled='true']), [data-cm-search]") ?? []);
  const focusFirst = (level: number) => requestAnimationFrame(() => itemsAt(level)[0]?.focus({ preventScroll: true }));

  useEffect(() => {
    panelAt(0)?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openSub = async (item: MenuAction, level: number, element: HTMLElement, focus: boolean) => {
    if (!item.submenu) return;
    if (levels[level + 1]?.id === item.id) {
      if (focus) focusFirst(level + 1);
      return;
    }
    const anchor = element.getBoundingClientRect();
    setQueries((current) => Object.fromEntries(Object.entries(current).filter(([key]) => Number(key) <= level)));
    setLevels((current) => [...current.slice(0, level + 1), { id: item.id, sections: [], width: SUB_WIDTH, anchor, loading: true }]);
    try {
      const sub = await item.submenu();
      setLevels((current) => (current[level + 1]?.id === item.id ? [...current.slice(0, level + 1), { id: item.id, sections: sub.sections ?? [], search: sub.search, render: sub.render, width: sub.width ?? (sub.search ? SEARCH_WIDTH : SUB_WIDTH), anchor }] : current));
      if (focus || sub.search) focusFirst(level + 1);
    } catch (error) {
      setLevels((current) => current.slice(0, level + 1));
      toast(error instanceof Error ? error.message : "That list could not load.", { tone: "error" });
    }
  };

  const activate = async (item: MenuAction, level: number, element: HTMLElement) => {
    if (item.disabled) return;
    if (item.submenu) return void openSub(item, level, element, true);
    if (item.confirm) {
      const ask = await item.confirm();
      if (ask) {
        setLevels((current) => current.slice(0, 1));
        setAsking({ ask, run: item.run });
        return;
      }
    }
    finish(item.run);
  };

  const onHover = (item: MenuAction | null, level: number, element: HTMLElement) => {
    window.clearTimeout(hover.current);
    if (item?.submenu) {
      hover.current = window.setTimeout(() => void openSub(item, level, element, false), 110);
    } else if (levels.length > level + 1) {
      hover.current = window.setTimeout(() => setLevels((current) => current.slice(0, level + 1)), 260);
    }
  };

  const onKey = (level: number) => (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = itemsAt(level);
    const active = document.activeElement as HTMLElement | null;
    const index = active ? items.indexOf(active) : -1;
    const inline = Boolean(active?.closest("[data-cm-inline]"));
    const search = active?.hasAttribute("data-cm-search");
    const move = (to: number) => {
      event.preventDefault();
      items[(to + items.length) % items.length]?.focus({ preventScroll: true });
    };
    switch (event.key) {
      case "ArrowDown":
        return move(index + 1);
      case "ArrowUp":
        return move(index < 0 ? items.length - 1 : index - 1);
      case "Home":
        if (search) return;
        return move(0);
      case "End":
        if (search) return;
        return move(items.length - 1);
      case "ArrowRight":
        if (search) return;
        if (inline) return move(index + 1);
        if (active?.getAttribute("aria-haspopup") === "menu") {
          event.preventDefault();
          active.click();
        }
        return;
      case "ArrowLeft":
        if (search) return;
        if (inline) return move(index - 1);
        if (level > 0) {
          event.preventDefault();
          setLevels((current) => current.slice(0, level));
          requestAnimationFrame(() => panelAt(level - 1)?.querySelector<HTMLElement>("[data-open]")?.focus({ preventScroll: true }));
        }
        return;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        if (search && queries[level]) return setQueries((current) => ({ ...current, [level]: "" }));
        if (level > 0) {
          setLevels((current) => current.slice(0, level));
          requestAnimationFrame(() => panelAt(level - 1)?.querySelector<HTMLElement>("[data-open]")?.focus({ preventScroll: true }));
        } else finish();
        return;
      case "Tab":
        event.preventDefault();
        return finish();
      case "Enter":
        if (search) {
          event.preventDefault();
          items.find((item) => !item.hasAttribute("data-cm-search"))?.click();
        }
        return;
      default:
        // Typing jumps to the next item that starts with that letter (a search field takes it instead).
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && !search && !levels[level]?.search) {
          const letter = event.key.toLowerCase();
          const order = [...items.slice(index + 1), ...items.slice(0, index + 1)];
          const found = order.find((item) => (item.dataset.cmLabel ?? "").toLowerCase().startsWith(letter));
          if (found) {
            event.preventDefault();
            found.focus({ preventScroll: true });
          }
        }
    }
  };

  return (
    <div ref={panels}>
      {levels.map((level, index) => {
        const query = queries[index] ?? "";
        const sections = filtered(level.sections, query);
        return (
          <Panel key={`${level.id}-${index}`} anchor={level.anchor} width={asking && index === 0 ? 264 : level.width} level={index} label={index === 0 ? menu.spec.title ?? "Actions" : level.id} onKeyDown={onKey(index)} onPointerEnter={() => index > 0 && window.clearTimeout(hover.current)}>
            {asking && index === 0 ? (
              <ConfirmCard
                ask={asking.ask}
                onCancel={() => finish()}
                onGo={() => finish(asking.run)}
              />
            ) : level.loading ? (
              <div className="flex items-center gap-2 px-2.5 py-2 text-[12.5px] text-muted">
                <Spinner size={12} /> Loading…
              </div>
            ) : level.render ? (
              level.render(() => finish())
            ) : (
              <>
                {level.search ? (
                  <label className="cm-search">
                    <Search size={13} className="shrink-0 text-faint" aria-hidden />
                    <input data-cm-search="" value={query} placeholder={level.search} aria-label={level.search} spellCheck={false} autoComplete="off" onChange={(event) => setQueries((current) => ({ ...current, [index]: event.target.value }))} />
                  </label>
                ) : null}
                {level.toolbar?.length ? <Toolbar tools={level.toolbar} onRun={(tool) => finish(tool.run)} /> : null}
                {sections.length ? (
                  <Entries sections={sections} levelIndex={index} openId={levels[index + 1]?.id ?? null} onActivate={(item, element) => void activate(item, index, element)} onHover={(item, element) => onHover(item, index, element)} />
                ) : (
                  <div className="px-2.5 py-2 text-[12.5px] text-muted">{query ? "Nothing matches." : "Nothing here."}</div>
                )}
              </>
            )}
          </Panel>
        );
      })}
    </div>
  );
}

/** On touch: the same menu as a sheet from the bottom, with finger-sized rows; a submenu slides in with Back. */
function SheetMenu({ menu }: { menu: OpenMenu }) {
  const finish = useFinish(menu);
  const [views, setViews] = useState<Array<{ title: string; sections: MenuSection[]; toolbar?: MenuTool[]; search?: string; render?: (close: () => void) => ReactNode; loading?: boolean }>>(() => [{ title: menu.spec.title ?? "Actions", sections: menu.spec.sections, toolbar: menu.spec.toolbar }]);
  const [query, setQuery] = useState("");
  const [asking, setAsking] = useState<{ ask: MenuConfirm; run?: () => unknown } | null>(null);
  const view = views[views.length - 1]!;
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => sheet.current?.focus({ preventScroll: true }), []);
  const open = async (item: MenuAction) => {
    if (item.disabled) return;
    if (item.submenu) {
      setQuery("");
      setViews((current) => [...current, { title: item.label, sections: [], loading: true }]);
      const sub = await item.submenu();
      setViews((current) => [...current.slice(0, -1), { title: item.label, sections: sub.sections ?? [], search: sub.search, render: sub.render }]);
      return;
    }
    if (item.confirm) {
      const ask = await item.confirm();
      if (ask) return setAsking({ ask, run: item.run });
    }
    finish(item.run);
  };
  const sections = filtered(view.sections, query);
  return (
    <div className="cm-sheet-layer" data-cm-menu="" onContextMenu={(event) => event.preventDefault()}>
      <div className="cm-sheet-backdrop" onClick={() => finish()} aria-hidden />
      <div ref={sheet} role="menu" aria-label={view.title} tabIndex={-1} className="cm-sheet" onKeyDown={(event) => event.key === "Escape" && finish()}>
        <div className="cm-sheet-grip" aria-hidden />
        <div className="cm-sheet-head">
          {views.length > 1 ? (
            <button type="button" className="cm-sheet-back" onClick={() => { setQuery(""); setViews((current) => current.slice(0, -1)); }}>
              <ChevronLeft size={16} /> Back
            </button>
          ) : null}
          <span className="min-w-0 flex-1 truncate">{asking ? asking.ask.title : view.title}</span>
        </div>
        {asking ? (
          <div className="px-3 pb-3">
            {asking.ask.body ? <p className="text-[13px] leading-5 text-muted">{asking.ask.body}</p> : null}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button type="button" className="btn h-11 justify-center" onClick={() => finish()}>Cancel</button>
              <button type="button" className={cx("h-11 rounded-lg font-medium", asking.ask.danger ? "cm-confirm-danger" : "btn-primary justify-center")} onClick={() => finish(asking.run)}>{asking.ask.action}</button>
            </div>
          </div>
        ) : view.loading ? (
          <div className="flex items-center gap-2 px-4 py-4 text-[14px] text-muted"><Spinner size={14} /> Loading…</div>
        ) : view.render ? (
          <div className="px-2 pb-2">{view.render(() => finish())}</div>
        ) : (
          <div className="cm-sheet-body">
            {view.search ? (
              <label className="cm-search mx-2 mb-1">
                <Search size={15} className="shrink-0 text-faint" aria-hidden />
                <input value={query} placeholder={view.search} aria-label={view.search} onChange={(event) => setQuery(event.target.value)} />
              </label>
            ) : null}
            {view.toolbar?.length ? (
              <div className="cm-sheet-tools">
                {view.toolbar.map((tool) => (
                  <button key={tool.id} type="button" aria-label={tool.label} aria-pressed={tool.active || undefined} data-active={tool.active || undefined} className="cm-tool" onClick={() => finish(tool.run)}>
                    <tool.icon size={17} aria-hidden />
                  </button>
                ))}
              </div>
            ) : null}
            {sections.map((section, index) => (
              <div key={index} role="group" aria-label={section.label}>
                {index > 0 ? <div role="separator" className="cm-separator" /> : null}
                {section.label ? <div className="cm-section-label px-4">{section.label}</div> : null}
                {section.items.map((entry) =>
                  isRow(entry) ? (
                    <div key={entry.id} className="cm-sheet-row">
                      {entry.row.map((part) => (
                        <button key={part.id} type="button" disabled={part.disabled} className="cm-sheet-part" onClick={() => finish(part.run)}>
                          <part.icon size={17} aria-hidden />
                          <span>{part.label}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <button key={entry.id} type="button" role="menuitem" disabled={entry.disabled} className={cx("cm-sheet-item", entry.danger && "cm-danger")} onClick={() => void open(entry)}>
                      {entry.icon ? <entry.icon size={17} className="cm-icon" aria-hidden /> : <span className="cm-icon" aria-hidden />}
                      <span className="min-w-0 flex-1 truncate text-left">{entry.label}</span>
                      {entry.checked ? <Check size={15} className="cm-check" aria-hidden /> : null}
                      {entry.submenu ? <ChevronRight size={16} className="cm-chevron" aria-hidden /> : null}
                    </button>
                  ),
                )}
              </div>
            ))}
            {!sections.length ? <div className="px-4 py-3 text-[14px] text-muted">{query ? "Nothing matches." : "Nothing here."}</div> : null}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Mounted once in the shell: the open menu, the page-wide menu where nothing nearer has one, touch
 * long-press, and closing on scroll, resize, leaving the window or another page.
 */
export function ContextMenuHost() {
  const menu = useSyncExternalStore(menuStore.subscribe, menuStore.get, () => null);
  const router = useRouter();
  const pathname = usePathname();
  // Appearance lives in this browser (and follows the account): the switch takes effect at once.
  const [appearance] = usePersistentState<AppearanceSettings>(APPEARANCE_KEY, DEFAULT_APPEARANCE);
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    setMenusEnabled(appearance.contextMenu !== false);
  }, [appearance.contextMenu]);

  useEffect(() => closeMenu(), [pathname]);

  useEffect(() => {
    setHostMounted(true);
    return () => setHostMounted(false);
  }, []);

  useEffect(() => {
    let timer = 0;
    let start: { x: number; y: number; target: Element } | null = null;
    let quietUntil = 0;
    let swallowClick = false;
    const cancel = () => {
      window.clearTimeout(timer);
      start = null;
    };
    const down = (event: PointerEvent) => {
      notePointer(event.pointerType);
      swallowClick = false;
      cancel();
      const target = event.target instanceof Element ? event.target : null;
      // While ours is open, a right-click on its "Browser menu" row or a second one on the same spot opens
      // the browser's own menu at once (a page cannot open it any other way).
      const secondary = event.pointerType !== "touch" && (event.button === 2 || (event.button === 0 && event.ctrlKey && MAC));
      if (secondary && menuStore.get() && (target?.closest(`[data-cm-id="${BROWSER_ID}"]`) || nearMenuOrigin(event.clientX, event.clientY))) armBrowserMenu(1500);
      // A press anywhere but in the menu closes it.
      if (menuStore.get() && !target?.closest("[data-cm-menu]")) closeMenu();
      if (event.pointerType !== "touch" || !(event.target instanceof Element)) return;
      const host = event.target.closest("[data-cm-touch]");
      if (!host) return;
      start = { x: event.clientX, y: event.clientY, target: event.target };
      timer = window.setTimeout(() => {
        const at = start;
        start = null;
        if (!at) return;
        const synthetic = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 2, view: window });
        at.target.dispatchEvent(synthetic);
        if (synthetic.defaultPrevented) {
          quietUntil = Date.now() + 900;
          swallowClick = true;
          navigator.vibrate?.(8);
        }
      }, LONG_PRESS_MS);
    };
    const moved = (event: PointerEvent) => {
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancel();
    };
    const early = (event: MouseEvent) => {
      // The long-press already opened one (Android also sends its own right-click): this one is quiet.
      if (event.isTrusted && Date.now() < quietUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.isTrusted) cancel();
      if (!(event.target instanceof Element) || !event.target.closest("[data-cm-menu]")) return;
      if (event.target.closest(`[data-cm-id="${BROWSER_ID}"]`) && passesThrough(event)) {
        window.setTimeout(closeMenu, 0);
        return;
      }
      event.preventDefault();
    };
    const late = (event: MouseEvent) => {
      if (event.defaultPrevented || passesThrough(event)) return;
      const spec = pageWideMenu(event, { navigate: (href) => routerRef.current.push(href), back: () => routerRef.current.back(), forward: () => routerRef.current.forward(), refresh: () => routerRef.current.refresh() });
      if (!spec) return;
      event.preventDefault();
      showMenu(spec, menuPoint(event), lastPointer() === "touch");
    };
    const click = (event: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("[data-cm-menu]")) return;
      cancel();
      closeMenu();
    };
    const away = () => {
      cancel();
      closeMenu();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointermove", moved, true);
    document.addEventListener("pointerup", cancel, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("contextmenu", early, true);
    document.addEventListener("contextmenu", late);
    document.addEventListener("click", click, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", away);
    window.addEventListener("blur", away);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointermove", moved, true);
      document.removeEventListener("pointerup", cancel, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("contextmenu", early, true);
      document.removeEventListener("contextmenu", late);
      document.removeEventListener("click", click, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", away);
      window.removeEventListener("blur", away);
    };
  }, []);

  if (!menu || typeof document === "undefined") return null;
  return createPortal(menu.touch ? <SheetMenu key={menu.key} menu={menu} /> : <FloatingMenu key={menu.key} menu={menu} />, document.body);
}
