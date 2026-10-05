"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Info, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Held } from "@/components/motion/held";
import { MetricsSkeleton } from "@/components/motion/skeletons";
import { Empty, PageHeader, Tag } from "@/components/ui";
import { api, type MetricsSummary } from "@/lib/api";
import { dateTime } from "@/lib/format";

function countNoun(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function minutesLabel(seconds: number, digits: number): string {
  const minutes = Math.max(0, seconds / 60);
  const text = minutes.toFixed(digits);
  return text.startsWith("-") ? (0).toFixed(digits) : text;
}

const PURPOSE_COLORS: Record<string, string> = {
  "Hub chat": "rgb(var(--accent-rgb))",
  "Delegated tasks": "color-mix(in srgb, rgb(var(--accent-rgb)) 55%, rgb(var(--ok-rgb)))",
  "Meeting extraction": "color-mix(in srgb, rgb(var(--accent-rgb)) 45%, rgb(var(--warn-rgb)))",
};

function money(value: number | null): string {
  if (value == null) return "—";
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function DailySpend({ days }: { days: MetricsSummary["days"] }) {
  const peak = Math.max(...days.map((day) => day.calls), 0);
  const scale = peak || 1;
  return (
    <div className="tile rounded-lg bg-panel p-4">
      <div className="mb-3 flex items-center justify-between text-[13px]">
        <span className="font-semibold">Calls per day</span>
        <span className="text-muted">peak {countNoun(peak, "call")}</span>
      </div>
      <div className="relative flex h-36 items-end gap-1.5 border-b border-dashed border-line-strong">
        {days.map((day) => (
          <div key={day.day} className="group relative flex flex-1 flex-col items-center justify-end" style={{ height: "100%" }}>
            <div
              className="w-full rounded-t bg-accent opacity-80 transition-opacity group-hover:opacity-100"
              style={{ height: `${Math.max((day.calls / scale) * 100, day.calls ? 3 : 0)}%` }}
            />
            <div className="pointer-events-none absolute -top-7 hidden whitespace-nowrap rounded bg-raised px-1.5 py-0.5 text-2xs shadow-pop group-hover:block">
              {day.day}: {countNoun(day.calls, "call")} · {day.tokensIn + day.tokensOut} tokens · {money(day.estimatedUsd)}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-2xs text-faint">
        <span>{days[0]?.day}</span>
        <span>{days[days.length - 1]?.day}</span>
      </div>
    </div>
  );
}

function Donut({ rows }: { rows: MetricsSummary["byPurpose"] }) {
  const calls = rows.reduce((sum, row) => sum + row.calls, 0);
  const total = calls;
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="flex items-center gap-6">
      <svg width="120" height="120" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={radius} fill="none" stroke="var(--raised)" strokeWidth="14" />
        {rows.map((row) => {
          const fraction = calls ? row.calls / calls : 0;
          const dash = fraction * circumference;
          const element = (
            <circle
              key={row.purpose}
              cx="60"
              cy="60"
              r={radius}
              fill="none"
              stroke={PURPOSE_COLORS[row.purpose] ?? "var(--tag-gray-fg)"}
              strokeWidth="14"
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 60 60)"
            />
          );
          offset += dash;
          return element;
        })}
        <text x="60" y="58" textAnchor="middle" className="fill-[rgb(var(--ink-rgb))] text-[18px] font-bold">
          {calls}
        </text>
        <text x="60" y="74" textAnchor="middle" className="fill-[rgb(var(--muted-rgb))] text-[10px]">
          {calls === 1 ? "call" : "calls"}
        </text>
      </svg>
      <div className="space-y-1 text-[12.5px]">
        {["Hub chat", "Delegated tasks", "Meeting extraction"].map((purpose) => {
          const row = rows.find((item) => item.purpose === purpose);
          return (
            <div key={purpose} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: PURPOSE_COLORS[purpose] }} />
              {purpose} · {countNoun(row?.calls ?? 0, "call")} · {(row?.tokensIn ?? 0) + (row?.tokensOut ?? 0)} tokens · {money(row?.estimatedUsd ?? null)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="tile rounded-lg bg-panel p-4 text-[12.5px]">
      <div className="mb-1.5 text-[14px] font-semibold">{title}</div>
      <div className="space-y-0.5 text-muted">{children}</div>
    </div>
  );
}

export default function MetricsPage() {
  const metrics = useQuery({ queryKey: ["metrics"], queryFn: api.metrics });
  const [more, setMore] = useState(false);
  const [provider, setProvider] = useState("all");
  const verify = useMutation({ mutationFn: api.verifyLedger });
  const data = metrics.data;
  const shown = data
    ? {
        ...data,
        byModel: data.byModel.filter((row) => provider === "all" || row.provider === provider),
        recent: data.recent.filter((row) => provider === "all" || row.provider === provider),
      }
    : null;
  const maxModel = Math.max(...(shown?.byModel.map((row) => row.calls) ?? [1]), 1);

  return (
    <div className="mx-auto max-w-[1100px] px-10 pb-24 pt-8">
      <PageHeader
        title="Metrics"
        description="Calls, models, tokens and estimated cost over the last 14 days. Dollar amounts use published list prices when we know them. Token counts are what the provider returned."
        actions={
          <select value={provider} onChange={(event) => setProvider(event.target.value)} className="field">
            <option value="all">All providers</option>
            {(data?.providers ?? []).filter((name) => name !== "unknown").map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        }
      />
      <Held pending={metrics.isLoading || !shown} fallback={<MetricsSkeleton />}>
        {shown ? <div className="space-y-4">
          <DailySpend days={shown.days} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="tile rounded-lg bg-panel p-4">
              <div className="mb-3 text-[13px] font-semibold">By model</div>
              {shown.byModel.length === 0 ? (
                <Empty>No model calls yet.</Empty>
              ) : (
                <div className="space-y-2">
                  {shown.byModel.map((row) => (
                    <div key={row.model} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_150px] items-center gap-3 text-[12.5px]">
                      <span className="truncate">{row.model}</span>
                      <div className="h-2.5 overflow-hidden rounded bg-raised">
                        <div className="h-full rounded bg-accent" style={{ width: `${(row.calls / maxModel) * 100}%` }} />
                      </div>
                      <span className="text-right text-muted">
                        {countNoun(row.calls, "call")} · {money(row.estimatedUsd)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="tile rounded-lg bg-panel p-4">
              <div className="mb-3 text-[13px] font-semibold">What asked for it</div>
              <Donut rows={shown.byPurpose} />
            </div>
          </div>

          <div className="tile rounded-lg bg-panel p-4">
            <div className="mb-2 text-[13px] font-semibold">Most recent calls</div>
            {shown.recent.length === 0 ? (
              <Empty>No calls recorded.</Empty>
            ) : (
              <>
                {shown.recent.slice(0, more ? 40 : 5).map((call, index) => (
                  <div key={`${call.at}-${index}`} className="row-tile flex items-center gap-3 rounded border-b border-b-line px-2 py-1.5 text-[12.5px]">
                    <span className="min-w-0 flex-1 truncate font-medium">{call.title}</span>
                    <span className="text-muted">
                      {call.provider} · {call.model} · in {call.tokensIn ?? "—"} · out {call.tokensOut ?? "—"} · {dateTime(call.at)}
                    </span>
                    <span className="w-16 text-right text-muted">{money(call.estimatedUsd)}</span>
                  </div>
                ))}
                {shown.recent.length > 5 ? (
                  <button type="button" className="mt-2 text-[12.5px] text-accent hover:underline" onClick={() => setMore(!more)}>
                    {more ? "Show fewer" : `Show ${Math.min(35, shown.recent.length - 5)} more (${shown.recent.length - 5} left)`}
                  </button>
                ) : null}
              </>
            )}
            <div className="mt-3 flex items-start gap-2 rounded-md border border-line bg-raised p-2 text-[12px] text-muted">
              <Info size={13} className="mt-0.5 shrink-0" />
              Token counts come back from the provider on each call. A dollar figure is an estimate from that vendor&apos;s published list price, and only when Ensemble knows the price for that exact model. Your invoice is in the provider&apos;s billing page.
            </div>
          </div>

          <div>
            <div className="mb-2 text-[12.5px] text-muted">
              Baselines are self-measured stopwatch samples · <Tag tone="orange">provisional</Tag> small samples until you have a few working days of data
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
              {shown.baselines.length === 0 ? (
                <Stat title="Morning triage">
                  <div>No baseline captured yet.</div>
                  <div>Record one in eval/baseline.md, then the Hub compares against it.</div>
                </Stat>
              ) : (
                shown.baselines.map((row) => (
                  <Stat key={row.kind} title={row.kind}>
                    <div className="text-[18px] font-bold text-ink">
                      <span className="text-muted line-through">{Math.max(0, Math.round(row.baselineSeconds / 60))}</span> →{" "}
                      {row.currentSeconds !== null ? `${minutesLabel(row.currentSeconds, 1)} min` : "not enough data"}
                    </div>
                    {row.currentSeconds !== null && row.currentSeconds < row.baselineSeconds ? <Tag tone="green">Improved</Tag> : null}
                    <div>{row.observations} observations · baseline n={row.sampleSize}</div>
                    {row.note ? <div>{row.note}</div> : null}
                  </Stat>
                ))
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Stat title="Agent throughput">
              <div>{countNoun(shown.throughput.completed, "task")} completed in this window</div>
              <div>{shown.throughput.failed} failed</div>
              <div>Median time to completion: {shown.throughput.medianMinutes === null ? "not enough data" : `${minutesLabel(shown.throughput.medianMinutes * 60, 0)} min`}</div>
              <div>{shown.throughput.waitingOnYou} waiting on you now</div>
            </Stat>
            <Stat title="Trust">
              <div>
                {shown.trust.approved} approved as-is · {shown.trust.edited} edited · {shown.trust.rejected} rejected
              </div>
              <div>
                {shown.trust.approved + shown.trust.edited + shown.trust.rejected
                  ? `${Math.round((shown.trust.approved / (shown.trust.approved + shown.trust.edited + shown.trust.rejected)) * 100)}% accepted without edits`
                  : "Nothing delegated yet"}
              </div>
            </Stat>
            <Stat title="Governance">
              <div>{shown.governance.ledgerEntries} actions recorded in the ledger</div>
              <div className="mt-1 flex items-center gap-2">
                <button type="button" className="btn py-0.5" onClick={() => verify.mutate()} disabled={verify.isPending}>
                  <ShieldCheck size={12} /> Verify hash chain
                </button>
                {verify.data ? (
                  <Tag tone={verify.data.ok ? "green" : "red"}>
                    {verify.data.ok ? `intact · ${verify.data.checked} rows` : `broken at ${verify.data.brokenAt?.slice(0, 8)}`}
                  </Tag>
                ) : null}
              </div>
            </Stat>
          </div>
        </div> : null}
      </Held>
    </div>
  );
}
