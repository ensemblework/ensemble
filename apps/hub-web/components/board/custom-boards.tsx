"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowRight, ArrowUp, Columns3, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BoardColor, type PageBoardColumn, type PageBoardRecord } from "@ensemble/shared-types";
import { api, inItemView } from "@/lib/api";
import { useSpaceAccess } from "@/lib/access";
import { plural } from "@/lib/format";
import { boardHref } from "@/lib/page-boards";
import { Dialog } from "../ui";
import { LoadError } from "../load-error";
import { useToast } from "../toast";
import "./custom-boards.css";

export function CustomBoards() {
  const boards = useQuery({ queryKey: ["boards"], queryFn: api.boards, enabled: !inItemView() });
  const access = useSpaceAccess();
  const [creating, setCreating] = useState(false);
  if (inItemView()) return null;
  return <section className="custom-boards" aria-label="Your boards">
    <header><div><span className="cb-eyebrow">A SPACE FOR EACH KIND OF WORK</span><h2>Your boards</h2><p>Different projects. Your own way of moving them forward.</p></div>
      {access.ready && access.canEdit && <button type="button" className="btn" onClick={() => setCreating(true)}><Plus size={15} />New board</button>}
    </header>
    {boards.isError ? <LoadError what="your boards" error={boards.error} onRetry={() => void boards.refetch()} /> : boards.isPending ? <p className="text-[13px] text-muted" role="status">Loading your boards…</p> : <div className="cb-grid">
      {boards.data.boards.map((board) => <Link key={board.id} href={boardHref(board.id)} className="cb-board-card">
        <span className="cb-board-icon"><Columns3 size={21} /></span><ArrowRight size={16} className="cb-card-arrow" />
        <h3>{board.title}</h3><p>{board.description || `${plural(board.pageCount, "page")} · ${plural(board.columns.length, "column")}`}</p>
        <div className="cb-column-preview">{board.columns.slice(0, 5).map((column) => <span key={column.id} data-board-color={column.color}><i />{column.name}</span>)}</div>
      </Link>)}
      {access.ready && access.canEdit && <button type="button" className="cb-new-card" onClick={() => setCreating(true)}><Plus size={22} /><strong>Create a board</strong><span>Research, learning, personal…</span></button>}
      {!boards.data.boards.length && !access.canEdit && <p className="text-[13px] text-muted">No custom boards in this space.</p>}
    </div>}
    {creating && <BoardSettings onClose={() => setCreating(false)} />}
  </section>;
}

export function BoardSettings({ board, onClose }: { board?: PageBoardRecord; onClose: () => void }) {
  const client = useQueryClient(), router = useRouter(), toast = useToast();
  const [title, setTitle] = useState(board?.title ?? "");
  const [description, setDescription] = useState(board?.description ?? "");
  const [revision] = useState(board?.revision);
  const [columns, setColumns] = useState<PageBoardColumn[]>(() => board?.columns ?? [
    { id: crypto.randomUUID(), name: "To do", color: "gray" },
    { id: crypto.randomUUID(), name: "In progress", color: "blue" },
    { id: crypto.randomUUID(), name: "Done", color: "green" },
  ]);
  const [confirming, setConfirming] = useState(false);
  const save = useMutation({
    mutationFn: () => board ? api.patchBoard(board.id, { title, description, columns, revision: revision! }) : api.createBoard({ title, description, columns }),
    onSuccess: ({ board: saved }) => { void client.invalidateQueries({ queryKey: ["boards"] }); void client.invalidateQueries({ queryKey: ["pages"] }); onClose(); if (!board) router.push(boardHref(saved.id)); },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteBoard(board!.id),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["boards"] }); void client.invalidateQueries({ queryKey: ["pages"] }); void client.invalidateQueries({ queryKey: ["tasks"] }); onClose(); toast("Board deleted. Its pages are safe in Pages."); router.push("/board"); },
  });
  const pending = save.isPending || remove.isPending;
  const change = (id: string, patch: Partial<PageBoardColumn>) => setColumns((rows) => rows.map((column) => column.id === id ? { ...column, ...patch } : column));
  const reorder = (index: number, delta: number) => setColumns((rows) => { const next = [...rows]; [next[index], next[index + delta]] = [next[index + delta]!, next[index]!]; return next; });
  return <Dialog open onClose={onClose} title={board ? "Board settings" : "A board for your work"} width={560}>
    <form className="cb-settings" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <p className="text-[13px] text-muted">Every card is a page. Name the columns to match how you work.</p>
      <label>Board name<input autoFocus className="field" placeholder="e.g. Research" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>Description <small>optional</small><input className="field" maxLength={500} placeholder="What belongs here?" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      <div className="cb-settings-columns"><span className="text-[13px] font-medium">Columns</span>{columns.map((column, index) => <div key={column.id} className="cb-column-setting">
        <select className="field cb-color-select" aria-label={`Color for column ${index + 1}`} data-board-color={column.color} value={column.color} onChange={(event) => change(column.id, { color: BoardColor.parse(event.target.value) })}>{BoardColor.options.map((color) => <option key={color} value={color}>{color}</option>)}</select>
        <input className="field min-w-0 flex-1" aria-label={`Column ${index + 1} name`} maxLength={80} value={column.name} onChange={(event) => change(column.id, { name: event.target.value })} />
        <button type="button" className="icon-btn" aria-label={`Move ${column.name} up`} disabled={index === 0 || pending} onClick={() => reorder(index, -1)}><ArrowUp size={13} /></button>
        <button type="button" className="icon-btn" aria-label={`Move ${column.name} down`} disabled={index === columns.length - 1 || pending} onClick={() => reorder(index, 1)}><ArrowDown size={13} /></button>
        <button type="button" className="icon-btn" aria-label={`Remove ${column.name}`} disabled={columns.length === 1 || pending} onClick={() => setColumns((rows) => rows.filter((row) => row.id !== column.id))}><Trash2 size={13} /></button>
      </div>)}<button type="button" className="btn-ghost self-start" disabled={columns.length >= 20 || pending} onClick={() => setColumns((rows) => [...rows, { id: crypto.randomUUID(), name: "", color: "gray" }])}><Plus size={14} />Add column</button></div>
      {(save.error || remove.error) && <p role="alert" className="text-[13px] text-danger">{(save.error || remove.error)?.message}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        {board ? <button type="button" className="btn-ghost text-danger" disabled={pending} onClick={() => setConfirming(!confirming)}><Trash2 size={13} />Delete board</button> : <span />}
        <button type="submit" className="btn-primary" disabled={!title.trim() || columns.some((column) => !column.name.trim()) || pending}>{save.isPending ? "Saving…" : board ? "Save changes" : "Create board"}</button>
      </div>
      {confirming && <div className="rounded-lg border border-line p-3 text-[13px]"><p>Delete “{board?.title}”? Only the board is deleted. Pages and task content are kept; task pages return to the Ensemble board.</p><div className="mt-3 flex gap-2"><button type="button" className="btn text-danger" disabled={pending} onClick={() => remove.mutate()}>Delete board permanently</button><button type="button" className="btn" onClick={() => setConfirming(false)}>Keep board</button></div></div>}
    </form>
  </Dialog>;
}
