import { redirect } from "next/navigation";
import { Suspense } from "react";
import { desktopExport } from "@/lib/desktop-export";
import { FilesBody } from "./screen";

export default async function FilesPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  // The packaged UI is a static export, which rejects awaiting searchParams; FilesBody redirects there.
  if (!desktopExport() && (await searchParams).view === "apps") redirect("/files");
  return (
    <Suspense fallback={null}>
      <FilesBody />
    </Suspense>
  );
}
