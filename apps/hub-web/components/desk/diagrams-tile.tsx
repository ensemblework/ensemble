"use client";

import { useQuery } from "@tanstack/react-query";
import { Workflow } from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useModuleOn } from "@/lib/use-module";

const SAMPLE = ["System overview", "Release pipeline", "Data flow"].map((title, index) => ({ id: `sample-${index}`, title }));

/** The newest block diagrams, as many as the tile's width holds. The preview draws sample cards and fetches nothing. */
export function DiagramStrip({ c, preview = false }: { c: number; preview?: boolean }) {
  const on = useModuleOn("diagrams");
  const diagrams = useQuery({ queryKey: ["diagrams"], queryFn: api.diagrams, enabled: on && !preview });
  const rows = preview ? SAMPLE : (diagrams.data?.diagrams ?? []);
  const fit = Math.max(1, Math.min(6, Math.floor(c / 3)));
  if (!preview && diagrams.isSuccess && !rows.length) {
    return <div className="col gap8" style={{ fontSize: 13, color: "var(--muted)" }}>No diagrams yet. <Link href="/diagrams" className="qadd">Open Diagrams →</Link></div>;
  }
  return (
    <div data-diagram-strip style={{ display: "grid", gridTemplateColumns: `repeat(${fit}, minmax(0, 1fr))`, gap: 12, height: "100%", minHeight: 0 }}>
      {rows.slice(0, fit).map((row) => {
        const body = (
          <>
            {preview ? (
              <span style={{ flex: 1, minHeight: 60, display: "grid", placeItems: "center", border: "1px dashed var(--line)", borderRadius: 8, color: "var(--faint)" }}><Workflow size={22} aria-hidden /></span>
            ) : (
              <img alt="" src={`/api/diagrams/${row.id}/svg`} style={{ flex: 1, minHeight: 0, width: "100%", objectFit: "contain", background: "transparent" }} />
            )}
            <span className="trunc" style={{ fontSize: 12.5 }}>{row.title}</span>
          </>
        );
        return preview ? (
          <span key={row.id} className="col gap6" style={{ minWidth: 0, minHeight: 0 }}>{body}</span>
        ) : (
          <Link key={row.id} href={`/diagrams/${row.id}`} className="col gap6" style={{ minWidth: 0, minHeight: 0 }}>{body}</Link>
        );
      })}
    </div>
  );
}

/** How many diagrams the Diagrams tile can show, for its header. Null until known. */
export function useDiagramCount(): number | null {
  const on = useModuleOn("diagrams");
  const diagrams = useQuery({ queryKey: ["diagrams"], queryFn: api.diagrams, enabled: on });
  return on && diagrams.isSuccess ? diagrams.data.diagrams.length : null;
}
