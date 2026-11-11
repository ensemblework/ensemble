"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Settings } from "@ensemble/shared-types";
import { findSettingsTarget, flashSetting, SETTINGS_DESTINATION_BY_ID } from "@/components/settings/navigation";
import { AppearanceSection } from "@/components/settings/appearance";
import { AccountTab } from "@/components/settings/tab-account";
import { SettingsNav } from "@/components/settings/settings-nav";
import type { SettingsHit } from "@/components/settings/settings-search";
import { navigateSettings, useSettingsLocation, type SettingsTab } from "@/components/settings/url-state";
import { confirmLeaveSettings, hasUnsaved } from "@/components/settings/unsaved";
import { useToast } from "@/components/toast";
import { PageHeader, SkeletonRows } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { useSpaceAccess } from "@/lib/access";
import { useClientPlatform } from "@/lib/platform";

const loading = () => <SkeletonRows count={4} rowClassName="h-28" className="space-y-5" />;
const AssistantTab = dynamic(() => import("@/components/settings/tab-assistant").then((mod) => mod.AssistantTab), { ssr: false, loading });
const AgentsTab = dynamic(() => import("@/components/settings/tab-agents").then((mod) => mod.AgentsTab), { ssr: false, loading });
const ConnectionsTab = dynamic(() => import("@/components/settings/tab-connections").then((mod) => mod.ConnectionsTab), { ssr: false, loading });
const NotificationsTab = dynamic(() => import("@/components/settings/tab-notifications").then((mod) => mod.NotificationsTab), { ssr: false, loading });
const SpacesTab = dynamic(() => import("@/components/settings/tab-spaces").then((mod) => mod.SpacesTab), { ssr: false, loading });
const SharingTab = dynamic(() => import("@/components/settings/tab-sharing").then((mod) => mod.SharingTab), { ssr: false, loading });
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
  // In a space shared with you, connected apps and the space's data are the owner's.
  const access = useSpaceAccess();
  const platform = useClientPlatform();
  const guestTabs: SettingsTab[] = [...(access.guest ? ["connections", "data"] as SettingsTab[] : []), ...(platform.mobile ? ["shortcuts"] as SettingsTab[] : [])];
  useEffect(() => { if (platform.mobile && location.tab === "shortcuts") navigateSettings({ tab: "account" }); }, [platform.mobile, location.tab]);
  useEffect(() => {
    if (access.guest && (location.tab === "connections" || location.tab === "data")) navigateSettings({ tab: "account" });
  }, [access.guest, location.tab]);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const pending = useRef<Plain>({});
  const timer = useRef<number | undefined>(undefined);
  const mainRef = useRef<HTMLDivElement>(null);
  const scrolled = useRef<string | null>(null);
  // Bumped by a search jump, so jumping again to the same place scrolls and highlights again.
  const [jumps, setJumps] = useState(0);

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
    const destination = SETTINGS_DESTINATION_BY_ID.get(anchor);
    const followUps: number[] = [];
    let tries = 0;
    // The tab and its cards load lazily, so look again until the control is there.
    const find = (): HTMLElement | null => {
      if (!destination) return document.getElementById(anchor);
      const section = document.getElementById(destination.section);
      const panel = mainRef.current;
      return (
        (section ? findSettingsTarget(section, destination.target) : null) ??
        // A control that moved to another card on the same tab is still found, a moment later.
        (tries > 10 && panel ? findSettingsTarget(panel, destination.target) : null) ??
        (tries > 40 && section?.childElementCount ? section : null)
      );
    };
    const timer = window.setInterval(() => {
      tries += 1;
      const node = find();
      if (!node) {
        if (tries > 120) window.clearInterval(timer);
        return;
      }
      window.clearInterval(timer);
      scrolled.current = key;
      node.style.scrollMarginTop = "6rem";
      const block = node.matches("section, [id]") && !node.closest("div[data-setting-label]") ? "start" : "center";
      node.scrollIntoView?.({ block });
      if (destination && node.id !== destination.section) flashSetting(node);
      // Cards above it can still be filling in. If they push it out of view before the person scrolls, bring it back.
      const root = mainRef.current;
      let landed = root?.scrollTop ?? 0;
      for (const delay of [400, 1200]) {
        followUps.push(
          window.setTimeout(() => {
            if (!root || Math.abs(root.scrollTop - landed) > 1) return;
            const box = node.getBoundingClientRect();
            const view = root.getBoundingClientRect();
            if (box.top >= view.top && box.bottom <= view.bottom) return;
            node.scrollIntoView?.({ block });
            landed = root.scrollTop;
          }, delay),
        );
      }
    }, 50);
    return () => {
      window.clearInterval(timer);
      followUps.forEach((id) => window.clearTimeout(id));
    };
  }, [draft, location.tab, location.anchor, jumps]);

  const selectTab = useCallback((tab: SettingsTab) => {
    const go = () => {
      scrolled.current = null;
      navigateSettings({ tab, anchor: null, dialog: null, store: null, connector: null }, "push");
      mainRef.current?.scrollTo?.({ top: 0 });
    };
    // Most of Settings saves as you go; the profile and password forms wait for Save.
    if (hasUnsaved()) void confirmLeaveSettings().then((leave) => leave && go());
    else go();
  }, []);

  const jumpTo = useCallback((hit: SettingsHit) => {
    const go = () => {
      scrolled.current = null;
      const view = { store: null, connector: null };
      if (hit.dialog) navigateSettings({ ...view, tab: hit.tab, anchor: null, dialog: hit.dialog }, "push");
      else navigateSettings({ ...view, tab: hit.tab, anchor: hit.anchor ?? null, dialog: null }, "push");
      if (!hit.anchor) mainRef.current?.scrollTo?.({ top: 0 });
      setJumps((count) => count + 1);
    };
    if (hit.tab !== location.tab && hasUnsaved()) void confirmLeaveSettings().then((leave) => leave && go());
    else go();
  }, [location.tab]);

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
            actions={
              <span className="text-[12px] text-muted" aria-live="polite">
                {saving === "saving" ? "Saving…" : saving === "saved" ? "All settings saved" : ""}
              </span>
            }
          />
          {access.guest ? (
            <div className="mb-5 rounded-lg border border-line bg-panel px-4 py-3 text-[12.5px] leading-5 text-muted">
              You&apos;re in {access.owner ?? "someone"}&apos;s space. Settings here are your own: your theme, models, keys, notifications and
              shortcuts. Connected apps and the space&apos;s data belong to them; switch to one of your spaces to manage yours.
            </div>
          ) : null}
          <div className="lg:grid lg:grid-cols-[208px_minmax(0,1fr)] lg:gap-10">
            <div className="sticky top-0 z-20 -mx-4 mb-5 border-b border-line bg-bg/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:top-6 lg:mx-0 lg:mb-0 lg:self-start lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
              <SettingsNav value={location.tab} onChange={selectTab} onJump={jumpTo} hidden={guestTabs} guest={access.guest} scroller={mainRef} />
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
              ) : location.tab === "appearance" ? (
                <div id="appearance" className="scroll-mt-6"><AppearanceSection patch={patch} /></div>
              ) : location.tab === "assistant" ? (
                <AssistantTab {...props} />
              ) : location.tab === "agents" ? (
                <AgentsTab {...props} />
              ) : location.tab === "connections" ? (
                <ConnectionsTab {...props} />
              ) : location.tab === "notifications" ? (
                <NotificationsTab {...props} />
              ) : location.tab === "spaces" ? (
                <SpacesTab />
              ) : location.tab === "sharing" ? (
                <SharingTab />
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
