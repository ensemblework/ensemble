"use client";
import type { State } from "../ui";
import { PlotSlot } from "../plots";
import * as K from "../widgets/maker";

export function Tiles({ state, plots }: { state?: State; plots?: boolean; mobile?: boolean }) {
  return (
    <>
      <K.Gantt state={state} plots={plots} />
      <K.Bom state={state} plots={plots} />
      <K.TestGrid state={state} plots={plots} />
      <K.BuildLog state={state} plots={plots} />
      <K.Budget state={state} plots={plots} />
      <K.LeadTime state={state} plots={plots} />
      {plots ? <PlotSlot state={state} title="Current draw · series" meta="plot slot · e.g. amps vs time, per board" c={6} r={4} /> : null}
      <K.CurrentDraw state={state} plots={plots} />
      <K.NextMilestone state={state} plots={plots} />
    </>
  );
}
