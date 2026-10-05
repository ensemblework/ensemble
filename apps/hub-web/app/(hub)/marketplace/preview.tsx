"use client";

import dynamic from "next/dynamic";
import { WIDGET_REGISTRY, type WidgetId } from "@ensemble/shared-types/widgets";

const LensTile = dynamic(() => import("@/components/widgets/lenses").then((mod) => mod.LensTile), { ssr: false });

const SPAN: Record<string, number> = { s: 3, m: 6, l: 6, xl: 12 };

export function TemplatePreview({
  placements,
}: {
  placements: Array<{ type: string; size: string }>;
}) {
  return (
    <div className="grid grid-cols-12 gap-2" aria-label="Preview">
      {placements.map((row, index) => {
        const spec = WIDGET_REGISTRY[row.type as WidgetId];
        return (
          <section
            key={`${row.type}-${index}`}
            className="min-h-[120px] rounded-xl bg-panel/80 p-3"
            style={{ gridColumn: `span ${SPAN[row.size] ?? 6}` }}
          >
            <div className="text-[12px] font-medium uppercase tracking-[0.08em] text-faint">{spec?.label ?? row.type}</div>
            <div className="mt-2">
              {spec?.blurb ? <LensTile type={row.type as WidgetId} /> : <p className="text-[13px] text-muted">Your {spec?.label ?? "tile"} stays in this spot.</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
