"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api, type Priority, type TaskRecord, type TaskStatus } from "@/lib/api";
import { Dialog, Spinner } from "../ui";

export function CreateTaskDialog({ status = "todo", onCreated, onClose }: {
  status?: TaskStatus;
  onCreated: (task: TaskRecord) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("p1");
  const [due, setDue] = useState("");
  const submitting = useRef(false);
  const save = useMutation({
    mutationFn: async () => {
      if (!title.trim()) throw new Error("Enter a task title.");
      const date = due ? new Date(due) : null;
      if (date && !Number.isFinite(date.getTime())) throw new Error("Choose a valid due date and time.");
      return api.createTask({
        title: title.trim(), description, priority, due: date?.toISOString() ?? null,
        status, owner: status === "proposed" ? "unassigned" : "me",
      });
    },
    onSuccess: ({ task }) => { onCreated(task); onClose(); },
    onSettled: () => { submitting.current = false; },
  });
  const submit = () => {
    if (submitting.current) return;
    submitting.current = true;
    save.mutate();
  };
  const close = () => { if (!submitting.current) onClose(); };
  return (
    <Dialog open title="New task" onClose={close}>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); submit(); }} onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); submit(); }
      }}>
        <label className="block text-[13px] font-medium">
          Title
          <input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} className="field mt-1 w-full" />
        </label>
        <label className="block text-[13px] font-medium">
          Description (optional)
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} className="field mt-1 w-full" rows={3} />
        </label>
        <label className="block text-[13px] font-medium">
          Priority
          <select aria-label="Priority" value={priority} onChange={(event) => setPriority(event.target.value as Priority)} className="field mt-1 w-full">
            <option value="p0">High</option><option value="p1">Normal</option><option value="p2">Low</option>
          </select>
        </label>
        <label className="block text-[13px] font-medium">
          Due (local time, optional)
          <input type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} className="field mt-1 w-full" />
        </label>
        {save.error ? <p role="alert" className="text-[13px] text-danger">{save.error.message}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" disabled={save.isPending} onClick={close}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={!title.trim() || save.isPending}>
            <Spinner active={save.isPending} size={12} /> Create task
          </button>
        </div>
      </form>
    </Dialog>
  );
}
