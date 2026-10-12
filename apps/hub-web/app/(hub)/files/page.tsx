"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { FilesScreen } from "@/components/files/files-screen";

/** `?view=apps` opens From your apps; `&item=<id>` opens one item in the reader. */
function FilesBody() {
  const params = useSearchParams();
  const router = useRouter();
  const view = params.get("view") === "apps" ? "apps" : "files";
  return <FilesScreen view={view} item={view === "apps" ? params.get("item") : null} navigate={(href) => router.replace(href, { scroll: false })} />;
}

export default function FilesPage() {
  return (
    <Suspense fallback={null}>
      <FilesBody />
    </Suspense>
  );
}
