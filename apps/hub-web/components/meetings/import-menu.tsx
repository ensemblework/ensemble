"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ClipboardPaste, Download, Upload } from "lucide-react";
import Link from "next/link";
import { MEETING_QUERY, meetingsApi, PROVIDER_LOGO, type MeetingSources, type RemoteProvider } from "@/lib/api-meetings";
import { connectorReturnTo } from "../connectors/catalog-view";
import { BrandLogo } from "../connectors/brand-logo";
import { Popover, Spinner } from "../ui";
import { useToast } from "../toast";
import { useConnectApp } from "./fetch-problem";

const VENDOR_LOGO: Record<string, string> = { fireflies: "fireflies", fathom: "fathom", granola: "granola", tldv: "tldv", krisp: "krisp", jamie: "jamie", otter: "otter" };

function AppState({ state, available }: { state: MeetingSources["apps"][number]["state"]; available: boolean }) {
  if (state === "ready") return <span className="import-menu-state" data-ready>Connected</span>;
  if (!available && state === "not_connected") return <span className="import-menu-state">Not set up here</span>;
  return <span className="import-menu-state">{state === "needs_access" ? "Turn on" : "Connect"}</span>;
}

/**
 * Every way to bring a meeting in, in one menu: a file or a paste, the meeting app itself (Teams,
 * Google Meet, Zoom), and the meeting-notes apps with an API key (Granola, Fireflies, …).
 */
export function ImportMenu({ sources, onUpload, onPaste, onRemote }: { sources: MeetingSources | undefined; onUpload: () => void; onPaste: () => void; onRemote: (provider: RemoteProvider) => void }) {
  const toast = useToast();
  const client = useQueryClient();
  const connect = useConnectApp();
  const vendor = useMutation({
    mutationFn: (id: string) => meetingsApi.importVendor(id, 30),
    onSuccess: (result) => {
      toast(result.message, { tone: result.ok ? "ok" : "error" });
      void client.invalidateQueries({ queryKey: ["meetings-imported"] });
    },
    onError: (error: Error) => toast(error.message, { tone: "error" }),
  });
  return (
    <Popover
      align="right"
      width={300}
      maxHeight={520}
      trigger={(open, toggle) => (
        <button type="button" className="btn" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
          <Download size={14} aria-hidden />
          Import
          <ChevronDown size={13} aria-hidden className="text-muted" />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label="Import a meeting" className="import-menu">
          <button type="button" role="menuitem" className="import-menu-item" onClick={() => { close(); onUpload(); }}>
            <span className="import-menu-icon"><Upload size={15} aria-hidden /></span>
            <span className="min-w-0 flex-1">
              <span className="block">Upload a transcript</span>
              <span className="import-menu-hint">.vtt, .docx, .srt, .txt or .json</span>
            </span>
          </button>
          <button type="button" role="menuitem" className="import-menu-item" onClick={() => { close(); onPaste(); }}>
            <span className="import-menu-icon"><ClipboardPaste size={15} aria-hidden /></span>
            <span className="min-w-0 flex-1">
              <span className="block">Paste a transcript</span>
              <span className="import-menu-hint">Copied from Teams, Zoom or Meet</span>
            </span>
          </button>
          <p className="import-menu-label" role="presentation">From the meeting app</p>
          {(sources?.apps ?? []).map((app) => (
            <button
              key={app.id}
              type="button"
              role="menuitem"
              className="import-menu-item"
              disabled={(!app.available && app.state === "not_connected") || connect.isPending}
              onClick={() => {
                close();
                if (app.state === "ready") onRemote(app.id);
                else connect.mutate({ connector: app.connector, product: app.product });
              }}
            >
              <BrandLogo id={PROVIDER_LOGO[app.id]} size={20} decorative />
              <span className="min-w-0 flex-1 truncate">{app.label}</span>
              <AppState state={app.state} available={app.available} />
            </button>
          ))}
          <p className="import-menu-label" role="presentation">Meeting-notes apps</p>
          {(sources?.vendors ?? []).map((row) =>
            row.connected ? (
              <button key={row.id} type="button" role="menuitem" className="import-menu-item" disabled={vendor.isPending} onClick={() => { close(); vendor.mutate(row.id); }}>
                <BrandLogo id={VENDOR_LOGO[row.id] ?? row.id} name={row.label} size={20} decorative />
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                <span className="import-menu-state" data-ready>{vendor.isPending && vendor.variables === row.id ? <Spinner size={12} /> : "Import 30 days"}</span>
              </button>
            ) : (
              <Link key={row.id} role="menuitem" className="import-menu-item" href={connectorReturnTo(row.id, "/settings")} onClick={close}>
                <BrandLogo id={VENDOR_LOGO[row.id] ?? row.id} name={row.label} size={20} decorative />
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                <span className="import-menu-state">Connect</span>
              </Link>
            ),
          )}
          {!sources ? <p className="px-2 py-1.5 text-[12.5px] text-muted">Loading…</p> : null}
        </div>
      )}
    </Popover>
  );
}
