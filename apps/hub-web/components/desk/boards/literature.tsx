"use client";
import type { State } from "../ui";
import { PlotSlot } from "../plots";
import * as R from "../widgets/research";

export function Tiles({ state, plots }: { state?: State; plots?: boolean; mobile?: boolean }) {
  const c = plots ? 3 : 4;
  return (
    <>
      <R.Pipeline state={state} plots={plots} />
      <R.WordCount state={state} c={c} plots={plots} />
      <R.CiteGraph state={state} c={c} plots={plots} />
      <R.ReadStreak state={state} c={c} plots={plots} />
      {plots ? <PlotSlot state={state} title="Reading trend" c={3} r={3} /> : null}
      <R.OpenQs state={state} plots={plots} />
      <R.Advisor state={state} plots={plots} />
      <R.Venue state={state} plots={plots} />
    </>
  );
}
