"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { Eye, LocateFixed, Users } from "lucide-react";
import { api, type PresenceEntry, type SharingPerson } from "@/lib/api";
import { followStore, useFollowing } from "@/lib/follow";
import { people, usePresence } from "@/lib/presence";
import { Popover } from "@/components/ui";
import { useToast } from "@/components/toast";

/** Round initials in a person's colour. `ring` marks someone live right now. */
export function Avatar({
  person,
  color,
  size = 24,
  ring = false,
  title,
}: {
  person: Pick<SharingPerson, "name" | "initials">;
  color?: string;
  size?: number;
  ring?: boolean;
  title?: string;
}) {
  const tint = color ?? "var(--ink)";
  return (
    <span
      title={title ?? person.name}
      aria-label={person.name}
      className="inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none text-white"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.4)),
        background: color ? tint : "color-mix(in srgb, var(--ink) 45%, var(--bg))",
        boxShadow: ring ? `0 0 0 2px var(--bg), 0 0 0 3.5px ${tint}` : undefined,
      }}
    >
      {person.initials}
    </span>
  );
}

const PLACES: Array<[RegExp, string]> = [
  [/^\/board/, "the board"],
  [/^\/pages\//, "a page"],
  [/^\/tasks\//, "a task"],
  [/^\/diagrams\/./, "a diagram"],
  [/^\/diagrams/, "diagrams"],
  [/^\/plots\/./, "a plot space"],
  [/^\/plots/, "plots"],
  [/^\/context/, "Context"],
  [/^\/needs-me/, "Needs me"],
  [/^\/runs/, "runs"],
  [/^\/workspace/, "the workspace"],
  [/^\/code/, "code"],
  [/^\/skills/, "skills"],
  [/^\/meetings/, "meetings"],
  [/^\/recap/, "the weekly recap"],
  [/^\/projects/, "projects"],
];

export function placeOf(entry: Pick<PresenceEntry, "route" | "resource">): string {
  if (!entry.route) return entry.resource ? `the shared ${entry.resource.kind.replace("_", " ")}` : "this space";
  const path = entry.route.split("?")[0] ?? "";
  if (entry.route.includes("peek=task:")) return "a task";
  return PLACES.find(([pattern]) => pattern.test(path))?.[1] ?? "this space";
}

/** Who else is in this shared space right now. Click someone to follow them or jump to them. */
export function SpacePeople() {
  const router = useRouter();
  const here = people(usePresence());
  const following = useFollowing();
  if (!here.length) return null;
  const shown = here.slice(0, 4);
  const more = here.length - shown.length;
  return (
    <Popover
      align="right"
      width={280}
      trigger={(open, toggle) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={`${here.length} ${here.length === 1 ? "person" : "people"} here now`}
          className="mr-1 flex items-center rounded-md px-1 py-0.5 hover:bg-hover"
        >
          <span className="flex -space-x-1.5">
            {shown.map((entry) => (
              <span key={entry.accountId} className="relative">
                <Avatar person={entry} color={entry.color} size={22} ring={following?.accountId === entry.accountId} title={`${entry.name}, on ${placeOf(entry)}`} />
                {entry.typing ? <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 animate-pulse rounded-full border border-bg" style={{ background: entry.color }} /> : null}
              </span>
            ))}
          </span>
          {more > 0 ? <span className="ml-1 text-2xs text-muted">+{more}</span> : null}
        </button>
      )}
    >
      {(close) => (
        <div className="py-1">
          <div className="flex items-center gap-1.5 px-2 pb-1.5 pt-0.5 text-2xs font-medium uppercase tracking-wide text-faint">
            <Users size={11} /> Here now
          </div>
          {here.map((entry) => {
            const isFollowed = following?.accountId === entry.accountId;
            return (
              <div key={entry.accountId} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover">
                <Avatar person={entry} color={entry.color} size={26} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{entry.name}</div>
                  <div className="truncate text-2xs text-muted">
                    {entry.typing ? "Editing " : "On "}
                    {placeOf(entry)}
                  </div>
                </div>
                {entry.route ? (
                  <button
                    type="button"
                    className="icon-btn"
                    title={`Go to ${entry.name}`}
                    aria-label={`Go to ${entry.name}`}
                    onClick={() => {
                      router.push(entry.route!);
                      close();
                    }}
                  >
                    <LocateFixed size={14} />
                  </button>
                ) : null}
                {entry.route ? (
                  <button
                    type="button"
                    className="rounded-md border border-line px-2 py-0.5 text-2xs font-medium hover:bg-hover"
                    style={isFollowed ? { borderColor: entry.color, color: entry.color } : undefined}
                    onClick={() => {
                      if (isFollowed) followStore.stop();
                      else followStore.start({ accountId: entry.accountId, name: entry.name, color: entry.color });
                      close();
                    }}
                  >
                    {isFollowed ? "Following" : "Follow"}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Popover>
  );
}

/** "Shared by Mira · can edit", in the top bar of a space someone shared with you. */
export function SharedBadge() {
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const shared = shell.data?.space?.shared;
  if (!shared) return null;
  return (
    <span
      className="hidden shrink-0 items-center gap-1.5 rounded-md border border-line bg-panel px-1.5 py-0.5 text-2xs text-muted md:inline-flex"
      title={`${shared.owner.name} shared this space with you. You ${shared.role === "editor" ? "can edit" : "can view"} it. Your settings, keys and metrics stay your own.`}
    >
      <Avatar person={shared.owner} size={14} />
      <span className="max-w-[140px] truncate">Shared by {shared.owner.name.split(" ")[0]}</span>
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
        <Eye size={13} />
        Following {following.name.split(" ")[0]}
        <button type="button" className="rounded-full bg-white/20 px-2 py-0.5 text-2xs hover:bg-white/30" onClick={() => followStore.stop()}>
          Stop · Esc
        </button>
      </div>
    </>
  );
}
