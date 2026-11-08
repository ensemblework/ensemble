"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, type ConnectBridge } from "@/lib/api";
import { relative } from "@/lib/format";
import { clearBridgeToken, readBridgeToken, saveBridgeToken, useBridgeToken } from "@/lib/connect/session-token";
import { useToast } from "../toast";
import { CopyBlock } from "./bits";

export function BridgeKey({
  tokens,
  compact = false,
}: {
  tokens: ConnectBridge["tokens"];
  compact?: boolean;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const fresh = useBridgeToken();
  const [canWrite, setCanWrite] = useState(true);
  const [canUseApps, setCanUseApps] = useState(true);
  const create = useMutation({
    mutationFn: () => api.createBridgeToken(`${canWrite ? "Editor" : "Read-only"} · ${new Date().toLocaleDateString()}`, canWrite, canUseApps),
    onSuccess: (result) => {
      saveBridgeToken(result.token);
      toast("Key created. Copy it now, Ensemble will not show it again.", { tone: "ok" });
      void client.invalidateQueries({ queryKey: ["connect-bridge"] });
      void client.invalidateQueries({ queryKey: ["tokens"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeToken(id),
    onSuccess: (_data, id) => {
      const row = tokens.find((token) => token.id === id);
      if (row && readBridgeToken()?.startsWith(row.prefix)) clearBridgeToken();
      void client.invalidateQueries({ queryKey: ["connect-bridge"] });
      void client.invalidateQueries({ queryKey: ["tokens"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  return (
    <div>
      <p className="text-[13.5px] leading-5 text-muted">
        {compact
          ? "Create the key here if you have not already. It is filled into the later steps."
          : "One key for every app on this page. It starts with ens_ and reads your tasks, projects, people and meetings. With changes allowed it can also edit tasks, pages, boards, diagrams, plots, files, projects, people, deliverables and meeting notes (never settings, skills or bulk deletes; Undo has each change). With apps allowed it can use the apps you connected to Ensemble. Editor hooks in Settings use a different key that is allowed to ask you questions."}
      </p>
      <div className="mt-3">
        {fresh ? (
          <CopyBlock text={fresh} label="Your key, copy it now" />
        ) : (
          <div className="flex flex-col gap-2">
            <label className="flex items-start gap-2 text-[13px] leading-5">
              <input type="checkbox" className="mt-0.5" checked={canWrite} onChange={(event) => setCanWrite(event.target.checked)} />
              <span>Let editors and agents make changes (tasks, pages, boards, diagrams, plots, files, projects, people, meeting notes)</span>
            </label>
            <label className="flex items-start gap-2 text-[13px] leading-5">
              <input type="checkbox" className="mt-0.5" checked={canUseApps} onChange={(event) => setCanUseApps(event.target.checked)} />
              <span>Let editors and agents use your connected apps through Ensemble (read, and change when changes are allowed)</span>
            </label>
            <div>
              <button type="button" className="btn-primary" onClick={() => create.mutate()} disabled={create.isPending}>
                <KeyRound size={14} /> {create.isPending ? "Creating…" : canWrite ? "Create a key" : "Create a read-only key"}
              </button>
            </div>
          </div>
        )}
      </div>
      {fresh ? <p className="mt-2 text-[12.5px] text-muted">Kept in this browser tab so the guides can fill it in. Closing the tab hides it.</p> : null}
      {tokens.length ? (
        <ul className="mt-3 space-y-1.5">
          {tokens.map((token) => (
            <li key={token.id} className="flex items-center justify-between gap-3 text-[12.5px]">
              <span className="min-w-0 truncate">
                <span className="font-mono">{token.prefix}…</span> {token.name}{" "}
                <span className="text-faint">· {token.canWrite ? "reads and makes changes" : "read only"}{token.canUseApps ? ", uses your apps" : ""}</span>{" "}
                <span className="text-faint">· {token.lastUsedAt ? `used ${relative(token.lastUsedAt)}` : "not used yet"}</span>
              </span>
              <button type="button" className="btn-ghost py-0 text-[12px]" onClick={() => revoke.mutate(token.id)}>
                <Trash2 size={12} /> Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
