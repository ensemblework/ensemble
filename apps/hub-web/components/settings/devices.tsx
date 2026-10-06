"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { RunBranchStatus } from "@/components/agent/run-branch-status";
import { useToast } from "@/components/toast";
import { SectionCard, SettingRow, Spinner, cx } from "@/components/ui";
import { api } from "@/lib/api";
import { INSTALL_CHANNELS, type ConnectOs } from "@/lib/connect/configs";
import { pairingCodeConsumed, platformLabel } from "@/lib/device-copy";
import { relative } from "@/lib/format";

const OS_TABS: Array<{ id: ConnectOs; label: string }> = [
  { id: "mac", label: "macOS" },
  { id: "windows", label: "Windows" },
  { id: "linux", label: "Linux" },
];

export function DevicesSection() {
  const client = useQueryClient();
  const toast = useToast();
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [os, setOs] = useState<ConnectOs>("mac");
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, refetchInterval: code ? 2_000 : 15_000 });
  const seen = useRef<string[] | null>(null);
  const rows = devices.data?.devices ?? [];
  useEffect(() => {
    if (devices.isLoading) return;
    const ids = rows.map((device) => device.id);
    if (code && seen.current && pairingCodeConsumed(seen.current, ids)) setCode(null);
    seen.current = ids;
  }, [rows, code, devices.isLoading]);
  const pair = useMutation({
    mutationFn: api.pairDevice,
    onSuccess: (result) => setCode(result),
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const revoke = useMutation({
    mutationFn: api.revokeDevice,
    onSuccess: () => {
      toast("Unpaired. That computer can no longer take tasks.", { tone: "ok" });
      void client.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  return (
    <SectionCard
      title="Devices"
      description="Add a computer with the Ensemble CLI, then assign tasks to it from the web. The task runs there, with that computer's model key and git sign-in."
      actions={
        <button type="button" className="btn" onClick={() => pair.mutate()} disabled={pair.isPending}>
          {pair.isPending ? <Spinner size={12} /> : <Monitor size={13} />} Pair desktop app
        </button>
      }
    >
      <section className="mb-5 rounded-xl border border-line bg-bg/60 p-4" aria-labelledby="cli-device-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 id="cli-device-title" className="text-[15px] font-semibold">
              Add a computer with the Ensemble CLI
            </h3>
            <p className="mt-1 max-w-2xl text-[13px] leading-5 text-muted">
              Install the CLI, sign in, share a folder, and install the runner so tasks can start when you log in.
            </p>
          </div>
          <Link href="https://ensemblework.com/download" className="btn" target="_blank" rel="noopener">
            Download
          </Link>
        </div>
        <div role="tablist" aria-label="Computer operating system" className="mt-4 inline-flex rounded-lg border border-line bg-raised p-0.5">
          {OS_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={os === tab.id}
              className={cx("rounded-md px-2.5 py-1 text-[12.5px]", os === tab.id ? "bg-panel font-medium text-ink shadow-sm" : "text-muted hover:text-ink")}
              onClick={() => setOs(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="space-y-2">
            <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-faint">Install</div>
            {INSTALL_CHANNELS[os].slice(0, 2).map((channel) => (
              <div key={channel.id} className="rounded-lg border border-line bg-panel px-3 py-2">
                <div className="text-[12.5px] font-medium">
                  {channel.label}
                  {channel.status === "coming-soon" ? <span className="ml-1 text-faint">· coming soon</span> : null}
                </div>
                <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[12px] leading-5 text-muted">{channel.commands.join("\n")}</pre>
              </div>
            ))}
          </div>
          <div>
            <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-faint">Then run</div>
            <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-line bg-panel px-3 py-2 font-mono text-[12px] leading-5 text-muted">
{`ensemble login
ensemble folders add <path>
ensemble runner install`}
            </pre>
          </div>
        </div>
      </section>
      {code ? (
        <div className="mb-4 rounded-lg border border-accent/40 bg-[var(--accent-soft)] px-3 py-3">
          <div className="text-[12.5px] text-muted">Type this code into the desktop app. It lasts 10 minutes.</div>
          <div className="mt-1 font-mono text-[28px] font-semibold tracking-[0.28em]">{code.code}</div>
          <div className="text-[12px] text-faint">Expires at {new Date(code.expiresAt).toLocaleTimeString()}</div>
        </div>
      ) : null}
      {devices.isLoading ? <Spinner size={14} /> : null}
      {rows.length ? (
        <ul className="divide-y divide-line">
          {rows.map((device) => (
            <li key={device.id} className="flex items-center gap-3 py-2.5">
              <span className={cx("h-2 w-2 shrink-0 rounded-full", device.online ? "bg-ok pulse-dot" : "bg-faint")} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-medium">
                  {device.name} <span className="font-normal text-muted">· {platformLabel(device.platform)}</span>
                </div>
                <div className="truncate text-[12px] text-faint">
                  {device.online ? "Online" : device.lastSeenAt ? `Last seen ${relative(device.lastSeenAt)}` : "Not seen yet"}
                  {device.appVersion ? ` · ${device.appVersion}` : ""}
                  {device.runBranchPush ? " · run-branch push on" : ""}
                </div>
              </div>
              <button type="button" className="btn-ghost py-0 text-[12px]" onClick={() => revoke.mutate(device.id)} disabled={revoke.isPending}>
                <Trash2 size={12} /> Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : devices.isLoading ? null : (
        <div className="text-[13px] text-muted">No computers connected yet. Use the CLI setup above, or pair the desktop app.</div>
      )}
      <div className="mt-3 border-t border-line">
        <SettingRow
          title="Remote tasks may push to their own run branch"
          description="Off unless a paired computer turns it on, and only for repos that computer already trusts. Every other push still asks there."
        >
          <RunBranchStatus
            on={rows.some((device) => device.runBranchPush)}
            device={rows.filter((device) => device.runBranchPush).map((device) => device.name).join(", ") || rows[0]?.name}
          />
        </SettingRow>
      </div>
    </SectionCard>
  );
}
