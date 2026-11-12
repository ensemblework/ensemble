"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Eye, Info, LocateFixed, Users } from "lucide-react";
import { api, type PresenceEntry, type SharingPerson } from "@/lib/api";
import { followStore, useFollowing } from "@/lib/follow";
import { distinctInitials, personInitials } from "@/lib/initials";
import { hrefOf, isGuest, people, placeOf, presenceStore, roleLabel, statusOf, usePresence } from "@/lib/presence";
import { resourceOf } from "./presence-host";
import { Popover } from "@/components/ui";
import { useToast } from "@/components/toast";
import { PersonaAvatar } from "@/components/avatars/persona";
import { parseAvatar } from "@ensemble/shared-types";

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
  dim = false,
  title,
}: {
  person: Pick<SharingPerson, "name"> & { initials?: string; avatar?: string | null; emoji?: string | null };
  color?: string;
  size?: number;
  ring?: boolean;
  stacked?: boolean;
  /** Faded: their tab is in the background. */
  dim?: boolean;
  /** Hover text; `""` leaves it to a tooltip around the avatar. */
  title?: string;
}) {
  const tint = color ?? "var(--ink)";
  const gap = stacked ? "0 0 0 1.5px var(--bg)" : undefined;
  const shadow = ring ? `0 0 0 2px var(--bg), 0 0 0 3.5px ${tint}` : gap;
  const faded = dim ? { opacity: 0.5, filter: "saturate(0.4)" } : undefined;
  if (person.avatar && parseAvatar(person.avatar)) {
    return (
      <span title={title ?? person.name} aria-label={person.name} className="inline-flex shrink-0 rounded-full" style={{ width: size, height: size, boxShadow: shadow, ...faded }}>
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
          ...faded,
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
        ...faded,
      }}
    >
      {initials}
    </span>
  );
}

const STACK_MAX = 4;

/** Motion is off in the OS or in Settings › Appearance (`data-reduce-motion`, lib/prefs.ts). */
function reducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  return document.documentElement.dataset.reduceMotion === "true" || Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

// Web Animations rather than a stylesheet: these components render in node tests too.
function animateIn(node: HTMLElement | null): void {
  if (!node || reducedMotion() || typeof node.animate !== "function") return;
  // A fade-out that filled forwards would otherwise win once this one ends.
  for (const running of node.getAnimations?.() ?? []) running.cancel();
  node.animate([{ opacity: 0, transform: "scale(0.6)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
}
function animateOut(node: HTMLElement | null): void {
  if (!node || reducedMotion() || typeof node.animate !== "function") return;
  node.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.6)" }], { duration: 150, easing: "ease-in", fill: "forwards" });
}

const LEAVE_MS = 160;

/** The people in a stack plus, for a moment, those who just left, in the places they had, so they fade out. */
export function useWithLeaving(entries: PresenceEntry[]): Array<{ entry: PresenceEntry; leaving: boolean }> {
  const [leaving, setLeaving] = useState<Array<{ entry: PresenceEntry; index: number }>>([]);
  const last = useRef<PresenceEntry[]>(entries);
  const ids = entries.map((entry) => entry.accountId).join("|");
  useEffect(() => {
    const here = new Set(entries.map((entry) => entry.accountId));
    const left = reducedMotion() ? [] : last.current.flatMap((entry, index) => (here.has(entry.accountId) ? [] : [{ entry, index }]));
    last.current = entries;
    setLeaving((current) => {
      const kept = current.filter((row) => !here.has(row.entry.accountId) && !left.some((gone) => gone.entry.accountId === row.entry.accountId));
      return kept.length === current.length && !left.length ? current : [...kept, ...left];
    });
    // `ids` names everyone in `entries`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  useEffect(() => {
    if (!leaving.length) return;
    const timer = window.setTimeout(() => setLeaving([]), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  const rows = entries.map((entry) => ({ entry, leaving: false }));
  for (const row of [...leaving].sort((a, b) => a.index - b.index)) rows.splice(Math.min(row.index, rows.length), 0, { entry: row.entry, leaving: true });
  return rows;
}

/** A label under an avatar on hover or keyboard focus, after a short delay. */
function Tip({ children }: { children: ReactNode }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-1/2 top-full z-30 mt-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-2xs font-medium text-bg opacity-0 shadow-pop transition-opacity duration-150 group-hover/avatar:opacity-100 group-hover/avatar:delay-300 group-focus-visible/avatar:opacity-100"
    >
      {children}
    </span>
  );
}

/**
 * Up to four live avatars, each ringed in that person's caret and cursor colour, then "+N" for
 * the rest. A dot shows who is active (pulsing while they type); someone with the tab in the
 * background is faded. Each avatar names its person on hover and focus, and opens the list.
 */
export function PresenceStack({
  entries,
  size,
  describe,
  following,
  onPick,
  quiet = false,
}: {
  entries: PresenceEntry[];
  size: number;
  describe: (entry: PresenceEntry) => string;
  /** No hover labels: the list they open is showing. */
  quiet?: boolean;
  /** The account you follow: their ring is thicker. */
  following?: string | null;
  /** Opens the list at that person (null: the "+N" chip); `element` takes focus back when it closes. */
  onPick: (entry: PresenceEntry | null, element: HTMLElement) => void;
}) {
  const rows = useWithLeaving(entries);
  const live = rows.filter((row) => !row.leaving);
  const shown = rows.filter((row) => row.leaving || live.indexOf(row) < STACK_MAX);
  const hidden = live.slice(STACK_MAX).map((row) => row.entry);
  const initials = distinctInitials(shown.map((row) => row.entry));
  const dot = Math.max(7, Math.round(size * 0.32));
  return (
    <span className="flex items-center" data-follow-keep>
      <span className="flex items-center -space-x-1">
        {shown.map(({ entry, leaving }, index) => {
          const status = statusOf(entry);
          const followed = following === entry.accountId;
          return (
            <button
              key={leaving ? `${entry.accountId}:leaving` : entry.accountId}
              ref={leaving ? animateOut : animateIn}
              type="button"
              tabIndex={leaving ? -1 : 0}
              aria-hidden={leaving || undefined}
              aria-label={`${describe(entry)}. Show who's here`}
              onClick={(event) => onPick(entry, event.currentTarget)}
              className="group/avatar relative grid place-items-center rounded-full p-[3px] outline-none hover:z-10 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-accent"
              style={{ zIndex: leaving ? 0 : undefined }}
              data-presence={entry.accountId}
            >
              <Avatar
                person={{ ...entry, initials: initials[index] }}
                color={entry.color}
                size={size}
                ring
                dim={status === "away"}
                title=""
              />
              {status !== "away" ? (
                <span
                  aria-hidden
                  className={`absolute bottom-[1px] right-[1px] rounded-full ${status === "editing" ? "pulse-dot" : ""}`}
                  style={{ width: dot, height: dot, background: status === "editing" ? entry.color : "var(--ok)", boxShadow: "0 0 0 2px var(--bg)" }}
                />
              ) : null}
              {followed ? <span aria-hidden className="absolute -inset-[1px] rounded-full" style={{ boxShadow: `0 0 0 2px ${entry.color}` }} /> : null}
              {quiet ? null : <Tip>{describe(entry)}</Tip>}
            </button>
          );
        })}
      </span>
      {hidden.length ? (
        <button
          type="button"
          onClick={(event) => onPick(null, event.currentTarget)}
          aria-label={`${hidden.length} more: ${hidden.map(describe).join(", ")}. Show who's here`}
          className="group/avatar relative ml-0.5 grid place-items-center rounded-full p-[3px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span
            className="grid place-items-center rounded-full bg-hover font-semibold leading-none text-muted"
            style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.38)), boxShadow: "0 0 0 2px var(--bg), 0 0 0 3px var(--line-strong)" }}
          >
            +{hidden.length}
          </span>
          {quiet ? null : <Tip>{hidden.length > 3 ? `${hidden.slice(0, 3).map((entry) => entry.name).join(", ")} and ${hidden.length - 3} more` : hidden.map((entry) => entry.name).join(", ")}</Tip>}
        </button>
      ) : null}
    </span>
  );
}

const FOCUSABLE = "button:not([disabled]), a[href]";

/**
 * The inside of a people popover. Focus moves in when it opens, the arrow keys and Tab move
 * between its buttons, and focus returns to the chip that opened it when it closes (the popover
 * itself closes on Esc and outside clicks).
 */
export function PeoplePanel({ label, opener, focus, children }: { label: string; opener: RefObject<HTMLElement | null>; focus?: string | null; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = panel.current;
    // The popover is placed, and only then visible, in the render after this one.
    const frame = window.requestAnimationFrame(() => {
      const row = focus ? Array.from(node?.querySelectorAll<HTMLElement>("[data-person]") ?? []).find((el) => el.dataset.person === focus) : undefined;
      (row?.querySelector<HTMLElement>(FOCUSABLE) ?? node?.querySelector<HTMLElement>(FOCUSABLE) ?? node)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      const active = document.activeElement;
      if (!active || active === document.body || node?.contains(active)) opener.current?.focus();
    };
    // Only on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <div ref={panel} role="dialog" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown} className="py-1 outline-none" data-follow-keep>
      {children}
    </div>
  );
}

const STATUS_TEXT = { editing: "Editing now", viewing: "Viewing", away: "Away · tab in the background" } as const;

/**
 * One person in a people list: their avatar in their colour, what they are doing and may do,
 * and Follow. In Here now, `place` says where they are and Go to takes you there.
 */
export function PersonRow({
  entry,
  followed,
  canFollow,
  place,
  onGo,
  close,
}: {
  entry: PresenceEntry;
  followed: boolean;
  /** Following needs a route to go to, or to be on the item they are on. */
  canFollow: boolean;
  place?: string;
  onGo?: () => void;
  close: () => void;
}) {
  const status = statusOf(entry);
  const followsYou = Boolean(entry.follows && entry.follows === presenceStore.me());
  const detail = [place ? `${status === "editing" ? "Editing" : status === "away" ? "Away on" : "On"} ${place}` : STATUS_TEXT[status], entry.role ? roleLabel(entry.role) : null, followsYou ? "Following you" : null]
    .filter(Boolean)
    .join(" · ");
  const person = (
    <>
      <Avatar person={entry} color={entry.color} size={28} ring dim={status === "away"} title="" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-ink">{entry.name}</span>
          {isGuest(entry) ? <span className="shrink-0 rounded bg-hover px-1 py-px text-[10.5px] font-medium text-muted">Guest</span> : null}
        </span>
        <span className="flex items-center gap-1 truncate text-2xs text-muted">
          {status === "editing" ? <span aria-hidden className="pulse-dot size-1.5 shrink-0 rounded-full" style={{ background: entry.color }} /> : null}
          <span className="truncate">{detail}</span>
        </span>
      </span>
    </>
  );
  return (
    <div className="flex items-center gap-1 px-1" data-person={entry.accountId}>
      {onGo ? (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left hover:bg-hover focus-visible:bg-hover"
          title={`Go to ${entry.name}`}
          aria-label={`Go to ${entry.name}. ${detail}`}
          onClick={() => {
            onGo();
            close();
          }}
        >
          {person}
          <LocateFixed size={13} className="shrink-0 text-faint" aria-hidden />
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2.5 px-1.5 py-1.5">{person}</div>
      )}
      {canFollow ? (
        <button
          type="button"
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-2xs font-medium transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent"
          style={followed ? { borderColor: entry.color, color: entry.color, background: `color-mix(in srgb, ${entry.color} 12%, transparent)` } : { borderColor: "var(--line-strong)" }}
          aria-pressed={followed}
          aria-label={followed ? `Stop following ${entry.name}` : `Follow ${entry.name}`}
          title={followed ? `Stop following ${entry.name}` : `See what ${entry.name} sees, live. Esc, a scroll or a click stops.`}
          onClick={() => {
            if (followed) followStore.stop();
            else followStore.start({ accountId: entry.accountId, name: entry.name, color: entry.color });
            close();
          }}
        >
          <Eye size={12} aria-hidden />
          {followed ? "Following" : "Follow"}
        </button>
      ) : (
        <span className="grid size-7 shrink-0 place-items-center text-faint" title={`${entry.name} has only ${placeOf(entry)} open. Go to it to follow them there.`}>
          <Info size={13} aria-hidden />
          <span className="sr-only">{`${entry.name} has only ${placeOf(entry)} open. Go to it to follow them there.`}</span>
        </span>
      )}
    </div>
  );
}

/** The heading of a people list: "Here now · 3". */
export function PanelHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 pb-1.5 pt-1 text-2xs font-medium uppercase tracking-wide text-faint">
      <Users size={11} aria-hidden /> {label}
      <span className="ml-auto rounded-full bg-hover px-1.5 text-[10.5px] tabular-nums text-muted">{count}</span>
    </div>
  );
}

/** Who else is in this shared space right now. Click someone to go to them or follow them. */
export function SpacePeople() {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const search = useSearchParams();
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const here = people(usePresence());
  const following = useFollowing();
  const opener = useRef<HTMLElement | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  if (!here.length) return null;
  const mine = resourceOf(pathname, search, shell.data?.space?.id ?? null);
  const describe = (entry: PresenceEntry) => {
    const status = statusOf(entry);
    return `${entry.name}${isGuest(entry) ? " (guest)" : ""} · ${status === "viewing" ? "on" : status} ${placeOf(entry)}`;
  };
  return (
    <Popover
      align="right"
      width={320}
      trigger={(open, toggle) => (
        <span className="mr-1 flex items-center" aria-label={`Here now: ${here.map((entry) => entry.name).join(", ")}`} role="group">
          <PresenceStack
            entries={here}
            size={22}
            following={following?.accountId}
            describe={describe}
            quiet={open}
            onPick={(entry, element) => {
              opener.current = element;
              setFocus(entry?.accountId ?? null);
              if (!open) toggle();
            }}
          />
        </span>
      )}
    >
      {(close) => (
        <PeoplePanel label="Here now" opener={opener} focus={focus}>
          <PanelHeading label="Here now" count={here.length} />
          {here.map((entry) => {
            const href = hrefOf(entry);
            const sameItem = Boolean(mine && entry.resource && mine.kind === entry.resource.kind && mine.id === entry.resource.id);
            return (
              <PersonRow
                key={entry.accountId}
                entry={entry}
                place={placeOf(entry)}
                followed={following?.accountId === entry.accountId}
                canFollow={Boolean(entry.route) || sameItem}
                onGo={href ? () => router.push(href) : undefined}
                close={close}
              />
            );
          })}
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
 * Following someone: frames the window in their colour with "Following ‹name› · Stop". Esc, your
 * own scroll or click, or Stop ends it; so does their leaving, with a toast. In the Hub (with
 * FollowHost) and on a shared item or public link.
 */
export function FollowBanner() {
  const toast = useToast();
  const following = useFollowing();
  const list = usePresence();
  const target = following ? people(list).find((entry) => entry.accountId === following.accountId) : undefined;
  const missing = following !== null && target === undefined;

  useEffect(() => {
    if (!following || !missing) return;
    // A reload looks like leaving for a moment.
    const timer = window.setTimeout(() => {
      toast(`${following.name} left, so you stopped following them.`);
      followStore.stop();
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [following, missing, toast]);

  useEffect(() => {
    if (!following) return;
    const stop = () => followStore.stop();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || SCROLL_KEYS.has(event.key)) stop();
    };
    // Your own scroll or click takes over; the banner and the people lists do not count.
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-follow-keep]")) return;
      stop();
    };
    const passive = { passive: true, capture: true } as const;
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", stop, passive);
    window.addEventListener("touchmove", stop, passive);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", stop, passive);
      window.removeEventListener("touchmove", stop, passive);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [following]);

  if (!following) return null;
  const status = target ? statusOf(target) : null;
  return (
    <>
      <div className="pointer-events-none fixed inset-0 z-[60] rounded-[3px]" style={{ boxShadow: `inset 0 0 0 2px ${following.color}` }} aria-hidden />
      <div
        ref={animateIn}
        role="status"
        data-follow-keep
        className="fixed left-1/2 top-[54px] z-[61] flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-2 rounded-full py-1 pl-1 pr-1 text-[12.5px] font-medium text-white shadow-pop"
        style={{ background: `color-mix(in srgb, ${following.color} 72%, black)` }}
      >
        <Avatar person={target ?? { name: following.name }} color={following.color} size={22} title="" />
        <span className="min-w-0 truncate">
          Following {following.name}
          {status && status !== "viewing" ? <span className="font-normal text-white/80"> · {status === "editing" ? "editing" : "away"}</span> : null}
        </span>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-white/20 px-2.5 py-0.5 text-2xs hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          onClick={() => followStore.stop()}
          aria-label={`Stop following ${following.name}`}
        >
          Stop <kbd className="rounded bg-black/20 px-1 font-sans text-[10px]">Esc</kbd>
        </button>
      </div>
    </>
  );
}

const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);

/**
 * In the Hub, follow mode also goes where the person goes in the space: their route. Moving
 * somewhere else yourself stops it.
 */
export function FollowHost() {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const search = useSearchParams();
  const following = useFollowing();
  const list = usePresence();
  const target = following ? people(list).find((entry) => entry.accountId === following.accountId) : undefined;
  const expected = useRef<string | null>(null);
  const here = `${pathname}${search?.toString() ? `?${search.toString()}` : ""}`;

  useEffect(() => {
    if (!following || !target?.route) {
      if (!following) expected.current = null;
      return;
    }
    expected.current = target.route;
    if (target.route !== here) router.push(target.route);
    // `here` is left out on purpose: your own navigation is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [following, target?.route]);

  // You went somewhere they are not: you stopped following.
  useEffect(() => {
    if (!following || !expected.current) return;
    if (here !== expected.current && target?.route !== here) followStore.stop();
    else expected.current = here;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here]);

  return <FollowBanner />;
}
