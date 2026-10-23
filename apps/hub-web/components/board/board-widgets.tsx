"use client";

import type { BoardPage, PageBoardRecord, PageBoardTile } from "@ensemble/shared-types";
import { Columns3, FileText, History, PieChart, Plus, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { plural, relative } from "@/lib/format";
import { Dialog } from "../ui";
import { boardPageHref } from "@/lib/page-boards";

const TILES = {
  count: { title: "Page count", description: "A quiet count of everything on this board.", icon: FileText },
  distribution: { title: "By column", description: "A donut chart using your column names and colors.", icon: PieChart },
  flow: { title: "Column breakdown", description: "Compare the number of pages at each stage.", icon: Columns3 },
  recent: { title: "Recently edited", description: "Pick up where you left off on this board.", icon: History },
};
const COLORS = { gray: "var(--muted)", blue: "#6498d6", violet: "#a48ada", amber: "#cea45a", green: "#6baa8b", rose: "#d18597" };

export function BoardWidgets({ board, pages, editable, pending, onChange }: { board: PageBoardRecord; pages: BoardPage[]; editable: boolean; pending: boolean; onChange: (tiles: PageBoardTile[]) => void }) {
  const [gallery, setGallery] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  let offset = 0;
  const counts = board.columns.map((column) => ({ ...column, count: pages.filter((page) => page.columnId === column.id).length }));
  const gradient = counts.map((column) => { const start = offset; offset += pages.length ? column.count / pages.length * 100 : 0; return `${COLORS[column.color]} ${start}% ${offset}%`; }).join(", ");
  return <section className="cb-widgets" aria-label={`${board.title} overview`}>
    <div className="cb-section-heading"><button type="button" aria-expanded={!collapsed} aria-controls="custom-board-widgets" onClick={() => setCollapsed(!collapsed)}><Columns3 size={14} />Board overview</button>{editable && <button type="button" className="btn-ghost" onClick={() => setGallery(true)}><Plus size={13} />Board tiles</button>}</div>
    {!collapsed && <div className="cb-widget-grid" id="custom-board-widgets">
      {board.tiles.map((tile) => <article className="cb-widget" key={tile}><header><span>{TILES[tile].title}</span>{editable && <button type="button" className="icon-btn" disabled={pending} aria-label={`Remove ${TILES[tile].title} tile`} onClick={() => onChange(board.tiles.filter((id) => id !== tile))}><X size={12} /></button>}</header>
        {tile === "count" ? <div className="cb-count"><strong>{pages.length}</strong><span>{plural(board.columns.length, "column")} in {board.title}</span><p>Every card has room for the whole story.</p></div>
          : tile === "distribution" ? <div className="cb-distribution"><div className="cb-donut" role="img" aria-label={counts.map((column) => `${column.name}: ${column.count}`).join(", ")} style={{ background: pages.length ? `conic-gradient(${gradient})` : "var(--line)" }}><span>{pages.length}<small>{pages.length === 1 ? "page" : "pages"}</small></span></div><div className="cb-chart-legend">{counts.map((column) => <span key={column.id} data-board-color={column.color}><i />{column.name}<b>{column.count}</b></span>)}</div></div>
          : tile === "flow" ? <div className="cb-bars">{counts.map((column) => <div key={column.id} data-board-color={column.color}><span>{column.name}<b>{column.count}</b></span><div><i style={{ width: `${pages.length ? column.count / pages.length * 100 : 0}%` }} /></div></div>)}</div>
          : <div className="cb-recent">{[...pages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3).map((page) => <Link key={page.id} href={boardPageHref(page)}><FileText size={13} /><span>{page.title}</span><small>{relative(page.updatedAt)}</small></Link>)}{!pages.length && <p>Add a page to start your board.</p>}</div>}
      </article>)}
      {!board.tiles.length && editable && <button type="button" className="cb-widget-empty" onClick={() => setGallery(true)}><Plus size={17} />Add an overview tile<span>Only pages from {board.title} appear here.</span></button>}
    </div>}
    {gallery && <Dialog open title={`Tiles for ${board.title}`} onClose={() => setGallery(false)} width={620}><p className="mb-4 text-[13px] text-muted">These tiles use only this board’s pages and your column names.</p><div className="cb-tile-options">{(Object.keys(TILES) as PageBoardTile[]).map((id) => { const tile = TILES[id], Icon = tile.icon, selected = board.tiles.includes(id); return <button key={id} type="button" aria-pressed={selected} disabled={pending} onClick={() => onChange(selected ? board.tiles.filter((key) => key !== id) : [...board.tiles, id])}><Icon size={20} /><span><strong>{tile.title}</strong><small>{tile.description}</small></span><b>{selected ? "Remove" : "Add"}</b></button>; })}</div></Dialog>}
  </section>;
}
