"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Download, Monitor } from "lucide-react";
import { api, HUB_API } from "@/lib/api";
import { Dialog } from "../ui";
import { useToast } from "../toast";

/** One guided connection flow wherever a computer is needed. */
export function ConnectComputerButton({ className = "btn" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className={className} onClick={() => setOpen(true)}><Monitor size={14} />Connect a computer</button>{open ? <ConnectComputerDialog onClose={() => setOpen(false)} /> : null}</>;
}

function ConnectComputerDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [expired, setExpired] = useState(false);
  const existing = useRef<string[] | null>(null);
  const pair = useMutation({ mutationFn: async () => {
    existing.current = (await api.devices()).devices.map(device => device.id);
    return api.pairDevice();
  } });
  useEffect(() => {
    setExpired(false);
    if (!pair.data) return;
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, new Date(pair.data.expiresAt).getTime() - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pair.data]);
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, refetchInterval: pair.data && !expired ? 2000 : false });
  useEffect(() => {
    if (pair.data && existing.current && devices.data?.devices.some(device => !existing.current!.includes(device.id))) {
      void client.invalidateQueries({ queryKey: ["subscriptions"] });
      toast("Computer connected.", { tone: "ok" });
      onClose();
    }
  }, [devices.data, pair.data, client, onClose, toast]);
  return <Dialog open onClose={onClose} title="Connect a computer" width={480}>
    <p className="text-[14px] leading-6 text-muted">Install and open Ensemble on the computer you want to use for tasks and AI subscriptions.</p>
    <a className="btn mt-4" href="https://ensemblework.com/download" target="_blank" rel="noopener noreferrer"><Download size={14} />Get Ensemble</a>
    <div className="mt-5 border-t border-line pt-4"><h4 className="text-[14px] font-medium">Already installed?</h4><p className="mt-1 text-[13px] text-muted">Create a code. In the desktop app, open Settings › Account › This computer (This Mac on macOS). Enter the web address below and this code, then choose Pair. Turn on Allow remote tasks there when you are ready.</p>
      <p className="mt-3 text-[12px] text-muted">Web address: <span className="select-all break-all font-mono text-ink">{HUB_API}</span></p>
      {pair.data ? <div className="mt-4 rounded-xl border border-accent bg-accent-soft p-4"><div className="font-mono text-[28px] font-semibold tracking-[0.25em]" aria-label="Connection code">{expired ? "Code expired" : pair.data.code}</div><p className="mt-2 text-[12px] text-muted">{expired ? "Create a new code to continue." : "Valid for 10 minutes. This window closes when your computer connects."}</p></div> : null}
      {pair.error ? <p role="alert" className="mt-3 text-[13px] text-danger">{pair.error.message}</p> : null}
      <button type="button" className="btn-primary mt-4" disabled={pair.isPending} onClick={() => pair.mutate()}>{pair.isPending ? "Creating code…" : pair.data ? "Create a new code" : "Create connection code"}</button>
    </div>
  </Dialog>;
}
