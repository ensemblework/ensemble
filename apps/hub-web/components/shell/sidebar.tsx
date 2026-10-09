"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  BookOpen,
  Briefcase,
  CalendarDays,
  CalendarCheck,
  CircleCheck,
  Code2,
  Columns3,
  LayoutTemplate,
  ChartSpline,
  PanelLeft,
  Workflow,
  ListChecks,
  Settings,
  Users,
  UsersRound,
} from "lucide-react";
import { HomeLogoLink } from "../motion/brand-morph";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { hasModule, moduleForPath, type OptionalModule } from "@ensemble/shared-types/modules";
import { api } from "@/lib/api";
import { startDevWarm } from "@/lib/dev-warm";
import { prefetchHref } from "@/lib/prefetch";
import { toggleSidebarRail } from "@/lib/sidebar-rail";
import { useModKey } from "@/lib/platform";
import { SpaceSwitcher } from "./space-switcher";
import { SidebarResize } from "./sidebar-resize";
import { PagesNav } from "@/components/pages/pages-nav";
import { useLive } from "../live";
import { cx } from "../ui";

const PRIMARY = [
  { href: "/today", label: "Today", icon: CalendarDays },
  { href: "/board", label: "Board", icon: Columns3 },
  { href: "/needs-me", label: "Needs me", icon: CircleCheck, badge: "approvals" as const },
];

const GROUPS: Array<Array<{ href: string; label: string; icon: typeof Activity }>> = [
  [
    { href: "/context", label: "Context", icon: Users },
    { href: "/meetings", label: "Meeting notes", icon: CalendarCheck },
  ],
  [
    { href: "/code", label: "Code", icon: Code2 },
    { href: "/workspace", label: "Workspace", icon: Briefcase },
    { href: "/runs", label: "Runs", icon: Activity },
    { href: "/skills", label: "Skills", icon: BookOpen },
  ],
  [
    { href: "/metrics", label: "Metrics", icon: BarChart3 },
    { href: "/diagrams", label: "Diagrams", icon: Workflow },
    { href: "/plots", label: "Plots", icon: ChartSpline },
    { href: "/recap", label: "Weekly recap", icon: ListChecks },
  ],
];

/** Dynamic routes. Prefetch the full payload so a fast click never commits loading.tsx. */
const EAGER = new Set(["/today", "/board", "/context", "/marketplace"]);

const WARM = [
  "/today",
  "/board",
  "/needs-me",
  "/context",
  "/meetings",
  "/code",
  "/workspace",
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
}: {
  href: string;
  label: string;
  icon: typeof Activity;
  badge?: number;
}) {
  const pathname = usePathname();
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
    >
      <Icon size={16} strokeWidth={1.8} className="text-muted" />
      <span className="sidebar-label flex-1">{label}</span>
      {badge ? (
        <span className="sidebar-label on-accent rounded-md px-1.5 text-2xs font-semibold">{badge}</span>
      ) : null}
    </Link>
  );
}

export function Sidebar({ mobile = false }: { mobile?: boolean }) {
  const { connected } = useLive();
  const mod = useModKey();
  const client = useQueryClient();
  const router = useRouter();
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
          const shared = client.getQueryData<{ space?: { shared?: unknown } }>(["shell"])?.space?.shared;
          if (shared && (href === "/today" || href === "/metrics")) continue;
          const gate = moduleForPath(href);
          if (gate) {
            const modules = client.getQueryData<{ modules?: string | null }>(["shell"])?.modules;
            // An off module answers 404. Don't warm it; the link is hidden once the shell loads.
            if (!hasModule(modules, gate)) continue;
          }
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
  // A space shared with you: Today and Metrics are the owner's own.
  const guest = Boolean(shell.data?.space?.shared);
  const visible = (href: string) => {
    if (guest && (href === "/today" || href === "/metrics")) return false;
    const gate = moduleForPath(href);
    if (!gate) return true;
    // Hide a module only after the shell says it is off. Until then the link
    // has to be clickable, or the first click on Metrics lands on nothing.
    if (!shell.data) return true;
    return hasModule(modules, gate as OptionalModule);
  };
  const waiting = (shell.data?.approvals ?? 0) + (shell.data?.decisions ?? 0);
  const withMe = useQuery({ queryKey: ["shared-with-me"], queryFn: api.sharedWithMe, staleTime: 60_000, enabled: Boolean(shell.data) });
  const sharedCount = (withMe.data?.spaces.length ?? 0) + (withMe.data?.items.length ?? 0);
  const unopened = withMe.data?.items.filter((item) => !item.openedAt).length ?? 0;
  return (
    <aside className={cx("app-sidebar flex h-full shrink-0 flex-col border-r border-line bg-sidebar/90", mobile && "sidebar-mobile")}>
      {mobile ? null : <SidebarResize />}
      <HomeLogoLink size={24} railSize={24} className="sidebar-brand mx-2 mt-3 flex min-h-10 items-center gap-2 rounded-lg px-2 font-semibold" />
      <div className="px-2 pb-2 pt-3">
        <SpaceSwitcher />
      </div>
      <button
        type="button"
        className="sidebar-search mx-2 mb-3 flex items-center gap-2 rounded-lg border border-line bg-panel/80 px-2.5 py-1.5 text-left text-[12.5px] text-muted hover:border-line-strong hover:text-ink"
        title="Jump to…"
        aria-label="Jump to"
        onClick={() => window.dispatchEvent(new CustomEvent("ensemble:palette"))}
      >
        <span className="sidebar-label flex-1">Jump to…</span>
        <span className="sidebar-label kbd">{mod === "⌘" ? "⌘K" : "Ctrl+K"}</span>
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
      {guest ? null : (
        <nav className="flex flex-col gap-0.5 px-2" aria-label="Primary">
          <NavItem href="/today" label="Today" icon={CalendarDays} />
        </nav>
      )}
      <PagesNav />
      {sharedCount ? (
        <nav className="mt-1 flex flex-col gap-0.5 px-2" aria-label="Shared with you">
          <NavItem href="/shared" label="Shared with you" icon={UsersRound} badge={unopened || undefined} />
        </nav>
      ) : null}
      <nav className="mt-2 flex flex-col gap-0.5 px-2" aria-label="Work">
        {PRIMARY.slice(1).filter((item) => visible(item.href)).map((item) => (
          <NavItem
            key={item.href}
            {...item}
            label={item.href === "/board" && shell.data?.labels?.board ? shell.data.labels.board : item.label}
            badge={item.badge === "approvals" ? waiting : undefined}
          />
        ))}
        {shell.data?.devTools && !guest ? <NavItem href="/marketplace" label="Templates" icon={LayoutTemplate} /> : null}
      </nav>
      {GROUPS.map((group) => {
        const items = group.filter((item) => visible(item.href));
        if (!items.length) return null;
        return (
          <nav key={items[0]!.href} className="mt-3 flex flex-col gap-0.5 px-2" aria-label={items[0]!.label}>
            {items.map((item) => (
              <NavItem key={item.href} {...item} />
            ))}
          </nav>
        );
      })}
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
