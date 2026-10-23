import { Suspense } from "react";
import { Boards } from "@/components/board/boards-page";
import { loadLayout } from "@/lib/server-layout";

export default async function BoardPage() {
  const initialBoardLayout = await loadLayout("board");
  return <Suspense fallback={<div className="p-6 text-muted">Opening boards…</div>}><Boards initialBoardLayout={initialBoardLayout} /></Suspense>;
}
