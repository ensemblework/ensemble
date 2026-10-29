"use client";

import type { WeeklyRecap } from "@/lib/api";
import { dayLabel, dayMonth, duration, hourLabel, plural, surfaceLabel, weekdayLong, weekdayShort } from "./format";

type Day = WeeklyRecap["days"][number];

const SURFACE_HUES = ["var(--chart-teal)", "var(--chart-blue)", "var(--chart-amber)", "var(--chart-rose)", "var(--chart-violet)"];

/** Tasks finished per day (you and agents stacked), with tasks added as a dashed ghost bar behind. */
export function DailyChart({ days, today }: { days: Day[]; today: string }) {
  const done = (day: Day) => day.completedByYou + day.completedByAgents;
  const mostDone = Math.max(0, ...days.map(done));
  const mostAdded = Math.max(0, ...days.map((day) => day.created));
  // Finished work sets the scale; a day of bulk adds (an import) is clipped and labelled, not allowed to flatten the bars.
  const peak = mostDone ? Math.max(mostDone, Math.min(mostAdded, mostDone * 2)) : Math.max(1, mostAdded);
  const height = (value: number) => `${Math.round((Math.min(value, peak) / peak) * 82)}%`;
  return (
    <ol className="recap-days" aria-label="Tasks by day. Focus a day for its numbers.">
      {days.map((day) => {
        const total = done(day);
        const words = day.future
          ? `${weekdayLong(day.date)} ${dayMonth(day.date)}: still ahead`
          : `${weekdayLong(day.date)} ${dayMonth(day.date)}: ${plural(day.completedByYou, "task")} done by you, ${day.completedByAgents} by agents, ${day.created} added, ${duration(day.activeMinutes)} active in Ensemble`;
        return (
          <li
            key={day.date}
            className="recap-day"
            tabIndex={0}
            aria-label={words}
            data-today={day.date === today ? "" : undefined}
            data-future={day.future ? "" : undefined}
          >
            <div className="recap-day-plot" aria-hidden>
              {day.created > 0 ? <span className="recap-day-ghost" data-clipped={day.created > peak ? "" : undefined} style={{ height: height(day.created) }} /> : null}
              {total > 0 ? (
                <>
                  <span className="recap-day-stack" style={{ height: height(total) }}>
                    {day.completedByAgents > 0 ? <i data-who="agents" style={{ flex: day.completedByAgents }} /> : null}
                    {day.completedByYou > 0 ? <i data-who="you" style={{ flex: day.completedByYou }} /> : null}
                  </span>
                  <span className="recap-day-total" style={{ bottom: `calc(${height(total)} + 4px)` }}>{total}</span>
                </>
              ) : null}
              {day.created > 0 && (Math.min(day.created, peak) - total) / peak > 0.16 ? (
                <span className="recap-day-added" style={{ bottom: `calc(${height(day.created)} + 4px)` }}>+{day.created}</span>
              ) : null}
            </div>
            <div className="recap-day-label" aria-hidden>
              <b>{weekdayShort(day.date)}</b>
              <small>{Number(day.date.slice(8, 10))}</small>
            </div>
            {day.future ? null : (
              <div className="recap-day-tip" aria-hidden>
                <b>{dayLabel(day.date)}</b>
                {day.completedByYou} by you · {day.completedByAgents} by agents
                <br />
                {day.created} added · {duration(day.activeMinutes)} active
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function level(value: number, peak: number): number {
  if (value <= 0) return 0;
  const share = value / peak;
  return share > 0.75 ? 4 : share > 0.5 ? 3 : share > 0.25 ? 2 : 1;
}

/** Weekday × hour of active screen time, darker for more. */
export function HeatStrip({ rhythm, days, summary }: { rhythm: number[][]; days: Day[]; summary: string }) {
  const peak = Math.max(1, ...rhythm.flat());
  return (
    <div className="recap-heat" role="img" aria-label={summary}>
      <span aria-hidden />
      {Array.from({ length: 24 }, (_, hour) => (
        <span key={hour} className="recap-heat-hours" aria-hidden>
          {hour % 6 === 0 ? hourLabel(hour) : ""}
        </span>
      ))}
      <span aria-hidden />
      {days.map((day, row) => (
        <HeatRow key={day.date} day={day} hours={rhythm[row] ?? []} peak={peak} />
      ))}
    </div>
  );
}

function HeatRow({ day, hours, peak }: { day: Day; hours: number[]; peak: number }) {
  return (
    <>
      <span className="recap-heat-row" aria-hidden>{weekdayShort(day.date)}</span>
      {Array.from({ length: 24 }, (_, hour) => {
        const minutes = hours[hour] ?? 0;
        return (
          <span
            key={hour}
            className="recap-heat-cell"
            data-level={level(minutes, peak)}
            data-future={day.future ? "" : undefined}
            title={minutes ? `${weekdayShort(day.date)} ${hourLabel(hour)}: ${duration(minutes)}` : undefined}
            aria-hidden
          />
        );
      })}
      <span className="recap-heat-total" aria-hidden>{day.activeMinutes ? duration(day.activeMinutes) : day.future ? "" : "–"}</span>
    </>
  );
}

export function HeatScale() {
  return (
    <span className="recap-heat-scale" aria-hidden>
      Less
      {[0, 1, 2, 3, 4].map((step) => (
        <i key={step} className="recap-heat-cell" data-level={step} />
      ))}
      More
    </span>
  );
}

/** Screen time per area of the Hub: a ring with the total and a bar per area. */
export function SurfaceDonut({ surfaces }: { surfaces: WeeklyRecap["surfaces"] }) {
  const total = surfaces.reduce((sum, row) => sum + row.minutes, 0);
  const rows = surfaces.map((row, index) => ({ ...row, label: surfaceLabel(row.surface), hue: row.surface === "other" ? "color-mix(in srgb, var(--ink) 32%, transparent)" : SURFACE_HUES[index % SURFACE_HUES.length]! }));
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const gap = rows.length > 1 ? 3 : 0;
  let offset = 0;
  const largest = Math.max(1, ...rows.map((row) => row.minutes));
  return (
    <div className="recap-donut">
      <div className="recap-donut-ring" role="img" aria-label={`Active time by area: ${rows.map((row) => `${row.label} ${duration(row.minutes)}`).join(", ")}`}>
        <svg viewBox="0 0 132 132" aria-hidden>
          <circle cx="66" cy="66" r={radius} fill="none" stroke="var(--recap-track)" strokeWidth="12" />
          {rows.map((row) => {
            const length = (row.minutes / Math.max(1, total)) * circumference;
            const dash = Math.max(0.5, length - gap);
            const start = offset;
            offset += length;
            return <circle key={row.surface} cx="66" cy="66" r={radius} fill="none" stroke={row.hue} strokeWidth="12" strokeDasharray={`${dash} ${circumference}`} strokeDashoffset={-start} />;
          })}
        </svg>
        <div className="recap-donut-center" aria-hidden>
          <span className="recap-num">{total >= 60 ? `${Math.floor(total / 60)}h` : `${total}m`}{total >= 60 && total % 60 ? <small>{total % 60}m</small> : null}</span>
          <small>active</small>
        </div>
      </div>
      <ul className="recap-bars" aria-label="Active time by area">
        {rows.map((row) => (
          <li key={row.surface} className="recap-bar-row" style={{ ["--swatch" as string]: row.hue }}>
            <i aria-hidden />
            <span>{row.label}</span>
            <b>{duration(row.minutes)}</b>
            <span className="recap-bar-track" aria-hidden><i style={{ width: `${(row.minutes / largest) * 100}%` }} /></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Share of agent runs that succeeded. */
export function SuccessRing({ succeeded, runs }: { succeeded: number; runs: number }) {
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  const share = runs ? succeeded / runs : 0;
  return (
    <div className="recap-agent-ring" role="img" aria-label={`${succeeded} of ${runs} agent runs succeeded`}>
      <svg viewBox="0 0 108 108" aria-hidden>
        <circle cx="54" cy="54" r={radius} fill="none" stroke="var(--recap-track)" strokeWidth="9" />
        {share > 0 ? <circle cx="54" cy="54" r={radius} fill="none" stroke="var(--recap-agents)" strokeWidth="9" strokeLinecap="round" strokeDasharray={`${Math.max(1, share * circumference)} ${circumference}`} /> : null}
      </svg>
      <div aria-hidden>
        <span className="recap-num">{Math.round(share * 100)}<small>%</small></span>
        <small>succeeded</small>
      </div>
    </div>
  );
}
