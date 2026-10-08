"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { useDelayedFlag } from "@/lib/motion/use-delayed-flag";
import { api } from "@/lib/api";
import { useModuleOn } from "@/lib/use-module";
import { useToast } from "@/components/toast";
import { usePersistentState } from "@/lib/prefs";
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
  const [banner, setBanner, bannerReady] = usePersistentState("ensemble.today.sample-hint", true);
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
            {sample ? <span className="sample-mark">Sample</span> : null}
          </div>
          <h1 className="display">Today</h1>
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
          <AddTileButton deskId={deskId} plots={plots} startOpen={add} />
        </div>
      </div>
      {!sample && bannerReady && banner && liveQuery.isFetched && !filled ? (
        <div className="today-hint" data-sample-hint>
          <span>Want to see what a full desk looks like first?</span>
          <button type="button" className="btn" onClick={() => void setFlag(SAMPLE_KEY, true)}>Show a sample</button>
          <button type="button" className="today-hint-x" aria-label="Dismiss" onClick={() => setBanner(false)}>
            <X size={13} />
          </button>
        </div>
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
