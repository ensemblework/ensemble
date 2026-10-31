"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useSortable, type AnimateLayoutChanges } from "@dnd-kit/sortable";
import { AgentIcon as Orbit } from "@/components/agent-icon";
import { GripVertical, Trash2 } from "lucide-react";
import { type TaskRecord } from "@/lib/api";
import { warmTask } from "@/lib/warm";
import { dueLabel, plural } from "@/lib/format";
import { PriorityTag, cx } from "../ui";
import { LabelChips } from "../task/labels";
import { colorFor } from "@/lib/presence";
import { taskPersonId, useSpacePeople } from "@/lib/space-people";
import { NodeOwnerMark } from "../task/node-owner";

/**
 * Who does it, as a small pill: "Me", "Agent", a node ("@tester") or crew, or someone's initials in a shared space. "Me" is
 * relative: whoever is looking sees their own tasks as Me and everyone else's as initials.
 */
function OwnerMark({ task }: { task: TaskRecord }) {
  const { me, ownerId, byId } = useSpacePeople();
  if (task.owner === "agent") {
    return (
      <span title="The agent does it" className="inline-flex h-[18px] items-center gap-1 rounded-full bg-ink/10 px-1.5 text-[11px] font-medium leading-none text-ink">
        <Orbit size={11} aria-hidden /> Agent
      </span>
    );
  }
  if (task.owner === "node") return <NodeOwnerMark task={task} />;
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

/** The card's trash button, shown on hover or focus. Neither drags nor opens the card. */
export function CardDelete({ label, onDelete }: { label: string; onDelete: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn absolute right-1 top-1 h-6 w-6 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
      aria-label={`Delete ${label}`}
      title="Delete"
      // The card drags on pointer down and opens on click; the button does neither.
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onDelete();
      }}
    >
      <Trash2 size={13} />
    </button>
  );
}

/** Where the trash button goes when there is none: a quiet handle for people who may only move cards, and the drag copy. */
export function CardHandle() {
  return <GripVertical size={14} className="absolute right-1.5 top-2 text-faint opacity-0 transition-opacity group-hover:opacity-100" />;
}

/** The card. `onDelete` adds a trash button that shows on hover; the drag overlay copy has none. */
export function CardBody({ task, onDelete }: { task: TaskRecord; onDelete?: (id: string) => void }) {
  const due = dueLabel(task.due, task.status === "done");
  return (
    <div className="board-card group text-left" data-priority={task.priority}>
      <div className="flex min-w-0 items-start gap-2 pr-4">
        <span className="card-title min-w-0 [overflow-wrap:anywhere]" title={task.title}>{task.title}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
        <PriorityTag priority={task.priority} />
        <OwnerMark task={task} />
        {task.people.length ? <span>{plural(task.people.length, "person", "people")}</span> : null}
        {due ? <span className={due.overdue ? "text-[color:var(--tag-red-fg)]" : undefined}>{due.text}</span> : null}
        <LabelChips labels={task.labels} />
      </div>
      {onDelete ? <CardDelete label={task.title || "task"} onDelete={() => onDelete(task.id)} /> : <CardHandle />}
    </div>
  );
}

export type BoardCardMotion = {
  transition: { duration: number; easing: string } | null;
  animateLayoutChanges: AnimateLayoutChanges;
};

/**
 * A draggable board card, shared by the Ensemble board and custom boards: the whole card drags,
 * a click (or Enter) opens it, Shift-click selects it. `children` is what the card shows.
 */
export function SortableBoardCard({
  id,
  active,
  selected,
  disabled = false,
  motion,
  onOpen,
  onToggleSelect,
  onWarm,
  children,
}: {
  id: string;
  active: boolean;
  selected?: boolean;
  disabled?: boolean;
  motion: BoardCardMotion;
  onOpen: (id: string) => void;
  onToggleSelect?: (id: string) => void;
  onWarm?: () => void;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
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
      data-id={id}
      data-bdg-ph={isDragging || undefined}
      onClick={(event) => {
        if (event.shiftKey && onToggleSelect) {
          event.preventDefault();
          onToggleSelect(id);
          return;
        }
        onOpen(id);
      }}
      onContextMenu={(event) => event.preventDefault()}
      data-active={active || undefined}
      {...attributes}
      {...pointerListeners}
      // A card that cannot move still opens from the keyboard.
      tabIndex={0}
      aria-disabled={undefined}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key === "Enter" && !event.defaultPrevented) onOpen(id);
      }}
      onMouseEnter={onWarm}
      onFocus={onWarm}
    >
      <div className={cx((active || selected) && "rounded-md ring-1 ring-line-strong")}>{children}</div>
    </div>
  );
}

export function SortableCard({
  task,
  active,
  selected,
  motion,
  onOpen,
  onToggleSelect,
  onDelete,
}: {
  task: TaskRecord;
  active: boolean;
  selected?: boolean;
  motion: BoardCardMotion;
  onOpen: (id: string) => void;
  onToggleSelect?: (id: string) => void;
  onDelete?: (id: string) => void;
}) {
  const client = useQueryClient();
  return (
    <SortableBoardCard id={task.id} active={active} selected={selected} motion={motion} onOpen={onOpen} onToggleSelect={onToggleSelect} onWarm={() => warmTask(client, task.id)}>
      <CardBody task={task} onDelete={onDelete} />
    </SortableBoardCard>
  );
}
