"use client";

/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * The Tools picker (docs/CONTEXT_BRIDGE.md §5.5): which connected apps, and which of their tools, one
 * thread, chat, run profile, run or outside app may use. It lists what is connected (GET /api/tools),
 * grouped by app or server, and keeps a list of what is off; the server applies that list everywhere.
 */
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Plug, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { ToolCatalogApp } from "@ensemble/shared-types";
import { BrandLogo } from "@/components/connectors/brand-logo";
import { InfoTip, Popover, SectionCard, SkeletonRows, Toggle, cx } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { appIsOn, offLabel, offSummary, setApp, setTool, toolIsOn, toolsOnCount } from "@/lib/tools-picker";

export type ToolsScope = "thread" | "chat" | "profile" | "run" | "app";

const SCOPE: Record<ToolsScope, { title: string; tip: string }> = {
  thread: { title: "Tools for this thread", tip: "Kept with this thread until you change them. A new thread starts with everything on, or with its run profile's choices." },
  chat: { title: "Tools for this chat", tip: "Kept with this chat until you change them. A new chat starts with everything on." },
  profile: { title: "Tools for this profile", tip: "Runs and threads that start with this profile get these. Ones already started keep their own." },
  run: { title: "Tools for this run", tip: "Only this run. Its run profile stays as it is." },
  app: { title: "Tools this app may use", tip: "This app never gets what is off here, whatever one of its chats asks for. Many apps cannot pass a per-chat choice, so this is the switch that always holds." },
};
const COMMON = "Only connected apps are listed. Ensemble's own tools and an agent's own shell and file tools are not affected. Connections and their switches in Settings come first.";

export const TOOL_CATALOG_KEY = ["tool-catalog"] as const;

export function useToolCatalog(enabled = true) {
  return useQuery({ queryKey: TOOL_CATALOG_KEY, queryFn: () => api.toolCatalog(), enabled, staleTime: 30_000, retry: false });
}

export function ToolsPicker({
  value,
  onChange,
  scope,
  variant = "chip",
  align = "left",
  disabled = false,
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  scope: ToolsScope;
  /** chip: the Code agent's composer; button: the assistant's options row; field: a form (profiles, Assign, outside apps). */
  variant?: "chip" | "button" | "field";
  align?: "left" | "right";
  disabled?: boolean;
}) {
  const catalog = useToolCatalog();
  const apps = catalog.data?.apps;
  const summary = apps ? offSummary(value, apps) : { apps: 0, tools: 0 };
  const count = summary.apps + summary.tools;
  const label = offLabel(value, apps);
  // In a space shared with you the owner's connected apps are theirs: there is nothing to choose.
  if (catalog.error instanceof ApiError && catalog.error.status === 403) return null;
  return (
    <Popover
      width={360}
      maxHeight={460}
      align={align}
      trigger={(open, toggle) => {
        const onClick = () => {
          if (!open) void catalog.refetch();
          toggle();
        };
        const shared = { type: "button" as const, onClick, disabled, "aria-haspopup": "dialog" as const, "aria-expanded": open, title: `Connected-app tools: ${label}`, "data-testid": "tools-picker" };
        if (variant === "chip") {
          return (
            <button {...shared} className="agent-chip" aria-label={`Tools, ${label}`}>
              <Plug size={12} aria-hidden /> <span className="max-md:hidden">Tools</span>
              {count ? <span className="tools-count">{count}</span> : null}
            </button>
          );
        }
        if (variant === "button") {
          return (
            <button {...shared} className="btn min-w-0 max-w-full" aria-label={`Tools, ${label}`}>
              <Plug size={13} aria-hidden /> <span className="truncate">{count ? `Tools · ${label}` : "Tools"}</span> <ChevronDown size={13} aria-hidden />
            </button>
          );
        }
        return (
          <button {...shared} className="field flex h-9 w-full items-center gap-2 px-2.5 text-left text-[13px]" aria-label={`Tools, ${label}`}>
            <Plug size={13} className="shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{label === "All on" ? "Every connected app" : label}</span>
            <ChevronDown size={13} className="shrink-0 text-faint" aria-hidden />
          </button>
        );
      }}
    >
      {() => <ToolsPanel value={value} onChange={onChange} scope={scope} apps={apps} loading={catalog.isLoading} failed={catalog.isError} />}
    </Popover>
  );
}

export function ToolsPanel({
  value,
  onChange,
  scope,
  apps,
  loading,
  failed,
  readOnly = false,
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  scope: ToolsScope | null;
  apps: readonly ToolCatalogApp[] | undefined;
  loading: boolean;
  failed: boolean;
  /** The catalog only (Settings › Connections): what each connection offers, without choosing. */
  readOnly?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!apps) return [];
    if (!needle) return apps.map((app) => ({ app, tools: app.tools }));
    return apps
      .map((app) => ({ app, tools: app.name.toLowerCase().includes(needle) ? app.tools : app.tools.filter((tool) => `${tool.title} ${tool.name} ${tool.product ?? ""}`.toLowerCase().includes(needle)) }))
      .filter((row) => row.tools.length || row.app.name.toLowerCase().includes(needle));
  }, [apps, needle]);
  const total = apps?.reduce((sum, app) => sum + app.tools.length, 0) ?? 0;
  const expand = (key: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const copy = scope ? SCOPE[scope] : null;

  return (
    <div className="flex flex-col" data-testid="tools-panel">
      {copy ? (
        <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-2">
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{copy.title}</span>
          <InfoTip text={`${copy.tip} ${COMMON}`} />
        </div>
      ) : null}
      {apps && (apps.length > 5 || total > 14) ? (
        <label className="compound-field mx-2 mb-1.5 flex h-8 items-center gap-1.5 rounded-md border border-line px-2">
          <Search size={13} className="shrink-0 text-faint" aria-hidden />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find an app or tool" aria-label="Find an app or tool" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint" />
        </label>
      ) : null}
      <div className={cx("overflow-y-auto pb-1", !readOnly && "max-h-[340px]")} role="list" aria-label="Connected apps">
        {loading ? <div className="px-3 py-2"><SkeletonRows count={4} rowClassName="h-8" /></div> : null}
        {failed ? <p className="px-3 py-2 text-[12px] text-muted">Connected apps could not be loaded. Try again.</p> : null}
        {apps && !apps.length ? (
          <p className="px-3 py-2 text-[12.5px] text-muted">
            No apps are connected. <Link className="text-accent hover:underline" href="/settings?tab=connections&store=connected">Connect one</Link>
          </p>
        ) : null}
        {apps && apps.length && !shown.length ? <p className="px-3 py-2 text-[12px] text-muted">Nothing matches.</p> : null}
        {shown.map(({ app, tools }) => (
          <AppRow key={app.key} app={app} tools={tools} off={value} expanded={Boolean(needle) || open.has(app.key)} onExpand={() => expand(app.key)} onChange={onChange} readOnly={readOnly} />
        ))}
      </div>
      {readOnly ? null : <div className="flex items-center gap-3 border-t border-line px-3 py-2 text-[12px]">
        {value.length ? (
          <button type="button" className="text-accent hover:underline" onClick={() => onChange([])}>
            Turn all on
          </button>
        ) : null}
        <span className="flex-1" />
        <Link className="text-muted hover:text-ink hover:underline" href="/settings?tab=connections&store=connected">
          Manage connections
        </Link>
      </div>}
    </div>
  );
}

function AppRow({
  app,
  tools,
  off,
  expanded,
  onExpand,
  onChange,
  readOnly,
}: {
  app: ToolCatalogApp;
  tools: ToolCatalogApp["tools"];
  off: readonly string[];
  expanded: boolean;
  onExpand: () => void;
  onChange: (next: string[]) => void;
  readOnly: boolean;
}) {
  const on = !app.blocked && appIsOn(off, app);
  const usable = app.tools.filter((tool) => !tool.blocked).length;
  const count = toolsOnCount(off, app);
  const products = new Set(tools.map((tool) => tool.product).filter(Boolean));
  let lastProduct: string | undefined;
  return (
    <div role="listitem" className={cx(app.blocked && "opacity-70")} data-testid="tools-app">
      <div className="flex items-center gap-2 px-2 py-1.5 hover:bg-hover">
        <button type="button" className="icon-btn h-6 w-6 shrink-0" onClick={onExpand} aria-expanded={expanded} aria-label={`${expanded ? "Hide" : "Show"} ${app.name} tools`} disabled={!app.tools.length}>
          {expanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        </button>
        <BrandLogo id={app.logo ?? app.key} name={app.name} size={18} decorative />
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onExpand} tabIndex={-1}>
          <span className="block truncate text-[12.5px] text-ink">{app.name}</span>
          <span className="block truncate text-[11px] text-faint">{readOnly ? `${app.source === "mcp" ? "MCP server" : "Built in"} · ${app.blocked ?? `${usable} of ${app.tools.length} ${app.tools.length === 1 ? "tool" : "tools"} usable`}` : app.blocked ?? (on ? (count === usable ? `${usable} ${usable === 1 ? "tool" : "tools"}` : `${count} of ${usable} on`) : "Off")}</span>
        </button>
        {readOnly ? null : <Toggle checked={on} disabled={Boolean(app.blocked) || !usable} onChange={(next) => onChange(setApp(off, app, next))} label={`${app.name}: ${on ? "on" : "off"}`} />}
      </div>
      {expanded ? (
        <ul className="pb-1 pl-9 pr-2">
          {tools.map((tool) => {
            const heading = products.size > 1 && tool.product !== lastProduct ? tool.product : undefined;
            lastProduct = tool.product;
            const toolOn = !tool.blocked && !app.blocked && toolIsOn(off, app, tool.name);
            return (
              <li key={tool.name}>
                {heading ? <p className="pb-0.5 pt-1.5 text-[11px] font-medium text-faint">{heading}</p> : null}
                <div className="flex items-center gap-2 py-1" title={tool.blocked ?? tool.name}>
                  <span className={cx("min-w-0 flex-1 truncate text-[12px]", tool.blocked ? "text-faint" : "text-muted")}>
                    {tool.title}
                    {tool.write ? <span className="ml-1.5 text-[10.5px] text-faint">changes</span> : null}
                  </span>
                  {tool.blocked ? <span className="max-w-[45%] truncate text-[10.5px] text-faint">{tool.blocked}</span> : null}
                  {readOnly ? null : <Toggle small checked={toolOn} disabled={Boolean(tool.blocked || app.blocked)} onChange={(next) => onChange(setTool(off, app, tool.name, next))} label={`${tool.title}: ${toolOn ? "on" : "off"}`} />}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** Settings › Connections: what each connection offers agents, and where to choose. */
export function ToolCatalogSection() {
  const catalog = useToolCatalog();
  if (catalog.error instanceof ApiError && catalog.error.status === 403) return null;
  if (catalog.data && !catalog.data.apps.length) return null;
  return (
    <SectionCard
      title="Tools for agents"
      info={`Ensemble offers these to the assistant, the Code tab's agent, runs it starts and AI apps connected to it, with your own connections. Choose per chat or thread with Tools, per run profile, per run in Assign, and per AI app under Editors & agents. ${COMMON}`}
      description="What each connection lets an agent do."
    >
      <ToolsPanel value={[]} onChange={() => undefined} scope={null} apps={catalog.data?.apps} loading={catalog.isLoading} failed={catalog.isError} readOnly />
    </SectionCard>
  );
}
