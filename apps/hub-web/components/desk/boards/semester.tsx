"use client";
import type { State } from "../ui";
import { PlotSlot } from "../plots";
import * as S from "../widgets/student";

export function Tiles({ state, plots }: { state?: State; plots?: boolean; mobile?: boolean }) {
  const c = plots ? 3 : 4;
  return (
    <>
      <S.WeekStrip state={state} plots={plots} />
      <S.DeadlineRail state={state} plots={plots} />
      <S.CourseRings state={state} plots={plots} />
      <S.Streak state={state} plots={plots} />
      <S.NowNext state={state} plots={plots} />
      <S.StudyPlan state={state} c={c} plots={plots} />
      <S.GroupProject state={state} c={c} plots={plots} />
      <S.Reading state={state} c={c} plots={plots} />
      {plots ? <PlotSlot state={state} title="Study hours" c={3} r={3} /> : null}
    </>
  );
}
