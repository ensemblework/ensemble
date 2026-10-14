"use client";

import { BrandMorph } from "./brand-morph";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  celebrateHoldMs,
  inboxCount,
  initialClear,
  initialToday,
  needsCount,
  stepClear,
  stepToday,
  type TaskSnap,
} from "@/lib/motion/celebrate";

type ShellSnap = { approvals: number; decisions: number };
type RowSnap = { approvals?: unknown[]; decisions?: { status?: string }[]; tasks?: TaskSnap[] };

function readLine(client: ReturnType<typeof useQueryClient>, needs: ReturnType<typeof initialClear>, inbox: ReturnType<typeof initialClear>, today: ReturnType<typeof initialToday>) {
  const shell = client.getQueryData<ShellSnap>(["shell"]) ?? null;
  const approvals = client.getQueryData<RowSnap>(["approvals"]);
  const decisions = client.getQueryData<RowSnap>(["decisions"]);
  const tasks = client.getQueryData<RowSnap>(["tasks"]);
  const rows = tasks?.tasks ?? null;
  const blocked = rows ? rows.filter((task) => task.status === "blocked" || task.status === "waiting_approval").length : null;
  const pending = decisions?.decisions ? decisions.decisions.filter((row) => !row.status || row.status === "pending").length : null;
  const needsStep = stepClear(
    needs,
    needsCount({
      shell,
      approvals: approvals?.approvals ? approvals.approvals.length : null,
      decisions: pending,
      blocked,
    }),
  );
  const inboxStep = stepClear(inbox, rows ? inboxCount(rows) : null);
  const todayStep = stepToday(today, rows);
  const line = todayStep.fire ? "Today is done." : needsStep.fire ? "Nothing needs you." : inboxStep.fire ? "Inbox clear." : null;
  return { needs: needsStep.watch, inbox: inboxStep.watch, today: todayStep.watch, line };
}

/** Inbox clear, Needs me clear, or every Today task marked done. Once per event. */
export function CelebrateHost() {
  const client = useQueryClient();
  const needs = useRef(initialClear());
  const inbox = useRef(initialClear());
  const today = useRef(initialToday());
  const token = useRef(0);
  const [line, setLine] = useState<string | null>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    const apply = () => {
      const next = readLine(client, needs.current, inbox.current, today.current);
      needs.current = next.needs;
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
