"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { api, type TaskRecord } from "@/lib/api";
import type { LayoutPayload } from "@/lib/server-layout";
import { WIDGET_REGISTRY, type LayoutDocument, type WidgetId } from "@ensemble/shared-types/widgets";

const EditCanvas = dynamic(() => import("./edit-mode").then((mod) => mod.EditCanvas), { ssr: false });

const COLUMNS = [
  ["proposed", "Proposed"],
  ["todo", "Todo"],
  ["in_progress", "Doing"],
  ["waiting", "Waiting"],
  ["done", "Done"],
] as const;

function columnOf(status: string): (typeof COLUMNS)[number][0] | null {
  if (status === "proposed") return "proposed";
  if (status === "todo") return "todo";
  if (status === "in_progress") return "in_progress";
  if (status === "waiting_approval" || status === "blocked") return "waiting";
  if (status === "done") return "done";
  return null;
}

function Tile({ type, tasks, cap }: { type: WidgetId; tasks: TaskRecord[]; cap: number }) {
  if (type === "column-summary") {
    const counts = Object.fromEntries(COLUMNS.map(([id]) => [id, 0])) as Record<string, number>;
    for (const task of tasks) {
      if (task.status === "dropped") continue;
      const column = columnOf(task.status);
      if (column) counts[column] = (counts[column] ?? 0) + 1;
    }
    return (
      <div className="flex items-end gap-2">
        {COLUMNS.map(([id, label]) => (
          <div key={id} className="min-w-0 text-center">
            <div className="text-[15px] font-medium leading-none">{counts[id]}</div>
            <div className="mt-0.5 text-[12px] leading-none text-muted">{label}</div>
          </div>
        ))}
      </div>
    );
  }
  if (type === "wip") {
    const doing = tasks.filter((task) => task.status === "in_progress").length;
    return (
      <div className="flex items-center">
        <span className="text-[20px] font-medium leading-none">
          {doing}
          <span className="text-[13px] text-muted">/{cap}</span>
        </span>
      </div>
    );
  }
  if (type === "blocked") {
    const rows = tasks.filter((task) => task.status === "blocked").length;
    return (
      <div className="flex items-center">
        <span className="text-[20px] font-medium leading-none">{rows}</span>
      </div>
    );
  }
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const done = tasks.filter((task) => task.status === "done" && task.completedAt && new Date(task.completedAt).getTime() >= weekAgo).length;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[20px] font-medium leading-none">{done}</span>
      <span className="text-[12px] leading-4 text-muted">done this week</span>
    </div>
  );
}

/** One short row above the kanban. Horizontal scroll if the row is wider than the page. */
export function BoardStrip({
  tasks,
  initialLayout = null,
  editing,
  onEditingChange,
}: {
  tasks: TaskRecord[];
  initialLayout?: LayoutPayload | null;
  editing: boolean;
  onEditingChange: (next: boolean) => void;
}) {
  const layout = useQuery({
    queryKey: ["layout", "board"],
    queryFn: () => api.layout("board"),
    initialData: initialLayout ?? undefined,
    staleTime: 30_000,
    refetchOnMount: initialLayout ? false : true,
  });
  const document = (layout.data?.document ?? null) as LayoutDocument | null;
  const placements = document?.placements ?? [];
  const cap = document?.config?.wipCap ?? 3;

  if (editing && document) {
    return (
      <div className="px-4 pb-3 sm:px-6">
        <EditCanvas
          surface="board"
          initial={document}
          columns={12}
          phone={false}
          onClose={() => onEditingChange(false)}
          render={(type) => <Tile type={type} tasks={tasks} cap={cap} />}
        />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-4 pb-3 sm:px-6" data-board-strip>
      <div className="board-scroll relative min-w-0 flex-1">
        <div className="flex max-h-[96px] items-center gap-2 overflow-x-auto" data-board-scroll>
          {placements.map((row) => (
            <section
              key={row.type}
              data-widget={row.type}
              data-size={row.size}
              aria-label={WIDGET_REGISTRY[row.type].label}
              className="tile flex min-h-[72px] w-[168px] shrink-0 flex-col justify-center overflow-hidden rounded-lg bg-panel/80 px-2.5 py-2"
              style={row.type === "column-summary" ? { width: 240 } : undefined}
            >
              <div className="text-[12px] font-medium text-muted">{WIDGET_REGISTRY[row.type].label}</div>
              <Tile type={row.type} tasks={tasks} cap={cap} />
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
