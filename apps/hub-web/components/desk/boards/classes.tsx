"use client";
import type { State } from "../ui";
import { PlotSlot } from "../plots";
import * as T from "../widgets/teacher";

export function Tiles({ state, plots }: { state?: State; plots?: boolean; mobile?: boolean }) {
  return (
    <>
      <T.Timetable state={state} plots={plots} />
      <T.Grading state={state} plots={plots} />
      <T.SyllabusClass state={state} plots={plots} />
      <T.FollowUpsT state={state} plots={plots} />
      <T.Attendance state={state} plots={plots} />
      <T.Ptm state={state} plots={plots} />
      {plots ? <PlotSlot state={state} title="Marks by class" meta="plot slot · e.g. scores vs test, per section" c={6} r={4} /> : null}
      <T.Duty state={state} plots={plots} />
      <T.NextTest state={state} plots={plots} />
    </>
  );
}
