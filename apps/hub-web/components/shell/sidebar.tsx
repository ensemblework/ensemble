"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CirclePlay,
  BarChart3,
  BookOpen,
  CalendarDays,
  CalendarCheck,
  CircleCheck,
  Code2,
  Columns3,
  FolderOpen,
  LayoutTemplate,
  ChartSpline,
  PanelLeft,
  Repeat,
  Workflow,
  ListChecks,
  Settings,
  Users,
  UsersRound,
} from "lucide-react";
import { HomeLogoLink } from "../motion/brand-morph";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { hasModule, moduleFitsProfile, moduleForPath, type OptionalModule } from "@ensemble/shared-types/modules";
import { shellProfile } from "@/components/desk/tile-catalog";
import { api } from "@/lib/api";
import { runsModule } from "@/lib/run-modules";
import { startDevWarm } from "@/lib/dev-warm";
import { prefetchHref } from "@/lib/prefetch";
import { toggleSidebarRail } from "@/lib/sidebar-rail";
import { useModKey } from "@/lib/platform";
import { SpaceSwitcher } from "./space-switcher";
import { SidebarResize } from "./sidebar-resize";
import { PagesNav } from "@/components/pages/pages-nav";
import { useLive } from "../live";
import { cx } from "../ui";
import { navMenu, sidebarMenu } from "../context-menu/builders";
import { openContextMenu } from "../context-menu/menu-store";
import { useToast } from "../toast";
import { usePersistentState } from "@/lib/prefs";
import { measureBoxes, motionReduced, perFrame, playFlip, type Box } from "@/lib/motion/drag";
import { SIDEBAR_ORDER_KEY, arrangeSidebar, isDefaultSidebar, moveSidebarTab, stepSidebarTab } from "@/lib/sidebar-order";

/** The tabs that can be dragged into another order (lib/sidebar-order.ts keeps it). */
const TABS: Record<string, { label: string; icon: typeof CirclePlay }> = {
  "/board": { label: "Board", icon: Columns3 },
  "/needs-me": { label: "Needs me", icon: CircleCheck },
  "/marketplace": { label: "Templates", icon: LayoutTemplate },
  "/context": { label: "Context", icon: Users },
  "/meetings": { label: "Meeting notes", icon: CalendarCheck },
  "/routines": { label: "Routines", icon: Repeat },
  "/code": { label: "Code", icon: Code2 },
  "/runs": { label: "Runs", icon: CirclePlay },
  "/skills": { label: "Skills", icon: BookOpen },
  "/metrics": { label: "Metrics", icon: BarChart3 },
  "/diagrams": { label: "Diagrams", icon: Workflow },
  "/plots": { label: "Plots", icon: ChartSpline },
  "/recap": { label: "Weekly recap", icon: ListChecks },
};

const DRAG_START = 5;
type Drop = { group: number; before: string | null; y: number };
type Reorder = { start: (event: React.PointerEvent) => void; dragging: boolean; up?: () => void; down?: () => void; reset?: () => void };

/** Dynamic routes. Prefetch the full payload so a fast click never commits loading.tsx. */
const EAGER = new Set(["/today", "/board", "/context", "/marketplace"]);

const WARM = [
  "/today",
  "/board",
  "/needs-me",
  "/context",
  "/meetings",
  "/code",
  "/runs",
  "/skills",
  "/metrics",
  "/diagrams",
  "/recap",
  "/settings",
];

function NavItem({
  href,
  label,
  icon: Icon,
  badge,
  reorder,
}: {
  href: string;
  label: string;
  icon: typeof CirclePlay;
  badge?: number;
  reorder?: Reorder;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const client = useQueryClient();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  const warm = () => prefetchHref(client, href);
  return (
    <Link
      href={href}
      prefetch={EAGER.has(href) ? true : undefined}
      onMouseEnter={warm}
      onFocus={warm}
      className={cx(
        "nav-link row-tile flex items-center gap-2.5 rounded-lg px-2 py-[6px] text-[13.5px]",
        active ? "font-medium text-ink" : "text-ink/80",
      )}
      data-active={active || undefined}
      aria-current={active ? "page" : undefined}
      title={label}
      data-cm-touch=""
      data-nav-href={reorder ? href : undefined}
      data-dragging={reorder?.dragging || undefined}
      draggable={false}
      onPointerDown={reorder?.start}
      onContextMenu={(event) => openContextMenu(event, () => navMenu(href, label, router.push, reorder ? { up: reorder.up, down: reorder.down, reset: reorder.reset } : undefined))}
    >
      {/* The open tab's icon takes the accent; its label keeps the text colour. */}
      <Icon size={16} strokeWidth={1.8} className={cx("transition-colors", active ? "text-accent" : "text-muted")} />
      <span className="sidebar-label flex-1">{label}</span>
      {badge ? (
        <span className="sidebar-label on-accent rounded-md px-1.5 text-2xs font-semibold">{badge}</span>
      ) : null}
    </Link>
  );
}

export function Sidebar({ mobile = false }: { mobile?: boolean }) {
  const { connected } = useLive();
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reveal = () => {
    if (mobile || document.documentElement.dataset.sidebarAuto !== "true") return;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    document.documentElement.dataset.sidebarHover = "true";
  };
  const hide = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => { delete document.documentElement.dataset.sidebarHover; }, 120);
  };
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); delete document.documentElement.dataset.sidebarHover; }, []);
  const mod = useModKey();
  const client = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const shell = useQuery({
    queryKey: ["shell"],
    queryFn: api.shell,
    refetchInterval: connected ? 60_000 : 2_000,
  });
  useEffect(() => startDevWarm(), []);
  // Full RSC prefetch as soon as the shell mounts, including Marketplace
  // before its link is allowed to render. A click then skips loading.tsx.
  useEffect(() => {
    for (const href of EAGER) router.prefetch(href);
  }, [router]);
  useEffect(() => {
    let cancelled = false;
    const start = window.setTimeout(() => {
      void (async () => {
        for (const href of WARM) {
          if (cancelled) return;
          const data = client.getQueryData<Awaited<ReturnType<typeof api.shell>>>(["shell"]);
          if (data?.space?.shared && (href === "/today" || href === "/metrics")) continue;
          const gate = href === "/runs" ? runsModule(data?.modules) : moduleForPath(href);
          // An off module answers 404, and one the profile is not offered has no link. Don't warm either.
          if (gate && !(hasModule(data?.modules, gate) && moduleFitsProfile(gate, shellProfile(data)))) continue;
          prefetchHref(client, href);
          await new Promise((resolve) => window.setTimeout(resolve, 300));
        }
      })();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearTimeout(start);
    };
  }, [client]);
  const modules = shell.data?.modules;
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  // A space shared with you: Today and Metrics are the owner's own.
  const guest = Boolean(shell.data?.space?.shared);
  const visible = (href: string) => {
    if (guest && (href === "/today" || href === "/metrics")) return false;
    // Routines are the owner's, and leave the sidebar when Settings turns them off.
    if (href === "/routines") return !guest && settings.data?.settings.routines?.enabled !== false;
    const gate = href === "/runs" ? runsModule(modules) : moduleForPath(href);
    if (!gate) return true;
    // Optional modules wait for the shell: when it fails, a link the space has
    // turned off must not appear and lead to a 404.
    if (!shell.data) return false;
    return hasModule(modules, gate as OptionalModule) && moduleFitsProfile(gate as OptionalModule, shellProfile(shell.data));
  };
  const waiting = (shell.data?.approvals ?? 0) + (shell.data?.decisions ?? 0) + (shell.data?.nodeApprovals ?? 0);
  const withMe = useQuery({ queryKey: ["shared-with-me"], queryFn: api.sharedWithMe, staleTime: 60_000, enabled: Boolean(shell.data) });
  const sharedCount = (withMe.data?.spaces.length ?? 0) + (withMe.data?.items.length ?? 0);
  const unopened = withMe.data?.items.filter((item) => !item.openedAt).length ?? 0;
  const [stored, setStored] = usePersistentState<string[][] | null>(SIDEBAR_ORDER_KEY, null);
  const order = useMemo(() => arrangeSidebar(stored), [stored]);
  const shown = (href: string) => (href === "/marketplace" ? Boolean(shell.data?.devTools && !guest) : visible(href));
  const tabsArea = useRef<HTMLDivElement>(null);
  const dropLine = useRef<HTMLDivElement>(null);
  // Only which tab is held is state. Where it is and where it lands are drawn on the DOM directly,
  // so a pointer move does not render the sidebar.
  const [drag, setDrag] = useState<{ href: string } | null>(null);
  // The tabs' places before a drop, so the new order glides in (FLIP) once it renders.
  const settle = useRef<Map<string, Box> | null>(null);
  useLayoutEffect(() => {
    const before = settle.current;
    const area = tabsArea.current;
    if (!before || !area) return;
    settle.current = null;
    playFlip(area.querySelectorAll<HTMLElement>("[data-nav-href]"), (node) => node.dataset.navHref, before);
  });

  // Where a dragged tab would land: before the first tab whose middle is below the pointer, or at the end of
  // the group just above a gap when the pointer is nearer that group.
  const dropAt = (clientY: number, dragging: string): Drop | null => {
    const area = tabsArea.current;
    if (!area) return null;
    const top = area.getBoundingClientRect().top;
    const rows = [...area.querySelectorAll<HTMLElement>("[data-nav-href]")]
      .filter((row) => row.dataset.navHref !== dragging)
      .map((row) => ({ href: row.dataset.navHref!, group: Number(row.closest<HTMLElement>("[data-nav-group]")?.dataset.navGroup ?? 0), rect: row.getBoundingClientRect() }));
    if (!rows.length) return null;
    let previous: (typeof rows)[number] | null = null;
    for (const row of rows) {
      if (clientY < row.rect.top + row.rect.height / 2) {
        if (previous && previous.group !== row.group && clientY - previous.rect.bottom < row.rect.top - clientY) return { group: previous.group, before: null, y: previous.rect.bottom - top + 1 };
        return { group: row.group, before: row.href, y: row.rect.top - top - 1 };
      }
      previous = row;
    }
    const last = rows[rows.length - 1]!;
    return { group: last.group, before: null, y: last.rect.bottom - top + 1 };
  };

  const startDrag = (href: string) => (event: React.PointerEvent) => {
    if (event.button !== 0 || event.pointerType === "touch" || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.currentTarget as HTMLElement;
    const startY = event.clientY;
    let active = false;
    let last: Drop | null = null;
    const line = () => dropLine.current;
    // Where it lands: once a frame at most, and the line glides there.
    const aim = perFrame((clientY: number) => {
      const next = dropAt(clientY, href);
      const el = line();
      if (next && el) {
        if (!last || el.hidden) el.style.transition = "none";
        el.style.transform = `translateY(${next.y}px)`;
        el.hidden = false;
        if (el.style.transition === "none") requestAnimationFrame(() => { el.style.transition = ""; });
      } else if (el) el.hidden = true;
      last = next;
    });
    const finish = (apply: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      delete document.documentElement.dataset.navDragging;
      if (apply) aim.flush();
      else aim.cancel();
      const el = line();
      if (el) el.hidden = true;
      if (!active) return;
      // The release ends a drag, not a click: the link must not open.
      const swallow = (click: MouseEvent) => { click.preventDefault(); click.stopPropagation(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      const area = tabsArea.current;
      // Measured with the drag offset still on, so the tab settles from where it was let go.
      if (area && !motionReduced()) settle.current = measureBoxes(area.querySelectorAll<HTMLElement>("[data-nav-href]"), (node) => node.dataset.navHref);
      link.style.transform = "";
      setDrag(null);
      if (apply && last) {
        const target = order[last.group] ?? [];
        setStored(moveSidebarTab(order, href, last.group, last.before ? target.indexOf(last.before) : target.length));
      }
    };
    const move = (ev: PointerEvent) => {
      if (!active) {
        if (Math.abs(ev.clientY - startY) < DRAG_START) return;
        active = true;
        document.documentElement.dataset.navDragging = "1";
        setDrag({ href });
      }
      // In the event itself, so the tab never trails the pointer.
      link.style.transform = `translateY(${ev.clientY - startY}px)`;
      aim(ev.clientY);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !active) return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
  };

  const reorderFor = (href: string): Reorder => ({
    start: startDrag(href),
    dragging: drag?.href === href,
    up: () => setStored(stepSidebarTab(order, href, -1, shown)),
    down: () => setStored(stepSidebarTab(order, href, 1, shown)),
    reset: isDefaultSidebar(order) ? undefined : () => setStored(null),
  });
  let firstGroup = true;
  return (
    <aside onContextMenu={(event) => openContextMenu(event, () => sidebarMenu({ client, navigate: router.push, toast }))} className={cx("app-sidebar flex h-full shrink-0 flex-col border-r border-line bg-sidebar/90", mobile && "sidebar-mobile")} onPointerEnter={reveal} onPointerLeave={hide} onFocusCapture={reveal} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hide(); }}>
      {mobile ? null : <SidebarResize />}
      <HomeLogoLink size={24} railSize={24} className="sidebar-brand mx-2 mt-3 flex min-h-10 items-center gap-2 rounded-lg px-2 font-semibold" />
      <div className="px-2 pb-2 pt-3">
        <SpaceSwitcher />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
      {guest ? null : (
        <nav className="flex flex-col gap-0.5 px-2" aria-label="Primary">
          <NavItem href="/today" label="Today" icon={CalendarDays} />
        </nav>
      )}
      <PagesNav />
      <nav className="mt-1 flex flex-col gap-0.5 px-2" aria-label="Files">
        <NavItem href="/files" label="Files" icon={FolderOpen} />
      </nav>
      {sharedCount ? (
        <nav className="mt-1 flex flex-col gap-0.5 px-2" aria-label="Shared with you">
          <NavItem href="/shared" label="Shared with you" icon={UsersRound} badge={unopened || undefined} />
        </nav>
      ) : null}
      {/* Press and drag a tab to put it elsewhere; its right-click menu also moves it, for the keyboard. */}
      <div ref={tabsArea} className="relative" data-sidebar-tabs>
        {order.map((group, index) => {
          const items = group.filter(shown);
          if (!items.length) return null;
          const first = firstGroup;
          firstGroup = false;
          return (
            <nav key={index} data-nav-group={index} className={cx("flex flex-col gap-0.5 px-2", first ? "mt-2" : "mt-3")} aria-label={first ? "Work" : TABS[items[0]!]!.label}>
              {items.map((href) => (
                <NavItem
                  key={href}
                  href={href}
                  icon={TABS[href]!.icon}
                  label={href === "/board" && shell.data?.labels?.board ? shell.data.labels.board : TABS[href]!.label}
                  badge={href === "/needs-me" ? waiting : undefined}
                  reorder={reorderFor(href)}
                />
              ))}
            </nav>
          );
        })}
        <div ref={dropLine} className="nav-drop-line" hidden aria-hidden />
      </div>
      </div>
      <div className="border-t border-line px-2 pb-3 pt-2">
        <NavItem href="/settings" label="Settings" icon={Settings} />
      </div>
      <button type="button" className="sidebar-expand icon-btn mx-auto mb-2" aria-label="Expand sidebar" title="Expand sidebar" onClick={toggleSidebarRail}>
        <PanelLeft size={16} />
      </button>
    </aside>
  );
}
