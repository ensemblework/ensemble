"use client";

import { DndContext, closestCorners, type DragEndEvent, type DragOverEvent, type DragStartEvent, type UniqueIdentifier } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ellipsis, FileText, Plus, Settings2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BoardPage, PageBoardColumn, PatchPageBoard } from "@ensemble/shared-types";
import { api } from "@/lib/api";
import { useSpaceAccess } from "@/lib/access";
import { plural } from "@/lib/format";
import { useAssistantSurface } from "@/lib/assistant-surface";
import { useWarmEditors, warmTask } from "@/lib/warm";
import { BoardDragOverlay, useBoardDragSensors, useBoardMotion, useBoardMoveMotion } from "../motion/board-drag/board-drag-dnd-kit";
import { LoadError } from "../load-error";
import { SearchQuery } from "../motion/search-query";
import { MenuItem, PageHeader, Popover, useOverflowRight } from "../ui";
import { useToast } from "../toast";
import { usePeek } from "../shell/peek";
import { BoardSettings } from "./custom-boards";
import { BoardWidgets } from "./board-widgets";
import { BoardColumn } from "./board-column";
import { SortableBoardCard } from "./task-card";
import { PageCardBody } from "./page-card";
import { markFreshPage } from "../pages/fresh-page";

type Lanes = Record<string, string[]>;

/** Page ids per column, in board order. */
function lanesOf(columns: PageBoardColumn[], pages: BoardPage[]): Lanes {
  const lanes: Lanes = Object.fromEntries(columns.map((column) => [column.id, [] as string[]]));
  for (const page of [...pages].sort((a, b) => a.boardOrder - b.boardOrder)) if (page.columnId && lanes[page.columnId]) lanes[page.columnId]!.push(page.id);
  return lanes;
}

/**
 * A custom board: its own name, columns and tiles, with the Ensemble board's cards, motion and
 * side peek. Pages open in the peek; the trash button moves a page to Trash with Undo.
 */
export function CustomBoard({ id }: { id: string }) {
  const query = useQuery({ queryKey: ["boards", id], queryFn: () => api.board(id) });
  const directory = useQuery({ queryKey: ["pages", "directory"], queryFn: api.pageDirectory });
  const access = useSpaceAccess(), client = useQueryClient(), toast = useToast(), peek = usePeek();
  useWarmEditors("peek");
  const [settings, setSettings] = useState(false), [search, setSearch] = useState("");
  const [existingSearch, setExistingSearch] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  // While a card is in the air its column changes live, as on the Ensemble board; null otherwise.
  const [dragLanes, setDragLanes] = useState<Lanes | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const [overlayWidth, setOverlayWidth] = useState(248);
  const origin = useRef<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const [boardScroll, boardMore] = useOverflowRight();
  const sensors = useBoardDragSensors((event, args) => {
    const direction = event.code === "ArrowLeft" ? -1 : event.code === "ArrowRight" ? 1 : 0;
    if (!direction) return sortableKeyboardCoordinates(event, args);
    event.preventDefault();
    const { board, pages } = query.data ?? {};
    if (!board || !pages) return;
    const overId = args.context.over?.id ?? args.context.active?.id;
    const columnId = board.columns.find((column) => column.id === overId)?.id ?? pages.find((page) => page.id === overId)?.columnId;
    const target = board.columns[board.columns.findIndex((column) => column.id === columnId) + direction];
    if (!target) return;
    const box = args.context.droppableContainers.get(target.id)?.node.current?.getBoundingClientRect();
    return box ? { x: box.left + 12, y: box.top + 44 } : undefined;
  });
  const byId = useMemo(() => new Map((query.data?.pages ?? []).map((page) => [page.id, page])), [query.data?.pages]);
  const titleOf = useCallback((pageId: UniqueIdentifier) => byId.get(String(pageId))?.title ?? "Page", [byId]);
  const motion = useBoardMotion(titleOf);
  const moveMotion = useBoardMoveMotion(boardRef, dragId !== null, `board:${id}`, (query.data?.pages ?? []).map((page) => ({ id: page.id, column: page.columnId ?? "", completion: null })));
  // Freeze each column's height while a card is in the air, as the Ensemble board does, so the page does not bounce.
  useLayoutEffect(() => {
    const root = boardRef.current;
    if (!root || !dragId) return;
    const columns = [...root.querySelectorAll<HTMLElement>(".board-column")];
    columns.forEach((node) => { node.style.minHeight = `${node.getBoundingClientRect().height}px`; });
    return () => columns.forEach((node) => { node.style.minHeight = ""; });
  }, [dragId]);
  const editable = access.ready && access.canEdit;
  const invalidate = () => { void client.invalidateQueries({ queryKey: ["boards"] }); void client.invalidateQueries({ queryKey: ["pages"] }); void client.invalidateQueries({ queryKey: ["tasks"] }); };
  const fail = (error: Error) => { toast(error.message, { tone: "error" }); invalidate(); };
  const patch = useMutation({
    mutationFn: (data: Omit<PatchPageBoard, "revision">) => api.patchBoard(id, { ...data, revision: query.data!.board.revision }),
    onSuccess: ({ board }) => { client.setQueryData<Awaited<ReturnType<typeof api.board>>>(["boards", id], (old) => old ? { ...old, board } : old); invalidate(); },
    onError: fail,
  });
  // A new page opens in the side peek with its title ready, like a new task on the Ensemble board.
  const create = useMutation({
    mutationFn: (columnId: string) => api.createBoardPage(id, columnId),
    onSuccess: ({ page }) => { invalidate(); markFreshPage(page.id); peek.open(page.id, page.kind === "task" ? "task" : "page"); },
    onError: fail,
  });
  const assign = useMutation({
    mutationFn: (input: { page: { id: string; kind: "page" | "task" }; columnId: string; beforeId?: string | null; afterId?: string | null }) => api.assignPageBoard(input.page.kind, input.page.id, { boardId: id, columnId: input.columnId, beforeId: input.beforeId, afterId: input.afterId }),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: ["boards", id] });
      const previous = client.getQueryData<Awaited<ReturnType<typeof api.board>>>(["boards", id]);
      if (previous) {
        const before = previous.pages.find((page) => page.id === input.beforeId)?.boardOrder;
        const after = previous.pages.find((page) => page.id === input.afterId)?.boardOrder;
        const order = before !== undefined && after !== undefined ? (before + after) / 2 : before !== undefined ? before + 1 : after !== undefined ? after - 1 : Math.max(-1, ...previous.pages.filter((page) => page.columnId === input.columnId).map((page) => page.boardOrder)) + 1;
        const moved = previous.pages.some((page) => page.id === input.page.id);
        const added = moved ? [] : [{ ...(directory.data?.pages.find((page) => page.id === input.page.id) ?? { title: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), id: input.page.id, kind: input.page.kind, columnId: input.columnId, boardOrder: order } as BoardPage];
        client.setQueryData(["boards", id], { ...previous, pages: [...previous.pages.map((page) => page.id === input.page.id ? { ...page, columnId: input.columnId, boardOrder: order } : page), ...added].sort((a, b) => a.boardOrder - b.boardOrder) });
      }
      return { previous };
    },
    onError: (error, _input, context) => { if (context?.previous) client.setQueryData(["boards", id], context.previous); fail(error); },
    onSettled: invalidate,
  });
  // The card's trash button, as on the Ensemble board: gone at once, back with Undo, back on failure.
  const remove = useMutation({
    mutationFn: (page: BoardPage) => page.kind === "task" ? api.deleteTask(page.id) : api.deletePage(page.id).then(() => ({ undoEntryId: null })),
    onMutate: async (page) => {
      await client.cancelQueries({ queryKey: ["boards", id] });
      const previous = client.getQueryData<Awaited<ReturnType<typeof api.board>>>(["boards", id]);
      if (previous) client.setQueryData(["boards", id], { ...previous, pages: previous.pages.filter((row) => row.id !== page.id) });
      if (peek.peekId === page.id) peek.close();
      return { previous };
    },
    onError: (error, _page, context) => { if (context?.previous) client.setQueryData(["boards", id], context.previous); toast((error as Error).message, { tone: "error" }); },
    onSuccess: (result) => {
      toast("Moved to Trash.", { action: { label: "Undo", run: () => { void api.undo(result?.undoEntryId ?? undefined).then(() => client.invalidateQueries()).catch((error: Error) => toast(error.message, { tone: "error" })); } } });
    },
    onSettled: invalidate,
  });
  const deletePage = (page: BoardPage) => {
    // An open page saves what was typed first and moves itself to Trash (pages-nav.tsx sends the same event).
    if (!window.dispatchEvent(new CustomEvent(page.kind === "task" ? "ensemble:delete-task" : "ensemble:delete-page", { detail: { id: page.id }, cancelable: true }))) {
      void client.invalidateQueries({ queryKey: ["boards", id] });
      return;
    }
    remove.mutate(page);
  };
  const openPage = (pageId: string) => {
    const page = byId.get(pageId);
    if (page) peek.open(page.id, page.kind === "task" ? "task" : "page");
  };
  useAssistantSurface("/board", {
    kind: "board",
    filters: { boardId: id, boardTitle: query.data?.board.title ?? "", customBoard: true, search },
    visibleIds: (query.data?.pages ?? []).filter((page) => page.title.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 100).map((page) => page.id),
  });
  const needle = search.trim().toLowerCase();
  const visiblePages = useMemo(() => (query.data?.pages ?? []).filter((page) => page.title.toLowerCase().includes(needle)), [query.data?.pages, needle]);
  const settled = useMemo(() => lanesOf(query.data?.board.columns ?? [], visiblePages), [query.data?.board.columns, visiblePages]);
  if (!query.data) return <div className="p-6"><Link href="/board" className="btn-ghost mb-6"><ArrowLeft size={14} />All boards</Link>{query.isError ? <LoadError what="this board" error={query.error} onRetry={() => void query.refetch()} /> : <p role="status" className="text-muted">Opening board…</p>}</div>;
  const { board, pages } = query.data;
  const lanes = dragLanes ?? settled;
  const busy = assign.isPending || create.isPending || patch.isPending;
  const canMove = editable && !needle;
  const laneOf = (pageId: string, from: Lanes = lanes): string | null => pageId in from ? pageId : Object.keys(from).find((key) => from[key]!.includes(pageId)) ?? null;
  const columnFromOver = (over: DragOverEvent["over"]): string | null => {
    if (!over) return null;
    const sortable = over.data.current?.sortable as { containerId?: UniqueIdentifier } | undefined;
    const raw = sortable?.containerId != null ? String(sortable.containerId) : String(over.id);
    return raw in lanes ? raw : laneOf(String(over.id));
  };
  const onDragStart = ({ active }: DragStartEvent) => {
    const pageId = String(active.id);
    setDragId(pageId);
    setDragLanes(settled);
    origin.current = laneOf(pageId, settled);
    const node = document.querySelector<HTMLElement>(`[data-bdg-card][data-id="${CSS.escape(pageId)}"]`);
    const width = node?.getBoundingClientRect().width;
    if (width && width > 40) setOverlayWidth(Math.round(width));
  };
  const onDragOver = ({ active, over }: DragOverEvent) => {
    const hovered = columnFromOver(over);
    setOverColumn((current) => (current === hovered ? current : hovered));
    if (!over) return;
    setDragLanes((prev) => {
      const current = prev ?? settled;
      const from = laneOf(String(active.id), current);
      const to = laneOf(String(over.id), current);
      if (!from || !to || from === to) return current;
      const source = current[from]!.filter((pageId) => pageId !== active.id);
      const target = [...current[to]!];
      const overIndex = target.indexOf(String(over.id));
      target.splice(overIndex < 0 ? target.length : overIndex, 0, String(active.id));
      return { ...current, [from]: source, [to]: target };
    });
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    moveMotion.skipNext();
    const pageId = String(active.id);
    const current = dragLanes ?? settled;
    setDragId(null);
    setOverColumn(null);
    setDragLanes(null);
    if (!over) return;
    const column = laneOf(pageId, current);
    const page = byId.get(pageId);
    if (!column || !page) return;
    let list = current[column]!;
    const overIndex = list.indexOf(String(over.id));
    const activeIndex = list.indexOf(pageId);
    if (overIndex >= 0 && activeIndex !== overIndex) list = arrayMove(list, activeIndex, overIndex);
    if (origin.current === column && list.join("|") === settled[column]?.join("|")) return;
    const index = list.indexOf(pageId);
    assign.mutate({ page, columnId: column, beforeId: list[index - 1] ?? null, afterId: list[index + 1] ?? null });
  };
  const onDragCancel = () => { moveMotion.skipNext(); setDragId(null); setOverColumn(null); setDragLanes(null); };
  const dragged = dragId ? byId.get(dragId) : undefined;
  return <div className="cb-detail">
    <Link href="/board" className="cb-back"><ArrowLeft size={14} />All boards</Link>
    <PageHeader title={board.title} description={board.description || "Your pages, organized your way."} actions={editable ? <button type="button" className="btn" onClick={() => setSettings(true)}><Settings2 size={14} />Board settings</button> : undefined} />
    {query.isError && <LoadError what="the latest board changes" error={query.error} onRetry={() => void query.refetch()} />}
    <div className="flex w-full min-w-0 flex-wrap items-center gap-2 pb-3 pt-2">
      <SearchQuery
        className="w-full min-w-0 sm:w-64 sm:max-w-sm"
        pill
        overlay
        value={search}
        onValue={setSearch}
        placeholder="Search pages…"
        label={`Search ${board.title} pages`}
        count={needle ? visiblePages.length : null}
        status="Searching pages…"
        emptyTitle="No pages match that search."
        emptyHint="Clear the search to see the whole board."
      />
      <span className="text-[12.5px] text-muted">{plural(pages.length, "page")}</span>
      {editable ? (
        <div className="ml-auto flex flex-nowrap items-center gap-2" data-board-tools>
          <Popover
            align="right"
            width={300}
            maxHeight={380}
            trigger={(open, toggle) => <button type="button" className="btn px-2" aria-label="More board actions" title="More board actions" aria-expanded={open} disabled={busy} onClick={toggle}><Ellipsis size={16} /></button>}
          >
            {(close) => <div className="cb-existing-pages" role="group" aria-label="Add a page to the board">
              <p className="px-2 pb-1.5 pt-1 text-[12px] font-medium text-muted">Add a page…</p>
              <input className="field mb-2 w-full text-[12px]" type="search" aria-label="Find an existing page" placeholder="Find a page…" value={existingSearch} onChange={(event) => setExistingSearch(event.target.value)} />
              {directory.isError ? <p role="alert" className="p-2 text-[13px] text-danger">{directory.error.message}<button type="button" className="btn" onClick={() => void directory.refetch()}>Retry</button></p> : directory.isPending ? <p className="p-2 text-[13px] text-muted">Loading pages…</p> : directory.data.pages.filter((page) => page.board?.id !== id && page.title.toLowerCase().includes(existingSearch.trim().toLowerCase())).map((page) => <MenuItem key={page.id} onClick={() => { close(); assign.mutate({ page, columnId: board.columns[0]!.id }); }}><FileText size={13} /><span className="truncate">{page.title}</span><small className="ml-auto text-muted">{page.board?.title || "Independent"}</small></MenuItem>)}
              {directory.data && directory.data.pages.every((page) => page.board?.id === id || !page.title.toLowerCase().includes(existingSearch.trim().toLowerCase())) && <p className="p-2 text-[13px] text-muted">{existingSearch.trim() ? "No matching pages." : "No other pages. Create one in a column below."}</p>}
            </div>}
          </Popover>
          <button type="button" className="btn-primary" disabled={busy} onClick={() => create.mutate(board.columns[0]!.id)}><Plus size={14} />New page</button>
        </div>
      ) : null}
    </div>
    <BoardWidgets board={board} pages={pages} editable={editable} pending={busy} onChange={(tiles) => patch.mutate({ tiles })} />
    <div ref={boardRef} className="board-frame mt-4" data-motion-slot="board.drag" data-dragging={dragId ? "1" : undefined}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        autoScroll={{ acceleration: 4, interval: 16, threshold: { x: 0.12, y: 0.06 }, layoutShiftCompensation: { x: true, y: false } }}
        measuring={motion.measuring}
        accessibility={motion.accessibility}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <div className="relative z-0 min-w-0 max-w-full">
          <div ref={boardScroll} data-board-hscroll="" className="flex w-full min-w-0 max-w-full items-start gap-3 overflow-x-auto overflow-y-hidden overscroll-x-contain pb-10 pt-1" aria-label={`${board.title} columns`}>
            {board.columns.map((column) => {
              const ids = lanes[column.id] ?? [];
              return (
                <BoardColumn
                  key={column.id}
                  id={column.id}
                  name={column.name}
                  label={<span className="inline-flex items-center gap-2" data-board-color={column.color}><i className="cb-column-dot" aria-hidden />{column.name}</span>}
                  count={ids.length}
                  over={overColumn === column.id && origin.current !== column.id ? "yes" : undefined}
                  createLabel="New page"
                  onCreate={editable ? () => create.mutate(column.id) : undefined}
                  disabled={busy}
                  empty={needle ? "No pages match." : "Room for your next idea."}
                >
                  <SortableContext id={column.id} items={ids} strategy={verticalListSortingStrategy}>
                    {ids.map((pageId) => {
                      const page = byId.get(pageId);
                      return page ? (
                        <SortableBoardCard key={page.id} id={page.id} active={peek.peekId === page.id} disabled={!canMove || busy} motion={motion.sortable} onOpen={openPage} onWarm={page.kind === "task" ? () => warmTask(client, page.id) : undefined}>
                          <PageCardBody page={page} onDelete={editable ? deletePage : undefined} />
                        </SortableBoardCard>
                      ) : null;
                    })}
                  </SortableContext>
                </BoardColumn>
              );
            })}
            {editable && <button type="button" className="cb-add-column" onClick={() => setSettings(true)}><Plus size={15} />Add column</button>}
          </div>
          {boardMore ? <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-12" style={{ background: "linear-gradient(to left, var(--bg), transparent)" }} /> : null}
        </div>
        <BoardDragOverlay width={overlayWidth}>{dragged ? <PageCardBody page={dragged} /> : null}</BoardDragOverlay>
      </DndContext>
    </div>
    {settings && <BoardSettings board={board} onClose={() => setSettings(false)} />}
  </div>;
}
