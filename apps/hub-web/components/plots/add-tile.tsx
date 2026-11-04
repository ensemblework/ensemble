"use client";

import { useMemo, useState } from "react";
import { GALLERY, type GallerySlot, type PoolColumn } from "@ensemble/shared-types";
import { PlotDialog } from "@/components/plots/plot-dialog";
import { InfoTip } from "@/components/ui";
import { ArrowLeft, Search } from "lucide-react";

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

  const nameOf = (id: string | null) => (id ? columns.find((column) => column.id === id)?.name ?? null : null);
  /** The columns in one slot, by name, for its chip. */
  const slotNames = (name: GallerySlot): string[] => {
    if (name === "x") return [nameOf(xRef)].filter((item): item is string => Boolean(item));
    if (name === "y") return yRefs.map(nameOf).filter((item): item is string => Boolean(item));
    if (name === "error") return [nameOf(errorRef)].filter((item): item is string => Boolean(item));
    if (name === "seed") return [nameOf(seedRef)].filter((item): item is string => Boolean(item));
    return [nameOf(valueRef)].filter((item): item is string => Boolean(item));
  };
  /** Which slots a column fills, for its row's marks. */
  const slotsOf = (id: string): GallerySlot[] =>
    (gallery?.slots ?? []).filter((name) => (name === "x" ? xRef === id : name === "y" ? yRefs.includes(id) : name === "error" ? errorRef === id : name === "seed" ? seedRef === id : valueRef === id));

  const filled = (name: GallerySlot) => {
    if (name === "x") return Boolean(xRef);
    if (name === "y") return yRefs.length > 0;
    if (name === "error") return Boolean(errorRef);
    if (name === "seed") return Boolean(seedRef);
    return Boolean(valueRef);
  };

  return (
    <PlotDialog
      open={open}
      onClose={close}
      title={gallery ? gallery.label : "Add tile"}
      description={gallery ? "Pick a column for each slot. Y can take several." : "Pick a chart. Next, choose its columns."}
      width={760}
    >
      {!gallery ? (
        <div className="space-y-5" data-gallery>
          {(["paper", "everyday"] as const).map((group) => (
            <section key={group}>
              <h4 className="pl-section-label">{group === "paper" ? "Paper figures" : "Everyday charts"}</h4>
              <div className="pl-gallery-grid">
                {GALLERY.filter((item) => item.group === group).map((item) => (
                  <button key={item.id} type="button" className="pl-gallery-card" onClick={() => { setGallery(item); setSlot(item.slots[0] ?? "x"); }}>
                    <span className="pl-gallery-mark"><GalleryMark id={item.id} /></span>
                    <span className="pl-gallery-name">{item.label}</span>
                    <span className="pl-gallery-blurb">{item.blurb}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div data-column-pool>
          <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[12px]" role="group" aria-label="Chart slots">
            {gallery.slots.map((name) => {
              const picked = slotNames(name);
              return (
                <button
                  key={name}
                  type="button"
                  aria-pressed={slot === name}
                  className="pl-slot"
                  data-filled={picked.length ? "1" : undefined}
                  onClick={() => setSlot(name)}
                >
                  <span className="pl-slot-key">{SLOT_LABEL[name]}</span>
                  <span className="truncate">{picked.length ? picked.join(", ") : name === "seed" ? "optional" : "pick a column"}</span>
                </button>
              );
            })}
            <InfoTip label={`How ${gallery.label} uses columns`} text={gallery.hint} />
          </div>
          <label className="pl-search mb-2">
            <Search size={14} aria-hidden className="pl-search-icon" />
            <input className="pl-search-input" aria-label="Search columns" placeholder="Search columns" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <ul className="max-h-72 space-y-0.5 overflow-auto">
            {filtered.map((column) => (
              <li key={column.id}>
                <button
                  type="button"
                  aria-pressed={slotsOf(column.id).length > 0}
                  className="pl-col-row"
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
                  <span className="min-w-0 flex-1 truncate text-[13px]">{column.name}</span>
                  {slotsOf(column.id).map((name) => <span key={name} className="pl-slot-mark">{SLOT_LABEL[name]}</span>)}
                  <span className="pl-type">{column.type}</span>
                  {column.source ? <span className="max-w-[10rem] truncate text-[11px] text-muted">{column.source}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          {!columns.length ? <p className="text-[13px] text-muted">Upload a table first. Tiles share that data.</p> : null}
          <div className="pl-dialog-footer">
            <button type="button" className="pl-btn" onClick={() => setGallery(null)}><ArrowLeft size={14} aria-hidden />Back</button>
            <button
              type="button"
              className="btn-primary pl-primary"
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
