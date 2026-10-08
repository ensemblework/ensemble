"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, Check, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { TEMPLATE_CARDS } from "@ensemble/shared-types/manifest";
import { api, type SpaceSummary, type SpacesPayload } from "@/lib/api";
import { announceSpace, enterSpace, SPACE_ICONS, spaceInitial, switchSpace } from "@/lib/spaces";
import { SpaceIcon } from "../shell/space-switcher";
import { useToast } from "../toast";
import { Dialog, Popover, SectionCard, SettingRow, Toggle } from "../ui";

const templateName = (id: string | null) => TEMPLATE_CARDS.find((card) => card.id === id)?.name ?? null;

function SpaceRow({ space, active, onChanged, onDelete }: { space: SpaceSummary; active: boolean; onChanged: () => void; onDelete: (space: SpaceSummary) => void }) {
  const toast = useToast();
  const [name, setName] = useState(space.name);
  const save = useMutation({
    mutationFn: (data: { name?: string; icon?: string | null }) => api.updateSpace(space.id, data),
    onSuccess: onChanged,
    onError: (error) => {
      setName(space.name);
      toast((error as Error).message, { tone: "error" });
    },
  });
  const sub = templateName(space.templateId);
  return (
    <div className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0" data-space-row={space.id}>
      <Popover
        width={232}
        trigger={(open, toggle) => (
          <button type="button" className="rounded-md hover:bg-hover" aria-label={`Change the icon for ${space.name}`} aria-expanded={open} onClick={toggle}>
            <SpaceIcon space={{ name, icon: space.icon }} size={32} />
          </button>
        )}
      >
        {(close) => (
          <div className="space-icon-grid p-2" role="radiogroup" aria-label="Icon">
            <button type="button" role="radio" aria-checked={!space.icon} title="Use the first letter" onClick={() => { close(); save.mutate({ icon: null }); }}>
              {spaceInitial(name)}
            </button>
            {SPACE_ICONS.map((emoji) => (
              <button key={emoji} type="button" role="radio" aria-checked={space.icon === emoji} onClick={() => { close(); save.mutate({ icon: emoji }); }}>
                {emoji}
              </button>
            ))}
          </div>
        )}
      </Popover>
      <div className="min-w-0 flex-1">
        <input
          aria-label={`Name of ${space.name}`}
          className="w-full rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-[14px] font-medium text-ink hover:border-line focus:border-line-strong focus:outline-none"
          value={name}
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => {
            const next = name.trim();
            if (!next) setName(space.name);
            else if (next !== space.name) save.mutate({ name: next });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setName(space.name);
              event.currentTarget.blur();
            }
          }}
        />
        <div className="px-1.5 text-[12px] text-faint">
          {[space.primary ? "Your first space" : null, sub].filter(Boolean).join(" · ") || "Space"}
        </div>
      </div>
      {active ? (
        <span className="flex items-center gap-1 text-[12.5px] text-muted"><Check size={13} /> Open</span>
      ) : (
        <button type="button" className="btn" onClick={() => void switchSpace(space.id, "/settings?tab=spaces")}>
          <ArrowRightLeft size={13} />
          Open
        </button>
      )}
      {space.primary ? (
        <span className="w-[30px]" />
      ) : (
        <button type="button" className="icon-btn" aria-label={`Delete ${space.name}`} title="Delete space" onClick={() => onDelete(space)}>
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

/** Settings → Spaces. The list is the account's; the settings controls act on the open space. */
export function SpacesTab() {
  const client = useQueryClient();
  const toast = useToast();
  const spaces = useQuery({ queryKey: ["spaces"], queryFn: api.spaces });
  const data = spaces.data;
  const [doomed, setDoomed] = useState<SpaceSummary | null>(null);
  const [confirm, setConfirm] = useState("");
  const [from, setFrom] = useState<string>("");
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["spaces"] });
    void client.invalidateQueries({ queryKey: ["shell"] });
  };
  const others = (data?.spaces ?? []).filter((row) => row.id !== data?.activeId);
  const source = from || others[0]?.id || "";
  const current = data?.spaces.find((row) => row.id === data.activeId);

  const sync = useMutation({
    mutationFn: (on: boolean) => api.syncSpaceSettings(on),
    onMutate: (on) => client.setQueryData<SpacesPayload>(["spaces"], (old) => (old ? { ...old, account: { ...old.account, sync: on } } : old)),
    onSuccess: (_result, on) => {
      toast(on ? `Every space now uses ${current?.name ?? "this space"}'s settings.` : "Each space keeps its own settings from now on.", { tone: "ok" });
      void client.invalidateQueries();
    },
    onError: (error) => {
      refresh();
      toast((error as Error).message, { tone: "error" });
    },
  });
  const copy = useMutation({
    mutationFn: () => api.copySpaceSettings(source),
    onSuccess: () => {
      toast(`Copied settings from ${data?.spaces.find((row) => row.id === source)?.name ?? "that space"}.`, { tone: "ok" });
      void client.invalidateQueries();
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteSpace(doomed!.id, confirm),
    onSuccess: () => {
      const wasOpen = doomed?.id === data?.activeId;
      setDoomed(null);
      setConfirm("");
      if (wasOpen) {
        // The server reopened the first space for every tab; tell the others before leaving.
        const first = data?.spaces.find((row) => row.primary)?.id;
        if (first) announceSpace(first);
        enterSpace("/today");
      }
      else {
        toast("Space deleted.", { tone: "ok" });
        refresh();
      }
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });

  return (
    <div className="space-y-4" data-settings-spaces>
      <SectionCard
        title="Spaces"
        description="Separate lines of work. Each space has its own tasks, pages, people, files, connected apps, assistant history and settings. Nothing is shared between them."
        actions={
          <Link href="/spaces/new" className="btn">
            <Plus size={13} />
            New space
          </Link>
        }
      >
        {spaces.isLoading ? <div className="skeleton h-24 rounded-md" /> : null}
        {(data?.spaces ?? []).map((space) => (
          <SpaceRow key={`${space.id}-${space.name}-${space.icon}`} space={space} active={space.id === data?.activeId} onChanged={refresh} onDelete={(row) => { setDoomed(row); setConfirm(""); }} />
        ))}
      </SectionCard>

      <SectionCard title="Settings across spaces" description="Theme, models and API keys, keyboard shortcuts, quiet hours, retention and time zone. Connected apps, code folders and data always stay in their own space.">
        <SettingRow
          title="Keep every space in sync"
          description={data?.account.sync ? "On. A change in any space is copied to the others." : `Turning this on copies ${current?.name ?? "this space"}'s settings to every other space.`}
        >
          <Toggle checked={data?.account.sync === true} disabled={!data || sync.isPending} label="Keep every space in sync" onChange={(on) => sync.mutate(on)} />
        </SettingRow>
        {!data?.account.sync && others.length ? (
          <SettingRow title="Copy settings into this space" description="A one-time copy. Later changes stay in their own space.">
            <div className="flex items-center gap-2">
              <select className="field py-1 text-[13px]" value={source} onChange={(event) => setFrom(event.target.value)} aria-label="Copy settings from">
                {others.map((row) => (
                  <option key={row.id} value={row.id}>{row.name}</option>
                ))}
              </select>
              <button type="button" className="btn" disabled={!source || copy.isPending} onClick={() => copy.mutate()}>
                {copy.isPending ? "Copying…" : "Copy"}
              </button>
            </div>
          </SettingRow>
        ) : null}
      </SectionCard>

      <Dialog open={Boolean(doomed)} onClose={() => setDoomed(null)} title={`Delete ${doomed?.name ?? "space"}?`} width={440}>
        <p className="text-[13.5px] leading-5 text-muted">
          This deletes every task, page, person, file, connected app and conversation in this space. Your other spaces are not touched. It cannot be undone.
        </p>
        <label className="mt-4 block text-[13px] font-medium">
          Type <b>{doomed?.name}</b> to confirm
          <input autoFocus className="field mt-1.5 w-full" value={confirm} onChange={(event) => setConfirm(event.target.value)} aria-label="Space name" />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={() => setDoomed(null)}>Cancel</button>
          <button type="button" className="btn text-danger" disabled={confirm.trim() !== doomed?.name.trim() || remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending ? "Deleting…" : "Delete space"}
          </button>
        </div>
      </Dialog>
    </div>
  );
}
