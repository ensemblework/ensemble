"use client";

import { ChartNoAxesCombined, ChartPie, ChartSpline, ChevronDown, Info, Lock, Plus, Search, TrendingUp, X } from "lucide-react";
import { PLOT_LINE, PlotCardArt, RingPlotToggle, SoonChip } from "./plots";

const CARDS = [
  { k: "any" as const, icon: ChartNoAxesCombined, title: "Plot", copy: "Any column against any column: bar, line, pie and more.", sizes: ["S", "M", "L"] },
  { k: "trend" as const, icon: ChartSpline, title: "Trend over time", copy: "A dated column on x, one or more series on y.", sizes: ["M", "L"] },
  { k: "breakdown" as const, icon: ChartPie, title: "Breakdown", copy: "Share by category, as a pie or a ranked bar.", sizes: ["S", "M"] },
];

export function PlotsGalleryPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="desk">
      <button type="button" aria-label="Close plots gallery" onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(12,10,8,0.64)", border: 0, zIndex: 40 }} />
      <div className="modal" role="dialog" aria-label="Add a tile" style={{ position: "fixed", left: "50%", top: 72, translate: "-50% 0", width: "min(1000px, calc(100vw - 32px))", zIndex: 41 }}>
        <div className="row gap12" style={{ padding: "16px 20px", borderBottom: "1px solid var(--line)" }}>
          <div className="col" style={{ gap: 2 }}>
            <span className="display" style={{ fontSize: 22 }}>Add a tile</span>
            <span className="faint" style={{ fontSize: 12.5 }}>Plots is reserved. These cards cannot be added yet.</span>
          </div>
          <div className="row gap8" style={{ marginLeft: "auto", width: 240, height: 32, padding: "0 10px", borderRadius: 9, border: "1px solid var(--line-strong)", color: "var(--faint)", fontSize: 12.5 }}>
            <Search size={13} />Search tiles
          </div>
          <button type="button" className="icon-btn" aria-label="Done" onClick={onClose} style={{ background: "transparent", border: 0, color: "var(--muted)" }}>
            <X size={15} />
          </button>
        </div>
        <div className="col" style={{ padding: "18px 22px 20px", gap: 14 }}>
          <div className="row gap10">
            <span className="display" style={{ fontSize: 20 }}>Plots</span>
            <SoonChip />
            <span className="faint" style={{ fontSize: 12, marginLeft: "auto" }}>3 reserved tiles</span>
          </div>
          <div style={{ fontSize: 13, color: "var(--muted)", maxWidth: 620, lineHeight: 1.5 }}>{PLOT_LINE}. Bar, line, pie and more, 2D only.</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
            {CARDS.map((card) => {
              const Icon = card.icon;
              return (
                <div key={card.title} className="tile pslot" style={{ padding: 10, gap: 0 }}>
                  <div style={{ position: "relative", height: 140, borderRadius: 10, overflow: "hidden" }}>
                    <div className="pframe" />
                    <PlotCardArt kind={card.k} />
                    <span className="soon" style={{ position: "absolute", left: 10, top: 10 }}><i />Coming soon</span>
                  </div>
                  <div className="col" style={{ padding: "12px 6px 4px", gap: 5 }}>
                    <div className="row gap8">
                      <Icon size={14} />
                      <span style={{ fontSize: 14, fontWeight: 600 }}>{card.title}</span>
                    </div>
                    <span className="faint" style={{ fontSize: 12, lineHeight: 1.45 }}>{card.copy}</span>
                    <div className="row gap6" style={{ marginTop: 6 }}>
                      {["S", "M", "L"].map((size) => (
                        <span key={size} className="mono" style={{ width: 22, height: 20, borderRadius: 5, display: "grid", placeItems: "center", fontSize: 10, border: "1px solid var(--line)", color: card.sizes.includes(size) ? "var(--muted)" : "var(--ghost)" }}>{size}</span>
                      ))}
                      <span className="gbtn off" aria-disabled="true" style={{ marginLeft: "auto" }}><Plus size={11} />Add</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="row gap12" style={{ padding: "12px 14px", borderRadius: 12, border: "1px solid var(--line)" }}>
            <Info size={15} />
            <div className="col" style={{ gap: 2, flex: 1 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>Already plot-ready on this desk</span>
              <span className="faint" style={{ fontSize: 12 }}>Billable keeps its ring today. When Plots arrives, the same tile can switch without moving.</span>
            </div>
            <RingPlotToggle />
          </div>
          <div className="row sb" style={{ paddingTop: 8 }}>
            <span className="mono faint" style={{ fontSize: 10.5 }}>Plots category shows only while the plots flag is on</span>
            <button type="button" className="btn" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChartTypePanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal" role="dialog" aria-label="Tile settings" style={{ position: "fixed", right: 28, top: 120, width: 356, zIndex: 41 }}>
      <div className="row gap8" style={{ padding: "14px 16px 12px", borderBottom: "1px solid var(--line)" }}>
        <TrendingUp size={14} />
        <span style={{ fontSize: 14, fontWeight: 600 }}>Tile settings</span>
        <span className="faint" style={{ fontSize: 12 }}>Mock scores</span>
        <button type="button" aria-label="Close tile settings" onClick={onClose} style={{ marginLeft: "auto", background: "transparent", border: 0, color: "var(--muted)" }}><X size={14} /></button>
      </div>
      <div className="col" style={{ padding: "6px 16px 14px" }}>
        <div className="setrow"><div className="row sb"><span className="sl">Title</span><span className="field">Mock scores</span></div></div>
        <div className="setrow"><div className="row sb"><span className="sl">Series</span><span className="field">GS I · out of 200<ChevronDown size={12} style={{ marginLeft: "auto" }} /></span></div></div>
        <div className="setrow off" aria-disabled="true">
          <div className="row sb">
            <span className="row gap6 sl"><Lock size={11} />Chart type</span>
            <span className="field dis">Line<ChevronDown size={12} style={{ marginLeft: "auto" }} /></span>
          </div>
          <div className="row gap8" style={{ marginTop: 8 }}>
            <SoonChip />
            <span style={{ fontSize: 11.5, color: "var(--faint)" }}>Reserved for Plots: bar, line, area, pie and more, 2D only.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
