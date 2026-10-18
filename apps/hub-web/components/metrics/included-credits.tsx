"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { CONNECT_COMPUTER_HREF, INCLUDED_PROVIDER, includedModelName, type IncludedUsage } from "@ensemble/shared-types";
import { CircleAlert, Unplug } from "lucide-react";
import Link from "next/link";
import { creditAmount, includedBlocked, resetDay, tokenCount, wholeCredits } from "@/lib/included";
import { ProviderLogo } from "../connectors/provider-logo";
import { cx, Empty } from "../ui";

/** Every day of the credits month, oldest first, with what was spent on it so far. */
export function monthDays(usage: Pick<IncludedUsage, "period" | "days">): Array<{ day: string; credits: number; calls: number }> {
  const [year, month] = usage.period.split("-").map(Number);
  if (!year || !month) return usage.days;
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: count }, (_, index) => {
    const day = `${usage.period}-${String(index + 1).padStart(2, "0")}`;
    const found = usage.days.find((row) => row.day === day);
    return { day, credits: found?.credits ?? 0, calls: found?.calls ?? 0 };
  });
}

function dayLabel(day: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${day}T00:00:00Z`));
}

function CreditsPerDay({ usage }: { usage: IncludedUsage }) {
  const days = monthDays(usage);
  const peak = Math.max(...days.map((day) => day.credits), 0);
  return (
    <div data-testid="credits-per-day">
      <div className="mb-2 flex items-center justify-between text-[12.5px]">
        <span className="font-medium">Credits per day</span>
        <span className="text-muted">{peak ? `peak ${creditAmount(peak)}` : "none spent yet"}</span>
      </div>
      <div className="flex h-16 items-end gap-[2px] border-b border-line">
        {days.map((day) => (
          <div key={day.day} className="group relative flex h-full flex-1 items-end justify-center" data-day={day.day}>
            <div
              className="w-full max-w-[24px] rounded-t-[4px] bg-accent opacity-80 transition-opacity group-hover:opacity-100"
              style={{ height: `${peak ? Math.max((day.credits / peak) * 100, day.credits ? 4 : 0) : 0}%` }}
            />
            <div className="pointer-events-none absolute -top-7 z-10 hidden whitespace-nowrap rounded bg-raised px-1.5 py-0.5 text-2xs shadow-pop group-hover:block">
              {dayLabel(day.day)}: {creditAmount(day.credits)} · {day.calls === 1 ? "1 call" : `${day.calls} calls`}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-2xs text-faint">
        <span>{days[0] ? dayLabel(days[0].day) : ""}</span>
        <span>{days.length ? dayLabel(days[days.length - 1]!.day) : ""}</span>
      </div>
    </div>
  );
}

/**
 * A local-only desktop app or CLI. The included models and the monthly credits belong to an
 * Ensemble account and run on Ensemble's server, so they wait until this computer is connected.
 * `compact`: the assistant's model menu.
 */
export function IncludedLocalOnly({ compact = false, onNavigate }: { compact?: boolean; onNavigate?: () => void }) {
  return (
    <div role="note" data-testid="included-local-only" className={cx("flex items-start gap-2.5 rounded-lg border border-line bg-raised", compact ? "px-3 py-2" : "mt-3 px-3 py-2.5")}>
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent/15 text-accent" aria-hidden>
        <Unplug size={14} />
      </span>
      <div className="min-w-0 flex-1 text-[12.5px]">
        <div className="font-medium text-ink">Included models need your Ensemble account</div>
        <p className="mt-0.5 text-muted">
          This computer is local only. Connect it to your account to use the included models and your monthly Ensemble credits. Your own API keys and AI plans work either way.
        </p>
        <Link href={CONNECT_COMPUTER_HREF} className="btn mt-2 inline-flex" onClick={onNavigate}>
          Connect this computer
        </Link>
      </div>
    </div>
  );
}

/**
 * The Metrics page's "Ensemble credits": what is left this month, when it resets, whether included
 * AI is paused for everyone, and where the credits went (input and output, models, purposes, days).
 */
export function IncludedCreditsCard({ usage }: { usage: IncludedUsage }) {
  const day = resetDay(usage.resetsAt);
  const blocked = includedBlocked(usage);
  const share = usage.limit > 0 ? Math.min(1, Math.max(0, usage.used / usage.limit)) : 1;
  const { totals } = usage;
  return (
    <section className="tile rounded-lg bg-panel p-4" data-testid="ensemble-credits" data-state={usage.paused ? "paused" : blocked ? "used" : "ok"} aria-labelledby="ensemble-credits-title">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
        <h2 id="ensemble-credits-title" className="inline-flex items-center gap-2 font-semibold">
          <ProviderLogo id={INCLUDED_PROVIDER} size={15} /> Ensemble credits
        </h2>
        <span className="text-muted">resets {day}</span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[24px] font-semibold text-ink" data-testid="credits-left">{wholeCredits(usage.remaining)}</span>
        <span className="text-[12.5px] text-muted">of {wholeCredits(usage.limit)} credits left this month</span>
      </div>
      <div
        role="progressbar"
        aria-label="Credits used this month"
        aria-valuemin={0}
        aria-valuemax={usage.limit}
        aria-valuenow={Math.min(Math.max(0, Math.round(usage.used)), usage.limit)}
        className={cx("mt-2 h-2 overflow-hidden rounded", blocked ? "bg-warn/20" : "bg-accent/15")}
      >
        <div className={cx("h-full rounded", blocked ? "bg-warn" : "bg-accent")} style={{ width: `${share * 100}%` }} />
      </div>
      {usage.paused || blocked ? (
        <p role="status" className="mt-3 flex items-start gap-2 rounded-md border border-warn/40 p-2 text-[12.5px] text-ink" data-testid="credits-notice">
          <CircleAlert size={14} className="mt-0.5 shrink-0 text-warn" aria-hidden />
          {usage.paused
            ? `Included AI is paused for everyone until ${day} because this month's shared budget is used up. Your own keys and plans still work.`
            : `You've used this month's credits. They reset on ${day}. Your own keys and plans still work.`}
        </p>
      ) : null}

      <div className="mt-4 grid gap-1 text-[12.5px]" data-testid="credits-split">
        <div>
          <span className="font-medium">Input</span> · {tokenCount(totals.inputTokens)} tokens{totals.cachedTokens ? ` (${tokenCount(totals.cachedTokens)} cached)` : ""} · {creditAmount(totals.inputCredits)}
        </div>
        <div>
          <span className="font-medium">Output</span> · {tokenCount(totals.outputTokens)} tokens · {creditAmount(totals.outputCredits)}
        </div>
        {totals.cachedTokens ? <p className="text-[12px] text-muted">Input read from the cache costs fewer credits than new input.</p> : null}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div>
          <div className="mb-1.5 text-[12.5px] font-medium">By model</div>
          {usage.byModel.length === 0 ? (
            <Empty>No included calls this month.</Empty>
          ) : (
            <table className="w-full text-left text-[12.5px]" data-testid="credits-by-model">
              <thead className="text-[11.5px] text-muted">
                <tr>
                  <th scope="col" className="py-1 font-normal">Model</th>
                  <th scope="col" className="py-1 text-right font-normal">Calls</th>
                  <th scope="col" className="py-1 text-right font-normal">Input</th>
                  <th scope="col" className="py-1 text-right font-normal">Output</th>
                  <th scope="col" className="py-1 text-right font-normal">Total</th>
                </tr>
              </thead>
              <tbody>
                {usage.byModel.map((row) => (
                  <tr key={row.model} className="border-t border-line">
                    <th scope="row" className="py-1.5 font-normal">{includedModelName(row.model)}</th>
                    <td className="py-1.5 text-right text-muted">{row.calls.toLocaleString("en-US")}</td>
                    <td className="py-1.5 text-right text-muted">{creditAmount(row.inputCredits)}</td>
                    <td className="py-1.5 text-right text-muted">{creditAmount(row.outputCredits)}</td>
                    <td className="py-1.5 text-right">{creditAmount(row.credits)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>
          <div className="mb-1.5 text-[12.5px] font-medium">What asked for it</div>
          {usage.byPurpose.length === 0 ? (
            <Empty>Nothing yet.</Empty>
          ) : (
            <ul className="space-y-1 text-[12.5px]" data-testid="credits-by-purpose">
              {usage.byPurpose.map((row) => (
                <li key={row.purpose} className="flex justify-between gap-2">
                  <span className="truncate">{row.purpose}</span>
                  <span className="shrink-0 text-muted">
                    {row.calls === 1 ? "1 call" : `${row.calls.toLocaleString("en-US")} calls`} · {creditAmount(row.credits)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="mt-4">
        <CreditsPerDay usage={usage} />
      </div>
    </section>
  );
}
