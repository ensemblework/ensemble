"use client";
import type { State } from "../ui";
import { PlotSlot } from "../plots";
import * as G from "../widgets/general";

export function Tiles({ state, plots, mobile }: { state?: State; plots?: boolean; mobile?: boolean }) {
  const c = plots ? 3 : 4;
  return (
    <>
      <G.YourDay state={state} plots={plots} mobile={mobile} />
      <G.NeedsMe state={state} plots={plots} />
      <G.Brief state={state} plots={plots} />
      <G.Focus state={state} plots={plots} />
      <G.Proposals state={state} plots={plots} />
      <G.Deliverables state={state} c={c} plots={plots} />
      <G.People state={state} c={c} plots={plots} />
      <G.Reminders state={state} c={c} plots={plots} />
      {plots ? <PlotSlot state={state} title="Focus time" c={3} r={3} /> : null}
    </>
  );
}
