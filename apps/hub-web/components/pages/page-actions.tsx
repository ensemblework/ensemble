"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { Dialog, Popover } from "../ui";
import { useToast } from "../toast";
import { PageHistory } from "./page-history";

export function PageActions({ id, title, onRename, onDelete, before }: { id: string; title: string; onRename?: () => void; onDelete?: () => void; before?: () => Promise<unknown> }) {
  const router = useRouter(), client = useQueryClient(), toast = useToast();
  const [history, setHistory] = useState(false), [savingTemplate, setSavingTemplate] = useState(false), [name, setName] = useState(title);
  const duplicate = useMutation({ mutationFn: async () => { await before?.(); return api.duplicatePage(id); }, onSuccess: result => { void client.invalidateQueries({ queryKey: ["pages"] }); router.push(`/pages/${result.page.id}`); }, onError: error => toast(error.message, { tone: "error" }) });
  const save = useMutation({ mutationFn: async () => { await before?.(); return api.savePageTemplate(id, name.trim()); }, onSuccess: () => { void client.invalidateQueries({ queryKey: ["page-templates"] }); setSavingTemplate(false); toast("Template saved for your profile in this space.", { tone: "ok" }); } });
  const openHistory = async () => { try { await before?.(); setHistory(true); } catch (error) { toast((error as Error).message, { tone: "error" }); } };
  return <><Popover trigger={(open, toggle) => <button type="button" className="icon-btn" title="More page actions" aria-label={`More actions for ${title}`} aria-expanded={open} onClick={toggle}><MoreHorizontal size={15} /></button>}>{close => <div className="min-w-44 space-y-1">{onRename ? <button type="button" className="menu-item w-full text-left" onClick={() => { close(); onRename(); }}>Rename</button> : null}<button type="button" className="menu-item w-full text-left" disabled={duplicate.isPending} onClick={() => { close(); duplicate.mutate(); }}>Duplicate</button><button type="button" className="menu-item w-full text-left" onClick={() => { close(); setName(title === "Untitled" ? "" : title); setSavingTemplate(true); }}>Save as template</button><button type="button" className="menu-item w-full text-left" onClick={() => { close(); void openHistory(); }}>Version history</button>{onDelete ? <button type="button" className="menu-item w-full text-left text-danger" onClick={() => { close(); onDelete(); }}>Delete</button> : null}</div>}</Popover>
    <PageHistory kind="page" id={id} open={history} onClose={() => setHistory(false)} />
    <Dialog open={savingTemplate} onClose={() => setSavingTemplate(false)} title="Save page as template" width={440}><p className="text-[13px] leading-5 text-muted">Keep this page’s writing and layout in your profile’s new-page picker. Comments and interactive AI requests are not copied.</p><label className="mt-4 block text-[13px]">Template name<input className="field mt-1 w-full" maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>{save.error ? <p role="alert" className="mt-2 text-[13px] text-danger">{save.error.message}</p> : null}<button type="button" className="btn-primary mt-4" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save template"}</button></Dialog>
  </>;
}
