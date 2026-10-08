"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Settings } from "@ensemble/shared-types";
import { AccountTab } from "@/components/settings/tab-account";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { navigateSettings, useSettingsLocation, type SettingsTab } from "@/components/settings/url-state";
import { useToast } from "@/components/toast";
import { PageHeader, SkeletonRows } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

const loading = () => <SkeletonRows count={4} rowClassName="h-28" className="space-y-5" />;
const AssistantTab = dynamic(() => import("@/components/settings/tab-assistant").then((mod) => mod.AssistantTab), { ssr: false, loading });
const ConnectionsTab = dynamic(() => import("@/components/settings/tab-connections").then((mod) => mod.ConnectionsTab), { ssr: false, loading });
const NotificationsTab = dynamic(() => import("@/components/settings/tab-notifications").then((mod) => mod.NotificationsTab), { ssr: false, loading });
const SpacesTab = dynamic(() => import("@/components/settings/tab-spaces").then((mod) => mod.SpacesTab), { ssr: false, loading });
const ShortcutsTab = dynamic(() => import("@/components/settings/tab-shortcuts").then((mod) => mod.ShortcutsTab), { ssr: false, loading });
const DataTab = dynamic(() => import("@/components/settings/tab-data").then((mod) => mod.DataTab), { ssr: false, loading });

const PROVIDER_NAMES: Record<string, string> = {
  google: "Google Workspace",
  microsoft: "Microsoft 365",
  github: "GitHub",
  notion: "Notion",
  linear: "Linear",
  slack: "Slack",
  atlassian: "Jira",
  zoom: "Zoom",
  docusign: "DocuSign",
};

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
  const location = useSettingsLocation();
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const pending = useRef<Plain>({});
  const timer = useRef<number | undefined>(undefined);
  const mainRef = useRef<HTMLDivElement>(null);
  const scrolled = useRef<string | null>(null);

  useEffect(() => {
    if (query.data && !draft) setDraft(query.data.settings);
  }, [query.data, draft]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const connected = url.searchParams.get("connected");
    const failed = url.searchParams.get("connectError");
    if (connected) toast(`${PROVIDER_NAMES[connected] ?? connected} connected.`, { tone: "ok" });
    if (failed) toast(failed, { tone: "error" });
    if (connected || failed) {
      url.searchParams.delete("connected");
      url.searchParams.delete("connectError");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
    // Old links (/settings#models) get their tab written into the address; the hash stays for the scroll.
    if (!url.searchParams.get("tab")) navigateSettings({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (location.anchor === "keys" || location.anchor === "changes") navigateSettings({ dialog: location.anchor, anchor: null });
  }, [location.anchor]);

  useEffect(() => {
    const anchor = location.anchor;
    if (!draft || !anchor) return;
    const key = `${location.tab}#${anchor}`;
    if (scrolled.current === key) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      const node = document.getElementById(anchor);
      tries += 1;
      if (node) {
        scrolled.current = key;
        node.scrollIntoView?.({ block: "start" });
      }
      if (node || tries > 60) window.clearInterval(timer);
    }, 50);
    return () => window.clearInterval(timer);
  }, [draft, location.tab, location.anchor]);

  const selectTab = useCallback((tab: SettingsTab) => {
    scrolled.current = null;
    navigateSettings({ tab, anchor: null, dialog: null, store: null, connector: null }, "push");
    mainRef.current?.scrollTo?.({ top: 0 });
  }, []);

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

  const props = draft ? { settings: draft, patch } : null;
  return (
    <div className="absolute inset-0 overflow-hidden">
      <div ref={mainRef} className="h-full overflow-y-auto" data-settings-main>
        <div className="mx-auto w-full max-w-[1060px] px-4 pb-16 pt-6 sm:px-6 lg:px-10 lg:pt-8">
          <PageHeader
            title="Settings"
            description="Make Ensemble work your way: your account and spaces, the assistant, connected apps, shortcuts, and your data."
            actions={
              <span className="text-[12px] text-muted" aria-live="polite">
                {saving === "saving" ? "Saving…" : saving === "saved" ? "All settings saved" : ""}
              </span>
            }
          />
          <div className="lg:grid lg:grid-cols-[196px_minmax(0,1fr)] lg:gap-10">
            <div className="sticky top-0 z-20 -mx-4 mb-4 border-b border-line bg-bg/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:top-8 lg:mx-0 lg:mb-0 lg:self-start lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
              <SettingsTabs value={location.tab} onChange={selectTab} />
            </div>
            <div
              role="tabpanel"
              id="settings-panel"
              aria-labelledby={`settings-tab-${location.tab}`}
              className="min-w-0 max-w-[760px] space-y-5"
              data-settings-tab={location.tab}
            >
              {!props ? (
                <SkeletonRows count={6} />
              ) : location.tab === "assistant" ? (
                <AssistantTab {...props} />
              ) : location.tab === "connections" ? (
                <ConnectionsTab {...props} />
              ) : location.tab === "notifications" ? (
                <NotificationsTab {...props} />
              ) : location.tab === "spaces" ? (
                <SpacesTab />
              ) : location.tab === "shortcuts" ? (
                <ShortcutsTab />
              ) : location.tab === "data" ? (
                <DataTab {...props} />
              ) : (
                <AccountTab {...props} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
