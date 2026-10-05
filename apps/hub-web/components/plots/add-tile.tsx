"use client";

import { useMemo, useState } from "react";
import { GALLERY, type GallerySlot, type PoolColumn } from "@ensemble/shared-types";
import { PlotDialog } from "@/components/plots/plot-dialog";

const SLOT_LABEL: Record<GallerySlot, string> = { x: "X", y: "Y", error: "Error", seed: "Seed", value: "Value" };

export function AddTileDialog({
  open,
  columns,
  onClose,
  onAdd,
}: {
  open: boolean;
  columns: PoolColumn[];
  onClose: () => void;
  onAdd: (choice: (typeof GALLERY)[number], xRef: string | null, yRefs: string[], errorRef: string | null, seedRef: string | null) => void;
}) {
  const [gallery, setGallery] = useState<(typeof GALLERY)[number] | null>(null);
  const [query, setQuery] = useState("");
  const [xRef, setXRef] = useState<string | null>(null);
  const [yRefs, setYRefs] = useState<string[]>([]);
  const [valueRef, setValueRef] = useState<string | null>(null);
  const [errorRef, setErrorRef] = useState<string | null>(null);
  const [seedRef, setSeedRef] = useState<string | null>(null);
  const [slot, setSlot] = useState<GallerySlot>("x");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return columns.filter((column) => !needle || column.name.toLowerCase().includes(needle) || (column.source ?? "").toLowerCase().includes(needle));
  }, [columns, query]);

  const close = () => {
    setGallery(null);
    setQuery("");
    setXRef(null);
    setYRefs([]);
    setValueRef(null);
    setErrorRef(null);
    setSeedRef(null);
    setSlot("x");
    onClose();
  };

  const filled = (name: GallerySlot) => {
    if (name === "x") return Boolean(xRef);
    if (name === "y") return yRefs.length > 0;
    if (name === "error") return Boolean(errorRef);
    if (name === "seed") return Boolean(seedRef);
    return Boolean(valueRef);
  };

  return (
    <PlotDialog open={open} onClose={close} title={gallery ? gallery.label : "Add tile"} width={720}>
      {!gallery ? (
        <div className="space-y-4" data-gallery>
          {(["paper", "everyday"] as const).map((group) => (
            <section key={group}>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{group === "paper" ? "Paper figures" : "Everyday charts"}</h4>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {GALLERY.filter((item) => item.group === group).map((item) => (
                  <button key={item.id} type="button" className="rounded-lg border border-line bg-raised px-3 py-3 text-left hover:bg-hover" onClick={() => { setGallery(item); setSlot(item.slots[0] ?? "x"); }}>
                    <GalleryMark id={item.id} />
                    <span className="mt-2 block text-[13px] font-medium">{item.label}</span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-muted">{item.blurb}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div data-column-pool>
          <p className="mb-3 text-[12.5px] leading-5 text-muted">{gallery.hint}</p>
          <input className="field mb-2 w-full" aria-label="Search columns" placeholder="Search columns" value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="mb-2 flex flex-wrap gap-1 text-[12px]">
            {gallery.slots.map((name) => (
              <button key={name} type="button" className={`rounded-md px-2 py-1 ${slot === name ? "bg-accent-soft text-ink" : "text-muted"}`} onClick={() => setSlot(name)}>
                {SLOT_LABEL[name]}{filled(name) ? " · set" : name === "seed" ? " · optional" : ""}
              </button>
            ))}
          </div>
          <ul className="max-h-64 space-y-1 overflow-auto">
            {filtered.map((column) => (
              <li key={column.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover"
                  onClick={() => {
                    if (slot === "x") {
                      setXRef(column.id);
                      setSlot("y");
                    } else if (slot === "error") setErrorRef(column.id);
                    else if (slot === "seed") setSeedRef(column.id);
                    else if (slot === "value") setValueRef(column.id);
                    else setYRefs((current) => current.includes(column.id) ? current.filter((item) => item !== column.id) : [...current, column.id].slice(0, 6));
                  }}
                >
                  <span className="flex-1 text-[13px]">{column.name}</span>
                  <span className="text-[11px] text-faint">{column.type}</span>
                  {column.source ? <span className="text-[11px] text-muted">{column.source}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          {!columns.length ? <p className="text-[13px] text-muted">Upload a table first. Tiles share that data.</p> : null}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setGallery(null)}>Back</button>
            <button
              type="button"
              className="btn-primary"
              disabled={(!xRef && gallery.id !== "runs") || yRefs.length === 0 || (gallery.slots.includes("error") && !errorRef) || (gallery.slots.includes("value") && !valueRef)}
              onClick={() => {
                const ys = valueRef ? [...yRefs, valueRef] : yRefs;
                onAdd(gallery, xRef, ys, errorRef, seedRef);
                close();
              }}
            >
              Add tile
            </button>
          </div>
        </div>
      )}
    </PlotDialog>
  );
}

function GalleryMark({ id }: { id: string }) {
  const stroke = "var(--accent)";
  if (id === "training") {
    return (
      <svg width="88" height="40" viewBox="0 0 88 40" aria-hidden>
        <path d="M6 30 C 20 28, 28 18, 44 16 S 70 10, 82 8" fill="none" stroke={stroke} strokeWidth="1.6" />
        <path d="M6 34 C 20 32, 28 24, 44 20 S 70 16, 82 12 L 82 4 C 70 6, 60 8, 44 12 S 20 24, 6 26 Z" fill={stroke} opacity="0.22" />
      </svg>
    );
  }
  if (id === "ablation" || id === "bar") {
    return (
      <svg width="88" height="40" viewBox="0 0 88 40" aria-hidden>
        {[[8, 22, 14], [26, 14, 22], [44, 18, 18], [62, 10, 26]].map(([x, y, h]) => (
          <g key={x}>
            <rect x={x} y={y} width="12" height={h} fill={stroke} opacity={id === "bar" ? 0.85 : 0.8} />
            {id === "ablation" ? <path d={`M${x! + 6} ${y! - 4} V${y! + 4} M${x! + 3} ${y! - 4} H${x! + 9} M${x! + 3} ${y! + 4} H${x! + 9}`} stroke={stroke} strokeWidth="1.2" fill="none" /> : null}
          </g>
        ))}
      </svg>
    );
  }
  if (id === "scaling") {
    return (
      <svg width="88" height="40" viewBox="0 0 88 40" aria-hidden>
        <path d="M14 6 V34 H82" fill="none" stroke="var(--faint)" strokeWidth="1" />
        <path d="M18 30 L34 22 L52 16 L74 8" fill="none" stroke={stroke} strokeWidth="1.6" />
        {[18, 34, 52, 74].map((x, index) => <circle key={x} cx={x} cy={[30, 22, 16, 8][index]} r="2" fill={stroke} />)}
        <text x="8" y="12" fontSize="7" fill="var(--faint)">10</text>
        <text x="8" y="32" fontSize="7" fill="var(--faint)">1</text>
      </svg>
    );
  }
  if (id === "pareto" || id === "scatter") {
    return (
      <svg width="88" height="40" viewBox="0 0 88 40" aria-hidden>
        {[[12, 30], [24, 26], [36, 18], [50, 14], [66, 10], [78, 22]].map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="2.4" fill={stroke} />)}
        {id === "pareto" ? <path d="M12 30 L24 26 L36 18 L50 14 L66 10" fill="none" stroke={stroke} strokeWidth="1.2" strokeDasharray="2 2" /> : null}
      </svg>
    );
  }
  if (id === "confusion") {
    return (
      <svg width="88" height="40" viewBox="0 0 88 40" aria-hidden>
        {[0, 1, 2, 3].map((row) => [0, 1, 2, 3].map((col) => <rect key={`${row}-${col}`} x={18 + col * 14} y={4 + row * 8} width="12" height="7" fill={stroke} opacity={row === col ? 0.9 : 0.18} />))}
      </svg>
    );
  }
  if (id === "reliability") {
    return (
      <svg width="88" height="40" viewBox="0 0 88 40" aria-hidden>
        <path d="M10 32 L78 8" stroke="var(--faint)" strokeDasharray="3 2" />
        <path d="M10 30 C 24 28, 40 22, 54 16 S 70 12, 78 10" fill="none" stroke={stroke} strokeWidth="1.6" />
      </svg>
    );
  }
  if (id === "runs") {
    return (
      <svg width="88" height="40" viewBox="0 0 88 40" aria-hidden>
        {[[22, 8], [44, 4], [66, 10]].map(([x, y]) => (
          <path key={x} d={`M${x} 32 C ${x! - 8} 28, ${x! - 10} ${y! + 8}, ${x} ${y} C ${x! + 10} ${y! + 8}, ${x! + 8} 28, ${x} 32 Z`} fill={stroke} opacity="0.75" />
        ))}
      </svg>
    );
  }
  if (id === "box") {
    return (
      <svg width="88" height="40" viewBox="0 0 88 40" aria-hidden>
        {[[18, 12, 16], [40, 8, 18], [62, 14, 14]].map(([x, y, h]) => (
          <g key={x}>
            <path d={`M${x! + 7} ${y! - 6} V${y! + h! + 6}`} stroke={stroke} strokeWidth="1.2" />
            <path d={`M${x! + 4} ${y! - 6} H${x! + 10} M${x! + 4} ${y! + h! + 6} H${x! + 10}`} stroke={stroke} strokeWidth="1.2" />
            <rect x={x} y={y} width="14" height={h} fill="none" stroke={stroke} strokeWidth="1.4" />
            <path d={`M${x} ${y! + h! / 2} H${x! + 14}`} stroke={stroke} strokeWidth="1.3" />
          </g>
        ))}
        <circle cx="76" cy="6" r="1.8" fill={stroke} />
      </svg>
    );
  }
  if (id === "line") {
    return (
      <svg width="88" height="40" viewBox="0 0 88 40" aria-hidden>
        <path d="M6 28 L24 18 L40 22 L58 10 L82 14" fill="none" stroke={stroke} strokeWidth="1.6" />
      </svg>
    );
  }
  return (
    <svg width="88" height="40" viewBox="0 0 88 40" aria-hidden>
      <path d="M6 30 C 22 30, 28 12, 46 16 S 70 8, 82 10" fill="none" stroke={stroke} strokeWidth="1.6" />
      <path d="M6 30 C 22 30, 28 12, 46 16 S 70 8, 82 10 V34 H6 Z" fill={stroke} opacity="0.18" />
    </svg>
  );
}
