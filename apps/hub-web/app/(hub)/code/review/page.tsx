"use client";

import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { CodeIde } from "@/components/code/ide";
import { CodeTargetProvider, type CodeTarget, type Source } from "@/lib/code-target";

/**
 * A review or a checkout in the Code tab's IDE (`components/code/ide.tsx`). `?device=<id>`: on a
 * paired computer, through Ensemble on the web (docs/25 §4.7).
 */
export default function ReviewPage() {
  const params = useSearchParams();
  const device = params.get("device");
  const target = useMemo<CodeTarget>(() => (device ? { kind: "device", deviceId: device } : { kind: "local" }), [device]);
  const review = params.get("review");
  const repo = params.get("repo");
  const source = useMemo<Source>(() => ({ review: review ?? undefined, repo: repo ?? undefined }), [review, repo]);
  return (
    <CodeTargetProvider value={target}>
      <CodeIde source={source} />
    </CodeTargetProvider>
  );
}
