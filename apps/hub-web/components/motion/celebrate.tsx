"use client";

import { BrandMorph } from "./brand-morph";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  celebrateHoldMs,
  inboxCount,
  initialClear,
  initialToday,
  stepClear,
  stepToday,
  type TaskSnap,
} from "@/lib/motion/celebrate";

type RowSnap = { tasks?: TaskSnap[] };

function readLine(client: ReturnType<typeof useQueryClient>, inbox: ReturnType<typeof initialClear>, today: ReturnType<typeof initialToday>) {
  const tasks = client.getQueryData<RowSnap>(["tasks"]);
  const rows = tasks?.tasks ?? null;
  const inboxStep = stepClear(inbox, rows ? inboxCount(rows) : null);
  const todayStep = stepToday(today, rows);
  const line = todayStep.fire ? "Today is done." : inboxStep.fire ? "Inbox clear." : null;
  return { inbox: inboxStep.watch, today: todayStep.watch, line };
}

/** Inbox clear, or every Today task marked done. Once per event. (Needs me emptying on its own is not a moment.) */
export function CelebrateHost() {
  const client = useQueryClient();
  const inbox = useRef(initialClear());
  const today = useRef(initialToday());
  const token = useRef(0);
  const [line, setLine] = useState<string | null>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    const apply = () => {
      const next = readLine(client, inbox.current, today.current);
      inbox.current = next.inbox;
      today.current = next.today;
      if (!next.line) return;
      const id = ++token.current;
      setLine(next.line);
      setOn(false);
      const ms = celebrateHoldMs(getComputedStyle(document.documentElement));
      window.setTimeout(() => {
        if (token.current === id) setLine(null);
      }, ms);
    };
    apply();
    return client.getQueryCache().subscribe(apply);
  }, [client]);

  useEffect(() => {
    if (!line) return;
    const frame = window.requestAnimationFrame(() => setOn(true));
    return () => window.cancelAnimationFrame(frame);
  }, [line]);

  if (!line) return null;
  return (
    <div className={`m-celebrate${on ? " on" : ""}`} data-motion-slot="moment.celebrate" data-state="cleared" role="status">
      <span className="m-celebrate-bits" aria-hidden>
        {Array.from({ length: 6 }, (_, index) => (
          <span key={index}>
            <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
              <path d="M3 15C6 6 12 6 12 12s6 8 9-2" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </span>
        ))}
      </span>
      <BrandMorph size={36} state="once" kind="unfurl" />
      <p>{line}</p>
    </div>
  );
}
