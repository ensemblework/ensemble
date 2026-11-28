"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, Info, RefreshCw, Search } from "lucide-react";
import { useState } from "react";
import { INCLUDED_LABEL, INCLUDED_PROVIDER, includedModelName } from "@ensemble/shared-types";
import { IncludedCreditsCard, IncludedLocalOnly } from "@/components/metrics/included-credits";
import { Empty, InfoTip, PageHeader, Spinner, cx } from "@/components/ui";
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
/** AI plans (Claude, ChatGPT, Copilot, Cursor) are paid by the person's own plan: never priced, never credits. */
const PLAN_PROVIDERS = new Set(["claude-code", "codex", "copilot-cli", "cursor-agent", "copilot", "cursor"]);
function costOf(provider: string, row: { estimatedUsd: number | null; credits?: number | null }) {
  if (provider === "ollama") return "Local model";
  if (PLAN_PROVIDERS.has(provider)) return "Your AI plan";
  return spent(row);
}

/** `credits`: Ensemble's own credits are in use, so the chart can show them. */
function ActivityChart({ days, credits }: { days: MetricsSummary["days"]; credits: boolean }) {
  const [chosen, setMode] = useState<"calls" | "tokensIn" | "tokensOut" | "credits">("calls");
  const mode = chosen === "credits" && !credits ? "calls" : chosen;
  const [selected, setSelected] = useState<string | null>(null);
  const peak = Math.max(1, ...days.map(day => day[mode] ?? 0));
  const current = days.find(day => day.day === selected);
  return <section className="tile rounded-xl bg-panel p-5" aria-label="Daily AI activity">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-sm font-semibold">Your AI activity</h2><p className="mt-1 text-xs text-muted">Dates are in UTC.</p></div>
      <div className="flex flex-wrap gap-1 rounded-lg bg-raised p-1" aria-label="Chart measure">
        {([ ["calls", "Calls"], ["tokensIn", "Input tokens"], ["tokensOut", "Output tokens"], ...(credits ? [["credits", "Credits"]] as const : []) ] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={mode === key} onClick={() => setMode(key)} className={cx("rounded-md px-2.5 py-1.5 text-xs", mode === key ? "bg-panel font-medium text-ink shadow-sm" : "text-muted hover:text-ink")}>{label}</button>)}
      </div>
    </div>
    <div className="mt-6 flex h-36 items-end gap-1 border-b border-line" role="group" aria-label="Activity by day">
      {days.map(day => <button key={day.day} type="button" className="group relative flex h-full min-w-0 flex-1 items-end rounded-t outline-offset-2" aria-label={`${day.day}: ${day.calls} calls, ${count(day.tokensIn)} input tokens, ${count(day.tokensOut)} output tokens, ${spent(day)}`} aria-pressed={selected === day.day} onMouseEnter={() => setSelected(day.day)} onFocus={() => setSelected(day.day)} onClick={() => setSelected(day.day)}>
        <span className={cx("w-full rounded-t transition-all", selected === day.day ? "bg-accent" : "bg-accent/55 group-hover:bg-accent")} style={{ height: `${day[mode] ? Math.max(3, ((day[mode] ?? 0) / peak) * 100) : 0}%` }} />
      </button>)}
    </div>
    <div className="mt-2 flex justify-between text-xs text-faint"><span>{days[0]?.day}</span><span>{days.at(-1)?.day}</span></div>
    <p className="mt-4 min-h-5 text-xs text-muted" aria-live="polite">{current ? `${current.day}: ${current.calls} ${current.calls === 1 ? "call" : "calls"} · ${count(current.tokensIn + current.tokensOut)} tokens · ${spent(current)}` : "Select a day for its totals."}</p>
  </section>;
}

/** One call: what it was, then its purpose, time, provider and model on the second line. */
function RecentCall({ call }: { call: UsageCall }) {
  const second = `${call.purpose} · ${dateTime(call.at)} · ${providerName(call.provider)} · ${modelName(call.provider, call.model)}`;
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line py-4" data-call-provider={call.provider}>
    <div className="min-w-0 flex-[2] basis-56"><p className="truncate text-sm font-medium" title={call.title}>{call.title}</p><p className="mt-1 truncate text-xs text-muted" title={second} data-call-line>{second}</p></div>
    <div className="flex min-w-0 flex-1 basis-48 justify-between gap-4 text-xs tabular-nums"><span><span className="block text-faint">Input tokens</span><strong className="mt-1 block font-medium">{count(call.tokensIn)}</strong></span><span><span className="block text-faint">Output tokens</span><strong className="mt-1 block font-medium">{count(call.tokensOut)}</strong></span></div>
    <span className="ml-auto min-w-24 text-right text-sm font-medium" data-call-cost>{costOf(call.provider, call)}</span>
  </div>;
}

export default function MetricsPage() {
  const [provider, setProvider] = useState("all");
  const [windowDays, setWindowDays] = useState(14);
  const [search, setSearch] = useState("");
  const [more, setMore] = useState(false);
  const [allModels, setAllModels] = useState(false);
  const [allPurposes, setAllPurposes] = useState(false);
  const metrics = useQuery({ queryKey: ["metrics", provider, windowDays], queryFn: () => api.metrics(provider, windowDays), placeholderData: keepPreviousData });
  const credits = useIncludedUsage();
  const data = metrics.data;
  const providerChoices = [...new Set([...(data?.providers ?? []), ...(provider === "all" ? [] : [provider])])];
  const calls = data?.byModel.reduce((sum, row) => sum + row.calls, 0) ?? 0;
  const input = data?.byModel.reduce((sum, row) => sum + row.tokensIn, 0) ?? 0;
  const output = data?.byModel.reduce((sum, row) => sum + row.tokensOut, 0) ?? 0;
  const recent = data?.recent.filter(call => `${call.title} ${call.model} ${call.purpose}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const maxCalls = Math.max(1, ...data?.byModel.map(row => row.calls) ?? []);
  const models = [...(data?.byModel ?? [])].sort((a, b) => b.calls - a.calls);
  const purposes = (data?.byPurpose ?? []).filter(row => row.calls > 0).sort((a, b) => b.calls - a.calls);
  return <div className="mx-auto max-w-[1200px] px-4 pb-24 pt-8 sm:px-8">
    <PageHeader title="Metrics" actions={<div className="flex flex-wrap items-center gap-2">
      <InfoTip label="About usage" text="Only calls through Ensemble appear here, with token counts as each provider reports them; missing means not reported, not zero. Input is what the model was sent, output what it wrote, including reasoning when the provider counts it. An agent may report one total for a whole run. Calls on your AI plan use that plan; Ensemble does not read its balance. Dollar costs are list-price estimates." />
      <select aria-label="Provider" value={provider} onChange={event => { setProvider(event.target.value); setMore(false); }} className="field text-sm"><option value="all">All providers</option>{providerChoices.map(id => <option key={id} value={id}>{providerName(id)}</option>)}</select>
      <select aria-label="Usage period" value={windowDays} onChange={event => setWindowDays(Number(event.target.value))} className="field text-sm"><option value={14}>Last 14 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select>
      <button type="button" className="icon-btn" aria-label="Refresh usage" disabled={metrics.isFetching} onClick={() => { void metrics.refetch(); void credits.refetch(); }}>{metrics.isFetching ? <Spinner size={15} /> : <RefreshCw size={15} />}</button>
    </div>} />
    {metrics.error ? <p role="alert" className="mb-4 rounded-lg border border-danger/40 p-3 text-sm text-danger">{metrics.error.message}</p> : null}
    <div className="space-y-5">
      {credits.data?.available ? <IncludedCreditsCard usage={credits.data} /> : credits.data?.localOnly ? <IncludedLocalOnly /> : credits.error ? <p role="alert" className="text-sm text-danger">Could not load credits: {credits.error.message}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted"><span>{provider === "all" ? "All Ensemble activity" : providerName(provider)} · last {windowDays} days</span>{metrics.isFetching ? <span>Updating usage…</span> : null}</div>
      {data?.truncated ? <p role="note" className="text-sm text-muted">This window exceeds 5,000 records from a usage source. Choose a shorter period for complete totals.</p> : null}
      <div className={cx("space-y-5 transition-opacity", metrics.isPlaceholderData && "pointer-events-none opacity-50")} aria-busy={metrics.isFetching}>
        <div className="grid gap-3 sm:grid-cols-3">
          {[{ title: "AI calls", value: calls, detail: "Requests made through Ensemble", icon: Info }, { title: "Input tokens", value: input, detail: "Context you sent to your models", icon: ArrowUpRight }, { title: "Output tokens", value: output, detail: "Content generated by your models", icon: ArrowDownLeft }].map(stat => <div key={stat.title} className="tile rounded-xl bg-panel p-5"><div className="flex items-center justify-between text-xs text-muted">{stat.title}<stat.icon size={15} /></div><div className="mt-3 text-3xl font-semibold tabular-nums">{metrics.isLoading ? "…" : count(stat.value)}</div><p className="mt-2 text-xs text-faint">{stat.detail}</p></div>)}
        </div>
        {data?.reporting && (data.reporting.withInput < calls || data.reporting.withOutput < calls) ? <p className="flex items-start gap-2 text-xs text-muted"><Info size={14} className="shrink-0" />Token totals include reported values only. Input counts: {data.reporting.withInput} of {calls} calls; output counts: {data.reporting.withOutput} of {calls} calls.</p> : null}
        {data ? <ActivityChart days={data.days} credits={Boolean(credits.data?.available) || data.days.some(day => day.credits != null)} /> : null}
        <div className="grid gap-4 md:grid-cols-2">
          <section className="tile min-w-0 rounded-xl bg-panel p-5">
            <h2 className="mb-4 text-sm font-semibold">Models you used</h2>
            {!models.length ? <Empty>No model calls recorded in this period.</Empty> : <div id="usage-models" className="space-y-4">{models.slice(0, allModels ? undefined : 5).map(row => <div key={`${row.provider}:${row.model}`} data-model-row={`${row.provider}:${row.model}`}><div className="flex items-start justify-between gap-3 text-xs"><span className="min-w-0"><span className="block truncate font-medium" title={modelName(row.provider, row.model)}>{modelName(row.provider, row.model)}</span><span className="mt-1 block text-faint">{providerName(row.provider)}</span></span><span className="shrink-0 text-right text-muted">{row.calls} calls · {costOf(row.provider, row)}</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-accent" style={{ width: `${row.calls / maxCalls * 100}%` }} /></div></div>)}</div>}
            {models.length > 5 ? <button type="button" className="btn-ghost mt-3 text-xs" aria-expanded={allModels} aria-controls="usage-models" onClick={() => setAllModels(value => !value)}>{allModels ? "Show fewer models" : `Show all ${models.length} models`}</button> : null}
          </section>
          <section className="tile min-w-0 rounded-xl bg-panel p-5">
            <h2 className="mb-4 text-sm font-semibold">Where your usage went</h2>
            {!purposes.length ? <Empty>No activity recorded.</Empty> : <div id="usage-purposes" className="space-y-4">{purposes.slice(0, allPurposes ? undefined : 5).map(row => <div key={row.purpose} data-purpose-row={row.purpose} className="flex items-start justify-between gap-3 border-b border-line pb-3 text-xs"><div className="min-w-0 break-words"><strong className="font-medium">{row.purpose}</strong><p className="mt-1 text-faint">{count(row.tokensIn + row.tokensOut)} reported tokens</p></div><span className="shrink-0 text-right text-muted">{row.calls} calls<br /><span className="mt-1 block">{spent(row)}</span></span></div>)}</div>}
            {purposes.length > 5 ? <button type="button" className="btn-ghost mt-3 text-xs" aria-expanded={allPurposes} aria-controls="usage-purposes" onClick={() => setAllPurposes(value => !value)}>{allPurposes ? "Show fewer purposes" : `Show all ${purposes.length} purposes`}</button> : null}
          </section>
        </div>
        <section className="tile rounded-xl bg-panel p-5"><div className="mb-3 flex flex-wrap items-center justify-between gap-3"><h2 className="text-sm font-semibold">Most recent calls</h2><label className="flex items-center gap-2 rounded-lg border border-line px-3 py-2"><Search size={14} className="shrink-0 text-muted" /><input type="search" aria-label="Search recent calls" placeholder="Find a call…" value={search} onChange={event => setSearch(event.target.value)} className="w-40 min-w-0 bg-transparent text-xs outline-none" /></label></div>
          {!recent.length ? <Empty>{search ? "No recent calls match." : "No calls recorded in this period."}</Empty> : recent.slice(0, more ? 40 : 5).map((call, index) => <RecentCall key={`${call.at}-${index}`} call={call} />)}
          {recent.length > 5 ? <button type="button" className="mt-3 text-xs text-accent" onClick={() => setMore(!more)}>{more ? "Show fewer" : `Show ${recent.length - 5} more calls`}</button> : null}
        </section>
      </div>
    </div>
  </div>;
}
