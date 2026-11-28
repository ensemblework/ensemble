"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { FilesScreen } from "@/components/files/files-screen";

/** An old link to `?view=apps` (with or without `&item=`) lands on Files itself; the packaged UI does it here. */
export function FilesBody() {
  const params = useSearchParams();
  const router = useRouter();
  const old = params.get("view") === "apps";
  useEffect(() => {
    if (old) router.replace("/files", { scroll: false });
  }, [old, router]);
  if (old) return null;
  return <FilesScreen />;
}
