"use client";
import type { State } from "../ui";
import * as L from "../widgets/legal";

export function Tiles({ state, plots, mobile }: { state?: State; plots?: boolean; mobile?: boolean }) {
  if (mobile) {
    return (
      <>
        <L.LimitationMobile />
        <L.CauseList mobile state={state} plots={plots} />
        <L.Unbilled mobile state={state} plots={plots} />
        <L.Hearings c={4} r={3} mobile state={state} plots={plots} />
        <L.Filings c={4} r={4} state={state} plots={plots} />
        <L.Billable c={4} r={3} state={state} plots={plots} />
      </>
    );
  }
  return (
    <>
      <L.LimitationHero state={state} plots={plots} />
      <L.Hearings state={state} plots={plots} />
      <L.Billable state={state} plots={plots} />
      <L.Stages state={state} plots={plots} />
      <L.Filings state={state} plots={plots} />
      <L.Drafts state={state} plots={plots} />
      <L.CauseList state={state} plots={plots} />
      <L.Unbilled state={state} plots={plots} />
      <L.LegalFocus state={state} plots={plots} />
      <L.FollowUps state={state} plots={plots} />
    </>
  );
}
