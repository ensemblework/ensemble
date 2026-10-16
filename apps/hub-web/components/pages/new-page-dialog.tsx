"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { standalonePageHref } from "./page-href";
import { confirmAction } from "../ask-dialog";
import { Dialog } from "../ui";

export function NewPageDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter(), client = useQueryClient();
  const [search, setSearch] = useState("");
  const templates = useQuery({ queryKey: ["page-templates"], queryFn: api.pageTemplates, enabled: open });
  const create = useMutation({ mutationFn: (id: string | null) => id ? api.pageFromTemplate(id) : api.createPage(), onSuccess: result => { void client.invalidateQueries({ queryKey: ["pages"] }); onClose(); router.push(standalonePageHref(result.page.id, true)); } });
  const remove = useMutation({ mutationFn: api.deletePageTemplate, onSuccess: () => client.invalidateQueries({ queryKey: ["page-templates"] }) });
  return <Dialog open={open} onClose={onClose} title="New page" width={560}><button type="button" className="btn-primary w-full justify-center py-3" disabled={create.isPending} onClick={() => create.mutate(null)}>Start with a blank page</button><h4 className="mt-5 text-[14px] font-semibold">Your profile’s templates</h4><p className="mt-1 text-[12px] text-muted">Saved by you in this space.</p><input className="field mt-3 w-full" aria-label="Search page templates" placeholder="Find a template…" value={search} onChange={event => setSearch(event.target.value)} />
    {create.error || templates.error || remove.error ? <p role="alert" className="mt-3 text-[13px] text-danger">{create.error?.message ?? templates.error?.message ?? remove.error?.message}</p> : null}
    <ul className="mt-3 max-h-72 divide-y divide-line overflow-y-auto">{templates.data?.templates.filter(row => row.title.toLowerCase().includes(search.toLowerCase())).map(row => <li key={row.id} className="flex items-center gap-3 py-2"><button type="button" className="min-w-0 flex-1 rounded-lg p-2 text-left text-[14px] hover:bg-hover" disabled={create.isPending} onClick={() => create.mutate(row.id)}>{row.title}</button><button type="button" className="btn-ghost" disabled={remove.isPending} onClick={() => void confirmAction({ title: "Remove this template?", body: "Pages already made from it are kept.", confirm: "Remove template", danger: true }).then(yes => { if (yes) remove.mutate(row.id); })} aria-label={`Remove template ${row.title}`}>Remove</button></li>)}</ul>{templates.isSuccess && !templates.data.templates.length ? <p className="mt-3 text-[13px] text-muted">Open a page’s More menu and choose Save as template to add one here.</p> : null}</Dialog>;
}
