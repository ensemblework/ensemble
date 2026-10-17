"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery } from "@tanstack/react-query";
import { ENSEMBLE_VERSION } from "@ensemble/shared-types";
import { Download, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { useClientPlatform } from "@/lib/platform";
import { SectionCard } from "../ui";

type NativeWindow = Window & { __ENSEMBLE_DESKTOP__?: { version?: string; platform?: string; arch?: string }; __TAURI__?: { core?: { invoke?: <T>(command: string) => Promise<T> } } };
const newer = (a: string, b: string) => {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { const delta = (left[i] ?? 0) - (right[i] ?? 0); if (delta) return delta > 0; } return false;
};
export function AboutSection() {
  const platform = useClientPlatform();
  const info = useQuery({ queryKey: ["release-info"], queryFn: () => api.version(true), staleTime: 300_000 });
  const native = typeof window !== "undefined" ? (window as NativeWindow).__ENSEMBLE_DESKTOP__ : null;
  const installed = platform.native ? native?.version ?? "Unknown" : ENSEMBLE_VERSION;
  const latest = platform.native ? info.data?.releases?.desktop?.version : info.data?.version;
  const behind = Boolean(latest && (installed === "Unknown" || newer(latest, installed)));
  const update = useMutation({ mutationFn: async () => {
    if (!platform.native) { window.location.reload(); return "Reloading Ensemble…"; }
    const invoke = (window as NativeWindow).__TAURI__?.core?.invoke;
    if (!invoke) { window.open("https://ensemblework.com/download", "_blank", "noopener"); return "Choose the installer for this computer."; }
    try { return await invoke<string>("install_update"); } catch { window.open("https://ensemblework.com/download", "_blank", "noopener"); return "Download the current installer to update this computer. Your work is kept."; }
  } });
  return <SectionCard title="About Ensemble" description="One release across your computers, the CLI and the web.">
    <div className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-[16px] font-semibold">Ensemble {installed}</p><p className="mt-1 text-[12px] text-muted">{platform.native ? "Desktop app" : "Web app"} · {info.data?.mode === "local" ? "On this computer" : "Connected to the web"}</p>{platform.native && installed !== ENSEMBLE_VERSION ? <p className="mt-1 text-[12px] text-muted">Web interface {ENSEMBLE_VERSION}</p> : null}</div><button type="button" className={behind ? "btn-primary" : "btn"} disabled={update.isPending || info.isFetching} onClick={() => { if (behind) update.mutate(); else void info.refetch(); }}>{behind ? <Download size={14} /> : <RefreshCw size={14} />}{update.isPending ? "Updating…" : info.isFetching ? "Checking…" : behind ? `Update to ${latest}` : "Check for updates"}</button></div>
    {behind ? <p className="mt-3 text-[13px] text-accent">A newer version is ready. Your work and settings are kept.</p> : info.data?.checked ? <p className="mt-3 text-[12px] text-muted">You have the current version.</p> : null}
    {info.error || (info.data && !info.data.checked) ? <p className="mt-3 text-[12px] text-muted">Could not check published updates right now. Your current app keeps working.</p> : null}
    {update.error || update.data ? <p role={update.error ? "alert" : "status"} className="mt-3 text-[13px] text-muted">{update.error ? "Could not update right now. Try again in a moment." : update.data}</p> : null}
    <a className="mt-3 inline-flex text-[12px] text-accent hover:underline" href="https://ensemblework.com/download" target="_blank" rel="noopener noreferrer">Downloads for your other computers</a>
  </SectionCard>;
}
