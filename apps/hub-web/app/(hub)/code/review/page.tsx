"use client";

import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { CodeIde, type IdeView } from "@/components/code/ide";
import { CodeTargetProvider, type CodeTarget, type Source } from "@/lib/code-target";

/**
 * A review or a checkout in the Code tab's IDE (`components/code/ide.tsx`). `?device=<id>`: on a
 * paired computer, through Ensemble on the web (docs/25 §4.7). `?file=<path>` opens that file first;
 * `?view=agent|editor` shows the agent's thread or the editor (docs/16 §9).
 */
export default function ReviewPage() {
  const params = useSearchParams();
  const device = params.get("device");
  const target = useMemo<CodeTarget>(() => (device ? { kind: "device", deviceId: device } : { kind: "local" }), [device]);
  const review = params.get("review");
  const repo = params.get("repo");
  const source = useMemo<Source>(() => ({ review: review ?? undefined, repo: repo ?? undefined }), [review, repo]);
  const view = params.get("view");
  return (
    <CodeTargetProvider value={target}>
      <CodeIde key={`${device ?? ""}:${review ?? ""}:${repo ?? ""}`} source={source} initialFile={params.get("file")} initialView={view === "agent" || view === "editor" ? (view as IdeView) : null} initialThread={params.get("thread")} />
    </CodeTargetProvider>
  );
}
