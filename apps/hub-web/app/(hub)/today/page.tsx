import { deskIdFromTemplate } from "@/components/desk/desks";
import { desktopExport } from "@/lib/desktop-export";
import { loadActiveTemplateId, loadSampleNotice, loadTodayDesk } from "@/lib/server-layout";
import { TodayBody } from "./body";
import { TodayDesktop } from "./desktop-page";

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ view?: string; plots?: string; panel?: string; apply?: string; add?: string; form?: string }> }) {
  if (desktopExport()) return <TodayDesktop />;
  const params = await searchParams;
  const widgets = params.view === "widgets";
  const [desk, templateId, samples] = await Promise.all([
    loadTodayDesk(),
    loadActiveTemplateId(),
    widgets ? loadSampleNotice() : Promise.resolve(false),
  ]);
  const persona = widgets ? null : deskIdFromTemplate(templateId);
  return (
    <TodayBody
      persona={persona}
      layout={desk.layout}
      nudges={desk.nudges}
      cues={desk.cues}
      samples={samples}
      plots={params.plots === "1"}
      panel={params.panel ?? null}
      apply={params.apply === "1"}
      add={params.add === "1"}
      form={params.form ?? null}
    />
  );
}
