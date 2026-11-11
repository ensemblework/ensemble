"use client";

import { ArrowUpRight, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import type { ConnectFacts, ConnectMethod, ConnectOs } from "@/lib/connect/configs";
import { EXTENSIONS, HOSTS, extensionsFor, type Extension, type HostId } from "@/lib/connect/extensions";
import type { AppCard } from "@/lib/connect/catalog";
import { cx } from "../ui";
import { CopyBlock } from "./bits";
import { AppMark } from "./logos";

/**
 * On an editor's guide: the AI extensions that run inside it and keep their own MCP server list
 * (Claude Code, Codex…). Picking one shows where it reads servers and what to add there, for the way
 * of connecting chosen above.
 */
export function ExtensionPanel({
  app,
  picked,
  onPick,
  method,
  os,
  facts,
}: {
  app: AppCard;
  picked: Extension | null;
  onPick: (id: string | null) => void;
  method: Exclude<ConnectMethod, "source">;
  os: ConnectOs;
  facts: ConnectFacts;
}) {
  const list = extensionsFor(app.id);
  const panel = useRef<HTMLElement>(null);
  // Arriving from the Connect page with ?ext= set: bring the panel into view once.
  useEffect(() => {
    if (picked && window.location.hash === "#extensions") panel.current?.scrollIntoView({ block: "start" });
  }, [picked]);
  if (!list.length) return null;
  const origin = typeof window === "undefined" ? undefined : window.location.origin;
  const setup = picked ? (method === "cli" ? picked.cli(os) : picked.hosted(facts, origin)) : null;
  return (
    <section ref={panel} id="extensions" className="connect-rise tile mt-5 scroll-mt-6 rounded-xl bg-panel p-4 md:p-5" aria-labelledby="extensions-title">
      <h2 id="extensions-title" className="text-[16px] font-semibold tracking-tight">
        Using an AI extension inside {app.name}?
      </h2>
      <p className="mt-1 max-w-2xl text-[13px] leading-5 text-muted">
        Extensions like Claude Code and Codex keep their own list of MCP servers, so the setup above does not reach them. Pick yours.
      </p>
      <div role="tablist" aria-label="AI extension" className="mt-3 flex flex-wrap gap-1.5">
        {list.map((item) => {
          const on = picked?.id === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={on}
              className={cx("connect-chip", on && "is-on")}
              onClick={() => onPick(on ? null : item.id)}
            >
              <ExtensionMark item={item} size={16} />
              {item.name}
            </button>
          );
        })}
      </div>
      {picked && setup ? (
        <div key={`${picked.id}-${method}`} role="tabpanel" aria-label={picked.name} className="connect-rise mt-4 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0">
            <p className="text-[13px] leading-5 text-muted">
              <span className="font-medium text-ink">Where it looks: </span>
              {picked.reads}
            </p>
            <ol className="connect-steps mt-3 space-y-1.5 text-[13.5px] leading-6">
              {setup.steps.map((step) => (
                <li key={step}>
                  <Inline text={step} />
                </li>
              ))}
            </ol>
            {setup.snippet ? (
              <div className="mt-3">
                <CopyBlock label={setup.snippet.label} text={setup.snippet.text} />
              </div>
            ) : null}
            <p className="mt-2 text-[12px] text-faint">
              Showing the {method === "cli" ? "CLI" : "hosted URL"} way. Switch it at the top of this guide.
            </p>
          </div>
          <aside className="space-y-3">
            <div className="rounded-lg border border-line bg-bg/50 p-3">
              <h3 className="text-[12.5px] font-semibold">Check it worked</h3>
              <p className="mt-1 text-[12.5px] leading-5 text-muted">
                <Inline text={picked.check} />
              </p>
            </div>
            {picked.caution ? (
              <div className="flex gap-2 rounded-lg border border-warn/35 bg-warn/[0.06] p-3 text-[12.5px] leading-5 text-muted">
                <ShieldAlert size={14} className="mt-0.5 shrink-0 text-warn" aria-hidden />
                <span>{picked.caution}</span>
              </div>
            ) : null}
            {picked.guide && picked.guide !== app.id ? (
              <Link href={`/connect/${picked.guide}`} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-accent hover:underline">
                Full {picked.name} guide <ArrowUpRight size={13} aria-hidden />
              </Link>
            ) : null}
          </aside>
        </div>
      ) : null}
    </section>
  );
}

/** The extension's own logo where Connect has it; otherwise its initial on a quiet tile, never another vendor's mark. */
function ExtensionMark({ item, size }: { item: Extension; size: number }) {
  if (item.mark) return <AppMark id={item.mark} size={size} />;
  return (
    <span aria-hidden className="ext-initial" style={{ width: size, height: size, fontSize: Math.round(size * 0.55), borderRadius: Math.round(size * 0.26) }}>
      {item.name.slice(0, 1)}
    </span>
  );
}

/** `code` spans written with backticks, the rest as text. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("`") && part.endsWith("`") ? (
          <code key={index} className="rounded bg-hover px-1 py-px font-mono text-[12px] text-ink">
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

/** On the Connect page: each extension, opening the panel above on its main editor's guide. */
export function ExtensionCards() {
  return (
    <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {EXTENSIONS.map((item, index) => {
        const host = item.hosts[0] as HostId;
        return (
          <li key={item.id} className="connect-rise" style={{ animationDelay: `${index * 30}ms` }}>
            <Link href={`/connect/${host}?ext=${item.id}#extensions`} className="connect-card tile flex h-full items-center gap-3 rounded-xl bg-panel px-3 py-2.5">
              <ExtensionMark item={item} size={24} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold">{item.name}</span>
                <span className="block truncate text-[12px] text-muted" title={`In ${item.hosts.map((id) => HOSTS[id]).join(", ")}`}>
                  {item.maker}
                </span>
              </span>
              <ArrowUpRight size={14} className="shrink-0 text-faint" aria-hidden />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
