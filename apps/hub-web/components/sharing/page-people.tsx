"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { PresenceEntry } from "@/lib/api";
import { useFollowing } from "@/lib/follow";
import { editingLine, isGuest, onResource, presenceLine, statusOf, usePresence } from "@/lib/presence";
import { Popover } from "@/components/ui";
import { PanelHeading, PeoplePanel, PersonRow, PresenceStack } from "./people";

/**
 * Set around a shared item's body (/shared/[id], /p/[token]) whose own header shows who is here,
 * so the page, task or diagram inside does not show them twice.
 */
export const PresenceInHeader = createContext(false);

/** "Curious Otter (guest) joined", "Mira Chen left", for screen readers, once each. */
function useArrivals(here: PresenceEntry[]): string {
  const [said, setSaid] = useState("");
  const known = useRef<Map<string, string> | null>(null);
  const ids = here.map((entry) => entry.accountId).join("|");
  useEffect(() => {
    const now = new Map(here.map((entry) => [entry.accountId, `${entry.name}${isGuest(entry) ? " (guest)" : ""}`]));
    const before = known.current;
    known.current = now;
    if (!before) return;
    const lines = [
      ...[...now].filter(([id]) => !before.has(id)).map(([, name]) => `${name} joined`),
      ...[...before].filter(([id]) => !now.has(id)).map(([, name]) => `${name} left`),
    ];
    if (lines.length) setSaid(lines.join(". "));
    // `ids` names everyone in `here`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  return said;
}

/**
 * Who else has this page, task or diagram open right now: avatars ringed in each person's caret
 * colour, a dot for who is active (pulsing while they type), "+N" past four. Clicking an avatar
 * lists everyone with what they are doing and may do, and Follow.
 */
export function PagePeople({ kind, id, size = 24 }: { kind: string; id: string; size?: number }) {
  const shownAbove = useContext(PresenceInHeader);
  const here = onResource(usePresence(), kind, id);
  const following = useFollowing();
  const opener = useRef<HTMLElement | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const said = useArrivals(shownAbove ? [] : here);
  if (shownAbove) return null;
  const noun = kind.replace("_", " ");
  const editing = here.filter((entry) => statusOf(entry) === "editing").map((entry) => entry.name);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="sr-only" role="status" aria-atomic="true">
        {said}
      </span>
      {editing.length ? (
        <span className="max-w-[220px] truncate text-2xs text-muted max-sm:hidden" title={editingLine(editing)}>
          {editingLine(editing)}
        </span>
      ) : null}
      {here.length ? (
        <Popover
          align="right"
          width={304}
          trigger={(open, toggle) => (
            <span role="group" aria-label={`On this ${noun}: ${here.map(presenceLine).join(", ")}`} className="flex items-center">
              <PresenceStack
                entries={here}
                size={size}
                following={following?.accountId}
                describe={presenceLine}
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
            <PeoplePanel label={`On this ${noun}`} opener={opener} focus={focus}>
              <PanelHeading label={`On this ${noun}`} count={here.length} />
              {here.map((entry) => (
                <PersonRow key={entry.accountId} entry={entry} followed={following?.accountId === entry.accountId} canFollow close={close} />
              ))}
              <p className="mx-2.5 mt-1 border-t border-line pb-0.5 pt-2 text-2xs leading-4 text-faint">Follow shows you what they see, as they move. Esc, a scroll or a click stops.</p>
            </PeoplePanel>
          )}
        </Popover>
      ) : null}
    </span>
  );
}
