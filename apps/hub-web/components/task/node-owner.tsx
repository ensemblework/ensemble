"use client";

import { useQuery } from "@tanstack/react-query";
import { Bot, Users } from "lucide-react";
import { api, type NodeAssignable, type TaskRecord } from "@/lib/api";
import { NO_NODES, nodeOwnerText } from "@/lib/node-owner";
import { MenuItem } from "../ui";

/** My Ensemble Node nodes and crews for a task's owner field. Ensemble on a computer has no Node: a refusal there is none. */
export function useNodeAssignable(enabled = true): NodeAssignable {
  const query = useQuery({ queryKey: ["node-assignable"], queryFn: api.nodeAssignable, retry: false, staleTime: 60_000, enabled });
  return query.data ?? NO_NODES;
}

export type NodeOwnerPick = { owner: "node"; assigneeNodeId: string; assigneeRoomId: null } | { owner: "node"; assigneeNodeId: null; assigneeRoomId: string };

const GROUP = "px-2 pb-1 pt-1 text-2xs font-medium uppercase tracking-wide text-faint";

/**
 * The owner menu's Nodes and Crews groups: my own nodes and crews, nothing when I have none. Picking one
 * gives the task to it; the node (or the crew's lead) is told in Ensemble Node and decides how to do it.
 */
export function NodeOwnerItems({ mine, task, onPick }: { mine: NodeAssignable; task: Pick<TaskRecord, "owner" | "assigneeNodeId" | "assigneeRoomId">; onPick: (pick: NodeOwnerPick) => void }) {
  if (!mine.nodes.length && !mine.crews.length) return null;
  const held = task.owner === "node";
  return (
    <>
      {mine.nodes.length ? (
        <div role="group" aria-label="Nodes">
          <div className="mx-2 my-1 border-t border-line" />
          <div className={GROUP}>Nodes</div>
          {mine.nodes.map((node) => (
            <MenuItem key={node.id} active={held && task.assigneeNodeId === node.id} hint={node.role} onClick={() => onPick({ owner: "node", assigneeNodeId: node.id, assigneeRoomId: null })}>
              <Bot size={13} aria-hidden />
              {node.name}
            </MenuItem>
          ))}
        </div>
      ) : null}
      {mine.crews.length ? (
        <div role="group" aria-label="Crews">
          <div className="mx-2 my-1 border-t border-line" />
          <div className={GROUP}>Crews</div>
          {mine.crews.map((crew) => (
            <MenuItem key={crew.roomId} active={held && task.assigneeRoomId === crew.roomId} hint={crew.lead ? `@${crew.lead.slug} leads` : `${crew.members} nodes`} onClick={() => onPick({ owner: "node", assigneeNodeId: null, assigneeRoomId: crew.roomId })}>
              <Users size={13} aria-hidden />
              {crew.title}
            </MenuItem>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** The board card's pill for a task with a node or a crew. */
export function NodeOwnerMark({ task }: { task: Pick<TaskRecord, "owner" | "assigneeNodeId" | "assigneeRoomId" | "nodeAssignee"> }) {
  const text = nodeOwnerText(task);
  const crew = Boolean(task.assigneeRoomId);
  return (
    <span title={crew ? `The crew ${text} does it` : `${text} does it`} className="inline-flex h-[18px] max-w-[140px] items-center gap-1 rounded-full bg-ink/10 px-1.5 text-[11px] font-medium leading-none text-ink">
      {crew ? <Users size={11} aria-hidden /> : <Bot size={11} aria-hidden />}
      <span className="truncate">{text}</span>
    </span>
  );
}
