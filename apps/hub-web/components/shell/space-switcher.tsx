"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Plus, Settings2, Share2, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { TEMPLATE_CARDS } from "@ensemble/shared-types/manifest";
import { api, type SpaceSummary } from "@/lib/api";
import { followSpaceSwitches, spaceInitial, switchSpace } from "@/lib/spaces";
import { Splash } from "@/components/motion/skeletons";
import { useToast } from "../toast";
import { Popover, cx } from "../ui";
import { Avatar } from "../sharing/people";
import { ShareDialog } from "../sharing/share-dialog";

export function SpaceIcon({ space, size = 22, className }: { space: Pick<SpaceSummary, "name" | "icon">; size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx("space-icon", className)}
      style={{ width: size, height: size, fontSize: space.icon ? size * 0.62 : size * 0.5 }}
    >
      {space.icon || spaceInitial(space.name)}
    </span>
  );
}

const templateName = (id: string | null) => TEMPLATE_CARDS.find((card) => card.id === id)?.name ?? null;

type Shell = Awaited<ReturnType<typeof api.shell>>;

/** A space shared with you: the owner's avatar sits on its icon. */
function SharedMark({ space, owner }: { space: Pick<SpaceSummary, "name" | "icon">; owner: { name: string; initials: string } }) {
  return (
    <span className="relative shrink-0">
      <SpaceIcon space={space} size={26} />
      <span className="absolute -bottom-1 -right-1 rounded-full ring-2 ring-raised">
        <Avatar person={owner} size={14} />
      </span>
    </span>
  );
}

function SpaceMenu({ shell, onPick, close, onShare }: { shell: Shell | undefined; onPick: (id: string, shared: boolean) => void; close: () => void; onShare: () => void }) {
  const router = useRouter();
  const spaces = useQuery({ queryKey: ["spaces"], queryFn: api.spaces, staleTime: 30_000 });
  const current = shell?.space;
  const list = spaces.data?.spaces ?? (current ? [{ ...current, role: null, templateId: null, createdAt: "" }] : []);
  return (
    <div role="menu" aria-label="Spaces" className="p-1" data-space-menu>
      <div className="truncate px-2 pb-1 pt-1.5 text-[11.5px] text-faint">{shell?.user?.email || "Your spaces"}</div>
      {list.map((space) => {
        const active = space.id === current?.id;
        const sub = templateName(space.templateId);
        return (
          <button
            key={space.id}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            data-space={space.id}
            className={cx("row-tile flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left", active && "bg-hover")}
            onClick={() => {
              close();
              onPick(space.id, false);
            }}
          >
            <SpaceIcon space={space} size={26} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink">{space.name}</span>
              {sub ? <span className="block truncate text-[11.5px] text-faint">{sub}</span> : null}
            </span>
            {active ? <Check size={14} className="shrink-0 text-ink" /> : null}
          </button>
        );
      })}
      {spaces.isLoading ? <div className="skeleton mx-2 my-1 h-8 rounded-md" /> : null}
      {spaces.data?.shared?.length ? (
        <>
          <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[11.5px] text-faint">
            <Users size={11} /> Shared with you
          </div>
          {spaces.data.shared.map((space) => {
            const active = space.id === current?.id;
            return (
              <button
                key={space.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                data-space={space.id}
                className={cx("row-tile flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left", active && "bg-hover")}
                onClick={() => {
                  close();
                  onPick(space.id, true);
                }}
              >
                <SharedMark space={space} owner={space.owner} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-ink">{space.name}</span>
                    <span className="shrink-0 rounded border border-line px-1 text-[10px] leading-4 text-faint">Shared</span>
                  </span>
                  <span className="block truncate text-[11.5px] text-faint">
                    {space.owner.name} · {space.role === "editor" ? "can edit" : "can view"}
                  </span>
                </span>
                {active ? <Check size={14} className="shrink-0 text-ink" /> : null}
              </button>
            );
          })}
        </>
      ) : null}
      <div className="my-1 border-t border-line" />
      {current && !current.shared ? (
        <button type="button" role="menuitem" className="row-tile flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-ink" onClick={() => { close(); onShare(); }}>
          <span className="grid size-[26px] place-items-center text-muted"><Share2 size={14} /></span>
          Share {current.name}…
          {current.members ? <span className="ml-auto text-2xs text-faint">{current.members} of 2</span> : null}
        </button>
      ) : null}
      <button type="button" role="menuitem" data-new-space className="row-tile flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-ink" onClick={() => { close(); router.push("/spaces/new"); }}>
        <span className="grid size-[26px] place-items-center rounded-md border border-dashed border-line-strong text-muted"><Plus size={14} /></span>
        New space
      </button>
      <button type="button" role="menuitem" className="row-tile flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-muted" onClick={() => { close(); router.push("/settings?tab=spaces"); }}>
        <span className="grid size-[26px] place-items-center"><Settings2 size={14} /></span>
        Manage spaces
      </button>
    </div>
  );
}

/** Top of the sidebar: the open space, and every other space one click away. */
export function SpaceSwitcher() {
  const toast = useToast();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const [switching, setSwitching] = useState(false);
  const [sharing, setSharing] = useState(false);
  const current = shell.data?.space;
  const currentId = useRef(current?.id);
  currentId.current = current?.id;
  useEffect(() => followSpaceSwitches(() => currentId.current), []);

  const go = async (id: string, shared: boolean) => {
    if (id === current?.id) return;
    setSwitching(true);
    try {
      // Today is the owner's own; a space shared with you opens on its board.
      await switchSpace(id, shared ? "/board" : "/today");
    } catch (error) {
      setSwitching(false);
      toast((error as Error).message, { tone: "error" });
    }
  };

  const label = current?.name ?? "";
  return (
    <>
      <Popover
        align="left"
        width={272}
        className="space-switcher-wrap"
        fill
        trigger={(open, toggle) => (
          <button
            type="button"
            className="space-switcher sidebar-brand"
            aria-label={label ? `Space: ${label}. Switch space` : "Switch space"}
            aria-haspopup="menu"
            aria-expanded={open}
            title={label || "Switch space"}
            data-space-switcher
            onClick={toggle}
          >
            {current ? <SpaceIcon space={current} /> : <span className="space-icon skeleton" style={{ width: 22, height: 22 }} />}
            <span className="sidebar-label min-w-0 flex-1 truncate text-left text-[13.5px] font-semibold text-ink">
              {label}
              {current?.shared ? <span className="ml-1 font-normal text-faint">(shared)</span> : null}
            </span>
            <ChevronsUpDown size={13} className="sidebar-label shrink-0 text-faint" />
          </button>
        )}
      >
        {(close) => <SpaceMenu shell={shell.data} close={close} onPick={(id, shared) => void go(id, shared)} onShare={() => setSharing(true)} />}
      </Popover>
      {sharing && current ? <ShareDialog open onClose={() => setSharing(false)} target={{ kind: "space", spaceId: current.id, name: current.name }} /> : null}
      <Splash active={switching} />
    </>
  );
}
