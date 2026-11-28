import { redirect } from "next/navigation";
import { Suspense } from "react";
import { SuspenseSkeleton } from "@/components/motion/skeletons";
import type { BoardPayload } from "@/lib/api";
import { cleanContextHref } from "@/lib/context-href";
import { desktopExport } from "@/lib/desktop-export";
import { loadContextBoard } from "@/lib/server-layout";
import { ContextScreen } from "./screen";

const DESK_VIEWS = new Set(["board", "grid", "list", "graph", "desk"]);

export default async function ContextPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // The packaged UI is a static export. Awaiting searchParams opts the route
  // into dynamic rendering, which that export rejects; ContextScreen redirects there.
  if (desktopExport()) return <ContextFrame initialBoard={null} />;
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (typeof value === "string") query.set(key, value);
  const clean = cleanContextHref(query);
  if (clean) redirect(clean);
  const view = query.get("view") ?? "";
  const tab = query.get("tab") ?? "";
  // The default lens uses no payload. The board is the desk, grid, list and graph, plus a tab that opens that desk.
  const initialBoard = DESK_VIEWS.has(view) || tab !== "" ? await loadContextBoard() : null;
  return <ContextFrame initialBoard={initialBoard} />;
}

function ContextFrame({ initialBoard }: { initialBoard: BoardPayload | null }) {
  return (
    <Suspense
      fallback={
        <div data-context-suspense="">
          <SuspenseSkeleton className="mx-auto mt-8 h-[420px] max-w-[1180px] rounded-xl" />
        </div>
      }
    >
      <ContextScreen initialBoard={initialBoard} />
    </Suspense>
  );
}
