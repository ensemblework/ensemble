"use client";

import type { ReactNode } from "react";
import type { DeskLive } from "@/lib/api";
import { Num, Ring } from "./ui";

type Row = { id: string; title: string; meta?: string };
type Stat = { v: string; unit?: string; note?: string } | null;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PALETTE = ["#cf9cf2", "#7eb8c9", "#e7a08a", "#d4c07a", "#8fbf9f", "#f0a36a"];
const OPEN = new Set(["todo", "proposed", "in_progress", "blocked", "waiting_approval"]);
const H = 60;

function colorFor(name: string) {
  let hash = 0;
  for (const ch of name) hash = (hash * 33 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}
function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
function addDays(iso: string, days: number) {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function short(iso: string) {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
function hm(min: number) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
function zone(days: number): "r" | "y" | "g" {
  if (days <= 7) return "r";
  if (days <= 21) return "y";
  return "g";
}
const ZONE = { r: "var(--danger)", y: "var(--warn)", g: "var(--ok)" } as const;

function Shell({ children }: { children: ReactNode }) {
  return (
    <div data-hero-draw className="col" style={{ flex: 1, minHeight: 0, justifyContent: "space-between", gap: 10 }}>
      {children}
    </div>
  );
}

function Limitation({ live }: { live: DeskLive }) {
  const pins = [...live.limitation].sort((a, b) => a.days - b.days);
  const next = pins[0];
  if (!next) return null;
  const inside7 = pins.filter((pin) => pin.days <= 7).length;
  const inside21 = pins.filter((pin) => pin.days > 7 && pin.days <= 21).length;
  const calm = pins.length - inside7 - inside21;
  const tone = zone(next.days);
  const pct = (days: number) => `${(Math.max(0, Math.min(H, days)) / H) * 100}%`;
  const ticks = [14, 28, 42, 56];
  return (
    <Shell>
      <div className="row gap12" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
        <Num v={String(next.days)} size={64} unit="days" color={ZONE[tone]} />
        <div className="col" style={{ minWidth: 0, paddingBottom: 6, gap: 3, flex: 1 }}>
          <div className="trunc" style={{ fontSize: 15, fontWeight: 650 }}>
            {next.title}
            {next.court ? <span className="faint" style={{ fontWeight: 450 }}> · {next.court}</span> : null}
          </div>
          <div className="trunc" style={{ fontSize: 12.5, color: "var(--muted)" }}>
            <span className={`pill ${tone === "g" ? "g" : tone === "y" ? "y" : "r"}`}>{short(next.due)}</span>
            {next.note ? <span style={{ marginLeft: 6 }}>{next.note}</span> : null}
          </div>
        </div>
        <div className="row" style={{ gap: 16, paddingBottom: 4 }}>
          {[
            [inside7, "inside 7 days", "var(--danger)"],
            [inside21, "inside 21 days", "var(--warn)"],
            [calm, "calm", "var(--ok)"],
          ].map(([n, label, color]) => (
            <div key={String(label)} className="col" style={{ gap: 2 }}>
              <span className="num" style={{ fontSize: 26, color: String(color) }}>{n}</span>
              <span style={{ fontSize: 11, color: "var(--faint)" }}>{label}</span>
            </div>
          ))}
        </div>
      </div>
      <div data-live-band style={{ position: "relative", height: 78 }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 22, height: 28, borderRadius: 8, overflow: "hidden", background: "color-mix(in srgb, var(--ink) 6%, transparent)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent)" }}>
          <div style={{ position: "absolute", left: 0, width: pct(7), top: 0, bottom: 0, background: "linear-gradient(90deg, rgb(227 107 100 / 0.5), rgb(227 107 100 / 0.16))" }} />
          <div style={{ position: "absolute", left: pct(7), width: pct(14), top: 0, bottom: 0, background: "linear-gradient(90deg, rgb(224 160 74 / 0.4), rgb(224 160 74 / 0.12))" }} />
          <div style={{ position: "absolute", left: pct(21), right: 0, top: 0, bottom: 0, background: "linear-gradient(90deg, rgb(var(--ok-rgb, 60 186 134) / 0.16), transparent)" }} />
          {pins.map((pin) => (
            <div
              key={pin.id}
              title={pin.title}
              style={{ position: "absolute", left: pct(pin.days), top: "50%", width: 9, height: 9, marginLeft: -4.5, marginTop: -4.5, transform: "rotate(45deg)", borderRadius: 2, background: ZONE[zone(pin.days)], boxShadow: "0 0 0 3px var(--tile)" }}
            />
          ))}
        </div>
        <div style={{ position: "absolute", left: 0, top: 14, bottom: 18, borderLeft: "2px solid var(--accent)" }} />
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 14, fontSize: 10.5, color: "var(--faint)" }}>
          <span style={{ position: "absolute", left: 0, color: "var(--accent)", fontWeight: 650 }}>Today</span>
          {ticks.map((day) => (
            <span key={day} style={{ position: "absolute", left: pct(day), transform: "translateX(-50%)" }}>{short(addDays(live.today, day))}</span>
          ))}
          <span style={{ position: "absolute", right: 0 }}>60d</span>
        </div>
      </div>
      <div className="row gap8">
        {pins.slice(0, 4).map((pin) => {
          const z = zone(pin.days);
          return (
            <div key={pin.id} style={{ flex: 1, minWidth: 0, borderRadius: 10, padding: "8px 10px", background: `color-mix(in srgb, ${ZONE[z]} 10%, transparent)` }}>
              <div className="row sb" style={{ gap: 8 }}>
                <span className="trunc" style={{ fontSize: 12.5, fontWeight: 650 }}>{pin.title}</span>
                <span className="num" style={{ fontSize: 20, color: ZONE[z] }}>{pin.days}<span style={{ fontSize: 11, color: "var(--faint)" }}>d</span></span>
              </div>
              <div className="trunc" style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 2 }}>{[short(pin.due), pin.court].filter(Boolean).join(" · ")}</div>
            </div>
          );
        })}
      </div>
    </Shell>
  );
}

function weekOf(today: string) {
  const date = new Date(`${today}T00:00:00Z`);
  const dow = date.getUTCDay();
  const monday = dow === 0 ? -6 : 1 - dow;
  return [1, 2, 3, 4, 5, 6, 0].map((weekday, index) => {
    const day = new Date(date);
    day.setUTCDate(date.getUTCDate() + monday + index);
    const iso = day.toISOString().slice(0, 10);
    return { weekday, iso, n: day.getUTCDate(), today: iso === today.slice(0, 10) };
  });
}

function Week({ live }: { live: DeskLive }) {
  const days = weekOf(live.today);
  const slots = [...live.slots].sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
  if (!slots.length) return null;
  const busy = new Set(slots.map((slot) => slot.weekday));
  return (
    <Shell>
      <div className="row" style={{ alignItems: "flex-end", gap: 14, flexWrap: "wrap" }}>
        <Num v={String(slots.length)} size={56} unit={slots.length === 1 ? "class" : "classes"} />
        <div className="row" style={{ marginLeft: "auto", gap: 6, paddingBottom: 6 }}>
          {days.map((day) => {
            const on = busy.has(day.weekday);
            return (
              <div key={day.iso} className="col" style={{ alignItems: "center", gap: 4, width: 28 }}>
                <span className="cap" style={{ color: day.today ? "var(--accent)" : undefined }}>{DAYS[day.weekday]!.slice(0, 1)}</span>
                <span className="num" style={{ fontSize: 16, color: day.today ? "var(--ink)" : "var(--muted)" }}>{day.n}</span>
                <span style={{ width: 18, height: 6, borderRadius: 99, background: on ? colorFor(slots.find((slot) => slot.weekday === day.weekday)?.course || "class") : "color-mix(in srgb, var(--ink) 12%, transparent)" }} />
              </div>
            );
          })}
        </div>
      </div>
      <div className="row" style={{ gap: 8, flex: 1, alignItems: "stretch" }}>
        {slots.slice(0, 4).map((slot) => {
          const tint = colorFor(slot.course || slot.title);
          return (
            <div key={slot.id} className="col" style={{ flex: 1, minWidth: 0, minHeight: 108, justifyContent: "space-between", borderRadius: 12, padding: "12px 14px", background: `color-mix(in srgb, ${tint} 18%, transparent)` }}>
              <span className="num" style={{ fontSize: 28 }}>{DAYS[slot.weekday]!.slice(0, 3)}</span>
              <div>
                <div className="trunc" style={{ fontSize: 16, fontWeight: 700 }}>{slot.title}</div>
                <div className="trunc" style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>{hm(slot.startMin)}–{hm(slot.endMin)}{slot.course ? ` · ${slot.course}` : ""}</div>
              </div>
            </div>
          );
        })}
      </div>
    </Shell>
  );
}

function Countdown({ live }: { live: DeskLive }) {
  const next = [...live.countdowns].sort((a, b) => a.days - b.days)[0];
  if (!next) return null;
  const phases = live.tasks.filter((row) => row.taskType === "phase");
  const tone = zone(next.days);
  const span = Math.max(next.days, 30);
  const closeness = next.days <= 0 ? 1 : Math.max(0.08, Math.min(0.92, 1 - next.days / (span + next.days)));
  return (
    <Shell>
      <div className="row" style={{ alignItems: "center", gap: 18, flex: 1 }}>
        <div className="col" style={{ minWidth: 0, gap: 8 }}>
          <Num v={String(next.days)} size={78} unit="days" color={ZONE[tone]} />
          <div className="trunc" style={{ fontSize: 15, fontWeight: 650 }}>{next.title}</div>
          <div style={{ fontSize: 12.5, color: "var(--muted)" }}>{short(next.due)}{phases[0] ? ` · ${phases[0].title}` : ""}</div>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <Ring p={closeness} size={108} stroke={8} color={ZONE[tone]} glow>
            <div className="col" style={{ alignItems: "center" }}>
              <span className="num" style={{ fontSize: 28 }}>{next.days}</span>
              <span style={{ fontSize: 10.5, color: "var(--faint)" }}>to go</span>
            </div>
          </Ring>
        </div>
      </div>
      {phases.length ? (
        <div className="row" style={{ gap: 4 }}>
          {phases.slice(0, 4).map((phase, index) => (
            <div key={phase.id} className="col" style={{ flex: 1, gap: 4, minWidth: 0 }}>
              <div style={{ height: 6, borderRadius: 3, background: index === 0 ? "var(--accent)" : "color-mix(in srgb, var(--ink) 12%, transparent)" }} />
              <span className="trunc" style={{ fontSize: 11, fontWeight: 600, color: index === 0 ? "var(--ink)" : "var(--faint)" }}>{phase.title}</span>
            </div>
          ))}
        </div>
      ) : null}
    </Shell>
  );
}

function Periods({ live }: { live: DeskLive }) {
  const slots = [...live.slots].sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
  if (!slots.length) return null;
  const todayDow = new Date(`${live.today}T00:00:00Z`).getUTCDay();
  const focus = slots.find((slot) => slot.weekday === todayDow) ?? slots[0]!;
  const rest = slots.filter((slot) => slot.id !== focus.id).slice(0, 6);
  const whenLabel = focus.weekday === todayDow ? `Today · ${DAYS[focus.weekday]}` : DAYS[focus.weekday];
  return (
    <Shell>
      <div className="row" style={{ gap: 12, alignItems: "stretch", flex: 1 }}>
        <div className="col" style={{ flex: 1.5, gap: 8, justifyContent: "center", minHeight: 120, padding: "16px 18px", borderRadius: 12, background: "linear-gradient(135deg, rgb(var(--accent-rgb) / 0.18), rgb(var(--accent-rgb) / 0.04))", border: "1px solid rgb(var(--accent-rgb) / 0.3)" }}>
          <span className="cap" style={{ color: "var(--accent)" }}>{whenLabel} · {hm(focus.startMin)}–{hm(focus.endMin)}</span>
          <span className="display" style={{ fontSize: 28 }}>{focus.title}</span>
          {focus.course ? <span style={{ fontSize: 14, color: "var(--muted)" }}>{focus.course}</span> : null}
        </div>
        {rest[0] ? (
          <div className="col" style={{ flex: 1, gap: 6, justifyContent: "center", padding: "16px 18px", borderRadius: 12, background: "color-mix(in srgb, var(--ink) 4%, transparent)", border: "1px solid color-mix(in srgb, var(--ink) 8%, transparent)" }}>
            <span className="cap">Next</span>
            <span className="display" style={{ fontSize: 22 }}>{rest[0].title}</span>
            <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{DAYS[rest[0].weekday]} · {hm(rest[0].startMin)}</span>
          </div>
        ) : null}
      </div>
      <div className="row" style={{ gap: 6 }}>
        {(rest.length ? [focus, ...rest] : [focus]).map((slot) => (
          <div key={slot.id} className="col" style={{ flex: 1, minWidth: 0, minHeight: 58, borderRadius: 9, padding: "6px 8px", background: slot.id === focus.id ? "var(--accent)" : "color-mix(in srgb, var(--ink) 5%, transparent)", color: slot.id === focus.id ? "var(--accent-fg, #14120f)" : undefined }}>
            <div className="row sb" style={{ fontSize: 10.5, fontWeight: 650, opacity: 0.75 }}><span>{DAYS[slot.weekday]!.slice(0, 3)}</span><span>{hm(slot.startMin)}</span></div>
            <span className="trunc" style={{ fontSize: 13, fontWeight: 700, marginTop: 2 }}>{slot.course || slot.title}</span>
          </div>
        ))}
      </div>
    </Shell>
  );
}

function Team({ live }: { live: DeskLive }) {
  const people = live.people;
  if (!people.length) return null;
  const cap = 40;
  const over = people.filter((person) => (person.capacityHours ?? 0) > cap);
  const lead = over[0] ?? people[0]!;
  const leadHours = lead.capacityHours ?? 0;
  return (
    <Shell>
      <div className="row" style={{ alignItems: "center", gap: 16 }}>
        <Num v={String(over.length || people.length)} size={64} color={over.length ? "var(--danger)" : "var(--ink)"} />
        <div className="col" style={{ minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 15, fontWeight: 650 }}>{over.length ? "over capacity" : "on the team"}</span>
          <span className="trunc" style={{ fontSize: 12.5, color: "var(--faint)" }}>{lead.name}{lead.capacityHours != null ? ` · ${lead.capacityHours} h of ${cap}` : ""}</span>
        </div>
        <Ring p={Math.max(0.08, Math.min(1, leadHours / cap))} size={84} stroke={7} color={leadHours > cap ? "var(--danger)" : "var(--accent)"} glow>
          <span className="num" style={{ fontSize: 22 }}>{leadHours || people.length}</span>
        </Ring>
      </div>
      <div className="col" style={{ gap: 8 }}>
        {people.slice(0, 6).map((person) => {
          const hours = person.capacityHours ?? 0;
          const hot = hours > cap;
          return (
            <div key={person.id} className="row gap10" style={{ minHeight: 28 }}>
              <span className="av" style={{ background: colorFor(person.name), boxShadow: hot ? "0 0 0 2px var(--danger)" : undefined }}>{initials(person.name)}</span>
              <span className="trunc" style={{ width: 132, fontSize: 12.5, fontWeight: 650 }}>{person.name}</span>
              <div className="bar grow" style={{ height: 10 }}>
                <i style={{ width: `${Math.max(8, Math.min(100, (hours / cap) * 100))}%`, background: hot ? "var(--danger)" : "var(--accent)" }} />
              </div>
              <span className="num" style={{ width: 36, textAlign: "right", fontSize: 16, color: hot ? "var(--danger)" : "var(--ink-2)" }}>{hours || "–"}</span>
            </div>
          );
        })}
      </div>
    </Shell>
  );
}

function Reviews({ rows }: { rows: Row[] }) {
  const unique = rows.filter((row, index) => rows.findIndex((other) => other.id === row.id) === index);
  const shown = unique.slice(0, 4);
  if (!shown.length) return null;
  return (
    <Shell>
      <div className="row" style={{ alignItems: "flex-end", gap: 12 }}>
        <Num v={String(shown.length)} size={56} />
        <div className="col" style={{ paddingBottom: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 650 }}>waiting on you</span>
          <span className="faint" style={{ fontSize: 12 }}>{shown[0]?.title}</span>
        </div>
      </div>
      <div className="col">
        {shown.map((row) => (
          <div key={row.id} className="row gap10" style={{ padding: "7px 0", borderTop: "1px solid color-mix(in srgb, var(--ink) 8%, transparent)" }}>
            <span className="av" style={{ background: colorFor(row.title) }}>{initials(row.title) || "PR"}</span>
            <span className="trunc grow" style={{ fontSize: 13, fontWeight: 600 }}>{row.title}</span>
            <span className="pill a">{row.meta || "Review"}</span>
          </div>
        ))}
      </div>
    </Shell>
  );
}

function Build({ live }: { live: DeskLive }) {
  const rows = live.tasks.filter((row) => OPEN.has(row.status)).slice(0, 5);
  if (!rows.length) return null;
  const dated = rows.filter((row) => row.due).sort((a, b) => String(a.due).localeCompare(String(b.due)));
  const next = dated[0];
  const days = next?.due ? Math.round((Date.parse(`${next.due.slice(0, 10)}T00:00:00Z`) - Date.parse(`${live.today}T00:00:00Z`)) / 86_400_000) : null;
  const span = 56;
  const marks = dated.length ? dated : rows.slice(0, 1);
  return (
    <Shell>
      <div className="row" style={{ alignItems: "flex-end", gap: 14 }}>
        <Num v={days == null ? String(rows.length) : String(days)} size={64} unit={days == null ? "open" : "days"} color={days != null && days <= 7 ? "var(--danger)" : "var(--ink)"} />
        <div className="col" style={{ paddingBottom: 6, minWidth: 0 }}>
          <span className="trunc" style={{ fontSize: 15, fontWeight: 650 }}>{next?.title ?? rows[0]!.title}</span>
          <span className="faint" style={{ fontSize: 12 }}>{next?.due ? short(next.due) : `${rows.length} open`}</span>
        </div>
      </div>
      <div data-live-band style={{ position: "relative", height: 46 }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 16, height: 14, borderRadius: 6, background: "color-mix(in srgb, var(--ink) 7%, transparent)" }} />
        <div style={{ position: "absolute", left: 0, top: 8, height: 30, borderLeft: "2px solid var(--danger)" }} />
        <span style={{ position: "absolute", left: 6, top: 0, fontSize: 10, fontWeight: 700, color: "var(--danger)" }}>Today</span>
        {marks.map((row) => {
          const dueDays = row.due ? Math.round((Date.parse(`${row.due.slice(0, 10)}T00:00:00Z`) - Date.parse(`${live.today}T00:00:00Z`)) / 86_400_000) : span / 2;
          return (
            <span key={row.id} title={row.title} style={{ position: "absolute", left: `${(Math.max(0, Math.min(span, dueDays)) / span) * 100}%`, top: 18, width: 10, height: 10, marginLeft: -5, transform: "rotate(45deg)", borderRadius: 2, background: "var(--accent)", boxShadow: "0 0 0 3px var(--tile)" }} />
          );
        })}
      </div>
      <div className="row" style={{ gap: 8 }}>
        {rows.slice(0, 4).map((row) => (
          <div key={row.id} className="col" style={{ flex: 1, minWidth: 0, borderRadius: 10, padding: "8px 10px", background: "color-mix(in srgb, var(--ink) 4%, transparent)" }}>
            <span className="trunc" style={{ fontSize: 12.5, fontWeight: 650 }}>{row.title}</span>
            <span className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>{row.due ? short(row.due) : "Open"}</span>
          </div>
        ))}
      </div>
    </Shell>
  );
}

function Pipeline({ live }: { live: DeskLive }) {
  const papers = live.tasks.filter((row) => row.taskType === "paper");
  if (!papers.length) return null;
  const stages = ["To read", "Reading", "Drafting", "Done"];
  for (const paper of papers) {
    const stage = paper.pipelineStage || "To read";
    if (!stages.includes(stage)) stages.push(stage);
  }
  return (
    <Shell>
      <div className="row" style={{ alignItems: "flex-end", gap: 12 }}>
        <Num v={String(papers.length)} size={56} unit={papers.length === 1 ? "paper" : "papers"} />
        <div className="col" style={{ paddingBottom: 6, minWidth: 0 }}>
          <span className="trunc" style={{ fontSize: 15, fontWeight: 650 }}>{papers[0]!.title}</span>
          <span className="faint" style={{ fontSize: 12 }}>{papers[0]!.pipelineStage || "To read"}{papers[0]!.wordCount ? ` · ${papers[0]!.wordCount} words` : ""}</span>
        </div>
      </div>
      <div className="row" style={{ gap: 8, alignItems: "stretch", flex: 1 }}>
        {stages.slice(0, 4).map((stage) => {
          const inStage = papers.filter((row) => (row.pipelineStage || "To read") === stage);
          const active = inStage.length > 0;
          return (
            <div key={stage} className="col" style={{ flex: 1, minWidth: 0, gap: 6, minHeight: 96, borderRadius: 10, padding: 8, background: active ? "color-mix(in srgb, var(--accent) 10%, transparent)" : "transparent", boxShadow: active ? "inset 0 0 0 1px rgb(var(--accent-rgb) / 0.28)" : "inset 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent)" }}>
              <span className="cap" style={{ color: active ? "var(--accent)" : undefined }}>{stage}</span>
              {inStage.slice(0, 2).map((row) => (
                <div key={row.id} style={{ borderRadius: 8, padding: "8px 10px", background: "color-mix(in srgb, var(--accent) 16%, transparent)" }}>
                  <div className="trunc" style={{ fontSize: 12.5, fontWeight: 650 }}>{row.title}</div>
                  {row.wordCount ? <div className="faint" style={{ fontSize: 11, marginTop: 2 }}>{row.wordCount} words</div> : null}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </Shell>
  );
}

function Day({ rows, stat }: { rows: Row[]; stat: Stat }) {
  if (!rows.length && !stat) return null;
  return (
    <Shell>
      <div className="row" style={{ alignItems: "flex-end", gap: 12 }}>
        <Num v={stat?.v ?? String(rows.length)} size={64} unit={stat?.unit ?? "open"} />
        {stat?.note ? <span className="trunc" style={{ fontSize: 13, color: "var(--muted)", paddingBottom: 8 }}>{stat.note}</span> : null}
      </div>
      <div className="col">
        {rows.slice(0, 4).map((row) => (
          <div key={row.id} className="row sb" style={{ gap: 8, padding: "6px 0", borderTop: "1px solid color-mix(in srgb, var(--ink) 8%, transparent)" }}>
            <span className="trunc" style={{ fontSize: 13, fontWeight: 650 }}>{row.title}</span>
            {row.meta ? <span className="faint" style={{ fontSize: 12 }}>{row.meta}</span> : null}
          </div>
        ))}
      </div>
    </Shell>
  );
}

/** Live hero drawings. Null leaves the ordinary row list in place. */
export function liveHero({ specKey, live, rows, stat }: { specKey: string; live: DeskLive; rows: Row[]; stat?: Stat }) {
  if (specKey === "limitation") return <Limitation live={live} />;
  if (specKey === "week") return <Week live={live} />;
  if (specKey === "countdown") return <Countdown live={live} />;
  if (specKey === "periods") return <Periods live={live} />;
  if (specKey === "load") return <Team live={live} />;
  if (specKey === "reviews") return <Reviews rows={rows} />;
  if (specKey === "build") return <Build live={live} />;
  if (specKey === "pipeline") return <Pipeline live={live} />;
  if (specKey === "day") return <Day rows={rows} stat={stat ?? null} />;
  return null;
}
