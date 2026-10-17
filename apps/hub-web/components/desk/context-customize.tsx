"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { Check, Plus, X } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Dialog } from "../ui";
import { api } from "@/lib/api";
import { CONTEXT_DESCRIPTIONS, PROFILE_CONTEXT } from "./context-tabs";
import type { Role } from "../onboarding/roles";
export function CustomizeContext({ role, tabs, ready }: { role: Role; tabs: string[]; ready: boolean }) {
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const save = useMutation({ mutationFn: (next: string[]) => api.putPreference(`context.tabs.${role}`, next), onSuccess: () => client.invalidateQueries({ queryKey: ["preferences"] }) });
  return <><button type="button" className="btn shrink-0" disabled={!ready} onClick={() => setOpen(true)}><Plus size={14} />Add a tab</button>
    <Dialog open={open} onClose={() => setOpen(false)} title="Make Context yours" width={620}>
      <p className="mb-4 text-[13px] text-muted">Choose what belongs in your work. Removing a tab keeps its data. Your choices follow you across Ensemble.</p>
      <div className="space-y-2">{PROFILE_CONTEXT[role].optional.map(label => { const active = tabs.includes(label); return <button type="button" key={label} aria-pressed={active} disabled={save.isPending} className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left ${active ? "border-accent bg-accent-soft" : "border-line hover:bg-hover"}`} onClick={() => save.mutate(active ? tabs.filter(tab => tab !== label) : [...tabs, label])}><span className="min-w-0 flex-1"><strong className="block text-[14px]">{label}</strong><span className="mt-1 block text-[12px] text-muted">{CONTEXT_DESCRIPTIONS[label]}</span></span>{active ? <Check size={18} className="text-accent" /> : <Plus size={18} className="text-muted" />}</button>; })}</div>
      <p className="mt-4 text-[12px] text-muted">Always included: {PROFILE_CONTEXT[role].fixed.join(", ")}.</p>
      {save.error && <p role="alert" className="mt-2 text-danger">Could not save your tabs. Try again.</p>}
    </Dialog></>;
}
export type MockService = { id: string; name: string; detail: string; projectId?: string };
export function mockServices(value: unknown): MockService[] { return Array.isArray(value) ? value.filter((row): row is MockService => Boolean(row && typeof row.id === "string" && typeof row.name === "string" && typeof row.detail === "string")).slice(0,100) : []; }
export function MockServices({ rows }: { rows: MockService[] }) {
  const client = useQueryClient(); const [open,setOpen]=useState(false); const [name,setName]=useState(""); const [detail,setDetail]=useState("");
  const save = useMutation({ mutationFn: (next: MockService[]) => api.putPreference("context.mock-services",next), onSuccess: () => { void client.invalidateQueries({queryKey:["preferences"]}); setOpen(false);setName("");setDetail(""); } });
  return <div className="col-span-full space-y-3"><button type="button" className="btn" disabled={rows.length>=100} onClick={()=>setOpen(true)}><Plus size={14}/>Add a mock service</button>{!rows.length&&<p className="rounded-xl border border-dashed border-line p-6 text-[13px] text-muted">Keep the endpoints, fixtures and test doubles your team relies on. Add your first mock service above.</p>}{rows.map(row=><article key={row.id} className="flex gap-3 rounded-xl border border-line p-4"><div className="min-w-0 flex-1"><h3 className="font-medium">{row.name}</h3><p className="mt-1 whitespace-pre-wrap break-words text-[13px] text-muted">{row.detail}</p></div><button className="icon-btn" aria-label={`Remove ${row.name}`} disabled={save.isPending} onClick={()=>save.mutate(rows.filter(item=>item.id!==row.id))}><X size={14}/></button></article>)}<Dialog open={open} onClose={()=>setOpen(false)} title="Add a mock service" width={520}><form className="space-y-3" onSubmit={event=>{event.preventDefault();save.mutate([...rows,{id:crypto.randomUUID(),name:name.trim(),detail:detail.trim()}]);}}><label className="block text-[13px]">Name<input className="field mt-1 w-full" required maxLength={120} value={name} onChange={e=>setName(e.target.value)}/></label><label className="block text-[13px]">Endpoint or notes<textarea className="field mt-1 min-h-28 w-full" maxLength={2000} value={detail} onChange={e=>setDetail(e.target.value)}/></label><button className="btn-primary" disabled={!name.trim()||save.isPending}>Save mock service</button></form></Dialog>{save.error&&<p role="alert" className="text-danger">Could not save the mock service. Try again.</p>}</div>;
}
