"use client";

import { useEffect, useState, type ComponentType, type CSSProperties } from "react";
import { DESKS, type DeskId } from "./desks";
import { DeskPreviewProvider, accentVars, type State } from "./ui";
import "./desk.css";

const LOADERS: Record<DeskId, () => Promise<{ Tiles: ComponentType<{ state?: State; plots?: boolean }> }>> = {
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

/** A scaled copy of a real desk. Each persona loads in its own chunk. */
export function DeskMini({
  deskId,
  width,
  height,
  head = true,
  state = "populated",
  style,
}: {
  deskId: DeskId;
  width: number;
  height: number;
  head?: boolean;
  state?: State;
  style?: CSSProperties;
}) {
  const desk = DESKS[deskId];
  const [Tiles, setTiles] = useState<ComponentType<{ state?: State; plots?: boolean }> | null>(null);
  useEffect(() => {
    let live = true;
    setTiles(null);
    void LOADERS[deskId]().then((mod) => {
      if (live) setTiles(() => mod.Tiles);
    });
    return () => {
      live = false;
    };
  }, [deskId]);
  const scale = width / 1224;
  return (
    <div
      className="desk"
      data-desk-mini={deskId}
      style={{
        width,
        height,
        overflow: "hidden",
        position: "relative",
        borderRadius: 10,
        background: "radial-gradient(80% 60% at 0% 0%, rgb(var(--accent-rgb) / 0.14), transparent 60%), var(--bg)",
        boxShadow: "inset 0 0 0 1px rgba(243,238,230,0.06)",
        ...accentVars(desk.accent),
        ...style,
      }}
    >
      <div style={{ width: 1224, padding: "26px 22px", transform: `scale(${scale})`, transformOrigin: "0 0", pointerEvents: "none" }}>
        {head ? (
          <div style={{ marginBottom: 18 }}>
            <div className="row gap8" style={{ fontSize: 12.5, color: "var(--muted)" }}>
              Wed, 30 Sept
              <span className="deskchip">
                <i />
                {desk.name}
              </span>
            </div>
            <div className="display" style={{ fontSize: 34, marginTop: 4 }}>
              Today
            </div>
          </div>
        ) : null}
        <DeskPreviewProvider>
          <div className="bento">{Tiles ? <Tiles state={state} plots={false} /> : null}</div>
        </DeskPreviewProvider>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 48, background: "linear-gradient(180deg, transparent, rgba(20,18,16,0.95))" }} />
    </div>
  );
}
