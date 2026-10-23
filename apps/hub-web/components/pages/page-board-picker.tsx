"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Columns3 } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import { Dialog } from "../ui";
import { useToast } from "../toast";
import { boardHref } from "@/lib/page-boards";
import Link from "next/link";

export function PageBoardPicker({ kind, id, onDefault, disabled = false }: { kind: "page" | "task"; id: string; onDefault?: () => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const directory = useQuery({ queryKey: ["pages", "directory"], queryFn: api.pageDirectory });
  const current = directory.data?.pages.find((page) => page.id === id && page.kind === kind)?.board;
  return <>
    <button type="button" className="btn-ghost" disabled={disabled} aria-label="Assign page to board" title={current?.title || "Assign page to a board and column"} onClick={() => setOpen(true)}><Columns3 size={13} /><span className="max-w-40 truncate max-sm:hidden">{current?.title || "Add to board"}</span></button>
    {open && <BoardPickerDialog kind={kind} id={id} onDefault={onDefault} onClose={() => setOpen(false)} />}
  </>;
}

function BoardPickerDialog({ kind, id, onDefault, onClose }: { kind: "page" | "task"; id: string; onDefault?: () => void; onClose: () => void }) {
  const client = useQueryClient(), toast = useToast();
  const boards = useQuery({ queryKey: ["boards"], queryFn: api.boards });
  const directory = useQuery({ queryKey: ["pages", "directory"], queryFn: api.pageDirectory });
  const current = directory.data?.pages.find((page) => page.id === id && page.kind === kind);
  const [choice, setChoice] = useState<string | null>(null);
  const [column, setColumn] = useState<string | null>(null);
  const boardId = choice ?? (current?.board?.id === "ensemble" ? "" : current?.board?.id ?? "");
  const board = boards.data?.boards.find((row) => row.id === boardId);
  const columnId = column ?? (current?.board?.id === boardId ? current.columnId : null) ?? board?.columns[0]?.id ?? "";
  const save = useMutation({
    mutationFn: () => api.assignPageBoard(kind, id, { boardId: boardId || null, columnId: boardId ? columnId : null }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["boards"] });
      void client.invalidateQueries({ queryKey: ["pages"] });
      void client.invalidateQueries({ queryKey: ["tasks"] });
      toast(board ? `Moved to ${board.title} · ${board.columns.find((row) => row.id === columnId)?.name}.` : kind === "task" ? "Returned to the Ensemble board." : "Page is now independent.");
      onClose();
    },
  });
  const error = boards.error || directory.error || save.error;
  return <Dialog open onClose={onClose} title="Where does this page belong?" width={450}>
    <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (boardId === "ensemble") { onClose(); onDefault?.(); } else save.mutate(); }}>
      <p className="text-[13px] leading-5 text-muted">Move this page to a board and column. Its writing stays intact, and you can always find it in Pages.</p>
      <label className="text-[13px]">Board<select className="field mt-1 w-full" aria-label="Board" value={boardId} onChange={(event) => { setChoice(event.target.value); setColumn(null); }}>
        <option value="">{kind === "task" ? "Ensemble board" : "No board · independent page"}</option>
        {onDefault && <option value="ensemble">Ensemble board · turn into a task</option>}
        {boards.data?.boards.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
      </select></label>
      {board && <label className="text-[13px]">Column<select className="field mt-1 w-full" aria-label="Board column" value={columnId} onChange={(event) => setColumn(event.target.value)}>{board.columns.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
      {kind === "task" && board && <p className="text-[12px] text-muted">Custom columns organize the page. The task’s agent status and runs stay unchanged.</p>}
      {error && <div role="alert" className="text-[13px] text-danger">{error.message}{(boards.isError || directory.isError) && <button type="button" className="btn ml-2" onClick={() => { void boards.refetch(); void directory.refetch(); }}>Retry</button>}</div>}
      <div className="flex items-center justify-between gap-2">
        {board ? <Link className="text-[12px] text-muted hover:text-ink" href={boardHref(board.id)} onClick={onClose}>Open board</Link> : <span />}
        <button type="submit" className="btn-primary" disabled={save.isPending || !boards.isSuccess || !directory.isSuccess || Boolean(boardId && boardId !== "ensemble" && !columnId)}>{save.isPending ? "Moving…" : boardId === "ensemble" ? "Add as task" : "Move page"}</button>
      </div>
    </form>
  </Dialog>;
}
