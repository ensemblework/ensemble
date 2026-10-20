"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, Info, RefreshCw, Search } from "lucide-react";
import { useState } from "react";
import { INCLUDED_LABEL, INCLUDED_PROVIDER, includedModelName } from "@ensemble/shared-types";
import { IncludedCreditsCard, IncludedLocalOnly } from "@/components/metrics/included-credits";
import { Empty, PageHeader, cx } from "@/components/ui";
import { api, type MetricsSummary, type UsageCall } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { creditAmount, useIncludedUsage } from "@/lib/included";

const PROVIDERS: Record<string, string> = { ensemble: INCLUDED_LABEL, openai: "OpenAI", anthropic: "Anthropic", google: "Google", "claude-code": "Claude Code", codex: "Codex", "copilot-cli": "GitHub Copilot", "cursor-agent": "Cursor", copilot: "GitHub Copilot", cursor: "Cursor", ollama: "Ollama (local)", unknown: "Unreported provider" };
const providerName = (id: string) => PROVIDERS[id] ?? id;
const modelName = (provider: string, model: string) => provider === INCLUDED_PROVIDER ? includedModelName(model) : model;
const count = (value: number | null) => value == null ? "Not reported" : value.toLocaleString("en-US");
function money(value: number): string { return value === 0 ? "$0" : `$${value.toFixed(value < 0.01 ? 4 : 2)}`; }
function spent(row: { estimatedUsd: number | null; credits?: number | null }): string {
  return [row.estimatedUsd == null ? null : money(row.estimatedUsd), row.credits == null ? null : creditAmount(row.credits)].filter(Boolean).join(" · ") || "Not reported";
}
function callCost(call: UsageCall) {
  if (call.provider === "ollama") return "Local model";
  if (["claude-code", "codex", "copilot-cli", "cursor-agent", "copilot", "cursor"].includes(call.provider)) return "Your AI plan";
  return spent(call);
}

function ActivityChart({ days }: { days: MetricsSummary["days"] }) {
  const [mode, setMode] = useState<"calls" | "tokensIn" | "tokensOut" | "credits">("calls");
  const [selected, setSelected] = useState<string | null>(null);
  const peak = Math.max(1, ...days.map(day => day[mode] ?? 0));
  const current = days.find(day => day.day === selected);
  return <section className="tile rounded-xl bg-panel p-5" aria-label="Daily AI activity">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-sm font-semibold">Your AI activity</h2><p className="mt-1 text-xs text-muted">Explore a day to see how you used AI. Dates are in UTC.</p></div>
      <div className="flex flex-wrap gap-1 rounded-lg bg-raised p-1" aria-label="Chart measure">
        {([ ["calls", "Calls"], ["tokensIn", "Input tokens"], ["tokensOut", "Output tokens"], ["credits", "Credits"] ] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={mode === key} onClick={() => setMode(key)} className={cx("rounded-md px-2.5 py-1.5 text-xs", mode === key ? "bg-panel font-medium text-ink shadow-sm" : "text-muted hover:text-ink")}>{label}</button>)}
      </div>
    </div>
    <div className="mt-6 flex h-36 items-end gap-1 border-b border-line" role="group" aria-label="Activity by day">
      {days.map(day => <button key={day.day} type="button" className="group relative flex h-full min-w-0 flex-1 items-end rounded-t outline-offset-2" aria-label={`${day.day}: ${day.calls} calls, ${count(day.tokensIn)} input tokens, ${count(day.tokensOut)} output tokens, ${spent(day)}`} aria-pressed={selected === day.day} onMouseEnter={() => setSelected(day.day)} onFocus={() => setSelected(day.day)} onClick={() => setSelected(day.day)}>
        <span className={cx("w-full rounded-t transition-all", selected === day.day ? "bg-accent" : "bg-accent/55 group-hover:bg-accent")} style={{ height: `${day[mode] ? Math.max(3, ((day[mode] ?? 0) / peak) * 100) : 0}%` }} />
      </button>)}
    </div>
    <div className="mt-2 flex justify-between text-xs text-faint"><span>{days[0]?.day}</span><span>{days.at(-1)?.day}</span></div>
    <p className="mt-4 min-h-5 text-xs text-muted" aria-live="polite">{current ? `${current.day}: ${current.calls} ${current.calls === 1 ? "call" : "calls"} · ${count(current.tokensIn + current.tokensOut)} tokens · ${spent(current)}` : "Hover, focus or select a day for its calls, tokens and cost."}</p>
  </section>;
}

function RecentCall({ call }: { call: UsageCall }) {
  return <details className="group border-t border-line" data-call-provider={call.provider}>
    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-3 py-4 marker:content-none [&::-webkit-details-marker]:hidden">
      <div className="min-w-0 flex-[2] basis-56"><p className="truncate text-sm font-medium" title={call.title}>{call.title}</p><p className="mt-1 text-xs text-muted">{providerName(call.provider)} · {modelName(call.provider, call.model)}</p></div>
      <div className="flex min-w-0 flex-1 basis-48 justify-between gap-4 text-xs tabular-nums"><span><span className="block text-faint">Input tokens</span><strong className="mt-1 block font-medium">{count(call.tokensIn)}</strong></span><span><span className="block text-faint">Output tokens</span><strong className="mt-1 block font-medium">{count(call.tokensOut)}</strong></span></div>
      <div className="ml-auto flex items-center gap-3"><span className="min-w-24 text-right text-sm font-medium">{callCost(call)}</span><ChevronDown size={14} className="text-muted transition-transform group-open:rotate-180" /></div>
    </summary>
    <div className="mb-4 rounded-lg bg-raised p-4 text-xs leading-5 text-muted"><p>{call.purpose} · {dateTime(call.at)}</p><p className="mt-2">{call.purpose === "Delegated tasks" ? "An external agent may report one total for its run, which can include multiple model calls. " : ""}Input is the context sent to the model, including instructions, conversation and attachments. Output is what the model generated, including reasoning when the provider counts it.</p>{call.tokensIn == null || call.tokensOut == null ? <p className="mt-2">This provider did not report every token count for this call. Unreported values are excluded from token totals.</p> : null}<p className="mt-2">{call.provider === "ensemble" ? "This call used your monthly Ensemble credits." : call.provider === "ollama" ? "This call ran on your local model. Ensemble does not measure your computer’s electricity or hardware costs." : ["claude-code", "codex", "copilot-cli", "cursor-agent", "copilot", "cursor"].includes(call.provider) ? "This call used your AI plan. Plan balance and usage outside Ensemble are not read." : call.estimatedUsd == null ? "The price for this model is unavailable; no cost is assumed." : "Cost is an estimate at the model’s published list price, not an invoice."}</p></div>
  </details>;
}

export default function MetricsPage() {
  const [provider, setProvider] = useState("all");
  const [windowDays, setWindowDays] = useState(14);
  const [search, setSearch] = useState("");
  const [more, setMore] = useState(false);
  const metrics = useQuery({ queryKey: ["metrics", provider, windowDays], queryFn: () => api.metrics(provider, windowDays), placeholderData: keepPreviousData });
  const credits = useIncludedUsage();
  const data = metrics.data;
  const providerChoices = [...new Set([...(data?.providers ?? []), ...(provider === "all" ? [] : [provider])])];
  const calls = data?.byModel.reduce((sum, row) => sum + row.calls, 0) ?? 0;
  const input = data?.byModel.reduce((sum, row) => sum + row.tokensIn, 0) ?? 0;
  const output = data?.byModel.reduce((sum, row) => sum + row.tokensOut, 0) ?? 0;
  const recent = data?.recent.filter(call => `${call.title} ${call.model} ${call.purpose}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const maxCalls = Math.max(1, ...data?.byModel.map(row => row.calls) ?? []);
  return <div className="mx-auto max-w-[1200px] px-4 pb-24 pt-8 sm:px-8">
    <PageHeader title="Metrics" description="Understand the AI you use through Ensemble. Your personal activity in other apps stays private." actions={<div className="flex flex-wrap items-center gap-2">
      <select aria-label="Provider" value={provider} onChange={event => { setProvider(event.target.value); setMore(false); }} className="field text-sm"><option value="all">All providers</option>{providerChoices.map(id => <option key={id} value={id}>{providerName(id)}</option>)}</select>
      <select aria-label="Usage period" value={windowDays} onChange={event => setWindowDays(Number(event.target.value))} className="field text-sm"><option value={14}>Last 14 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select>
      <button type="button" className="icon-btn" aria-label="Refresh usage" disabled={metrics.isFetching} onClick={() => { void metrics.refetch(); void credits.refetch(); }}><RefreshCw size={15} className={metrics.isFetching ? "animate-spin" : ""} /></button>
    </div>} />
    {metrics.error ? <p role="alert" className="mb-4 rounded-lg border border-danger/40 p-3 text-sm text-danger">{metrics.error.message}</p> : null}
    <div className="space-y-5">
      {credits.data?.available ? <IncludedCreditsCard usage={credits.data} /> : credits.data?.localOnly ? <IncludedLocalOnly /> : credits.error ? <p role="alert" className="text-sm text-danger">Could not load credits: {credits.error.message}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted"><span>{provider === "all" ? "All Ensemble activity" : providerName(provider)} · last {windowDays} days</span><span>{metrics.isFetching ? "Updating usage…" : "Provider and date filters apply below. Credits above cover the UTC calendar month."}</span></div>
      {data?.truncated ? <p role="note" className="text-sm text-muted">This window exceeds 5,000 records from a usage source. Choose a shorter period for complete totals.</p> : null}
      <div className={cx("space-y-5 transition-opacity", metrics.isPlaceholderData && "pointer-events-none opacity-50")} aria-busy={metrics.isFetching}>
        <div className="grid gap-3 sm:grid-cols-3">
          {[{ title: "AI calls", value: calls, detail: "Requests made through Ensemble", icon: Info }, { title: "Input tokens", value: input, detail: "Context you sent to your models", icon: ArrowUpRight }, { title: "Output tokens", value: output, detail: "Content generated by your models", icon: ArrowDownLeft }].map(stat => <div key={stat.title} className="tile rounded-xl bg-panel p-5"><div className="flex items-center justify-between text-xs text-muted">{stat.title}<stat.icon size={15} /></div><div className="mt-3 text-3xl font-semibold tabular-nums">{metrics.isLoading ? "…" : count(stat.value)}</div><p className="mt-2 text-xs text-faint">{stat.detail}</p></div>)}
        </div>
        {data?.reporting && (data.reporting.withInput < calls || data.reporting.withOutput < calls) ? <p className="flex items-start gap-2 text-xs text-muted"><Info size={14} className="shrink-0" />Token totals include reported values only. Input counts: {data.reporting.withInput} of {calls} calls; output counts: {data.reporting.withOutput} of {calls} calls.</p> : null}
        {data ? <ActivityChart days={data.days} /> : null}
        <div className="grid gap-4 md:grid-cols-2">
          <section className="tile rounded-xl bg-panel p-5"><h2 className="mb-4 text-sm font-semibold">Models you used</h2>{!data?.byModel.length ? <Empty>No model calls recorded in this period.</Empty> : <div className="space-y-4">{data.byModel.map(row => <div key={`${row.provider}:${row.model}`} data-model-row={`${row.provider}:${row.model}`}><div className="flex items-start justify-between gap-3 text-xs"><span className="min-w-0"><span className="block truncate font-medium">{modelName(row.provider, row.model)}</span><span className="mt-1 block text-faint">{providerName(row.provider)}</span></span><span className="shrink-0 text-right text-muted">{row.calls} calls · {spent(row)}</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-accent" style={{ width: `${row.calls / maxCalls * 100}%` }} /></div></div>)}</div>}</section>
          <section className="tile rounded-xl bg-panel p-5"><h2 className="mb-4 text-sm font-semibold">Where your usage went</h2>{!data?.byPurpose.length ? <Empty>No activity recorded.</Empty> : <div className="space-y-4">{data.byPurpose.filter(row => row.calls > 0).map(row => <div key={row.purpose} className="flex items-start justify-between gap-3 border-b border-line pb-3 text-xs"><div><strong className="font-medium">{row.purpose}</strong><p className="mt-1 text-faint">{count(row.tokensIn + row.tokensOut)} reported tokens</p></div><span className="text-right text-muted">{row.calls} calls<br /><span className="mt-1 block">{spent(row)}</span></span></div>)}</div>}</section>
        </div>
        <section className="tile rounded-xl bg-panel p-5"><div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-semibold">Most recent calls</h2><p className="mt-1 text-xs text-muted">Open a call for its time, purpose and how usage is counted.</p></div><label className="flex items-center gap-2 rounded-lg border border-line px-3 py-2"><Search size={14} className="shrink-0 text-muted" /><input type="search" aria-label="Search recent calls" placeholder="Find a call…" value={search} onChange={event => setSearch(event.target.value)} className="w-40 min-w-0 bg-transparent text-xs outline-none" /></label></div>
          {!recent.length ? <Empty>{search ? "No recent calls match." : "No calls recorded in this period."}</Empty> : recent.slice(0, more ? 40 : 5).map((call, index) => <RecentCall key={`${call.at}-${index}`} call={call} />)}
          {recent.length > 5 ? <button type="button" className="mt-3 text-xs text-accent" onClick={() => setMore(!more)}>{more ? "Show fewer" : `Show ${recent.length - 5} more calls`}</button> : null}
          <p className="mt-4 flex items-start gap-2 border-t border-line pt-4 text-xs leading-5 text-muted"><Info size={14} className="mt-0.5 shrink-0" />Only calls routed through Ensemble appear here. Token counts come from each call’s response. AI plan balances and usage in other apps are never fetched. Missing counts or prices mean “not reported”, rather than zero.</p>
        </section>
      </div>
    </div>
  </div>;
}
