"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, Check, ExternalLink, Globe, Link2, LogOut, Share2, Trash2, UserPlus, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { api, publicLinkUrl, type ShareKind, type SharingContact, type SharingOverview } from "@/lib/api";
import { colorFor } from "@/lib/presence";
import { switchSpace } from "@/lib/spaces";
import { SpaceIcon } from "../shell/space-switcher";
import { Avatar } from "../sharing/people";
import { Meter, PersonPicker, ShareDialog } from "../sharing/share-dialog";
import { useToast } from "../toast";
import { Dialog, SectionCard, SkeletonRows } from "../ui";

export const KIND_NAMES: Record<ShareKind, string> = {
  page: "Page",
  task: "Task",
  board: "Board",
  diagram: "Diagram",
  plot_space: "Plot space",
  plot: "Plot",
  meeting: "Meeting notes",
  skill: "Skill",
  workspace: "Workspace",
  code: "Code",
};

type OwnedSpace = SharingOverview["spaces"][number];

function RemoveContact({ contact, onClose }: { contact: SharingContact; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const remove = useMutation({
    mutationFn: () => api.removeContact(contact.id),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ["sharing"] });
      void client.invalidateQueries({ queryKey: ["space-members"] });
      void client.invalidateQueries({ queryKey: ["shell"] });
      const taken = result.removed.spaces + result.removed.items;
      toast(taken ? `Removed ${contact.name} and took back ${taken} share${taken === 1 ? "" : "s"}.` : `Removed ${contact.name}.`, { tone: "ok" });
      onClose();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const shared = contact.spaces + contact.items;
  return (
    <Dialog open onClose={onClose} title={`Remove ${contact.name}?`} width={440}>
      <p className="text-[13px] leading-5 text-muted">
        {shared ? (
          <>
            This takes back <strong className="text-ink">everything</strong> you shared with {contact.name.split(" ")[0]}, at once:
            {contact.spaces ? ` ${contact.spaces} space${contact.spaces === 1 ? "" : "s"}` : ""}
            {contact.spaces && contact.items ? " and" : ""}
            {contact.items ? ` ${contact.items} item${contact.items === 1 ? "" : "s"}` : ""}. Their own work stays theirs.
          </>
        ) : (
          <>Nothing is shared with {contact.name.split(" ")[0]} right now. Removing frees a contact slot.</>
        )}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
          {remove.isPending ? "Removing…" : "Remove and take back"}
        </button>
      </div>
    </Dialog>
  );
}

function TransferDialog({ space, onClose }: { space: OwnedSpace; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [to, setTo] = useState(space.members[0]?.id ?? "");
  const [typed, setTyped] = useState("");
  const transfer = useMutation({
    mutationFn: () => api.transferSpace(space.id, to, typed),
    onSuccess: () => {
      void client.invalidateQueries();
      toast(`${space.name} now belongs to ${space.members.find((row) => row.id === to)?.name ?? "them"}. You stay on as an editor.`, { tone: "ok" });
      onClose();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  return (
    <Dialog open onClose={onClose} title={`Hand over ${space.name}`} width={480}>
      <div className="space-y-3 text-[13px]">
        <p className="leading-5 text-muted">
          A space can change owner <strong className="text-ink">once</strong>. After this, it never can again.
        </p>
        <div className="space-y-1.5">
          {space.members.map((member) => (
            <label key={member.id} className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 ${to === member.id ? "border-accent bg-accent-soft" : "border-line hover:bg-hover"}`}>
              <input type="radio" name="transfer-to" className="sr-only" checked={to === member.id} onChange={() => setTo(member.id)} />
              <Avatar person={member} color={colorFor(member.id)} size={26} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{member.name}</span>
                <span className="block truncate text-2xs text-muted">{member.email}</span>
              </span>
            </label>
          ))}
        </div>
        <ul className="space-y-1 rounded-lg bg-panel px-3 py-2.5 text-[12px] text-muted">
          <li>• Its pages, tasks, boards, diagrams and plots move with it.</li>
          <li>• Your connected apps, model keys, computers and settings stay yours and leave the space.</li>
          <li>• You stay on as an editor. Links you shared from it stop working.</li>
        </ul>
        <label className="block">
          <span className="text-[12px] text-muted">
            Type <strong className="text-ink">{space.name}</strong> to confirm
          </span>
          <input className="field mt-1 w-full" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" disabled={!to || typed.trim() !== space.name.trim() || transfer.isPending} onClick={() => transfer.mutate()}>
            <ArrowRightLeft size={13} /> {transfer.isPending ? "Handing over…" : "Hand over"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** Settings → Sharing: your contacts, what you share, and what is shared with you. */
export function SharingTab() {
  const client = useQueryClient();
  const toast = useToast();
  const overview = useQuery({ queryKey: ["sharing", "overview"], queryFn: api.sharingOverview });
  const [removing, setRemoving] = useState<SharingContact | null>(null);
  const [sharingSpace, setSharingSpace] = useState<OwnedSpace | null>(null);
  const [handing, setHanding] = useState<OwnedSpace | null>(null);
  const [adding, setAdding] = useState(false);
  const refresh = () => void client.invalidateQueries({ queryKey: ["sharing"] });
  const fail = (error: unknown) => toast((error as Error).message, { tone: "error" });

  const addContact = useMutation({ mutationFn: (id: string) => api.addContact(id), onSuccess: () => { refresh(); setAdding(false); }, onError: fail });
  const unshare = useMutation({ mutationFn: (id: string) => api.removeShare(id), onSuccess: refresh, onError: fail });
  const leave = useMutation({
    mutationFn: async (spaceId: string) => {
      const me = client.getQueryData<{ user: { id: string } }>(["shell"])?.user.id;
      if (me) await api.removeMember(spaceId, me);
    },
    onSuccess: () => {
      void client.invalidateQueries();
      toast("You left the space.");
    },
    onError: fail,
  });

  if (overview.isLoading || !overview.data) return <SkeletonRows count={6} />;
  const data = overview.data;
  const contactIds = new Set(data.contacts.map((row) => row.id));
  const contactsFull = data.contacts.length >= data.limits.contacts;

  return (
    <div className="space-y-5">
      <SectionCard
        title="Contacts"
        description={`The people you share with: up to ${data.limits.contacts}. Removing someone takes back everything you shared with them, at once.`}
        actions={<Meter label="contacts" used={data.contacts.length} limit={data.limits.contacts} />}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {data.contacts.map((contact) => (
            <div key={contact.id} className="group flex items-center gap-2.5 rounded-lg border border-line px-3 py-2">
              <Avatar person={contact} color={colorFor(contact.id)} size={30} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{contact.name}</div>
                <div className="truncate text-2xs text-muted">
                  {contact.spaces + contact.items
                    ? [contact.spaces ? `${contact.spaces} space${contact.spaces === 1 ? "" : "s"}` : "", contact.items ? `${contact.items} item${contact.items === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")
                    : contact.email}
                </div>
              </div>
              <button type="button" className="icon-btn opacity-60 group-hover:opacity-100" aria-label={`Remove ${contact.name}`} title="Remove contact" onClick={() => setRemoving(contact)}>
                <X size={14} />
              </button>
            </div>
          ))}
          {Array.from({ length: Math.max(0, data.limits.contacts - data.contacts.length) }, (_, index) =>
            index === 0 && adding ? (
              <div key="adding" className="sm:col-span-2">
                <PersonPicker onPick={(person) => addContact.mutate(person.id)} exclude={contactIds} />
              </div>
            ) : (
              <button
                key={`slot-${index}`}
                type="button"
                disabled={index !== 0}
                onClick={() => setAdding(true)}
                className="flex items-center gap-2.5 rounded-lg border border-dashed border-line px-3 py-2 text-left text-[12.5px] text-faint enabled:hover:border-line-strong enabled:hover:text-ink disabled:opacity-50"
              >
                <span className="grid size-[30px] place-items-center rounded-full border border-dashed border-line-strong">
                  <UserPlus size={13} />
                </span>
                {index === 0 ? "Add a contact" : "Free slot"}
              </button>
            ),
          )}
        </div>
        {contactsFull ? <p className="mt-2 text-2xs text-faint">All slots are used. Remove someone to share with a new person.</p> : null}
      </SectionCard>

      <SectionCard title="Spaces you share" description={`A whole space, shared with up to ${data.limits.members} people. They see its work; your settings, keys, connected apps and computers stay yours.`}>
        <div className="divide-y divide-line">
          {data.spaces.map((space) => (
            <div key={space.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <SpaceIcon space={space} size={30} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-medium">{space.name}</div>
                <div className="text-2xs text-muted">
                  {space.members.length ? `${space.members.length} of ${data.limits.members} people` : "Only you"}
                  {space.transferredAt ? " · changed owner once" : ""}
                </div>
              </div>
              <div className="flex -space-x-1.5">
                {space.members.map((member) => (
                  <Avatar key={member.id} person={member} color={colorFor(member.id)} size={24} title={`${member.name} · ${member.role === "editor" ? "can edit" : "can view"}`} />
                ))}
              </div>
              <button type="button" className="btn h-7 gap-1.5 px-2.5 text-[12.5px]" onClick={() => setSharingSpace(space)}>
                <Share2 size={12} /> Share
              </button>
              {!space.primary && space.members.length && !space.transferredAt ? (
                <button type="button" className="btn h-7 gap-1.5 px-2.5 text-[12.5px]" onClick={() => setHanding(space)} title="Make one of its members the owner. Once per space.">
                  <ArrowRightLeft size={12} /> Hand over
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Items you shared" description="Single pages, tasks, diagrams, plots and more. Each link opens only for the person it was shared with.">
        {data.items.length ? (
          <div className="divide-y divide-line">
            {data.items.map((item) => (
              <div key={item.id} className="flex items-center gap-3 py-2">
                <span className="shrink-0 text-2xs uppercase tracking-wide text-faint sm:w-24">{KIND_NAMES[item.kind]}</span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{item.title}</span>
                <span className="flex items-center gap-1.5 text-2xs text-muted">
                  <Avatar person={item.person} color={colorFor(item.person.id)} size={18} />
                  {item.person.name.split(" ")[0]} · {item.role === "edit" ? "can edit" : "can view"}
                </span>
                <button type="button" className="icon-btn" title="Stop sharing" aria-label={`Stop sharing ${item.title} with ${item.person.name}`} onClick={() => unshare.mutate(item.id)}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[12.5px] text-muted">Nothing yet. Use Share on a page, task, diagram or plot space.</p>
        )}
      </SectionCard>

      <PublicLinks />

      <SectionCard title="Shared with you" description="Spaces and items other people shared with you. Leaving or removing one never touches their copy.">
        {data.withMe.spaces.length + data.withMe.items.length ? (
          <div className="divide-y divide-line">
            {data.withMe.spaces.map((space) => (
              <div key={space.id} className="flex items-center gap-3 py-2">
                <SpaceIcon space={space} size={26} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">
                    {space.name} <span className="font-normal text-faint">(shared)</span>
                  </div>
                  <div className="text-2xs text-muted">
                    {space.owner.name} · you {space.role === "editor" ? "can edit" : "can view"}
                  </div>
                </div>
                <button type="button" className="btn h-7 gap-1.5 px-2.5 text-[12.5px]" onClick={() => void switchSpace(space.id, "/board")}>
                  <ExternalLink size={12} /> Open
                </button>
                <button type="button" className="icon-btn" title="Leave this space" aria-label={`Leave ${space.name}`} onClick={() => leave.mutate(space.id)}>
                  <LogOut size={13} />
                </button>
              </div>
            ))}
            {data.withMe.items.map((item) => (
              <div key={item.id} className="flex items-center gap-3 py-2">
                <span className="shrink-0 text-2xs uppercase tracking-wide text-faint sm:w-24">{KIND_NAMES[item.kind]}</span>
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {item.title}
                  {!item.openedAt ? <span className="ml-1.5 rounded bg-accent-soft px-1 text-[10px] text-ink">New</span> : null}
                </span>
                <span className="text-2xs text-muted">from {item.owner.name.split(" ")[0]}</span>
                <Link href={`/shared/${item.id}`} className="btn h-7 gap-1.5 px-2.5 text-[12.5px]">
                  <ExternalLink size={12} /> Open
                </Link>
                <button type="button" className="icon-btn" title="Remove from your list" aria-label={`Remove ${item.title}`} onClick={() => unshare.mutate(item.id)}>
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[12.5px] text-muted">Nothing is shared with you yet.</p>
        )}
      </SectionCard>

      {removing ? <RemoveContact contact={removing} onClose={() => setRemoving(null)} /> : null}
      {sharingSpace ? <ShareDialog open onClose={() => { setSharingSpace(null); refresh(); }} target={{ kind: "space", spaceId: sharingSpace.id, name: sharingSpace.name }} /> : null}
      {handing ? <TransferDialog space={handing} onClose={() => setHanding(null)} /> : null}
    </div>
  );
}

/** Links anyone can open without an account: five per account for now. */
function PublicLinks() {
  const client = useQueryClient();
  const toast = useToast();
  const [copied, setCopied] = useState<string | null>(null);
  const links = useQuery({ queryKey: ["public-links"], queryFn: api.publicLinks });
  const remove = useMutation({
    mutationFn: (id: string) => api.removePublicLink(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["public-links"] });
      void client.invalidateQueries({ queryKey: ["public-link"] });
      toast("The link is off. Nobody can open it now.");
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const rows = links.data?.links ?? [];
  return (
    <SectionCard
      title="Public links"
      description="Pages, tasks, diagrams and meeting notes anyone with the link can open, no account needed. A whole space is never public."
      actions={links.data ? <Meter label="public links" used={rows.length} limit={links.data.limit} /> : undefined}
    >
      {rows.length ? (
        <div className="divide-y divide-line">
          {rows.map((link) => (
            <div key={link.id} className="flex items-center gap-3 py-2">
              <Globe size={14} className="shrink-0 text-faint" />
              <span className="shrink-0 text-2xs uppercase tracking-wide text-faint sm:w-24">{KIND_NAMES[link.kind]}</span>
              <span className="min-w-0 flex-1 truncate text-[13px]">{link.title || "Untitled"}</span>
              <span className="shrink-0 whitespace-nowrap text-2xs text-muted">
                {link.role === "edit" ? "anyone can edit" : "view only"}<span className="hidden sm:inline"> · {link.opens} open{link.opens === 1 ? "" : "s"}</span>
              </span>
              <button
                type="button"
                className="icon-btn"
                title="Copy link"
                aria-label={`Copy the link to ${link.title}`}
                onClick={() => {
                  void navigator.clipboard.writeText(publicLinkUrl(link.token));
                  setCopied(link.id);
                  window.setTimeout(() => setCopied(null), 1500);
                }}
              >
                {copied === link.id ? <Check size={13} /> : <Link2 size={13} />}
              </button>
              <button type="button" className="icon-btn" title="Turn the link off" aria-label={`Turn off the link to ${link.title}`} onClick={() => remove.mutate(link.id)}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[12.5px] text-muted">None yet. Open Share on a page, task, diagram or meeting notes and choose "Anyone with the link".</p>
      )}
    </SectionCard>
  );
}
