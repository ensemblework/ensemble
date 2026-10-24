"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConnectComputerButton } from "./connect-computer";
import { useToast } from "@/components/toast";
import { InfoTip, SectionCard, Spinner, cx } from "@/components/ui";
import { api } from "@/lib/api";
import { platformLabel } from "@/lib/device-copy";
import { computerOpensPullRequests, repositoryLabels } from "@/lib/pull-request";
import { relative } from "@/lib/format";

export function DevicesSection() {
  const client = useQueryClient();
  const toast = useToast();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameDevice(id, name),
    onSuccess: () => { setRenaming(null); void client.invalidateQueries({ queryKey: ["devices"] }); void client.invalidateQueries({ queryKey: ["subscriptions"] }); },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, refetchInterval: 15_000 });
  const rows = devices.data?.devices ?? [];
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
      title="Connected computers"
      description="Tasks run on a connected computer using its own AI subscriptions, model keys and git sign-in."
      actions={<ConnectComputerButton />}
    >
      {devices.isLoading ? <Spinner size={14} /> : null}{devices.error ? <p role="alert" className="text-[13px] text-danger">Could not load connected computers. <button className="btn" onClick={() => void devices.refetch()}>Retry</button></p> : null}
      {rows.length ? (
        <ul className="divide-y divide-line">
          {rows.map((device) => (
            <li key={device.id} className="flex items-center gap-3 py-2.5">
              <span className={cx("h-2 w-2 shrink-0 rounded-full", device.online ? "bg-ok pulse-dot" : "bg-faint")} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1 text-[13.5px] font-medium">
                  {renaming === device.id ? <form className="flex w-full min-w-0 flex-wrap gap-1" onSubmit={(event) => { event.preventDefault(); rename.mutate({ id: device.id, name: name.trim() }); }}><input autoFocus className="field min-w-0 flex-1" aria-label="Computer name" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} /><button className="btn" disabled={!name.trim() || rename.isPending}>Save</button><button type="button" className="btn-ghost" onClick={() => setRenaming(null)}>Cancel</button></form> : <button type="button" className="hover:underline" aria-label={`Rename ${device.name}`} onClick={() => { setRenaming(device.id); setName(device.name); }}>{device.name}</button>} <span className="font-normal text-muted">· {platformLabel(device.platform)}</span>
                </div>
                <div className="truncate text-[12px] text-faint">
                  {device.online ? "Online" : device.lastSeenAt ? `Last seen ${relative(device.lastSeenAt)}` : "Not seen yet"}
                  {device.appVersion ? ` · ${device.appVersion}` : ""}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  {computerOpensPullRequests(device.capabilities) ? null : (
                    <span className="inline-flex items-center gap-1.5 text-[12px] text-muted" data-pull-requests="unsupported">
                      Pull requests: update Ensemble there first
                      <InfoTip text={`Ensemble on ${device.name} is too old to open pull requests. Update it there (\`ensemble update\`).`} />
                    </span>
                  )}
                  {repositoryLabels(device.capabilities).length ? (
                    <span className="min-w-0 truncate text-[12px] text-muted" title="Shared as repositories: each run works in its own clone.">
                      Repositories: {repositoryLabels(device.capabilities).join(", ")}
                    </span>
                  ) : null}
                </div>
              </div>
              <button type="button" className="btn-ghost py-0 text-[12px]" onClick={() => revoke.mutate(device.id)} disabled={revoke.isPending}>
                <Trash2 size={12} /> Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : devices.isLoading || devices.error ? null : (
        <div className="text-[13px] text-muted">No computers connected yet. Choose Connect a computer to get started.</div>
      )}
    </SectionCard>
  );
}
