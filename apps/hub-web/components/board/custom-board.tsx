"use client";

import { DndContext, closestCorners, useDroppable, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, GripVertical, Plus, Search, Settings2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import type { BoardPage, PageBoardColumn, PatchPageBoard } from "@ensemble/shared-types";
import { api } from "@/lib/api";
import { useSpaceAccess } from "@/lib/access";
import { plural, relative } from "@/lib/format";
import { useAssistantSurface } from "@/lib/assistant-surface";
import { useBoardDragSensors, BoardDragOverlay } from "../motion/board-drag/board-drag-dnd-kit";
import { LoadError } from "../load-error";
import { MenuItem, PageHeader, Popover } from "../ui";
import { useToast } from "../toast";
import { BoardSettings } from "./custom-boards";
import { boardPageHref } from "@/lib/page-boards";
import { BoardWidgets } from "./board-widgets";
import { standalonePageHref } from "../pages/page-href";

export function CustomBoard({ id }: { id: string }) {
  const query = useQuery({ queryKey: ["boards", id], queryFn: () => api.board(id) });
  const directory = useQuery({ queryKey: ["pages", "directory"], queryFn: api.pageDirectory });
  const access = useSpaceAccess(), client = useQueryClient(), toast = useToast(), router = useRouter();
  const [settings, setSettings] = useState(false), [search, setSearch] = useState(""), [dragged, setDragged] = useState<BoardPage | null>(null);
  const [existingSearch, setExistingSearch] = useState("");
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
    const node = args.context.droppableContainers.get(target.id)?.node.current;
    const box = node?.querySelector(".cb-column-pages")?.getBoundingClientRect();
    return box ? { x: box.left, y: box.top } : undefined;
  });
  const editable = access.ready && access.canEdit;
  const invalidate = () => { void client.invalidateQueries({ queryKey: ["boards"] }); void client.invalidateQueries({ queryKey: ["pages"] }); void client.invalidateQueries({ queryKey: ["tasks"] }); };
  const fail = (error: Error) => { toast(error.message, { tone: "error" }); invalidate(); };
  const patch = useMutation({
    mutationFn: (data: Omit<PatchPageBoard, "revision">) => api.patchBoard(id, { ...data, revision: query.data!.board.revision }),
    onSuccess: ({ board }) => { client.setQueryData<Awaited<ReturnType<typeof api.board>>>(["boards", id], (old) => old ? { ...old, board } : old); invalidate(); },
    onError: fail,
  });
  const create = useMutation({ mutationFn: (columnId: string) => api.createBoardPage(id, columnId), onSuccess: ({ page }) => { invalidate(); router.push(standalonePageHref(page.id, true)); }, onError: fail });
  const assign = useMutation({
    mutationFn: (input: { page: { id: string; kind: "page" | "task" }; columnId: string; beforeId?: string | null; afterId?: string | null }) => api.assignPageBoard(input.page.kind, input.page.id, { boardId: id, columnId: input.columnId, beforeId: input.beforeId, afterId: input.afterId }),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: ["boards", id] });
      const previous = client.getQueryData<Awaited<ReturnType<typeof api.board>>>(["boards", id]);
      if (previous) {
        const before = previous.pages.find((page) => page.id === input.beforeId)?.boardOrder;
        const after = previous.pages.find((page) => page.id === input.afterId)?.boardOrder;
        const order = before !== undefined && after !== undefined ? (before + after) / 2 : before !== undefined ? before + 1 : after !== undefined ? after - 1 : Math.max(-1, ...previous.pages.filter((page) => page.columnId === input.columnId).map((page) => page.boardOrder)) + 1;
        client.setQueryData(["boards", id], { ...previous, pages: previous.pages.map((page) => page.id === input.page.id ? { ...page, columnId: input.columnId, boardOrder: order } : page).sort((a, b) => a.boardOrder - b.boardOrder) });
      }
      return { previous };
    },
    onError: (error, _input, context) => { if (context?.previous) client.setQueryData(["boards", id], context.previous); fail(error); },
    onSettled: invalidate,
  });
  useAssistantSurface("/board", {
    kind: "board",
    filters: { boardId: id, boardTitle: query.data?.board.title ?? "", customBoard: true, search },
    visibleIds: (query.data?.pages ?? []).filter((page) => page.title.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 100).map((page) => page.id),
  });
  if (!query.data) return <div className="p-6"><Link href="/board" className="btn-ghost mb-6"><ArrowLeft size={14} />All boards</Link>{query.isError ? <LoadError what="this board" error={query.error} onRetry={() => void query.refetch()} /> : <p role="status" className="text-muted">Opening board…</p>}</div>;
  const { board, pages } = query.data;
  const needle = search.trim().toLowerCase();
  const visible = pages.filter((page) => page.title.toLowerCase().includes(needle));
  const busy = assign.isPending || create.isPending || patch.isPending;
  const dragEnd = ({ active, over }: DragEndEvent) => {
    setDragged(null);
    if (!over || busy) return;
    const page = pages.find((row) => row.id === active.id);
    const overPage = pages.find((row) => row.id === over.id);
    const columnId = board.columns.find((column) => column.id === over.id)?.id ?? overPage?.columnId;
    if (!page || !columnId || active.id === over.id) return;
    const target = pages.filter((row) => row.columnId === columnId && row.id !== page.id);
    if (page.columnId === columnId && overPage) {
      const current = pages.filter((row) => row.columnId === columnId);
      const next = arrayMove(current, current.findIndex((row) => row.id === page.id), current.findIndex((row) => row.id === overPage.id));
      const index = next.findIndex((row) => row.id === page.id);
      assign.mutate({ page, columnId, beforeId: next[index - 1]?.id ?? null, afterId: next[index + 1]?.id ?? null });
    } else {
      const index = overPage ? target.findIndex((row) => row.id === overPage.id) : target.length;
      assign.mutate({ page, columnId, beforeId: target[index - 1]?.id ?? null, afterId: target[index]?.id ?? null });
    }
  };
  return <div className="cb-detail">
    <Link href="/board" className="cb-back"><ArrowLeft size={14} />All boards</Link>
    <PageHeader title={board.title} description={board.description || "Your pages, organized your way."} actions={editable ? <button type="button" className="btn" onClick={() => setSettings(true)}><Settings2 size={14} />Board settings</button> : undefined} />
    {query.isError && <LoadError what="the latest board changes" error={query.error} onRetry={() => void query.refetch()} />}
    <BoardWidgets board={board} pages={pages} editable={editable} pending={busy} onChange={(tiles) => patch.mutate({ tiles })} />
    <div className="cb-toolbar"><label><Search size={15} /><input type="search" aria-label={`Search ${board.title} pages`} placeholder="Find a page on this board…" value={search} onChange={(event) => setSearch(event.target.value)} /></label><span>{plural(pages.length, "page")}</span>
      {editable && <Popover trigger={(open, toggle) => <button type="button" className="btn" aria-expanded={open} disabled={busy} onClick={toggle}>Add existing page</button>}>{(close) => <div className="cb-existing-pages"><input className="field mb-2 w-full text-[12px]" type="search" aria-label="Find an existing page" placeholder="Find a page…" value={existingSearch} onChange={(event) => setExistingSearch(event.target.value)} />{directory.isError ? <p role="alert" className="p-2 text-[13px] text-danger">{directory.error.message}<button type="button" className="btn" onClick={() => void directory.refetch()}>Retry</button></p> : directory.isPending ? <p className="p-2 text-[13px] text-muted">Loading pages…</p> : directory.data.pages.filter((page) => page.board?.id !== id && page.title.toLowerCase().includes(existingSearch.trim().toLowerCase())).map((page) => <MenuItem key={page.id} onClick={() => { close(); assign.mutate({ page, columnId: board.columns[0]!.id }); }}><FileText size={13} /><span className="truncate">{page.title}</span><small className="ml-auto text-muted">{page.board?.title || "Independent"}</small></MenuItem>)}{directory.data && directory.data.pages.every((page) => page.board?.id === id || !page.title.toLowerCase().includes(existingSearch.trim().toLowerCase())) && <p className="p-2 text-[13px] text-muted">{existingSearch.trim() ? "No matching pages." : "No other pages. Create one in a column below."}</p>}</div>}</Popover>}
      {editable && <button type="button" className="btn-primary" disabled={busy} onClick={() => create.mutate(board.columns[0]!.id)}><Plus size={14} />New page</button>}
    </div>
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={({ active }) => setDragged(pages.find((page) => page.id === active.id) ?? null)} onDragEnd={dragEnd} onDragCancel={() => setDragged(null)}>
      <div className="cb-kanban" aria-label={`${board.title} columns`}>{board.columns.map((column) => {
        const rows = visible.filter((page) => page.columnId === column.id);
        return <CustomColumn key={column.id} column={column} count={rows.length} onCreate={editable ? () => create.mutate(column.id) : undefined} disabled={busy}>
          <SortableContext items={rows.map((page) => page.id)} strategy={verticalListSortingStrategy}>{rows.map((page) => <CustomCard key={page.id} page={page} editable={editable && !busy && !needle} />)}</SortableContext>
          {!rows.length && <p className="cb-column-empty">{needle ? "No matching pages" : "Room for your next idea."}</p>}
        </CustomColumn>;
      })}{editable && <button type="button" className="cb-add-column" onClick={() => setSettings(true)}><Plus size={15} />Add column</button>}</div>
      <BoardDragOverlay width={260}>{dragged && <div className="cb-page-card"><FileText size={14} /><strong>{dragged.title}</strong></div>}</BoardDragOverlay>
    </DndContext>
    {settings && <BoardSettings board={board} onClose={() => setSettings(false)} />}
  </div>;
}

function CustomColumn({ column, count, onCreate, disabled, children }: { column: PageBoardColumn; count: number; onCreate?: () => void; disabled: boolean; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id, disabled });
  return <section ref={setNodeRef} className="cb-column" data-over={isOver || undefined} aria-label={column.name}>
    <header><span data-board-color={column.color}><i />{column.name}</span><small>{count}</small>{onCreate && <button type="button" className="icon-btn" aria-label={`New page in ${column.name}`} disabled={disabled} onClick={onCreate}><Plus size={15} /></button>}</header>
    <div className="cb-column-pages">{children}</div>{onCreate && <button type="button" className="cb-add-page" disabled={disabled} onClick={onCreate}><Plus size={14} />New page</button>}
  </section>;
}
function CustomCard({ page, editable }: { page: BoardPage; editable: boolean }) {
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } = useSortable({ id: page.id, disabled: !editable });
  return <div ref={setNodeRef} className="cb-page-card" style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? .35 : 1 }}>
    {editable && <button type="button" className="cb-card-grip" aria-label={`Move ${page.title}. Press Space, then use arrow keys.`} {...attributes} {...listeners}><GripVertical size={13} /></button>}
    <Link href={boardPageHref(page)}><FileText size={15} /><strong>{page.title}</strong><small>Edited {relative(page.updatedAt)}</small></Link>
  </div>;
}
