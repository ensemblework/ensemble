"use client";

import {
  DndContext,
  closestCorners,
  useDroppable,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BoardDragOverlay, useBoardDragSensors, useBoardMotion, useBoardMoveMotion } from "@/components/motion/board-drag/board-drag-dnd-kit";
import { api, type Owner, type Priority, type TaskRecord, type TaskStatus } from "@/lib/api";
import { usePeek } from "../shell/peek";
import { useToast } from "../toast";
import { useWarmEditors } from "@/lib/warm";
import { STATUS, plural } from "@/lib/format";
import { Held } from "@/components/motion/held";
import { SearchQuery } from "@/components/motion/search-query";
import { PageHeader, Skeleton, useOverflowRight } from "../ui";
import { AskEnsemble } from "../ensemble/ask-button";
import { CardBody, SortableCard, type BoardCardMotion } from "./task-card";
import { BoardStrip } from "../widgets/board-strip";
import type { LayoutPayload } from "@/lib/server-layout";
import { CreateTaskDialog } from "./create-task-dialog";

type ColumnId = "proposed" | "todo" | "in_progress" | "waiting" | "done";

const COLUMNS: Array<{ id: ColumnId; statuses: TaskStatus[]; drop: TaskStatus; pill: TaskStatus }> = [
  { id: "proposed", statuses: ["proposed"], drop: "proposed", pill: "proposed" },
  { id: "todo", statuses: ["todo"], drop: "todo", pill: "todo" },
  { id: "in_progress", statuses: ["in_progress"], drop: "in_progress", pill: "in_progress" },
  { id: "waiting", statuses: ["waiting_approval", "blocked"], drop: "waiting_approval", pill: "waiting_approval" },
  { id: "done", statuses: ["done"], drop: "done", pill: "done" },
];

const columnOf = (status: TaskStatus): ColumnId | null =>
  COLUMNS.find((column) => column.statuses.includes(status))?.id ?? null;

function columnsFromTasks(rows: TaskRecord[], completedVisible: number): Record<ColumnId, string[]> {
  const next: Record<ColumnId, string[]> = { proposed: [], todo: [], in_progress: [], waiting: [], done: [] };
  for (const task of rows) {
    const column = columnOf(task.status);
    if (column) next[column].push(task.id);
  }
  next.done = next.done
    .map((id) => rows.find((task) => task.id === id))
    .filter((task): task is TaskRecord => Boolean(task))
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
    .slice(0, completedVisible)
    .map((task) => task.id);
  return next;
}

function Column({
  id,
  pill,
  ids,
  tasks,
  activeId,
  over,
  motion,
  onOpen,
  onCreate,
  moreHref,
  picked,
  onToggleSelect,
}: {
  id: ColumnId;
  pill: TaskStatus;
  ids: string[];
  tasks: Map<string, TaskRecord>;
  activeId: string | null;
  /** Another column is the drop target. "deny" is reserved for a column that refuses the card. */
  over?: "yes" | "deny";
  motion: BoardCardMotion;
  onOpen: (id: string) => void;
  onCreate: () => void;
  moreHref?: string;
  picked: string[];
  onToggleSelect: (id: string) => void;
}) {
  const { setNodeRef } = useDroppable({ id });
  return (
    <div className="relative w-[272px] shrink-0 self-start" data-column={id} aria-label={STATUS[pill].label}>
    <div className="board-column flex flex-col rounded-[14px] bg-panel/70 p-2">
      <div className="mb-2 flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: `var(--tag-${STATUS[pill].tone}-fg)` }} />
          <span className="text-[13px] font-medium">{STATUS[pill].label}</span>
          <span className="bdg-n text-[12px] tabular-nums text-muted">{ids.length}</span>
        </div>
        <div className="flex items-center gap-1">
          <AskEnsemble surface="board" anchorKey={`board:column:${id}`} label={`Ask Ensemble about ${STATUS[pill].label}`} entityIds={ids} selection={STATUS[pill].label} />
          <button type="button" className="icon-btn h-6 w-6" title="New task in this column" onClick={onCreate}>
            <Plus size={14} />
          </button>
        </div>
      </div>
      <div
        className="flex min-h-[60px] flex-col gap-1.5 rounded-lg border-l-2 p-1"
        style={{ borderColor: `var(--tag-${STATUS[pill].tone}-fg)` }}
      >
        <SortableContext id={id} items={ids} strategy={verticalListSortingStrategy}>
          {ids.map((taskId) => {
            const task = tasks.get(taskId);
            return task ? (
              <SortableCard
                key={taskId}
                task={task}
                active={activeId === taskId}
                selected={picked.includes(taskId)}
                motion={motion}
                onOpen={onOpen}
                onToggleSelect={onToggleSelect}
              />
            ) : null;
          })}
        </SortableContext>
          <button
            type="button"
            onClick={onCreate}
            className="row-tile flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] text-muted"
          >
            <Plus size={13} />
            New task
          </button>
        {moreHref ? (
          <Link href={moreHref} className="px-2 py-1 text-[12px] text-accent hover:underline">
            All completed
          </Link>
        ) : null}
      </div>
    </div>
    <div
      ref={setNodeRef}
      data-bdg-list=""
      data-over={over}
      className="pointer-events-none"
      style={{ position: "absolute", left: 0, right: 0, top: 0, height: "max(100%, 240px)" }}
    />
    </div>
  );
}

export function Board({ initialBoardLayout = null }: { initialBoardLayout?: LayoutPayload | null }) {
  const client = useQueryClient();
  const toast = useToast();
  const peek = usePeek();
  useWarmEditors("peek");
  const [boardScroll, boardMore] = useOverflowRight();
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.tasks });
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 30_000 });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  const completedVisible = settings.data?.settings.completedVisible ?? 5;
  const [search, setSearch] = useState("");
  const [owner, setOwner] = useState<Owner | "all">("all");
  const [priority, setPriority] = useState<Priority | "all">("all");
  const [columns, setColumns] = useState<Record<ColumnId, string[]>>({
    proposed: [],
    todo: [],
    in_progress: [],
    waiting: [],
    done: [],
  });
  const [dragId, setDragId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [layoutEdit, setLayoutEdit] = useState(false);
  const [creating, setCreating] = useState<TaskStatus | null>(null);
  const togglePick = (id: string) => setPicked((current) => (current.includes(id) ? current.filter((row) => row !== id) : [...current, id]));
  const origin = useRef<ColumnId | null>(null);

  const byId = useMemo(() => new Map((tasks.data?.tasks ?? []).map((task) => [task.id, task])), [tasks.data]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (tasks.data?.tasks ?? [])
      .filter((task) => (owner === "all" || task.owner === owner) && (priority === "all" || task.priority === priority))
      .filter((task) => !needle || task.title.toLowerCase().includes(needle))
      .sort((a, b) => a.boardOrder - b.boardOrder);
  }, [tasks.data, search, owner, priority]);

  const draggingRef = useRef(false);
  draggingRef.current = dragId !== null;
  // Sync from the server only while nobody is dragging. Depending on dragId here
  // would put the card back in its old column for a frame before the optimistic update lands,
  // and that jump would play as an agent move.
  useEffect(() => {
    if (draggingRef.current) return;
    setColumns(columnsFromTasks(visible, completedVisible));
  }, [visible, completedVisible]);

  const boardRef = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const track = (event: PointerEvent) => {
      pointer.current.x = event.clientX;
      pointer.current.y = event.clientY;
    };
    window.addEventListener("pointermove", track, { passive: true });
    window.addEventListener("pointerdown", track, { passive: true });
    return () => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerdown", track);
    };
  }, []);
  const sensors = useBoardDragSensors();
  const titleOf = useCallback((id: UniqueIdentifier) => byId.get(String(id))?.title ?? "Task", [byId]);
  const motion = useBoardMotion(titleOf);
  const moveMotion = useBoardMoveMotion(boardRef, dragId !== null);
  const [overColumn, setOverColumn] = useState<ColumnId | null>(null);
  const [overlayWidth, setOverlayWidth] = useState(248);
  // Freeze each column's painted height while a card is in the air. A shrink
  // mid-drag changes the page scroll height and dnd-kit then autoscrolls the
  // other way, which looks like the board bouncing top to bottom.
  useLayoutEffect(() => {
    const root = boardRef.current;
    if (!root || !dragId) return;
    const columns = [...root.querySelectorAll<HTMLElement>(".board-column")];
    columns.forEach((node) => {
      node.style.minHeight = `${node.getBoundingClientRect().height}px`;
    });
    const main = root.closest("main");
    if (main instanceof HTMLElement) main.style.overflowAnchor = "none";
    return () => {
      columns.forEach((node) => {
        node.style.minHeight = "";
      });
      if (main instanceof HTMLElement) main.style.overflowAnchor = "";
    };
  }, [dragId]);
  const canScroll = useCallback((element: Element) => {
    if (!(element instanceof HTMLElement)) return false;
    if (element.hasAttribute("data-board-hscroll")) return true;
    if (element.hasAttribute("data-column") || element.hasAttribute("data-bdg-list")) {
      return element.scrollHeight > element.clientHeight + 2 || element.scrollWidth > element.clientWidth + 2;
    }
    const doc = element.ownerDocument;
    const page = element === doc.scrollingElement || element === doc.documentElement || element === doc.body || element.tagName === "MAIN";
    if (!page) return false;
    const edge = 16;
    const y = pointer.current.y;
    return y <= edge || y >= window.innerHeight - edge;
  }, []);

  const containerOf = (id: string): ColumnId | null => {
    if (id in columns) return id as ColumnId;
    return (Object.keys(columns) as ColumnId[]).find((key) => columns[key].includes(id)) ?? null;
  };

  const move = useMutation({
    mutationFn: (input: { id: string; status: TaskStatus; beforeId: string | null; afterId: string | null }) =>
      api.moveTask(input.id, { status: input.status, beforeId: input.beforeId, afterId: input.afterId }),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: ["tasks"] });
      const previous = client.getQueryData<{ tasks: TaskRecord[] }>(["tasks"]);
      if (previous) {
        const before = input.beforeId ? previous.tasks.find((task) => task.id === input.beforeId)?.boardOrder : undefined;
        const after = input.afterId ? previous.tasks.find((task) => task.id === input.afterId)?.boardOrder : undefined;
        const order =
          before !== undefined && after !== undefined ? (before + after) / 2 : before !== undefined ? before + 1 : after !== undefined ? after - 1 : undefined;
        client.setQueryData(["tasks"], {
          tasks: previous.tasks.map((task) =>
            task.id === input.id ? { ...task, status: input.status, boardOrder: order ?? task.boardOrder } : task,
          ),
        });
      }
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous) client.setQueryData(["tasks"], context.previous);
      toast((error as Error).message, { tone: "error" });
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["tasks"] });
      void client.invalidateQueries({ queryKey: ["task"] });
      void client.invalidateQueries({ queryKey: ["shell"] });
    },
  });

  const created = (task: TaskRecord) => {
    client.setQueryData<{ tasks: TaskRecord[] }>(["tasks"], (current) => ({ tasks: [...(current?.tasks ?? []), task] }));
    setSearch("");
    setOwner("all");
    setPriority("all");
    void client.invalidateQueries({ queryKey: ["tasks"] });
    void client.invalidateQueries({ queryKey: ["shell"] });
  };

  const columnFromOver = (over: DragOverEvent["over"]): ColumnId | null => {
    if (!over) return null;
    const sortable = over.data.current?.sortable as { containerId?: UniqueIdentifier } | undefined;
    const raw = sortable?.containerId != null ? String(sortable.containerId) : String(over.id);
    if (raw === "proposed" || raw === "todo" || raw === "in_progress" || raw === "waiting" || raw === "done") return raw;
    return containerOf(String(over.id));
  };

  const onDragStart = ({ active }: DragStartEvent) => {
    const id = String(active.id);
    setDragId(id);
    origin.current = containerOf(id);
    const node = document.querySelector<HTMLElement>(`[data-bdg-card][data-id="${CSS.escape(id)}"]`);
    const width = node?.getBoundingClientRect().width;
    if (width && width > 40) setOverlayWidth(Math.round(width));
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    const hovered = columnFromOver(over);
    setOverColumn((current) => (current === hovered ? current : hovered));
    if (!over) return;
    const from = containerOf(String(active.id));
    const to = containerOf(String(over.id));
    if (!from || !to || from === to) return;
    setColumns((prev) => {
      const source = prev[from].filter((id) => id !== active.id);
      const target = [...prev[to]];
      const overIndex = target.indexOf(String(over.id));
      target.splice(overIndex < 0 ? target.length : overIndex, 0, String(active.id));
      return { ...prev, [from]: source, [to]: target };
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    moveMotion.skipNext();
    const id = String(active.id);
    setDragId(null);
    setOverColumn(null);
    if (!over) {
      setColumns(columnsFromTasks(visible, completedVisible));
      return;
    }
    const column = containerOf(id);
    if (!column) return;
    let list = columns[column];
    const overIndex = list.indexOf(String(over.id));
    const activeIndex = list.indexOf(id);
    if (overIndex >= 0 && activeIndex !== overIndex) {
      list = arrayMove(list, activeIndex, overIndex);
      setColumns((prev) => ({ ...prev, [column]: list }));
    }
    const index = list.indexOf(id);
    const task = byId.get(id);
    if (!task) return;
    const spec = COLUMNS.find((row) => row.id === column)!;
    const status = spec.statuses.includes(task.status) ? task.status : spec.drop;
    const beforeId = list[index - 1] ?? null;
    const afterId = list[index + 1] ?? null;
    if (origin.current === column && status === task.status && activeIndex === overIndex) return;
    move.mutate({ id, status, beforeId, afterId });
  };

  const count = visible.filter((task) => columnOf(task.status)).length;

  return (
    <div ref={boardRef} className="board-frame flex min-h-full min-w-0 flex-col" data-motion-slot="board.drag" data-dragging={dragId ? "1" : undefined}>
      <div className="board-chrome relative z-20 bg-bg">
      <div className="px-4 pt-6 sm:px-6">
        <PageHeader title={shell.data?.labels?.board || "Task board"} description="Proposed through done. Drag a card to move it." />
      </div>
      <div className="flex w-full min-w-0 flex-wrap items-center gap-2 px-4 pb-3 pt-2 sm:px-6">
        <SearchQuery
          className="min-w-0 flex-1 basis-[9rem]"
          value={search}
          onValue={setSearch}
          placeholder="Search tasks…"
          label="Search tasks"
          pending={tasks.isLoading && !tasks.data && search.trim().length > 0}
          count={search.trim() ? count : null}
          status="Searching tasks…"
          emptyTitle="No tasks match that search."
          emptyHint="Clear the search to see the whole board."
        />
        <select value={owner} onChange={(event) => setOwner(event.target.value as Owner | "all")} className="field py-1 text-[13px]" aria-label="Owner">
          <option value="all">All owners</option>
          <option value="me">Me</option>
          <option value="agent">Agent</option>
          <option value="unassigned">Unassigned</option>
        </select>
        <select
          value={priority}
          onChange={(event) => setPriority(event.target.value as Priority | "all")}
          className="field py-1 text-[13px]"
          aria-label="Priority"
        >
          <option value="all">All priorities</option>
          <option value="p0">High</option>
          <option value="p1">Normal</option>
          <option value="p2">Low</option>
        </select>
        <span className="text-[12.5px] text-muted">{plural(count, "task")}</span>
        {picked.length ? (
          <div className="flex items-center gap-2" data-ensemble-selection>
            <span className="text-[12.5px] text-muted">{plural(picked.length, "selected task", "selected tasks")}</span>
            <AskEnsemble
              surface="board"
              anchorKey={`board:sel:${[...picked].sort().join(",")}`}
              label="Ask Ensemble about the selection"
              entityIds={picked}
              selection={`${picked.length} selected`}
            />
          </div>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button type="button" className="btn" onClick={() => setLayoutEdit(true)}>
            Edit layout
          </button>
          <button type="button" className="btn-primary" onClick={() => setCreating("todo")}>
            <Plus size={14} />
            New task
          </button>
        </div>
      </div>
      <BoardStrip tasks={tasks.data?.tasks ?? []} initialLayout={initialBoardLayout} editing={layoutEdit} onEditingChange={setLayoutEdit} />
      </div>
      <Held
        pending={tasks.isLoading}
        fallback={
        <div className="flex gap-3 px-5" aria-hidden>
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="w-[272px] shrink-0 space-y-2">
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ))}
        </div>
        }
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          autoScroll={{
            acceleration: 4,
            interval: 16,
            threshold: { x: 0.12, y: 0.06 },
            layoutShiftCompensation: { x: true, y: false },
            canScroll,
          }}
          measuring={motion.measuring}
          accessibility={motion.accessibility}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={() => {
            moveMotion.skipNext();
            setDragId(null);
            setOverColumn(null);
            setColumns(columnsFromTasks(visible, completedVisible));
          }}
        >
          <div className="relative z-0 min-w-0 max-w-full">
            <div ref={boardScroll} data-board-hscroll="" className="flex w-full min-w-0 max-w-full items-start gap-3 overflow-x-auto overflow-y-hidden overscroll-x-contain px-5 pb-10">
              {COLUMNS.map((column) => (
                <Column
                  key={column.id}
                  id={column.id}
                  pill={column.pill}
                  ids={columns[column.id]}
                  tasks={byId}
                  activeId={peek.peekId}
                  over={overColumn === column.id && origin.current !== column.id ? "yes" : undefined}
                  motion={motion.sortable}
                  onOpen={peek.open}
                  onCreate={() => setCreating(column.id === "waiting" ? "blocked" : column.drop)}
                  moreHref={column.id === "done" ? "/settings#completed" : undefined}
                  picked={picked}
                  onToggleSelect={togglePick}
                />
              ))}
            </div>
            {boardMore ? (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 right-0 w-12"
                style={{ background: "linear-gradient(to left, var(--bg), transparent)" }}
              />
            ) : null}
          </div>
          <BoardDragOverlay width={overlayWidth}>
            {dragId && byId.get(dragId) ? <CardBody task={byId.get(dragId)!} /> : null}
          </BoardDragOverlay>
        </DndContext>
      </Held>
      {creating ? <CreateTaskDialog status={creating} onCreated={created} onClose={() => setCreating(null)} /> : null}
    </div>
  );
}
