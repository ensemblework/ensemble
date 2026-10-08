"use client";

import { onResource, usePresence } from "@/lib/presence";
import { Avatar } from "./people";

/** Who else has this page, task or diagram open right now. A pulse means they are typing. */
export function PagePeople({ kind, id, size = 22 }: { kind: string; id: string; size?: number }) {
  const here = onResource(usePresence(), kind, id);
  if (!here.length) return null;
  return (
    <span className="flex items-center gap-1.5" aria-label={`${here.map((entry) => entry.name).join(", ")} ${here.length === 1 ? "is" : "are"} here`}>
      <span className="flex -space-x-1.5">
        {here.slice(0, 4).map((entry) => (
          <span key={entry.accountId} className="relative">
            <Avatar person={entry} color={entry.color} size={size} ring={entry.typing} title={`${entry.name}${entry.typing ? " is editing" : " is viewing"}`} />
            {entry.typing ? <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 animate-pulse rounded-full border border-bg" style={{ background: entry.color }} /> : null}
          </span>
        ))}
      </span>
      {here.some((entry) => entry.typing) ? (
        <span className="text-2xs text-muted">
          {here.find((entry) => entry.typing)!.name.split(" ")[0]} is editing…
        </span>
      ) : null}
    </span>
  );
}
