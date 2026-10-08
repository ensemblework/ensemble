"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Plus, Settings2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { TEMPLATE_CARDS } from "@ensemble/shared-types/manifest";
import { api, type SpaceSummary } from "@/lib/api";
import { followSpaceSwitches, spaceInitial, switchSpace } from "@/lib/spaces";
import { Splash } from "@/components/motion/skeletons";
import { useToast } from "../toast";
import { Popover, cx } from "../ui";

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

function SpaceMenu({ shell, onPick, close }: { shell: Shell | undefined; onPick: (id: string) => void; close: () => void }) {
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
              onPick(space.id);
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
      <div className="my-1 border-t border-line" />
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
  const current = shell.data?.space;
  const currentId = useRef(current?.id);
  currentId.current = current?.id;
  useEffect(() => followSpaceSwitches(() => currentId.current), []);

  const go = async (id: string) => {
    if (id === current?.id) return;
    setSwitching(true);
    try {
      await switchSpace(id);
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
            <span className="sidebar-label min-w-0 flex-1 truncate text-left text-[13.5px] font-semibold text-ink">{label}</span>
            <ChevronsUpDown size={13} className="sidebar-label shrink-0 text-faint" />
          </button>
        )}
      >
        {(close) => <SpaceMenu shell={shell.data} close={close} onPick={(id) => void go(id)} />}
      </Popover>
      <Splash active={switching} />
    </>
  );
}
