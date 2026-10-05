"use client";
import type { State } from "../ui";
import * as E from "../widgets/exam";

export function Tiles({ state, plots, mobile }: { state?: State; plots?: boolean; mobile?: boolean }) {
  if (mobile) {
    return (
      <>
        <E.Countdown mobile state={state} plots={plots} />
        <E.DailyTarget mobile state={state} plots={plots} />
        <E.Affairs mobile state={state} plots={plots} />
        <E.RevisionQueue c={4} r={3} mobile state={state} plots={plots} />
        <E.MockTrend c={4} r={3} mobile state={state} plots={plots} />
        <E.Syllabus c={4} r={3} state={state} plots={plots} />
      </>
    );
  }
  return (
    <>
      <E.Countdown state={state} plots={plots} />
      <E.DailyTarget state={state} plots={plots} />
      <E.Affairs state={state} plots={plots} />
      <E.Syllabus state={state} plots={plots} />
      <E.MockTrend state={state} plots={plots} />
      <E.RevisionQueue state={state} plots={plots} />
      <E.HoursHeat state={state} plots={plots} />
      <E.PyqAccuracy state={state} plots={plots} />
    </>
  );
}
