"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { CodeHome } from "@/components/code/code-home";

/**
 * Code's window on its Welcome tab (`components/code/code-home.tsx`); `?job=<id>&file=<path>` opens a
 * run's files. `?view=agent` shows the agent (docs/16 §9), `&thread=<id>` (or `new`) a thread, and
 * `&device=<id>&repo=<path>` where a new one starts.
 */
export default function CodePage() {
  const params = useSearchParams();
  const router = useRouter();
  const view = params.get("view");
  const device = params.get("device");
  const repo = params.get("repo");
  return (
    <CodeHome
      jobId={params.get("job")}
      file={params.get("file")}
      onCloseRun={() => router.replace("/code", { scroll: false })}
      initialView={view === "agent" || view === "editor" ? view : null}
      initialThread={params.get("thread")}
      initialPlace={device || repo ? { deviceId: device, folder: repo } : null}
    />
  );
}
