"use client";

import type { DeskId } from "@/components/desk/desks";
import { DeskView } from "@/components/desk/view";
import type { LayoutPayload, TodayCues, TodayNudges } from "@/lib/server-layout";
import { TodayScreen } from "./screen";

export function TodayBody({
  persona,
  layout,
  nudges,
  cues,
  samples = false,
  plots = false,
  panel = null,
  apply = false,
  add = false,
  form = null,
}: {
  persona: DeskId | null;
  layout: LayoutPayload | null;
  nudges: TodayNudges | null;
  cues: TodayCues | null;
  samples?: boolean;
  plots?: boolean;
  panel?: string | null;
  apply?: boolean;
  add?: boolean;
  form?: string | null;
}) {
  if (persona) return <DeskView deskId={persona} plots={plots} panel={panel} apply={apply} add={add} form={form} />;
  return <TodayScreen initialLayout={layout} initialNudges={nudges} initialCues={cues} samples={samples} />;
}
