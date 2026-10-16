"use client";

import { useState, useMemo } from "react";
import { ChevronDown, Check, LocateFixed, Search } from "lucide-react";
import { timeZoneName } from "@ensemble/shared-types";
import { canonicalTimeZone, timeZoneLabel, timeZoneOptions } from "@/lib/time-zones";
import { Popover } from "../ui";

export function TimezonePicker({ value, automatic, onChange }: { value: string; automatic: boolean; onChange: (zone: string, mode: "auto" | "manual") => void }) {
  const [search, setSearch] = useState("");
  const detected = canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const known = Boolean(timeZoneName(value));
  const options = useMemo(() => timeZoneOptions(value).map(zone => ({ zone, label: timeZoneLabel(zone) })), [value]);
  const zones = options.filter(item => item.label.toLowerCase().includes(search.trim().toLowerCase()));
  return <div>
    <Popover width={340} trigger={(open, toggle) => <button type="button" id="settings-timezone" className="field flex w-full items-center justify-between gap-2 text-left" aria-label="Time zone" aria-invalid={!known || undefined} aria-describedby={!known ? "settings-timezone-error" : undefined} aria-haspopup="listbox" aria-expanded={open} onClick={toggle}><span className="truncate">{known ? timeZoneLabel(canonicalTimeZone(value)) : "Choose a time zone"}</span><ChevronDown size={14} /></button>}>
      {close => <div><label className="mb-2 flex items-center gap-2 rounded-lg border border-line px-2"><Search size={14} /><input className="min-w-0 flex-1 bg-transparent py-2 text-[13px] outline-none" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); event.currentTarget.closest("[role=dialog]")?.querySelector<HTMLButtonElement>("[role=option]")?.focus(); } if (event.key === "Enter" && zones.length === 1) { event.preventDefault(); onChange(zones[0]!.zone, "manual"); close(); } }} aria-label="Search time zones" placeholder="Search a city, such as Kolkata…" /></label>
        <button type="button" className="mb-2 flex w-full items-center gap-2 rounded-lg p-2 text-left text-[12px] text-accent hover:bg-hover" onClick={() => { onChange(detected, "auto"); close(); }}><LocateFixed size={14} /><span>Use this computer’s time zone<small className="block text-muted">{timeZoneLabel(detected)}</small></span></button>
        <div role="listbox" aria-label="Time zones" onKeyDown={event => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=option]")];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }} className="max-h-64 overflow-y-auto">{zones.map(({ zone, label }) => <button type="button" key={zone} role="option" aria-selected={canonicalTimeZone(value) === zone} className="flex w-full items-center justify-between gap-2 rounded-lg p-2 text-left text-[13px] text-ink hover:bg-hover" onClick={() => { onChange(zone, "manual"); close(); }}><span>{label}</span>{canonicalTimeZone(value) === zone ? <Check size={13} /> : null}</button>)}{!zones.length ? <p className="p-2 text-[13px] text-muted">No matching city. Try a nearby city in the same time zone.</p> : null}</div>
      </div>}
    </Popover>
    {!known ? <p id="settings-timezone-error" role="alert" className="mt-1 text-[12px] text-danger">Pick your time zone or use automatic detection.</p> : null}
    <p className="mt-1 text-[12px] font-normal text-muted">{automatic ? "Detected automatically from this computer." : "Your selected time zone. Use the picker to return to automatic detection."}</p>
  </div>;
}
