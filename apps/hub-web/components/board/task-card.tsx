"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSortable, type AnimateLayoutChanges } from "@dnd-kit/sortable";
import { Bot, GripVertical, UserRound } from "lucide-react";
import { api, type TaskRecord } from "@/lib/api";
import { warmTask } from "@/lib/warm";
import { OWNER_LABEL, dueLabel, plural } from "@/lib/format";
import { PriorityTag, cx } from "../ui";
import { LabelChips } from "../task/labels";

function OwnerMark({ owner }: { owner: string }) {
  const shell = useQuery({ queryKey: ["shell"], queryFn: api.shell, staleTime: 60_000 });
  const label = OWNER_LABEL[owner] ?? "Owner";
  if (owner === "agent") {
    return (
      <span title={label} role="img" aria-label={label} className="flex h-4 w-4 items-center justify-center rounded-md bg-ink/10 text-ink">
        <Bot size={11} aria-hidden />
      </span>
    );
  }
  if (owner === "unassigned") {
    return <span title={label} role="img" aria-label={label} className="inline-block h-4 w-4 rounded-full border border-dashed border-muted" />;
  }
  const name = shell.data?.user.name || shell.data?.user.email || "";
  const initial = name ? name.charAt(0).toUpperCase() : "";
  const personLabel = name ? `${label}, ${name}` : label;
  return (
    <span
      title={personLabel}
      role="img"
      aria-label={personLabel}
      className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold leading-none text-ink"
    >
      {initial || <UserRound size={11} aria-hidden />}
    </span>
  );
}

export function CardBody({ task }: { task: TaskRecord }) {
  const due = dueLabel(task.due, task.status === "done");
  return (
    <div className="board-card group text-left">
      <div className="flex items-start gap-2 pr-4">
        <span className="card-title">{task.title}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
        <PriorityTag priority={task.priority} />
        <OwnerMark owner={task.owner} />
        {task.people.length ? <span>{plural(task.people.length, "person", "people")}</span> : null}
        {due ? <span className={due.overdue ? "text-[#ffb4ae]" : undefined}>{due.text}</span> : null}
        <LabelChips labels={task.labels} />
      </div>
      <GripVertical
        size={14}
        className="absolute right-1.5 top-2 text-faint opacity-0 transition-opacity group-hover:opacity-100"
      />
    </div>
  );
}

export type BoardCardMotion = {
  transition: { duration: number; easing: string } | null;
  animateLayoutChanges: AnimateLayoutChanges;
};

export function SortableCard({
  task,
  active,
  selected,
  motion,
  onOpen,
  onToggleSelect,
}: {
  task: TaskRecord;
  active: boolean;
  selected?: boolean;
  motion: BoardCardMotion;
  onOpen: (id: string) => void;
  onToggleSelect?: (id: string) => void;
}) {
  const client = useQueryClient();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    transition: motion.transition,
    animateLayoutChanges: motion.animateLayoutChanges,
  });
  const { onKeyDown, ...pointerListeners } = listeners ?? {};
  return (
    <div
      ref={setNodeRef}
      style={{
        // translate, not transform: a transform on a tile replaces the add-limitation popup's centering.
        translate: transform ? `${Math.round(transform.x)}px ${Math.round(transform.y)}px` : undefined,
        transition: transition ? transition.replace(/\btransform\b/g, "translate") : undefined,
      }}
      className="cursor-pointer outline-none"
      data-bdg-card=""
      data-id={task.id}
      data-bdg-ph={isDragging || undefined}
      onClick={(event) => {
        if (event.shiftKey && onToggleSelect) {
          event.preventDefault();
          onToggleSelect(task.id);
          return;
        }
        onOpen(task.id);
      }}
      onContextMenu={(event) => event.preventDefault()}
      data-active={active || undefined}
      {...attributes}
      {...pointerListeners}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key === "Enter" && !event.defaultPrevented) onOpen(task.id);
      }}
      onMouseEnter={() => warmTask(client, task.id)}
      onFocus={() => warmTask(client, task.id)}
    >
      <div className={cx((active || selected) && "rounded-md ring-1 ring-line-strong")}>
        <CardBody task={task} />
      </div>
    </div>
  );
}
