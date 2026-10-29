"use client";

import { CheckSquare, FileText } from "lucide-react";
import type { BoardPage } from "@ensemble/shared-types";
import { relative } from "@/lib/format";
import { CardDelete, CardHandle } from "./task-card";

/**
 * A page on a custom board, drawn as the Ensemble board's card: title, what it is and when it
 * changed. `onDelete` adds the same hover trash button; the drag overlay copy has none.
 */
export function PageCardBody({ page, onDelete }: { page: BoardPage; onDelete?: (page: BoardPage) => void }) {
  const Icon = page.kind === "task" ? CheckSquare : FileText;
  return (
    <div className="board-card group text-left" data-page-kind={page.kind}>
      <div className="flex min-w-0 items-start gap-2 pr-4">
        <span className="card-title min-w-0 [overflow-wrap:anywhere]" title={page.title}>{page.title || "Untitled"}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
        <span className="inline-flex items-center gap-1"><Icon size={12} aria-hidden />{page.kind === "task" ? "Task" : "Page"}</span>
        <span aria-hidden>·</span>
        <span>Edited {relative(page.updatedAt)}</span>
      </div>
      {onDelete ? <CardDelete label={page.title || "page"} onDelete={() => onDelete(page)} /> : <CardHandle />}
    </div>
  );
}
