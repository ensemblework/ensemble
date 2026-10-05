"use client";
import type { State } from "../ui";
import { PlotSlot } from "../plots";
import * as D from "../widgets/dev";

export function Tiles({ state, plots, mobile }: { state?: State; plots?: boolean; mobile?: boolean }) {
  if (mobile) {
    return (
      <>
        <D.PrQueue c={4} r={5} mobile state={state} plots={plots} />
        <D.BranchActivity c={4} r={2} mobile state={state} plots={plots} />
        <D.Wip c={2} r={2} state={state} plots={plots} />
        <D.CiHealth mobile state={state} plots={plots} />
        <D.Issues c={4} r={3} mobile state={state} plots={plots} />
        <D.Deploys c={4} r={3} mobile state={state} plots={plots} />
        {plots ? <PlotSlot title="Commit trend" c={4} r={2} mobile state={state} /> : null}
      </>
    );
  }
  const c = plots ? 3 : 4;
  return (
    <>
      <D.PrQueue state={state} plots={plots} />
      <D.BranchActivity state={state} plots={plots} />
      <D.CiHealth state={state} plots={plots} />
      <D.Deploys state={state} plots={plots} />
      <D.Issues state={state} plots={plots} />
      <D.Wip state={state} c={c} plots={plots} />
      <D.Blocked state={state} c={c} plots={plots} />
      <D.WeekDone state={state} c={c} plots={plots} />
      {plots ? <PlotSlot state={state} title="Commit trend" c={3} r={2} /> : null}
    </>
  );
}
