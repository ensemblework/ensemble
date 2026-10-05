"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { useDelayedFlag } from "@/lib/motion/use-delayed-flag";
import { api } from "@/lib/api";
import { useModuleOn } from "@/lib/use-module";
import { useToast } from "@/components/toast";
import { resolveExtras } from "@/lib/desk-extras";
import { DESKS, type DeskId } from "./desks";
import { LiveBoard, liveLine, ownCount } from "./live-board";
import { ChartTypePanel, PlotsGalleryPanel } from "./plots-panel";
import { AddTileButton, AddedTiles } from "./add-tile";
import type { State } from "./ui";
import "./desk.css";

const LOADERS: Record<DeskId, () => Promise<{ Tiles: ComponentType<{ state?: State; plots?: boolean; mobile?: boolean }> }>> = {
  default: () => import("./boards/default"),
  semester: () => import("./boards/semester"),
  exam: () => import("./boards/exam"),
  literature: () => import("./boards/literature"),
  chambers: () => import("./boards/chambers"),
  classes: () => import("./boards/classes"),
  staff: () => import("./boards/staff"),
  branch: () => import("./boards/branch"),
  bench: () => import("./boards/bench"),
};

const SAMPLE_KEY = "desk.sample";
const PLOTS_KEY = "desk.plots";

function kickDate(now = new Date()) {
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][now.getDay()];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"][now.getMonth()];
  return `${weekday}, ${now.getDate()} ${month}`;
}

function flagValue(preferences: Array<{ key: string; value: unknown }> | undefined, key: string) {
  return preferences?.find((row) => row.key === key)?.value === true;
}

export function DeskView({
  deskId,
  plots: plotsQuery = false,
  panel: panelQuery = null,
  apply = false,
  add = false,
  form = null,
}: {
  deskId: DeskId;
  plots?: boolean;
  panel?: string | null;
  apply?: boolean;
  add?: boolean;
  form?: string | null;
}) {
  const desk = DESKS[deskId];
  const toast = useToast();
  const client = useQueryClient();
  const [panel, setPanel] = useState<string | null>(panelQuery);
  const diagramsOn = useModuleOn("diagrams");
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: api.preferences });
  const diagrams = useQuery({ queryKey: ["diagrams"], queryFn: api.diagrams, enabled: diagramsOn });
  const [Tiles, setTiles] = useState<ComponentType<{ state?: State; plots?: boolean; mobile?: boolean }> | null>(null);
  const [phone, setPhone] = useState(false);
  const [banner, setBanner] = useState(true);
  const [enter, setEnter] = useState(false);
  const sawLoader = useRef(false);

  const samplePref = flagValue(prefs.data?.preferences, SAMPLE_KEY);
  const plots = plotsQuery || flagValue(prefs.data?.preferences, PLOTS_KEY);
  const liveQuery = useQuery({ queryKey: ["desk-live"], queryFn: api.deskLive, enabled: prefs.isSuccess && !samplePref, staleTime: 15_000 });

  useEffect(() => {
    if (!samplePref) return;
    let live = true;
    setTiles(null);
    void LOADERS[deskId]().then((mod) => {
      if (live) setTiles(() => mod.Tiles);
    });
    return () => {
      live = false;
    };
  }, [deskId, samplePref]);

  useLayoutEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const apply = () => setPhone(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  const sample = samplePref;
  const openPanel = plots ? panel : null;
  useEffect(() => setPanel(panelQuery), [panelQuery]);
  const liveData = liveQuery.data;
  const ready = prefs.isSuccess && (sample ? Boolean(Tiles) : liveQuery.isFetched);
  const filled = Boolean(liveData && ownCount(liveData) > 0);
  const extraValue = prefs.data?.preferences.find((row) => row.key === "desk.extras")?.value;
  const extras = resolveExtras(deskId, prefs.isSuccess ? extraValue : undefined);
  const waiting = !((sample && Tiles && ready) || (!sample && ready && liveData));
  const showSkeleton = useDelayedFlag(waiting);
  if (showSkeleton) sawLoader.current = true;

  const spans = [
    ...(plots ? desk.spans.on : desk.spans.off).map(([c, r]) => ({ c, r })),
    ...[...extras].map(() => ({ c: 6, r: 3 })),
  ];

  useEffect(() => {
    if (!waiting && sawLoader.current) setEnter(true);
  }, [waiting]);

  async function setFlag(key: string, value: boolean) {
    await api.putPreference(key, value);
    await client.invalidateQueries({ queryKey: ["preferences"] });
  }

  async function clearSamples() {
    await setFlag(SAMPLE_KEY, false);
    toast("Samples cleared.", {
      action: {
        label: "Undo",
        run: () => {
          void setFlag(SAMPLE_KEY, true);
        },
      },
    });
  }

  return (
    <div className="desk page" data-desk={deskId} data-enter={enter ? "1" : undefined} data-phone={phone ? "1" : undefined} data-plots={plots ? "1" : undefined} data-sample={sample ? "1" : undefined}>
      <div className="phead">
        <div>
          <div className="kick">
            {kickDate()}
            <span className="deskchip"><i />{desk.name}</span>
            {sample ? <span className="sample-mark">Sample</span> : null}
          </div>
          <h1 className="display">Today</h1>
          <div className="u-title-thread" />
          <div className="sub">
            {sample ? (
              desk.line
            ) : !liveQuery.isFetched ? (
              <span className="sub-skel sk" data-visible={showSkeleton ? "1" : "0"} data-motion-slot="content.skeleton" data-state={showSkeleton ? "loading" : "ready"} data-motion-loading={showSkeleton ? "1" : "0"} aria-hidden />
            ) : filled && liveData ? (
              liveLine(deskId, liveData) ?? desk.empty
            ) : (
              desk.empty
            )}
          </div>
        </div>
        <div className="row gap8">
          <button
            type="button"
            className="btn"
            onClick={() => {
              const input = document.querySelector<HTMLInputElement>('input[aria-label="Ask Ensemble"]');
              if (input) {
                input.focus();
                return;
              }
              window.dispatchEvent(new CustomEvent("ensemble:ask"));
            }}
          >
            <Sparkles size={13} />Ask
          </button>
          <AddTileButton plots={plots} startOpen={add} />
        </div>
      </div>
      {!sample && banner && liveQuery.isFetched && !filled ? (
        <section className="tile hero sample-banner">
          <div style={{ position: "relative", width: 54, height: 54, borderRadius: 14, display: "grid", placeItems: "center", background: "rgb(var(--accent-rgb) / 0.14)", boxShadow: "inset 0 0 0 1px rgb(var(--accent-rgb) / 0.3)", color: "var(--accent)", flexShrink: 0 }}>
            <Sparkles size={24} />
          </div>
          <div className="col" style={{ gap: 3, minWidth: 0, flex: "0 1 360px" }}>
            <span className="display" style={{ fontSize: 21 }}>See it full before you fill it</span>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>Load a sample of this desk. It's marked as sample and clears in one click.</span>
          </div>
          <button type="button" className="btn-p" style={{ padding: "8px 14px", fontSize: 13 }} onClick={() => void setFlag(SAMPLE_KEY, true)}>
            <Sparkles size={14} />Try with sample data
          </button>
          <div className="row" style={{ marginLeft: "auto", gap: 18, paddingLeft: 18, borderLeft: "1px solid var(--line)" }}>
            {desk.steps.map((step, index) => (
              <div key={step.l} className="row gap8">
                <span style={{ width: 22, height: 22, borderRadius: 99, display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700, border: `1.5px solid ${index === 0 ? "var(--accent)" : "var(--line-strong)"}`, color: index === 0 ? "var(--accent)" : "var(--faint)" }}>{index + 1}</span>
                <div className="col" style={{ whiteSpace: "nowrap" }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{step.l}</span>
                  <span style={{ fontSize: 11, color: "var(--faint)" }}>{step.s}</span>
                </div>
              </div>
            ))}
            <button type="button" className="btn" aria-label="Dismiss sample offer" onClick={() => setBanner(false)} style={{ padding: 4 }}>
              <X size={14} color="var(--faint)" />
            </button>
          </div>
        </section>
      ) : null}
      {sample ? (
        <div className="row sb" style={{ marginBottom: 12 }}>
          <span className="sample-mark">Sample data · not your live desk</span>
          <button type="button" className="btn" onClick={() => void clearSamples()}>Clear samples</button>
        </div>
      ) : null}
      <div className={`bento${apply ? " applying" : ""}`} data-enter={enter ? "1" : undefined} data-widget-grid="desk">
        {sample && Tiles && ready ? <Tiles state="populated" plots={plots} mobile={phone} /> : !sample && ready && liveData ? <LiveBoard deskId={deskId} live={liveData} mobile={phone} plots={plots} formKind={form} /> : spans.map((span, index) => (
          <div key={index} className="tile skel sk" data-visible={showSkeleton ? "1" : "0"} data-motion-loading={showSkeleton ? "1" : "0"} data-motion-slot="content.skeleton" data-state={showSkeleton ? "loading" : "ready"} style={{ gridColumn: `span ${span.c}`, gridRow: `span ${span.r}`, ["--i" as string]: index }} />
        ))}
      </div>
      <AddedTiles />
      {openPanel === "plots" ? <PlotsGalleryPanel onClose={() => { setPanel(null); window.history.replaceState(null, "", window.location.pathname); }} /> : null}
      {openPanel === "chart" ? <ChartTypePanel onClose={() => { setPanel(null); window.history.replaceState(null, "", window.location.pathname); }} /> : null}
      {diagramsOn && (diagrams.data?.diagrams.length ?? 0) > 0 ? (
        <section className="tile" style={{ marginTop: 12 }} data-widget="diagrams">
          <header className="th">
            <span className="tt">Diagrams</span>
            <span className="tm">{diagrams.data!.diagrams.length} linked</span>
          </header>
          <div className="row gap12" style={{ alignItems: "stretch" }}>
            {diagrams.data!.diagrams.slice(0, 3).map((row) => (
              <a key={row.id} href={`/diagrams/${row.id}`} className="col gap6" style={{ flex: 1, minWidth: 0 }}>
                <img alt="" src={`/api/diagrams/${row.id}/svg`} style={{ width: "100%", height: 120, objectFit: "contain", background: "transparent" }} />
                <span className="trunc" style={{ fontSize: 12.5 }}>{row.title}</span>
              </a>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
