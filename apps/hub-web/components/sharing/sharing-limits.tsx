"use client";

import { useClientPlatform } from "@/lib/platform";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Users } from "lucide-react";
import { api } from "@/lib/api";
import { Dialog } from "../ui";

export function ContactLimitDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { native } = useClientPlatform();
  const client = useQueryClient();
  const contacts = useQuery({ queryKey: ["sharing", "contacts"], queryFn: api.contacts, enabled: open });
  const remove = useMutation({ mutationFn: api.removeContact, onSuccess: async () => { await client.invalidateQueries({ queryKey: ["sharing"] }); await client.invalidateQueries({ queryKey: ["space-members"] }); await client.invalidateQueries({ queryKey: ["item-shares"] }); onClose(); } });
  return <Dialog open={open} onClose={onClose} title="Make room for someone new" width={480}>
    <div className="mb-4 grid size-12 place-items-center rounded-xl bg-accent-soft text-accent"><Users size={24} /></div>
    <a href="/shared-by-me" target={native ? undefined : "_blank"} rel="noopener noreferrer" className="btn mb-3">Manage all sharing</a>
    <p className="text-[14px] leading-6 text-muted">You can share with {contacts.data?.limit ?? "a few"} people across all your Ensemble spaces and items. Remove a contact to add someone new, or raise the limit in Settings, Sharing.</p>
    <p className="mt-2 text-[12px] text-muted">Removing someone revokes everything you shared with them. Their own work stays theirs.</p>
    {contacts.isPending ? <p role="status">Loading contacts…</p> : null}
    {contacts.error ? <button className="btn mt-3" onClick={() => void contacts.refetch()}>Retry loading contacts</button> : null}
    <ul className="mt-4 divide-y divide-line rounded-xl border border-line">
      {contacts.data?.contacts.map(person => <li key={person.id} className="flex flex-wrap items-center justify-between gap-2 p-3"><span className="min-w-0 break-words text-[13px] font-medium">{person.name}</span><button type="button" className="btn" disabled={remove.isPending} onClick={() => remove.mutate(person.id)}>Remove and revoke access</button></li>)}
    </ul>
    {remove.error ? <p role="alert" className="mt-3 text-[13px] text-danger">{remove.error.message}</p> : null}
  </Dialog>;
}

export function PublicLinkLimitDialog({ open, onClose, onContinue }: { open: boolean; onClose: () => void; onContinue: () => Promise<unknown> }) {
  const { native } = useClientPlatform();
  const client = useQueryClient();
  const links = useQuery({ queryKey: ["public-links"], queryFn: api.publicLinks, enabled: open });
  const replace = useMutation({ mutationFn: async (id: string) => {
    await api.removePublicLink(id);
    const remaining = await api.publicLinks();
    client.setQueryData(["public-links"], remaining);
    await client.invalidateQueries({ queryKey: ["public-link"] });
    if (remaining.links.length < remaining.limit) await onContinue();
  } });
  return <Dialog open={open} onClose={onClose} title="Choose which page stays public" width={500}>
    <div className="mb-4 grid size-12 place-items-center rounded-xl bg-accent-soft text-accent"><Globe size={24} /></div>
    <a href="/shared-by-me" target={native ? undefined : "_blank"} rel="noopener noreferrer" className="btn mb-3">Manage all sharing</a>
    <p className="text-[14px] leading-6 text-muted">Three pages can be open to everyone across your account. Revoke a link below, then this page can take its place. The old link stops working immediately.</p>
    {(links.data?.links.length ?? 0) > 3 ? <p className="mt-2 text-[13px] text-muted">You have {links.data!.links.length} older links. Revoke {links.data!.links.length - 2} to make room for this page.</p> : null}
    {links.isPending ? <p role="status">Loading public pages…</p> : null}
    {links.error ? <button className="btn mt-3" onClick={() => void links.refetch()}>Retry loading pages</button> : null}
    <ul className="mt-4 divide-y divide-line rounded-xl border border-line">
      {links.data?.links.map(link => <li key={link.id} className="flex flex-wrap items-center justify-between gap-3 p-3"><span className="min-w-0 flex-1 break-words text-[13px] font-medium">{link.title}<small className="mt-1 block text-[11px] font-normal text-muted">{link.kind} · {link.role === "edit" ? "Anyone can edit" : "View only"}</small></span><button type="button" className="btn" disabled={replace.isPending} onClick={() => replace.mutate(link.id)}>Revoke and continue</button></li>)}
    </ul>
    {replace.error ? <p role="alert" className="mt-3 text-[13px] text-danger">{replace.error.message} You can close this dialog and try opening the new page again.</p> : null}
  </Dialog>;
}
