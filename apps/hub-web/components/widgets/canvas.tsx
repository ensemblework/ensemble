"use client";

import dynamic from "next/dynamic";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  columnsForWidth,
  phoneWidth,
  placementKey,
  tileLabel,
  WIDGET_REGISTRY,
  type LayoutDocument,
  type LayoutSurface,
  type Placement,
  type Size,
  type WidgetId,
} from "@ensemble/shared-types/widgets";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import type { LayoutPayload, TodayCues, TodayNudges } from "@/lib/server-layout";
import { useSpaceAccess } from "@/lib/access";

const EditCanvas = dynamic(() => import("./edit-mode").then((mod) => mod.EditCanvas), { ssr: false });

export function WidgetCanvas({
  surface,
  title,
  kicker,
  toolbar,
  belowHeader,
  panelId,
  render,
  bare = false,
  initialLayout = null,
  initialNudges = null,
  initialCues = null,
  samples = false,
}: {
  surface: LayoutSurface;
  title?: string;
  kicker?: string;
  toolbar?: ReactNode;
  belowHeader?: ReactNode;
  panelId?: string;
  bare?: boolean;
  initialLayout?: LayoutPayload | null;
  initialNudges?: TodayNudges | null;
  initialCues?: TodayCues | null;
  /** Marketplace sample rows, known on the first paint. Signup desks stay false. */
  samples?: boolean;
  render: (type: WidgetId, size: Size, placement?: Placement) => ReactNode;
}) {
  // Layouts are the space owner's: someone it is shared with sees theirs, unchanged.
  const guest = useSpaceAccess().guest;
  const layout = useQuery({
    queryKey: ["layout", surface],
    queryFn: () => api.layout(surface),
    initialData: initialLayout ?? undefined,
    staleTime: 30_000,
    refetchOnMount: initialLayout ? false : true,
  });
  const document = (layout.data?.document ?? null) as LayoutDocument | null;
  const placements = document?.placements ?? [];
  const cuesOn = placements.some((row) => row.type === "meeting-cues");
  const nudgesOn = placements.some((row) => row.type === "stale-nudges");
  const cues = useQuery({
    queryKey: ["meeting-cues"],
    queryFn: api.meetingCues,
    enabled: cuesOn,
    initialData: cuesOn && initialCues ? initialCues : undefined,
    staleTime: 60_000,
    refetchOnMount: initialCues ? false : true,
  });
  const nudges = useQuery({
    queryKey: ["nudges"],
    queryFn: api.nudges,
    enabled: nudgesOn,
    initialData: nudgesOn && initialNudges ? initialNudges : undefined,
    staleTime: 60_000,
    refetchOnMount: initialNudges ? false : true,
  });
  const [editing, setEditing] = useState(false);
  const [sampleNotice, setSampleNotice] = useState(samples);
  const [settle, setSettle] = useState(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("applied") !== "1") return;
    url.searchParams.delete("applied");
    const next = url.pathname + (url.searchParams.size ? `?${url.searchParams}` : "");
    window.history.replaceState(null, "", next);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    setSettle(true);
    const timer = window.setTimeout(() => setSettle(false), 900);
    return () => window.clearTimeout(timer);
  }, []);
  const [width, setWidth] = useState(0);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => {
      const next = el.clientWidth;
      if (next > 0) setWidth(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const client = useQueryClient();
  const toast = useToast();
  const incidentOn = placements.some((row) => row.type === "incident-now");
  const incidents = useQuery({
    queryKey: ["widget-feed"],
    queryFn: api.widgetFeed,
    enabled: incidentOn && !editing,
    staleTime: 30_000,
  });
  const hidden = useMemo(() => {
    if (editing) return new Set<string>();
    const next = new Set<string>();
    if (cuesOn && (!cues.data || cues.data.cues.length === 0)) next.add("meeting-cues");
    if (nudgesOn && (!nudges.data || nudges.data.nudges.length === 0)) next.add("stale-nudges");
    const incidentLive = incidents.data?.tasks.some((task) => task.status === "blocked" || task.taskType === "incident");
    if (incidentOn && !incidentLive) next.add("incident-now");
    return next;
  }, [editing, cuesOn, nudgesOn, cues.data, nudges.data, incidentOn, incidents.data]);

  const visible = placements.filter((row) => !hidden.has(row.type));
  const columns = width ? columnsForWidth(width) : 12;
  const phone = width ? phoneWidth(width) : false;
  const ready = Boolean(document) && !layout.isLoading;

  return (
    <div className={bare ? "min-w-0" : "mx-auto min-w-0 max-w-[1180px] px-4 pb-24 pt-8 sm:px-10"}>
      {title ? (
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            {kicker ? <div className="text-[13px] text-muted">{kicker}</div> : null}
            <h1 className="display mt-1 text-[32px] leading-none">{title}</h1>
          </div>
          <div className="flex items-center gap-2">
            {toolbar}
            {sampleNotice ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void api.clearSamples().then((result) => {
                    if (result.cleared > 0) setSampleNotice(false);
                    toast(result.cleared ? "Sample rows cleared." : "No sample rows to clear.", { tone: "ok" });
                    void client.invalidateQueries({ queryKey: ["widget-feed"] });
                    void client.invalidateQueries({ queryKey: ["tasks"] });
                  });
                }}
              >
                Clear samples
              </button>
            ) : null}
            {guest ? null : (
              <button type="button" className="btn" onClick={() => setEditing(true)}>
                Edit layout
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="mb-2 flex justify-end">
          {guest ? null : (
            <button type="button" className="btn-ghost text-[12.5px]" onClick={() => setEditing(true)}>
              Edit layout
            </button>
          )}
        </div>
      )}
      {sampleNotice ? (
        <p className="mb-3 text-[12.5px] text-faint">These rows are samples. Clear them when the real work starts.</p>
      ) : null}
      {belowHeader}
      <div ref={frame} className="widget-frame" id={panelId} role={panelId ? "tabpanel" : undefined} aria-label={panelId ? "Overview" : undefined} tabIndex={panelId ? 0 : undefined}>
        {editing && document ? (
          <EditCanvas
            surface={surface}
            initial={document}
            columns={width ? columns : 12}
            phone={phone}
            onClose={() => setEditing(false)}
            render={render}
          />
        ) : (
          <div
            data-widget-grid={surface}
            data-columns={width ? columns : undefined}
            data-phone={phone ? "1" : "0"}
            className={`widget-grid${settle ? " is-settling" : ""}`}
          >
            {!ready ? (
              <div className="skeleton col-span-full h-[212px] rounded-xl" />
            ) : (
              visible.map((cell, index) => (
                <section
                  key={placementKey(cell)}
                  role="region"
                  aria-label={tileLabel(cell)}
                  data-widget={cell.type}
                  data-size={cell.size}
                  data-order={index}
                  data-density={cell.config?.density ?? "comfortable"}
                  data-accent={cell.config?.accent || undefined}
                  className="widget-tile tile rounded-xl bg-panel/80"
                  style={{ animationDelay: settle ? `${Math.min(index, 8) * 45}ms` : undefined }}
                >
                  <div className="widget-kicker px-3 pt-2.5 text-[12px] font-medium uppercase tracking-[0.08em] text-faint">
                    {tileLabel(cell)}
                  </div>
                  <div className="widget-body px-3 pb-2.5">{render(cell.type, cell.size, cell)}</div>
                </section>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
