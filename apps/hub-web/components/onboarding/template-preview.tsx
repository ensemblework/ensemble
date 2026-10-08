"use client";

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { OnboardingTemplateCard } from "@/lib/api";
import { personInitials } from "@/lib/initials";
import { liveLine, PreviewTiles } from "@/components/desk/live-board";
import type { DeskId } from "@/components/desk/desks";
import { sampleBoard, sampleLive } from "./sample";
import "@/components/desk/desk.css";

export type PreviewView = "today" | "board" | "context";

/** Draws `children` at a fixed design width and scales it down to the box it sits in. */
export function Scaled({ width, maxHeight, children }: { width: number; maxHeight?: number; children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ scale: 0, height: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const available = outer.current?.clientWidth ?? 0;
      const scale = available ? available / width : 0;
      setBox({ scale, height: (inner.current?.scrollHeight ?? 0) * scale });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    if (outer.current) observer.observe(outer.current);
    if (inner.current) observer.observe(inner.current);
    return () => observer.disconnect();
  }, [width]);
  return (
    <div ref={outer} className="relative w-full overflow-hidden" style={{ height: maxHeight ? Math.min(box.height, maxHeight) : box.height }} aria-hidden="true">
      <div
        ref={inner}
        className="pointer-events-none select-none"
        style={{ width, transform: `scale(${box.scale})`, transformOrigin: "top left", visibility: box.scale ? "visible" : "hidden" }}
        inert
      >
        {children}
      </div>
    </div>
  );
}

function dayLabel(now = new Date()) {
  return now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function TodayView({ card, role }: { card: OnboardingTemplateCard; role: string }) {
  const live = useMemo(() => sampleLive(role, card), [role, card]);
  return (
    <div className="desk page onboard-preview-desk" data-desk={card.desk}>
      <div className="phead">
        <div>
          <div className="kick">{dayLabel()}</div>
          <h1 className="display">Today</h1>
          <div className="sub">{liveLine(card.desk as DeskId, live) ?? card.blurb}</div>
        </div>
      </div>
      <div className="bento">
        <PreviewTiles deskId={card.desk as DeskId} tiles={card.tiles} live={live} />
      </div>
    </div>
  );
}

function BoardView({ card, role }: { card: OnboardingTemplateCard; role: string }) {
  const lanes = useMemo(() => sampleBoard(sampleLive(role, card)), [role, card]);
  return (
    <div className="onboard-preview-page">
      <div className="text-[13px] text-muted">{card.preview.project}</div>
      <h1 className="display mt-1 text-[34px] leading-none">Board</h1>
      <div className="mt-6 grid grid-cols-4 gap-4">
        {lanes.map((lane) => (
          <div key={lane.id} className="rounded-md bg-hover p-2.5">
            <div className="flex items-center justify-between px-1 pb-2 text-[13px] font-medium text-ink/80">
              <span>{lane.title}</span>
              <span className="text-faint">{lane.cards.length}</span>
            </div>
            <div className="space-y-2">
              {lane.cards.map((item) => (
                <div key={item.id} className="rounded-md border border-line bg-panel px-3 py-2.5">
                  <div className="text-[13.5px] font-medium leading-snug text-ink">{item.title}</div>
                  <div className="mt-2 flex items-center justify-between text-[12px] text-faint">
                    {item.who ? (
                      <span className="flex items-center gap-1.5">
                        <span className="grid size-5 place-items-center rounded-full bg-hover text-[9.5px] font-semibold text-ink/80">{personInitials(item.who)}</span>
                        {item.who.split(" ")[0]}
                      </span>
                    ) : (
                      <span />
                    )}
                    {item.due ? <span>{new Date(`${item.due}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}</span> : null}
                  </div>
                </div>
              ))}
              {lane.cards.length === 0 ? <div className="rounded-md border border-dashed border-line px-3 py-4 text-center text-[12px] text-faint">Nothing here</div> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ContextView({ card, role }: { card: OnboardingTemplateCard; role: string }) {
  const live = useMemo(() => sampleLive(role, card), [role, card]);
  const people = live.people.slice(0, 5);
  const files = live.artifacts.slice(0, 4);
  const W = 560;
  const H = 400;
  const cx = W / 2;
  const cy = H / 2;
  const ring = (count: number, radius: number, offset: number) =>
    Array.from({ length: count }, (_, index) => {
      const angle = offset + (index / count) * Math.PI * 2;
      return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius * 0.78 };
    });
  const personAt = ring(people.length, 150, -Math.PI / 2);
  const fileAt = ring(files.length, 230, -Math.PI / 4);
  return (
    <div className="onboard-preview-page">
      <div className="text-[13px] text-muted">The people, projects, and files around your work</div>
      <h1 className="display mt-1 text-[34px] leading-none">Context</h1>
      <div className="mt-6 grid grid-cols-[300px_1fr] gap-5">
        <div className="rounded-md border border-line bg-panel p-3">
          <div className="px-1 pb-2 text-[13px] font-medium text-ink/80">People</div>
          {people.map((person) => (
            <div key={person.id} className="flex items-center gap-2.5 rounded-md px-1.5 py-2">
              <span className="grid size-8 place-items-center rounded-full bg-hover text-[11px] font-semibold text-ink/80">{personInitials(person.name)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-ink">{person.name}</span>
                <span className="block truncate text-[12px] text-faint">{person.role}</span>
              </span>
            </div>
          ))}
          <div className="mt-3 border-t border-line px-1 pb-2 pt-3 text-[13px] font-medium text-ink/80">Files</div>
          {files.map((file) => (
            <div key={file.id} className="flex items-center justify-between gap-2 px-1.5 py-1.5 text-[13px]">
              <span className="truncate text-ink">{file.title}</span>
              <span className="shrink-0 text-[12px] text-faint">{file.source}</span>
            </div>
          ))}
        </div>
        <div className="rounded-md border border-line bg-panel">
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full">
            {personAt.map((point, index) => (
              <line key={`pl${index}`} x1={cx} y1={cy} x2={point.x} y2={point.y} stroke="var(--line-strong)" strokeWidth="1.2" />
            ))}
            {fileAt.map((point, index) => {
              const owner = personAt[index % Math.max(1, personAt.length)] ?? { x: cx, y: cy };
              return <line key={`fl${index}`} x1={owner.x} y1={owner.y} x2={point.x} y2={point.y} stroke="var(--line)" strokeWidth="1" strokeDasharray="3 4" />;
            })}
            <circle cx={cx} cy={cy} r="30" fill="var(--panel)" />
            <circle cx={cx} cy={cy} r="30" fill="rgb(var(--accent-rgb) / 0.14)" stroke="rgb(var(--accent-rgb) / 0.55)" />
            <text x={cx} y={cy + 50} textAnchor="middle" fontSize="13" fontWeight="600" fill="var(--ink)">{live.projects[0]?.name}</text>
            {personAt.map((point, index) => (
              <g key={`p${index}`}>
                <circle cx={point.x} cy={point.y} r="17" fill="var(--panel)" stroke="var(--line-strong)" />
                <text x={point.x} y={point.y + 4} textAnchor="middle" fontSize="10.5" fontWeight="600" fill="var(--ink-2)">{personInitials(people[index]!.name)}</text>
                <text x={point.x} y={point.y + 32} textAnchor="middle" fontSize="11" fill="var(--muted)">{people[index]!.name.split(" ")[0]}</text>
              </g>
            ))}
            {fileAt.map((point, index) => (
              <g key={`f${index}`}>
                <rect x={point.x - 6} y={point.y - 6} width="12" height="12" rx="2.5" fill="var(--hover)" stroke="var(--line-strong)" />
                <text x={point.x} y={point.y + 22} textAnchor="middle" fontSize="10.5" fill="var(--faint)">{files[index]!.title.length > 20 ? `${files[index]!.title.slice(0, 19)}…` : files[index]!.title}</text>
              </g>
            ))}
          </svg>
        </div>
      </div>
    </div>
  );
}

export function TemplatePreview({ card, role, view = "today", maxHeight }: { card: OnboardingTemplateCard; role: string; view?: PreviewView; maxHeight?: number }) {
  return (
    <Scaled width={1180} maxHeight={maxHeight}>
      <div className="onboard-preview">
        {view === "today" ? <TodayView card={card} role={role} /> : view === "board" ? <BoardView card={card} role={role} /> : <ContextView card={card} role={role} />}
      </div>
    </Scaled>
  );
}
