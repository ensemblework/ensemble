"use client";

import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui";
import { useDelayedFlag } from "@/lib/motion/use-delayed-flag";
import { BrandMorph } from "./brand-morph";

function Block({ className, index = 0 }: { className: string; index?: number }) {
  return <Skeleton index={index} className={className} />;
}

/** Suspense fallback. Reserves the box immediately and only paints after the delay. */
export function SuspenseSkeleton({ className }: { className: string }) {
  return <Block className={className} />;
}

export function RowsSkeleton({ count, rowClassName }: { count: number; rowClassName: string }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: count }, (_, index) => (
        <Block key={index} index={index} className={`w-full ${rowClassName}`} />
      ))}
    </div>
  );
}

/** Matches a run row: chevron, title, meta line, outcome tag. */
export function RunsSkeleton() {
  return (
    <div aria-hidden>
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="flex items-center gap-3 border-b border-line px-2 py-2.5">
          <Block index={index} className="h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Block index={index} className="h-[18px] w-2/5" />
            <Block index={index} className="h-3 w-3/5" />
          </div>
          <Block index={index} className="h-5 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** Matches Metrics: chart tile, two cards, recent-call rows. */
export function MetricsSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="tile rounded-lg bg-panel p-4">
        <Block className="mb-3 h-4 w-32" />
        <Block className="h-36 w-full" />
        <Block className="mt-1 h-3 w-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="tile rounded-lg bg-panel p-4">
          <Block className="mb-3 h-4 w-24" />
          <div className="space-y-2">
            {Array.from({ length: 4 }, (_, index) => (
              <Block key={index} index={index} className="h-4 w-full" />
            ))}
          </div>
        </div>
        <div className="tile rounded-lg bg-panel p-4">
          <Block className="mb-3 h-4 w-36" />
          <div className="flex items-center gap-6">
            <Block className="h-[120px] w-[120px] shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <Block className="h-4 w-full" />
              <Block className="h-4 w-4/5" />
              <Block className="h-4 w-3/5" />
            </div>
          </div>
        </div>
      </div>
      <div className="tile rounded-lg bg-panel p-4">
        <Block className="mb-2 h-4 w-40" />
        {Array.from({ length: 5 }, (_, index) => (
          <Block key={index} index={index} className="mb-1 h-8 w-full" />
        ))}
        <Block className="mt-3 h-12 w-full" />
      </div>
      <div>
        <Block className="mb-2 h-4 w-64" />
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
          {Array.from({ length: 2 }, (_, index) => (
            <div key={index} className="tile rounded-lg bg-panel p-4">
              <Block className="mb-2 h-4 w-24" />
              <Block className="h-6 w-32" />
            </div>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="tile rounded-lg bg-panel p-4">
            <Block className="mb-2 h-4 w-28" />
            <Block className="mb-1 h-3 w-full" />
            <Block className="h-3 w-4/5" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Same stage box the context graph uses once nodes arrive. */
export function GraphSkeleton({ tall }: { tall?: boolean }) {
  const shown = useDelayedFlag(true);
  return (
    <div
      className={tall ? "m-graph tile relative h-[520px] min-h-[420px] overflow-hidden rounded-xl" : "m-graph relative min-h-0 w-full flex-1"}
      data-visible={shown ? "1" : "0"}
      data-motion-loading={shown ? "1" : "0"}
      data-motion-slot="content.skeleton"
      data-state={shown ? "loading" : "ready"}
      aria-hidden
    >
      <svg className="h-full w-full" viewBox="0 0 640 420">
        <path className="edge" pathLength="1" d="M120 210 H280" />
        <path className="edge" pathLength="1" d="M360 210 H520" />
        <path className="edge" pathLength="1" d="M320 150 V80" />
        <path className="edge" pathLength="1" d="M320 270 V340" />
        <circle className="node hub" cx="320" cy="210" r="28" />
        <circle className="node" cx="96" cy="210" r="16" />
        <circle className="node" cx="544" cy="210" r="16" />
        <circle className="node" cx="320" cy="64" r="14" />
        <circle className="node" cx="320" cy="356" r="14" />
      </svg>
    </div>
  );
}

/** Peek and task page: breadcrumb, title, property rows, editor. */
export function TaskSkeleton({ peek }: { peek?: boolean }) {
  return (
    <div className={peek ? "mx-auto w-full max-w-[860px] px-4 pt-4 sm:px-8 sm:pt-6" : "mx-auto w-full max-w-[900px] px-4 pt-6 sm:px-16 sm:pt-10"} aria-hidden>
      <div className="mb-3 flex items-center justify-between">
        <Block className="h-4 w-28" />
        <Block className="h-4 w-40" />
      </div>
      <Block className="h-9 w-2/3" />
      <div className="mt-5 space-y-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Block key={index} index={index} className="h-8 w-full" />
        ))}
      </div>
      <Block className="mt-6 h-[240px] w-full" />
    </div>
  );
}

const TODAY_SPANS: Array<[number, number]> = [
  [12, 4],
  [6, 3],
  [3, 3],
  [3, 3],
  [5, 4],
  [4, 4],
  [3, 2],
  [3, 2],
  [6, 3],
  [6, 3],
];

function DeskShell({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div className="mx-auto box-border w-full max-w-[1224px] px-4 pb-12 pt-5 sm:px-10 sm:pb-14 sm:pt-8" data-route-loading={id}>
      {children}
    </div>
  );
}

function Bento({ spans }: { spans: Array<[number, number]> }) {
  return (
    <div className="grid grid-cols-12 gap-3" style={{ gridAutoRows: "72px" }}>
      {spans.map(([columns, rows], index) => (
        <Skeleton key={index} index={index} className="rounded-[14px]" style={{ gridColumn: `span ${columns}`, gridRow: `span ${rows}` }} />
      ))}
    </div>
  );
}

/** Today desk: page padding, title block, 12-column bento. */
export function TodayRouteSkeleton() {
  return (
    <DeskShell id="today">
      <div className="mb-[18px] flex items-end justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-5 w-24 rounded-full" />
          </div>
          <Skeleton className="h-9 w-32" />
          <Skeleton className="mt-1.5 h-4 w-[min(520px,72vw)]" />
        </div>
        <Skeleton className="h-8 w-16" />
      </div>
      <Bento spans={TODAY_SPANS} />
    </DeskShell>
  );
}

/** Context lens: same desk page, tab row, then the bento. */
export function ContextRouteSkeleton() {
  return (
    <DeskShell id="context">
      <div className="mb-[18px]">
        <div className="mb-1 flex items-center gap-2">
          <Skeleton className="h-5 w-28 rounded-full" />
        </div>
        <Skeleton className="h-9 w-36" />
        <Skeleton className="mt-1.5 h-4 w-[min(520px,72vw)]" />
      </div>
      <div className="mb-4 flex w-fit gap-1 rounded-[10px] border border-line p-[3px]">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} index={index} className="h-7 w-[4.5rem] rounded-md" />
        ))}
      </div>
      <Bento spans={[[8, 3], [4, 3], [6, 3], [6, 3]]} />
    </DeskShell>
  );
}

/** Board: header, filters, five columns. */
export function BoardRouteSkeleton() {
  return (
    <div className="board-frame flex min-h-full min-w-0 flex-col" data-route-loading="board">
      <div className="board-chrome relative z-20 bg-bg">
        <div className="px-4 pt-6 sm:px-6">
          <div className="page-head">
            <div>
              <Skeleton className="h-8 w-48" />
              <Skeleton className="mt-2 h-4 w-72" />
            </div>
          </div>
        </div>
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 px-4 pb-3 pt-2 sm:px-6">
          <Skeleton className="h-8 min-w-0 flex-1 basis-[9rem]" />
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-32" />
          <Skeleton className="ml-auto h-8 w-24" />
        </div>
      </div>
      <div className="flex gap-3 px-5">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="w-[272px] shrink-0 space-y-2">
            <Skeleton index={index} className="h-6 w-24" />
            <Skeleton index={index} className="h-20 w-full" />
            <Skeleton index={index} className="h-20 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Marketplace: title, filters, two heroes, then the card grid. */
export function MarketplaceRouteSkeleton() {
  return (
    <div className="mx-auto min-w-0 max-w-[1180px] px-4 pb-24 pt-8 sm:px-10" data-route-loading="marketplace">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-2 h-8 w-80 max-w-full" />
      <Skeleton className="mt-2 h-4 w-full max-w-[42rem]" />
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-full sm:w-64" />
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} index={index} className="h-9 w-24" />
        ))}
      </div>
      <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2">
        <Skeleton className="h-[320px] w-full rounded-xl" />
        <Skeleton className="h-[320px] w-full rounded-xl" />
      </div>
      <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} index={index} className="h-[260px] w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}

export function Splash({ active }: { active: boolean }) {
  const shown = useDelayedFlag(active);
  if (!shown) return null;
  return (
    <div className="m-splash" data-motion-slot="brand.splash" data-state="reveal" data-motion-loading="1" aria-hidden>
      <span className="m-splash-tile">
        <BrandMorph size={56} state={active ? "loop" : "idle"} />
      </span>
    </div>
  );
}
