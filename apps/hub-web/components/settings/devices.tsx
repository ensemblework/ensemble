"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { RunBranchStatus } from "@/components/agent/run-branch-status";
import { useToast } from "@/components/toast";
import { SectionCard, SettingRow, Spinner, cx } from "@/components/ui";
import { api } from "@/lib/api";
import { pairingCodeConsumed, platformLabel } from "@/lib/device-copy";
import { relative } from "@/lib/format";

export function DevicesSection() {
  const client = useQueryClient();
  const toast = useToast();
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
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
      description="Pair a computer, then assign a task to it from the web. The task runs there, with that computer's model key and git sign-in."
      actions={
        <button type="button" className="btn" onClick={() => pair.mutate()} disabled={pair.isPending}>
          {pair.isPending ? <Spinner size={12} /> : <Monitor size={13} />} Pair a device
        </button>
      }
    >
      {code ? (
        <div className="mb-4 rounded-lg border border-accent/40 bg-[var(--accent-soft)] px-3 py-3">
          <div className="text-[12.5px] text-muted">Type this code into your computer. It lasts 10 minutes.</div>
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
        <div className="text-[13px] text-muted">No computers paired yet.</div>
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
