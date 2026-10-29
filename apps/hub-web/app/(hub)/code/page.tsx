"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { CodeHome } from "@/components/code/code-home";

/** Code's window on its Welcome tab (`components/code/code-home.tsx`); `?job=<id>&file=<path>` opens a run's files. */
export default function CodePage() {
  const params = useSearchParams();
  const router = useRouter();
  return <CodeHome jobId={params.get("job")} file={params.get("file")} onCloseRun={() => router.replace("/code", { scroll: false })} />;
}
