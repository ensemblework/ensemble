"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Eye, Info, LocateFixed, Users } from "lucide-react";
import { api, type PresenceEntry, type SharingPerson } from "@/lib/api";
import { followStore, useFollowing } from "@/lib/follow";
import { distinctInitials, personInitials } from "@/lib/initials";
import { hrefOf, people, placeOf, usePresence } from "@/lib/presence";
import { Popover } from "@/components/ui";
import { useToast } from "@/components/toast";
import { PersonaAvatar } from "@/components/avatars/persona";

/**
 * A person: their picture avatar, an anonymous visitor's creature, or initials in their colour.
 * `ring` marks someone live right now. `stacked` draws a gap in the page colour, so circles that
 * overlap in a row keep their initials readable.
 */
export function Avatar({
  person,
  color,
  size = 24,
  ring = false,
  stacked = false,
  title,
}: {
  person: Pick<SharingPerson, "name"> & { initials?: string; avatar?: string | null; emoji?: string | null };
  color?: string;
  size?: number;
  ring?: boolean;
  stacked?: boolean;
  title?: string;
}) {
  const tint = color ?? "var(--ink)";
  const gap = stacked ? "0 0 0 1.5px var(--bg)" : undefined;
  const shadow = ring ? `0 0 0 2px var(--bg), 0 0 0 3.5px ${tint}` : gap;
  if (person.avatar) {
    return (
      <span title={title ?? person.name} aria-label={person.name} className="inline-flex shrink-0 rounded-full" style={{ width: size, height: size, boxShadow: shadow }}>
        <PersonaAvatar id={person.avatar} size={size} />
      </span>
    );
  }
  if (person.emoji) {
    return (
      <span
        title={title ?? person.name}
        aria-label={person.name}
        className="inline-flex shrink-0 select-none items-center justify-center rounded-full leading-none"
        style={{
          width: size,
          height: size,
          fontSize: Math.round(size * 0.58),
          background: `color-mix(in srgb, ${tint} 22%, var(--raised))`,
          boxShadow: ring ? shadow : [gap, `inset 0 0 0 1.5px ${tint}`].filter(Boolean).join(", "),
        }}
      >
        {person.emoji}
      </span>
    );
  }
  const initials = person.initials || personInitials(person.name);
  return (
    <span
      title={title ?? person.name}
      aria-label={person.name}
      className="inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none text-white"
      style={{
        width: size,
        height: size,
        fontSize: initials.length > 2 ? Math.max(8, Math.round(size * 0.34)) : Math.max(9, Math.round(size * 0.4)),
        background: color ? tint : "color-mix(in srgb, var(--ink) 45%, var(--bg))",
        boxShadow: shadow,
      }}
    >
      {initials}
    </span>
  );
}

const STACK_MAX = 4;

/**
 * Up to four live avatars, then "+N" for the rest, as the top bar and item headers show them.
 * Each circle names its person on hover, and the chip names the people it stands for.
 */
export function PresenceStack({
  entries,
  size,
  ringed,
  describe,
}: {
  entries: PresenceEntry[];
  size: number;
  ringed: (entry: PresenceEntry) => boolean;
  describe: (entry: PresenceEntry) => string;
}) {
  const shown = entries.slice(0, STACK_MAX);
  const hidden = entries.slice(STACK_MAX);
  const initials = distinctInitials(shown);
  return (
    <>
      <span className="flex -space-x-0.5">
        {shown.map((entry, index) => (
          <span key={entry.accountId} className="relative">
            <Avatar person={{ ...entry, initials: initials[index] }} color={entry.color} size={size} ring={ringed(entry)} stacked title={describe(entry)} />
            {entry.typing ? <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 animate-pulse rounded-full border border-bg" style={{ background: entry.color }} /> : null}
          </span>
        ))}
      </span>
      {hidden.length ? (
        <span className="ml-1 text-2xs text-muted" title={hidden.map(describe).join("\n")}>
          +{hidden.length}
        </span>
      ) : null}
    </>
  );
}

const FOCUSABLE = "button:not([disabled]), a[href]";

/**
 * The inside of a people popover. Focus moves in when it opens, the arrow keys and Tab move
 * between its buttons, and focus returns to the chip that opened it when it closes (the popover
 * itself closes on Esc and outside clicks).
 */
export function PeoplePanel({ label, opener, children }: { label: string; opener: RefObject<HTMLElement | null>; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = panel.current;
    // The popover is placed, and only then visible, in the render after this one.
    const frame = window.requestAnimationFrame(() => (node?.querySelector<HTMLElement>(FOCUSABLE) ?? node)?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      const active = document.activeElement;
      if (!active || active === document.body || node?.contains(active)) opener.current?.focus();
    };
  }, [opener]);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Tab"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const back = event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : back ? (at <= 0 ? items.length - 1 : at - 1) : (at + 1) % items.length;
    items[next]!.focus();
  };
  return (
    <div ref={panel} role="dialog" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown} className="py-1 outline-none">
      {children}
    </div>
  );
}

/** One person in Here now: go to them, follow them, or, for someone on one shared item, why there is no Follow. */
function HereRow({ entry, followed, onGo, close }: { entry: PresenceEntry; followed: boolean; onGo: (href: string) => void; close: () => void }) {
  const href = hrefOf(entry);
  const place = `${entry.typing ? "Editing" : "On"} ${placeOf(entry)}`;
  const person = (
    <>
      <Avatar person={entry} color={entry.color} size={26} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{entry.name}</span>
        <span className="block truncate text-2xs text-muted">{place}</span>
      </span>
    </>
  );
  const noFollow = `Follow is for people working in this space. ${entry.name} has only ${placeOf(entry)} open${href ? ", and Go to opens it" : ""}.`;
  return (
    <div className="flex items-center gap-1 px-1">
      {href ? (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1.5 text-left hover:bg-hover focus-visible:bg-hover"
          title={`Go to ${entry.name}`}
          aria-label={`Go to ${entry.name}. ${place}`}
          onClick={() => {
            onGo(href);
            close();
          }}
        >
          {person}
          <span className="flex shrink-0 items-center gap-1 text-2xs text-muted" aria-hidden>
            <LocateFixed size={12} /> Go to
          </span>
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1.5">{person}</div>
      )}
      {entry.route ? (
        <button
          type="button"
          className="shrink-0 rounded-md border border-line px-2 py-0.5 text-2xs font-medium hover:bg-hover"
          style={followed ? { borderColor: entry.color, color: entry.color } : undefined}
          aria-pressed={followed}
          aria-label={followed ? `Stop following ${entry.name}` : `Follow ${entry.name}`}
          title={followed ? `Stop following ${entry.name}` : `Follow ${entry.name} wherever they go in this space`}
          onClick={() => {
            if (followed) followStore.stop();
            else followStore.start({ accountId: entry.accountId, name: entry.name, color: entry.color });
            close();
          }}
        >
          {followed ? "Following" : "Follow"}
        </button>
      ) : (
        <span className="grid size-6 shrink-0 place-items-center text-faint" title={noFollow}>
          <Info size={13} aria-hidden />
          <span className="sr-only">{noFollow}</span>
        </span>
      )}
    </div>
  );
}

/** Who else is in this shared space right now. Click someone to go to them or follow them. */
export function SpacePeople() {
  const router = useRouter();
  const here = people(usePresence());
  const following = useFollowing();
  const chip = useRef<HTMLButtonElement>(null);
  if (!here.length) return null;
  return (
    <Popover
      align="right"
      width={300}
      trigger={(open, toggle) => (
        <button
          ref={chip}
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={`Here now: ${here.map((entry) => entry.name).join(", ")}`}
          className="mr-1 flex items-center rounded-md px-1 py-0.5 hover:bg-hover"
        >
          <PresenceStack
            entries={here}
            size={22}
            ringed={(entry) => following?.accountId === entry.accountId}
            describe={(entry) => `${entry.name}, ${entry.typing ? "editing" : "on"} ${placeOf(entry)}`}
          />
        </button>
      )}
    >
      {(close) => (
        <PeoplePanel label="Here now" opener={chip}>
          <div className="flex items-center gap-1.5 px-2 pb-1.5 pt-0.5 text-2xs font-medium uppercase tracking-wide text-faint">
            <Users size={11} /> Here now
          </div>
          {here.map((entry) => (
            <HereRow key={entry.accountId} entry={entry} followed={following?.accountId === entry.accountId} onGo={(href) => router.push(href)} close={close} />
          ))}
        </PeoplePanel>
      )}
    </Popover>
  );
}

/**
 * "Shared by Mira Chen · Can edit", in the top bar of a space someone shared with you. Text rather
 * than another avatar: the owner's live avatar can sit in the same bar.
 */
export function SharedBadge() {
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const shared = shell.data?.space?.shared;
  if (!shared) return null;
  return (
    <span
      className="hidden shrink-0 items-center gap-1.5 rounded-md border border-line bg-panel px-1.5 py-0.5 text-2xs text-muted md:inline-flex"
      title={`${shared.owner.name} shared this space with you. You ${shared.role === "editor" ? "can edit" : "can view"} it. Your settings, keys and metrics stay your own.`}
    >
      <span className="max-w-[180px] truncate">
        Shared by <span className="text-ink">{shared.owner.name}</span>
      </span>
      <span className="text-faint">·</span>
      <span>{shared.role === "editor" ? "Can edit" : "Can view"}</span>
    </span>
  );
}

/**
 * Keeps you with the person you follow: goes where they go, frames the window in their colour,
 * and stops when you move on your own, press Esc, or they leave.
 */
export function FollowHost() {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const search = useSearchParams();
  const toast = useToast();
  const following = useFollowing();
  const list = usePresence();
  const target = following ? people(list).find((entry) => entry.accountId === following.accountId) : undefined;
  const expected = useRef<string | null>(null);
  const here = `${pathname}${search?.toString() ? `?${search.toString()}` : ""}`;

  useEffect(() => {
    if (!following) {
      expected.current = null;
      return;
    }
    if (!target) {
      // A reload or a moment offline looks like leaving: wait before giving up.
      const timer = window.setTimeout(() => {
        toast(`${following.name} left this space.`);
        followStore.stop();
      }, 10_000);
      return () => window.clearTimeout(timer);
    }
    if (target.route) {
      expected.current = target.route;
      if (target.route !== here) router.push(target.route);
    }
    // `here` is left out on purpose: your own navigation is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [following, target?.route, target === undefined]);

  // You went somewhere they are not: you stopped following.
  useEffect(() => {
    if (!following || !expected.current) return;
    if (here !== expected.current && target?.route !== here) followStore.stop();
    else expected.current = here;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here]);

  useEffect(() => {
    if (!following) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") followStore.stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [following]);

  if (!following) return null;
  return (
    <>
      <div className="pointer-events-none fixed inset-0 z-[60] rounded-[3px]" style={{ boxShadow: `inset 0 0 0 2px ${following.color}` }} aria-hidden />
      <div className="fixed left-1/2 top-[52px] z-[61] flex -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1 text-[12px] font-medium text-white shadow-pop" style={{ background: following.color }}>
        <Eye size={13} aria-hidden />
        <span className="max-w-[240px] truncate">Following {following.name}</span>
        <button type="button" className="rounded-full bg-white/20 px-2 py-0.5 text-2xs hover:bg-white/30" onClick={() => followStore.stop()}>
          Stop · Esc
        </button>
      </div>
    </>
  );
}
