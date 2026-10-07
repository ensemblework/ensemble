"use client";

import { useQuery } from "@tanstack/react-query";
import { Mic } from "lucide-react";
import Link from "next/link";
import { connectedApi } from "@/lib/api-connected";

/** "From meeting: <title>" on a task a meeting's action items proposed. */
export function FromMeeting({ meetingNoteId }: { meetingNoteId: string }) {
  const note = useQuery({ queryKey: ["meeting-note", meetingNoteId], queryFn: () => connectedApi.meetingNote(meetingNoteId), staleTime: 60_000 });
  const data = note.data?.note;
  return (
    <div className="flex min-h-[32px] items-center gap-2 text-[13.5px]" data-testid="from-meeting">
      <div className="flex w-[124px] shrink-0 items-center gap-2 whitespace-nowrap text-muted">
        <Mic size={14} strokeWidth={1.8} />
        From meeting
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {data ? (
          <Link href="/meetings" className="row-tile -mx-1.5 truncate rounded px-1.5 py-0.5 text-accent">
            {data.title}
            <span className="ml-1.5 text-[12px] text-muted">
              {data.sourceLabel} · {new Date(data.occurredAt).toLocaleDateString()}
            </span>
          </Link>
        ) : (
          <span className="text-faint">{note.isError ? "Meeting removed" : "…"}</span>
        )}
      </div>
    </div>
  );
}
