"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useSortable, type AnimateLayoutChanges } from "@dnd-kit/sortable";
import { Bot, GripVertical } from "lucide-react";
import { type TaskRecord } from "@/lib/api";
import { warmTask } from "@/lib/warm";
import { dueLabel, plural } from "@/lib/format";
import { PriorityTag, cx } from "../ui";
import { LabelChips } from "../task/labels";
import { colorFor } from "@/lib/presence";
import { taskPersonId, useSpacePeople } from "@/lib/space-people";

/**
 * Who does it, as a small pill: "Me", "Agent", or someone's initials in a shared space. "Me" is
 * relative: whoever is looking sees their own tasks as Me and everyone else's as initials.
 */
function OwnerMark({ task }: { task: TaskRecord }) {
  const { me, ownerId, byId } = useSpacePeople();
  if (task.owner === "agent") {
    return (
      <span title="The agent does it" className="inline-flex h-[18px] items-center gap-1 rounded-full bg-ink/10 px-1.5 text-[11px] font-medium leading-none text-ink">
        <Bot size={11} aria-hidden /> Agent
      </span>
    );
  }
  if (task.owner === "unassigned") {
    return <span title="Nobody yet" className="inline-flex h-[18px] items-center rounded-full border border-dashed border-line-strong px-1.5 text-[11px] leading-none text-faint">Unassigned</span>;
  }
  const personId = taskPersonId(task, ownerId);
  const person = personId ? byId.get(personId) : undefined;
  if (!personId || personId === me) {
    return <span title="You" className="inline-flex h-[18px] items-center rounded-full bg-accent-soft px-1.5 text-[11px] font-medium leading-none text-ink">Me</span>;
  }
  return (
    <span
      title={person?.name ?? "Someone in this space"}
      aria-label={person?.name ?? "Someone in this space"}
      className="inline-flex h-[18px] min-w-[22px] items-center justify-center rounded-full px-1.5 text-[10.5px] font-semibold leading-none text-white"
      style={{ background: colorFor(personId) }}
    >
      {person?.initials ?? "··"}
    </span>
  );
}

export function CardBody({ task }: { task: TaskRecord }) {
  const due = dueLabel(task.due, task.status === "done");
  return (
    <div className="board-card group text-left" data-priority={task.priority}>
      <div className="flex items-start gap-2 pr-4">
        <span className="card-title">{task.title}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
        <PriorityTag priority={task.priority} />
        <OwnerMark task={task} />
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
