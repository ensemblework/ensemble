"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Settings } from "@ensemble/shared-types";
import { AccountSection } from "@/components/settings/account";
import { AppearanceSection } from "@/components/settings/appearance";
import { FeaturesSection } from "@/components/features/section";
import { useToast } from "@/components/toast";
import { PageHeader, SkeletonRows } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { desktopShell } from "@/lib/desktop-param";

const SettingsBelow = dynamic(() => import("@/components/settings/below").then((mod) => mod.SettingsBelow), { ssr: false });

const NAV: Array<{ label: string; items: Array<readonly [string, string]> }> = [
  {
    label: "You",
    items: [
      ["account", "Account"],
      ["features", "Features"],
      ["appearance", "Appearance"],
      ["you", "Email & time zone"],
    ],
  },
  {
    label: "Agent",
    items: [
      ["autonomy", "Autonomy"],
      ["orchestration", "Orchestration"],
      ["prompts", "Prompts"],
      ["models", "Models"],
      ["assistant", "The assistant"],
      ["fetch", "Fetching"],
      ["quiet", "Quiet hours"],
      ["editors", "Editors & agents"],
      ["devices", "Devices"],
    ],
  },
  {
    label: "Connections",
    items: [
      ["connections", "Sources"],
      ["connect", "Apps"],
    ],
  },
  {
    label: "Data & housekeeping",
    items: [
      ["retention", "Data retention"],
      ["completed", "Completed"],
      ["trash", "Trash"],
      ["brief", "Morning brief"],
      ["nudges", "Quiet nudges"],
      ["capture", "Quick capture"],
      ["reminders", "Reminders"],
      ["terminal", "Terminal & commits"],
      ["danger", "Deleted & delete data"],
    ],
  },
];

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain => typeof value === "object" && value !== null && !Array.isArray(value);
function merge(base: Plain, patch: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = isPlain(value) && isPlain(base[key]) ? merge(base[key] as Plain, value) : value;
  return out;
}

export default function SettingsPage() {
  const client = useQueryClient();
  const toast = useToast();
  const query = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [draft, setDraft] = useState<Settings | null>(null);
  const [focus, setFocus] = useState("");
  const [active, setActive] = useState("account");
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const [onMac, setOnMac] = useState(false);
  const pending = useRef<Plain>({});
  const timer = useRef<number | undefined>(undefined);
  const mainRef = useRef<HTMLDivElement>(null);
  const pinnedNav = useRef<string | null>(null);

  useEffect(() => {
    if (query.data && !draft) setDraft(query.data.settings);
  }, [query.data, draft]);

  useEffect(() => setOnMac(desktopShell()), []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const failed = params.get("connectError");
    if (connected) {
      toast(connected === "google" ? "Signed in with Google. Gmail and Calendar are on." : `${connected} connected.`, { tone: "ok" });
    }
    if (failed) toast(failed, { tone: "error" });
    if (connected || failed) window.history.replaceState(null, "", `/settings${window.location.hash}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    setFocus(hash);
    if (hash) setActive(hash);
  }, []);

  useEffect(() => {
    const root = mainRef.current;
    if (!draft || !root) return;
    const sections = () =>
      NAV.flatMap((group) => group.items.map(([id]) => document.getElementById(id))).filter((node): node is HTMLElement => Boolean(node));
    const sync = () => {
      const list = sections();
      if (!list.length) return;
      const pinned = pinnedNav.current;
      if (pinned && list.some((node) => node.id === pinned)) {
        setActive(pinned);
        return;
      }
      const atBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 8;
      if (atBottom) {
        setActive(list[list.length - 1]!.id);
        return;
      }
      const edge = root.getBoundingClientRect().top + 32;
      let current = list[0]!.id;
      for (const node of list) {
        if (node.getBoundingClientRect().top <= edge) current = node.id;
      }
      setActive(current);
    };
    const release = () => {
      pinnedNav.current = null;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "PageDown" || event.key === "PageUp" || event.key === "Home" || event.key === "End" || event.key === " ") {
        pinnedNav.current = null;
      }
    };
    root.addEventListener("scroll", sync, { passive: true });
    root.addEventListener("wheel", release, { passive: true });
    root.addEventListener("touchmove", release, { passive: true });
    root.addEventListener("keydown", onKey);
    const mutations = new MutationObserver(sync);
    mutations.observe(root, { childList: true, subtree: true });
    sync();
    return () => {
      root.removeEventListener("scroll", sync);
      root.removeEventListener("wheel", release);
      root.removeEventListener("touchmove", release);
      root.removeEventListener("keydown", onKey);
      mutations.disconnect();
    };
  }, [draft]);

  const flush = useCallback(async () => {
    const patch = pending.current;
    pending.current = {};
    if (!Object.keys(patch).length) return;
    setSaving("saving");
    try {
      const result = await api.saveSettings(patch);
      client.setQueryData(["settings"], result);
      setSaving("saved");
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
      setSaving("idle");
      await client.invalidateQueries({ queryKey: ["settings"] });
      setDraft(null);
    }
  }, [client, toast]);

  const patch = useCallback(
    (value: Plain) => {
      setDraft((current) => (current ? (merge(current as unknown as Plain, value) as unknown as Settings) : current));
      pending.current = merge(pending.current, value);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), 500);
    },
    [flush],
  );

  useEffect(() => () => void flush(), [flush]);

  if (query.isError && !draft) {
    const message = query.error instanceof ApiError ? query.error.message : "Settings didn't load.";
    return (
      <div className="mx-auto max-w-lg px-8 pt-8">
        <div className="rounded-xl border border-line bg-panel p-6">
          <h1 className="text-[16px] font-semibold">Settings didn't load</h1>
          <p className="mt-2 text-[13.5px] text-muted">{message}</p>
          <button type="button" className="btn mt-4" onClick={() => void query.refetch()}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!draft) return <div className="mx-auto max-w-[760px] px-8 pt-8"><SkeletonRows count={6} /></div>;

  return (
    <div className="absolute inset-0 overflow-hidden">
      <div className="mx-auto flex h-full max-w-[1100px] gap-10 px-10">
        <div ref={mainRef} className="min-w-0 max-w-[760px] flex-1 overflow-y-auto py-8" data-settings-main>
          <PageHeader
            title="Settings"
            description="Make Ensemble work your way. Choose your appearance, connect your tools, and stay in control of the agent."
            actions={<span className="text-[12px] text-muted">{saving === "saving" ? "Saving…" : saving === "saved" ? "All settings saved" : ""}</span>}
          />
          <div className="space-y-5 pb-16">
            <h2 className="page-kicker">You</h2>
            <div id="account" className="scroll-mt-6"><AccountSection /></div>
            <div id="features" className="scroll-mt-6"><FeaturesSection /></div>
            <div id="appearance" className="scroll-mt-6"><AppearanceSection patch={patch} /></div>
            <SettingsBelow settings={draft} patch={patch} focus={focus} />
          </div>
        </div>
        <nav className="hidden h-full w-52 shrink-0 overflow-y-auto py-8 text-[12.5px] xl:block" aria-label="Settings sections" data-settings-nav>
          {onMac ? (
            <div className="mb-3">
              <div className="page-kicker px-2 pb-1">This Mac</div>
              <a
                href="#this-mac"
                aria-current={active === "this-mac" ? "true" : undefined}
                className={`row-tile block rounded px-2 py-1 hover:text-ink ${active === "this-mac" ? "bg-accent-soft text-ink" : "text-muted"}`}
                onClick={(event) => {
                  event.preventDefault();
                  pinnedNav.current = "this-mac";
                  setActive("this-mac");
                  document.getElementById("this-mac")?.scrollIntoView({ block: "start" });
                  window.history.replaceState(null, "", "#this-mac");
                }}
              >
                Remote tasks
              </a>
            </div>
          ) : null}
          {NAV.map((group) => (
            <div key={group.label} className="mb-3">
              <div className="page-kicker px-2 pb-1">{group.label}</div>
              {group.items.map(([id, label]) => (
                <a
                  key={id}
                  href={`#${id}`}
                  aria-current={active === id ? "true" : undefined}
                  className={`row-tile block rounded px-2 py-1 hover:text-ink ${active === id ? "bg-accent-soft text-ink" : "text-muted"}`}
                  onClick={(event) => {
                    event.preventDefault();
                    pinnedNav.current = id;
                    setActive(id);
                    document.getElementById(id)?.scrollIntoView({ block: "start" });
                    window.history.replaceState(null, "", `#${id}`);
                  }}
                >
                  {label}
                </a>
              ))}
            </div>
          ))}
        </nav>
      </div>
    </div>
  );
}
