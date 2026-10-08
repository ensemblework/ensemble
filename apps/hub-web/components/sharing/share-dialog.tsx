"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Globe, Link2, Lock, RefreshCw, Search, Share2, X } from "lucide-react";
import {
  api,
  type ItemRole,
  type MemberRole,
  type ShareKind,
  type SharingPerson,
} from "@/lib/api";
import { colorFor } from "@/lib/presence";
import { publicLinkUrl } from "@/lib/api";
import { Dialog } from "@/components/ui";
import { useToast } from "@/components/toast";
import { Avatar } from "./people";

export type ShareTarget = { kind: "space"; spaceId: string; name: string } | { kind: ShareKind; resourceId: string; title: string };

const VIEW_ONLY: ReadonlySet<string> = new Set(["meeting", "workspace", "code"]);

const KIND_LABEL: Record<ShareKind, string> = {
  page: "page",
  task: "task",
  board: "board",
  diagram: "diagram",
  plot_space: "plot space",
  plot: "plot",
  meeting: "meeting notes",
  skill: "skill",
  workspace: "workspace",
  code: "code",
};

const SPACE_GETS = ["Boards and tasks", "Pages", "Meeting notes", "Context", "Skills", "Runs and the workspace", "Code (view only)", "Diagrams and plots", "Weekly recap", "Needs me (view; only the runner answers)"];
const STAYS_PRIVATE = ["Today", "Metrics", "Settings", "Model keys", "Connected apps", "Your computers"];

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  return (
    <div className="flex items-center gap-2 text-2xs text-muted" title={`${used} of ${limit} ${label.toLowerCase()}`}>
      <span className="flex gap-0.5" aria-hidden>
        {Array.from({ length: limit }, (_, index) => (
          <span key={index} className={`h-1.5 w-3 rounded-sm ${index < used ? "bg-accent" : "bg-hover"}`} />
        ))}
      </span>
      <span>
        {used} of {limit} {label}
      </span>
    </div>
  );
}

export function RoleSelect<T extends string>({ value, options, onChange, disabled }: { value: T; options: Array<[T, string]>; onChange: (next: T) => void; disabled?: boolean }) {
  return (
    <span className="relative inline-flex items-center">
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
        className="appearance-none rounded-md border border-line bg-transparent py-1 pl-2 pr-6 text-[12px] text-ink hover:bg-hover disabled:opacity-60"
      >
        {options.map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
      <ChevronDown size={12} className="pointer-events-none absolute right-1.5 text-faint" />
    </span>
  );
}

/** People search: name or email; picks someone who already has an Ensemble account. */
export function PersonPicker({ onPick, exclude }: { onPick: (person: SharingPerson) => void; exclude: Set<string> }) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const q = useDebounced(query.trim(), 180);
  const results = useQuery({
    queryKey: ["sharing", "people", q],
    queryFn: () => api.searchPeople(q),
    enabled: q.length >= 2,
    staleTime: 30_000,
  });
  const rows = (results.data?.people ?? []).filter((row) => !exclude.has(row.id));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setCursor(0), [q]);
  const pick = (person: SharingPerson) => {
    onPick(person);
    setQuery("");
    input.current?.focus();
  };
  return (
    <div className="relative">
      <div className="flex items-center gap-2 rounded-lg border border-line-strong bg-bg px-2.5 focus-within:border-accent">
        <Search size={14} className="text-faint" />
        <input
          ref={input}
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setCursor((value) => Math.min(rows.length - 1, value + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((value) => Math.max(0, value - 1));
            } else if (event.key === "Enter" && rows[cursor]) {
              event.preventDefault();
              pick(rows[cursor]!);
            }
          }}
          placeholder="Add people by name or email"
          className="h-9 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
          aria-label="Search people"
          aria-autocomplete="list"
        />
      </div>
      {q.length >= 2 ? (
        <div className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-line-strong bg-raised shadow-pop" role="listbox">
          {results.isLoading ? <div className="px-3 py-2.5 text-[12px] text-muted">Searching…</div> : null}
          {results.isError ? <div className="px-3 py-2.5 text-[12px] text-danger">{(results.error as Error).message}</div> : null}
          {results.isSuccess && !rows.length ? (
            <div className="px-3 py-2.5 text-[12px] text-muted">
              Nobody on Ensemble matches “{q}”. They need an Ensemble account first; type their full email to be sure.
            </div>
          ) : null}
          {rows.map((row, index) => (
            <button
              key={row.id}
              type="button"
              role="option"
              aria-selected={index === cursor}
              onMouseEnter={() => setCursor(index)}
              onClick={() => pick(row)}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${index === cursor ? "bg-hover" : ""}`}
            >
              <Avatar person={row} color={colorFor(row.id)} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{row.name}</span>
                <span className="block truncate text-2xs text-muted">{row.email}</span>
              </span>
              {row.contact ? <span className="rounded-md bg-hover px-1.5 py-0.5 text-2xs text-muted">Contact</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type Row = { id: string; person: SharingPerson & { email?: string }; role: string; shareId?: string };

/**
 * Share a whole space (members, up to two) or one item (a page, a diagram…) with people who
 * have Ensemble accounts. Everyone you share with becomes a contact (up to five).
 */
export function ShareDialog({ open, onClose, target }: { open: boolean; onClose: () => void; target: ShareTarget }) {
  const client = useQueryClient();
  const toast = useToast();
  const space = target.kind === "space";
  const viewOnly = !space && VIEW_ONLY.has(target.kind);
  const [pending, setPending] = useState<SharingPerson | null>(null);
  const [role, setRole] = useState<string>(space ? "editor" : viewOnly ? "view" : "edit");
  const [showWhat, setShowWhat] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const contacts = useQuery({ queryKey: ["sharing", "contacts"], queryFn: api.contacts, enabled: open });
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const me = shell.data?.user;
  const myInitials = (me?.name ?? "You").trim().split(/\s+/).map((word) => word[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "Y";
  const members = useQuery({
    queryKey: ["space-members", space ? target.spaceId : ""],
    queryFn: () => api.spaceMembers((target as { spaceId: string }).spaceId),
    enabled: open && space,
  });
  const shares = useQuery({
    queryKey: ["item-shares", space ? "" : target.kind, space ? "" : (target as { resourceId: string }).resourceId],
    queryFn: () => api.itemShares(target.kind as ShareKind, (target as { resourceId: string }).resourceId),
    enabled: open && !space,
  });

  const rows: Row[] = useMemo(
    () =>
      space
        ? (members.data?.members ?? []).map((row) => ({ id: row.id, person: row, role: row.role }))
        : (shares.data?.shares ?? []).map((row) => ({ id: row.person.id, person: row.person, role: row.role, shareId: row.id })),
    [space, members.data, shares.data],
  );
  const limit = space ? (members.data?.limit ?? 2) : null;
  const full = limit !== null && rows.length >= limit;
  const contactLimit = contacts.data?.limit ?? 5;
  const contactIds = new Set((contacts.data?.contacts ?? []).map((row) => row.id));
  const contactsFull = (contacts.data?.contacts.length ?? 0) >= contactLimit;

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["space-members"] });
    void client.invalidateQueries({ queryKey: ["item-shares"] });
    void client.invalidateQueries({ queryKey: ["sharing"] });
    void client.invalidateQueries({ queryKey: ["shell"] });
  };
  const fail = (error: unknown) => toast((error as Error).message, { tone: "error" });

  const invite = useMutation({
    mutationFn: async (person: SharingPerson) => {
      if (space) await api.addMember(target.spaceId, person.id, role as MemberRole);
      else await api.shareItem({ kind: target.kind, resourceId: target.resourceId, personId: person.id, role: role as ItemRole });
      return person;
    },
    onSuccess: (person) => {
      setPending(null);
      refresh();
      toast(`Shared with ${person.name}. They'll see it under Shared with you.`, { tone: "ok" });
    },
    onError: fail,
  });
  const changeRole = useMutation({
    mutationFn: async ({ row, next }: { row: Row; next: string }) => {
      if (space) await api.setMemberRole(target.spaceId, row.id, next as MemberRole);
      else await api.setShareRole(row.shareId!, next as ItemRole);
    },
    onSuccess: refresh,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: async (row: Row) => {
      if (space) await api.removeMember(target.spaceId, row.id);
      else await api.removeShare(row.shareId!);
      return row;
    },
    onSuccess: (row) => {
      refresh();
      toast(`${row.person.name} no longer has access.`);
    },
    onError: fail,
  });

  const already = new Set(rows.map((row) => row.id));
  const roleOptions: Array<[string, string]> = space ? [["editor", "Can edit"], ["viewer", "Can view"]] : viewOnly ? [["view", "Can view"]] : [["edit", "Can edit"], ["view", "Can view"]];
  const blocked = pending && !contactIds.has(pending.id) && contactsFull;
  const name = space ? target.name : target.title || "Untitled";

  return (
    <Dialog open={open} onClose={onClose} title={space ? `Share ${name}` : `Share “${name}”`} width={540}>
      <div className="space-y-4">
        {pending ? (
          <div className="flex items-center gap-2 rounded-lg border border-line-strong bg-bg p-2">
            <Avatar person={pending} color={colorFor(pending.id)} size={30} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{pending.name}</div>
              <div className="truncate text-2xs text-muted">{pending.email}</div>
            </div>
            <RoleSelect value={role} options={roleOptions} onChange={setRole} disabled={viewOnly} />
            <button type="button" className="icon-btn" aria-label="Pick someone else" onClick={() => setPending(null)}>
              <X size={14} />
            </button>
          </div>
        ) : full ? (
          <div className="rounded-lg border border-line bg-panel px-3 py-2.5 text-[12.5px] text-muted">
            This space is shared with {limit} people, the most a space can have. Remove someone to add another.
          </div>
        ) : (
          <PersonPicker onPick={setPending} exclude={already} />
        )}
        {blocked ? (
          <p className="text-[12px] text-warn">
            Your contacts are full ({contactLimit} of {contactLimit}). Remove someone in Settings › Sharing first; that also takes back what you shared with them.
          </p>
        ) : null}
        {pending ? (
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={invite.isPending || Boolean(blocked)} onClick={() => invite.mutate(pending)}>
              <Share2 size={13} /> {invite.isPending ? "Sharing…" : "Share"}
            </button>
          </div>
        ) : null}

        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <h4 className="text-2xs font-medium uppercase tracking-wide text-faint">People with access</h4>
            {limit !== null ? <Meter label="members" used={rows.length} limit={limit} /> : null}
          </div>
          <div className="divide-y divide-line rounded-lg border border-line">
            <div className="flex items-center gap-2.5 px-3 py-2">
              <Avatar person={{ name: me?.name ?? "You", initials: myInitials, avatar: me?.avatar ?? null }} color={me ? colorFor(me.id) : undefined} size={28} />
              <div className="min-w-0 flex-1 text-[13px]">
                {me?.name ?? "You"} <span className="text-muted">(you)</span>
              </div>
              <span className="text-2xs text-muted">Owner</span>
            </div>
            {(space ? members.isLoading : shares.isLoading) ? <div className="px-3 py-2.5 text-[12px] text-muted">Loading…</div> : null}
            {rows.map((row) => (
              <div key={row.id} className="flex items-center gap-2.5 px-3 py-2">
                <Avatar person={row.person} color={colorFor(row.id)} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{row.person.name}</div>
                  {row.person.email ? <div className="truncate text-2xs text-muted">{row.person.email}</div> : null}
                </div>
                {row.shareId ? (
                  <button
                    type="button"
                    className="icon-btn"
                    title="Copy their link. It opens only for them."
                    aria-label={`Copy ${row.person.name}'s link`}
                    onClick={() => {
                      void navigator.clipboard.writeText(`${window.location.origin}/shared/${row.shareId}`);
                      setCopied(row.shareId!);
                      window.setTimeout(() => setCopied(null), 1500);
                    }}
                  >
                    {copied === row.shareId ? <Check size={14} /> : <Link2 size={14} />}
                  </button>
                ) : null}
                <RoleSelect value={row.role} options={roleOptions} disabled={viewOnly || changeRole.isPending} onChange={(next) => changeRole.mutate({ row, next })} />
                <button type="button" className="icon-btn" title="Remove access" aria-label={`Remove ${row.person.name}`} onClick={() => remove.mutate(row)} disabled={remove.isPending}>
                  <X size={14} />
                </button>
              </div>
            ))}
            {!rows.length && !(space ? members.isLoading : shares.isLoading) ? (
              <div className="px-3 py-2.5 text-[12px] text-muted">Only you, so far.</div>
            ) : null}
          </div>
        </section>

        <GeneralAccess target={target} />

        <section className="rounded-lg bg-panel px-3 py-2.5">
          <button type="button" className="flex w-full items-center justify-between text-left text-[12.5px] font-medium" onClick={() => setShowWhat((value) => !value)} aria-expanded={showWhat}>
            <span className="flex items-center gap-1.5">
              <Lock size={12} className="text-faint" />
              {space ? "What they get, and what stays yours" : `They see this ${KIND_LABEL[target.kind]} and nothing else`}
            </span>
            <ChevronDown size={13} className={`text-faint transition-transform ${showWhat ? "rotate-180" : ""}`} />
          </button>
          {showWhat ? (
            <div className="mt-2 grid grid-cols-2 gap-3 text-[12px]">
              <div>
                <div className="mb-1 text-2xs uppercase tracking-wide text-faint">Shared</div>
                <ul className="space-y-0.5 text-muted">
                  {(space ? SPACE_GETS : [`This ${KIND_LABEL[target.kind]}${viewOnly ? " (view only)" : ""}`, "Comments on it", "Who else is looking at it"]).map((line) => (
                    <li key={line} className="flex items-start gap-1.5">
                      <Check size={11} className="mt-0.5 shrink-0 text-ok" /> {line}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="mb-1 text-2xs uppercase tracking-wide text-faint">Private to you</div>
                <ul className="space-y-0.5 text-muted">
                  {(space ? STAYS_PRIVATE : ["Everything else in this space", ...STAYS_PRIVATE.slice(2)]).map((line) => (
                    <li key={line} className="flex items-start gap-1.5">
                      <Lock size={10} className="mt-0.5 shrink-0 text-faint" /> {line}
                    </li>
                  ))}
                </ul>
              </div>
              {space ? (
                <p className="col-span-2 text-2xs text-faint">
                  Agent runs go to the computer of whoever starts them, and only they can answer its questions or stop it. Code stays view-only for everyone but you.
                </p>
              ) : null}
            </div>
          ) : null}
        </section>

        <div className="flex items-center justify-between border-t border-line pt-3">
          <Meter label="contacts" used={contacts.data?.contacts.length ?? 0} limit={contactLimit} />
          <a href="/settings?tab=sharing" className="flex items-center gap-1 text-2xs text-muted hover:text-ink">
            Manage contacts
          </a>
        </div>
      </div>
    </Dialog>
  );
}

const PUBLIC_KINDS: ReadonlySet<string> = new Set(["page", "task", "diagram", "meeting"]);

/**
 * "Anyone with the link": open one page, task, diagram or meeting notes to people without an
 * account. Whole spaces, boards, code and runs never.
 */
function GeneralAccess({ target }: { target: ShareTarget }) {
  const client = useQueryClient();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const itemKind = target.kind === "space" ? null : target.kind;
  const allowed = Boolean(itemKind && PUBLIC_KINDS.has(itemKind));
  const resourceId = target.kind === "space" ? "" : target.resourceId;
  const state = useQuery({
    queryKey: ["public-link", itemKind, resourceId],
    queryFn: () => api.publicLinkFor(itemKind as ShareKind, resourceId),
    enabled: allowed,
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["public-link"] });
    void client.invalidateQueries({ queryKey: ["public-links"] });
  };
  const fail = (error: unknown) => toast((error as Error).message, { tone: "error" });
  const setLink = useMutation({ mutationFn: (role: ItemRole) => api.setPublicLink({ kind: itemKind as ShareKind, resourceId, role }), onSuccess: refresh, onError: fail });
  const remove = useMutation({ mutationFn: (id: string) => api.removePublicLink(id), onSuccess: () => { refresh(); toast("The link is off. Nobody can open it now."); }, onError: fail });
  const rotate = useMutation({ mutationFn: (id: string) => api.rotatePublicLink(id), onSuccess: () => { refresh(); toast("New link made. The old one stopped working.", { tone: "ok" }); }, onError: fail });

  if (target.kind === "space") {
    return (
      <section className="flex items-start gap-2.5 rounded-lg border border-line px-3 py-2.5 text-[12.5px] text-muted">
        <Lock size={14} className="mt-0.5 shrink-0 text-faint" />
        <span>A whole space can't be opened to anyone with a link. To share something publicly, open a page, task, diagram or meeting notes and use its Share button.</span>
      </section>
    );
  }
  if (!allowed) return null;
  const link = state.data?.link ?? null;
  const viewOnly = target.kind === "meeting";
  const full = !link && (state.data?.used ?? 0) >= (state.data?.limit ?? 5);
  const copy = (token: string) => {
    void navigator.clipboard.writeText(publicLinkUrl(token));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between">
        <h4 className="text-2xs font-medium uppercase tracking-wide text-faint">General access</h4>
        {state.data ? <Meter label="public links" used={state.data.used} limit={state.data.limit} /> : null}
      </div>
      <div className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2">
        <span className={`grid size-7 shrink-0 place-items-center rounded-full ${link ? "bg-accent-soft text-ink" : "bg-hover text-muted"}`}>
          {link ? <Globe size={14} /> : <Lock size={13} />}
        </span>
        <div className="min-w-0 flex-1">
          <RoleSelect
            value={link ? "anyone" : "restricted"}
            options={[["restricted", "Only people you add"], ["anyone", "Anyone with the link"]]}
            disabled={state.isLoading || setLink.isPending || remove.isPending || (full && !link)}
            onChange={(next) => (next === "anyone" ? setLink.mutate("view") : link ? remove.mutate(link.id) : undefined)}
          />
          <div className="mt-0.5 text-2xs text-muted">
            {link
              ? `No account needed. ${link.opens ? `Opened ${link.opens} time${link.opens === 1 ? "" : "s"}.` : "Not opened yet."}`
              : full
                ? "You have 5 public links. Turn one off in Settings › Sharing to make another."
                : "Only the people above can open it."}
          </div>
        </div>
        {link ? (
          <>
            <RoleSelect
              value={link.role}
              options={viewOnly ? [["view", "Can view"]] : [["view", "Can view"], ["edit", "Can edit"]]}
              disabled={viewOnly || setLink.isPending}
              onChange={(next) => setLink.mutate(next as ItemRole)}
            />
            <button type="button" className="icon-btn" title="Make a new link (the old one stops working)" aria-label="Make a new link" onClick={() => rotate.mutate(link.id)} disabled={rotate.isPending}>
              <RefreshCw size={13} />
            </button>
            <button type="button" className="btn h-7 gap-1.5 px-2.5 text-[12.5px]" onClick={() => copy(link.token)}>
              {copied ? <Check size={13} /> : <Link2 size={13} />} {copied ? "Copied" : "Copy link"}
            </button>
          </>
        ) : null}
      </div>
      {link?.role === "edit" ? (
        <p className="mt-1.5 text-2xs text-faint">Anyone with the link can change this {target.kind}'s content without signing in. They show up with a creature name.</p>
      ) : null}
    </section>
  );
}

/** The "Share" button on a page, diagram, board… Only the space's owner shares. */
export function ShareButton({ target, compact = false }: { target: ShareTarget; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  if (!shell.data || shell.data.space?.shared) return null;
  return (
    <>
      <button
        type="button"
        className={compact ? "icon-btn" : "btn h-7 gap-1.5 px-2.5 text-[12.5px]"}
        onClick={() => setOpen(true)}
        aria-label="Share"
        title="Share with someone on Ensemble"
      >
        <Share2 size={compact ? 15 : 13} />
        {compact ? null : "Share"}
      </button>
      {open ? <ShareDialog open={open} onClose={() => setOpen(false)} target={target} /> : null}
    </>
  );
}
