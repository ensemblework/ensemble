"use client";

type Row = { id: string; title: string; meta?: string };
type Stat = { v: string; unit?: string; note?: string } | null;

const RINGS = new Set(["billable", "hours", "accuracy", "attendance", "streak", "count"]);
const BARS = new Set(["syllabus", "mocks", "revision", "words", "objectives", "parts", "concepts"]);
const HEAT = new Set(["week", "periods", "now"]);
const TIME = new Set(["limitation", "hearings", "countdown", "deadlines", "venue", "lead", "next", "reminders", "dels", "paper", "hold"]);

export function liveDrawKind(specKey: string): "ring" | "bars" | "heat" | "timeline" | null {
  if (RINGS.has(specKey)) return "ring";
  if (BARS.has(specKey)) return "bars";
  if (HEAT.has(specKey)) return "heat";
  if (TIME.has(specKey)) return "timeline";
  return null;
}

function pctOf(meta: string | undefined, index: number, total: number): number {
  const match = meta?.match(/(\d+(?:\.\d+)?)\s*%/);
  if (match) return Math.max(8, Math.min(100, Number(match[1])));
  const num = meta?.match(/(\d+(?:\.\d+)?)/);
  if (num && meta && /%|h|d|out|\/|words/i.test(meta)) {
    const value = Number(num[1]);
    if (meta.includes("%")) return Math.max(8, Math.min(100, value));
    if (value > 0 && value <= 100) return Math.max(12, value);
  }
  return Math.max(18, 100 - index * (70 / Math.max(total, 1)));
}

/** A drawing that still looks finished when only one or two rows exist. */
export function LiveDraw({ specKey, rows, stat }: { specKey: string; rows: Row[]; stat?: Stat }) {
  if (!rows.length && !stat) return null;
  if (RINGS.has(specKey) && stat) {
    const raw = Number(stat.v);
    const pct = Number.isFinite(raw) ? Math.max(6, Math.min(100, raw > 100 ? 100 : raw <= 1 ? raw * 100 : raw)) : 36;
    const r = 28;
    const c = 2 * Math.PI * r;
    return (
      <div className="row gap12" data-live-draw="ring" style={{ alignItems: "center" }}>
        <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden>
          <circle cx="36" cy="36" r={r} fill="none" stroke="color-mix(in srgb, var(--ink) 14%, transparent)" strokeWidth="8" />
          <circle
            cx="36"
            cy="36"
            r={r}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${(pct / 100) * c} ${c}`}
            transform="rotate(-90 36 36)"
          />
        </svg>
        <div className="col" style={{ minWidth: 0 }}>
          <span className="num" style={{ fontSize: 36, lineHeight: 1 }}>{stat.v}{stat.unit ? <span style={{ fontSize: 16, marginLeft: 4 }}>{stat.unit}</span> : null}</span>
          {stat.note ? <span className="trunc" style={{ fontSize: 12, color: "var(--muted)" }}>{stat.note}</span> : null}
        </div>
      </div>
    );
  }
  if (BARS.has(specKey) && rows.length) {
    const shown = rows.slice(0, 4);
    return (
      <div className="col gap6" data-live-draw="bars">
        {shown.map((row, index) => (
          <div key={row.id} className="col" style={{ gap: 3 }}>
            <div className="row sb" style={{ fontSize: 11, color: "var(--muted)" }}>
              <span className="trunc">{row.title}</span>
              {row.meta ? <span>{row.meta}</span> : null}
            </div>
            <div style={{ height: shown.length < 3 ? 14 : 8, borderRadius: 99, background: "color-mix(in srgb, var(--ink) 10%, transparent)", overflow: "hidden" }}>
              <div style={{ width: `${pctOf(row.meta, index, shown.length)}%`, height: "100%", borderRadius: 99, background: "var(--accent)" }} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (HEAT.has(specKey)) {
    const days = ["M", "T", "W", "T", "F", "S", "S"];
    const filled = Math.min(7, Math.max(rows.length, 1));
    return (
      <div className="row gap6" data-live-draw="heat" aria-hidden>
        {days.map((day, index) => (
          <div key={`${day}${index}`} className="col" style={{ alignItems: "center", gap: 4, flex: 1 }}>
            <div style={{ width: "100%", height: 28, borderRadius: 6, background: index < filled ? "var(--accent)" : "color-mix(in srgb, var(--ink) 10%, transparent)", opacity: index < filled ? 0.35 + (index / 7) * 0.65 : 1 }} />
            <span style={{ fontSize: 10, color: "var(--faint)" }}>{day}</span>
          </div>
        ))}
      </div>
    );
  }
  if (TIME.has(specKey) && rows.length) {
    const shown = rows.slice(0, 4);
    return (
      <div data-live-draw="timeline" style={{ position: "relative", padding: "8px 0 4px" }}>
        <div style={{ position: "absolute", left: 6, right: 6, top: 14, height: 2, borderRadius: 99, background: "color-mix(in srgb, var(--ink) 18%, transparent)" }} />
        <div className="row sb" style={{ position: "relative" }}>
          {shown.map((row) => (
            <div key={row.id} className="col" style={{ alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
              <span style={{ width: 10, height: 10, borderRadius: 99, background: "var(--accent)", boxShadow: "0 0 0 3px rgb(var(--accent-rgb) / 0.25)" }} />
              <span className="trunc" style={{ fontSize: 10.5, color: "var(--muted)", maxWidth: "100%" }}>{row.meta || row.title}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return null;
}
