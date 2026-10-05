import { Suspense } from "react";
import { SuspenseSkeleton } from "@/components/motion/skeletons";
import type { BoardPayload } from "@/lib/api";
import { desktopExport } from "@/lib/desktop-export";
import { loadContextBoard, loadLayout, type LayoutPayload } from "@/lib/server-layout";
import { ContextScreen } from "./screen";

const DESK_VIEWS = new Set(["board", "grid", "list", "graph", "desk"]);

export default async function ContextPage({ searchParams }: { searchParams: Promise<{ view?: string; tab?: string }> }) {
  // The packaged UI is a static export. Awaiting searchParams opts the route
  // into dynamic rendering, which that export rejects.
  if (desktopExport()) return <ContextFrame initialLayout={null} initialBoard={null} />;
  const params = await searchParams;
  const view = params.view ?? "";
  const tab = params.tab ?? "";
  // The default lens uses neither payload. Layout is the widgets canvas; the board
  // is the desk, grid, list, and graph, plus a tab that opens that desk.
  const widgets = view === "widgets";
  const utility = tab === "preferences" || tab === "sources";
  const needsBoard = DESK_VIEWS.has(view) || (!widgets && !utility && tab !== "");
  const [initialLayout, initialBoard] = await Promise.all([
    widgets ? loadLayout("context") : Promise.resolve(null),
    needsBoard ? loadContextBoard() : Promise.resolve(null),
  ]);
  return <ContextFrame initialLayout={initialLayout} initialBoard={initialBoard} />;
}

function ContextFrame({ initialLayout, initialBoard }: { initialLayout: LayoutPayload | null; initialBoard: BoardPayload | null }) {
  return (
    <Suspense
      fallback={
        <div data-context-suspense="">
          <SuspenseSkeleton className="mx-auto mt-8 h-[420px] max-w-[1180px] rounded-xl" />
        </div>
      }
    >
      <ContextScreen initialLayout={initialLayout} initialBoard={initialBoard} />
    </Suspense>
  );
}
