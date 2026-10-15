"use client";

import { useRef } from "react";
import { Users } from "lucide-react";
import type { PresenceEntry } from "@/lib/api";
import { editingLine, onResource, usePresence } from "@/lib/presence";
import { Popover } from "@/components/ui";
import { Avatar, PeoplePanel, PresenceStack } from "./people";

/**
 * Who else has this page, task or diagram open right now. A pulse means they are typing. Past
 * four people a "+N" chip; clicking the avatars lists everyone.
 */
export function PagePeople({ kind, id, size = 22 }: { kind: string; id: string; size?: number }) {
  const here = onResource(usePresence(), kind, id);
  const chip = useRef<HTMLButtonElement>(null);
  if (!here.length) return null;
  const noun = kind.replace("_", " ");
  const status = (entry: PresenceEntry) => `${entry.name} is ${entry.typing ? "editing" : "viewing"}`;
  const editing = here.filter((entry) => entry.typing).map((entry) => entry.name);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Popover
        align="right"
        width={240}
        trigger={(open, toggle) => (
          <button
            ref={chip}
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label={`On this ${noun}: ${here.map(status).join(", ")}`}
            className="flex items-center rounded-md p-0.5 hover:bg-hover"
          >
            <PresenceStack entries={here} size={size} ringed={(entry) => entry.typing} describe={status} />
          </button>
        )}
      >
        {() => (
          <PeoplePanel label={`On this ${noun}`} opener={chip}>
            <div className="flex items-center gap-1.5 px-2 pb-1.5 pt-0.5 text-2xs font-medium uppercase tracking-wide text-faint">
              <Users size={11} /> On this {noun}
            </div>
            <ul>
              {here.map((entry) => (
                <li key={entry.accountId} className="flex items-center gap-2 px-2 py-1.5">
                  <Avatar person={entry} color={entry.color} size={24} ring={entry.typing} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{entry.name}</span>
                    <span className="block text-2xs text-muted">{entry.typing ? "Editing now" : "Viewing"}</span>
                  </span>
                </li>
              ))}
            </ul>
          </PeoplePanel>
        )}
      </Popover>
      {editing.length ? (
        <span className="max-w-[240px] truncate text-2xs text-muted" title={editingLine(editing)}>
          {editingLine(editing)}
        </span>
      ) : null}
    </span>
  );
}
