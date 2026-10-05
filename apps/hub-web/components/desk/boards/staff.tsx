"use client";
import type { State } from "../ui";
import { PlotSlot } from "../plots";
import * as M from "../widgets/manager";

export function Tiles({ state, plots }: { state?: State; plots?: boolean; mobile?: boolean }) {
  const c = plots ? 4 : 6;
  return (
    <>
      <M.TeamLoad state={state} plots={plots} />
      <M.Blockers state={state} plots={plots} />
      <M.OneOnOnes state={state} c={c} plots={plots} />
      <M.Objectives state={state} c={c} plots={plots} />
      {plots ? <PlotSlot state={state} title="Load trend" meta="plot slot · 8 weeks" c={4} r={3} /> : null}
      <M.DecisionLog state={state} plots={plots} />
      <M.WhosOut state={state} plots={plots} />
    </>
  );
}
