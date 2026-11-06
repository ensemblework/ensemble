"use client";

import { useQuery } from "@tanstack/react-query";
import { Bot, Users } from "lucide-react";
import { api, type NodeAssignable, type TaskRecord } from "@/lib/api";
import { NO_NODES, nodeOwnerText } from "@/lib/node-owner";
import { cx } from "../ui";
import { NodeFace } from "./node-face";

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
            // A long name or role ends in an ellipsis inside the menu; the full name is on hover.
            <button
              key={node.id}
              type="button"
              title={`${node.name} · @${node.slug}${node.paused ? " · paused" : ""}`}
              onClick={() => onPick({ owner: "node", assigneeNodeId: node.id, assigneeRoomId: null })}
              className={cx("node-face-row row-tile flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]", held && task.assigneeNodeId === node.id && "bg-hover")}
            >
              <NodeFace look={node.avatar} paused={node.paused} size={18} />
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              <span className="min-w-0 max-w-[45%] shrink truncate text-2xs text-faint">{node.role}</span>
            </button>
          ))}
        </div>
      ) : null}
      {mine.crews.length ? (
        <div role="group" aria-label="Crews">
          <div className="mx-2 my-1 border-t border-line" />
          <div className={GROUP}>Crews</div>
          {mine.crews.map((crew) => (
            <button
              key={crew.roomId}
              type="button"
              title={crew.title}
              onClick={() => onPick({ owner: "node", assigneeNodeId: null, assigneeRoomId: crew.roomId })}
              className={cx("row-tile flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]", held && task.assigneeRoomId === crew.roomId && "bg-hover")}
            >
              <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-ink/10 text-muted" aria-hidden>
                <Users size={11} />
              </span>
              <span className="min-w-0 flex-1 truncate">{crew.title}</span>
              <span className="min-w-0 max-w-[45%] shrink truncate text-2xs text-faint">{crew.lead ? `@${crew.lead.slug} leads` : `${crew.members} nodes`}</span>
            </button>
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
  // My own node shows its face; another person's, or a crew, its icon.
  const mine = useNodeAssignable(!crew && Boolean(task.assigneeNodeId));
  const node = crew ? undefined : mine.nodes.find((row) => row.id === task.assigneeNodeId);
  return (
    <span title={crew ? `The crew ${text} does it` : `${text} does it`} className="inline-flex h-[18px] max-w-[140px] items-center gap-1 rounded-full bg-ink/10 px-1.5 text-[11px] font-medium leading-none text-ink">
      {crew ? <Users size={11} aria-hidden /> : node ? <NodeFace look={node.avatar} paused={node.paused} size={13} /> : <Bot size={11} aria-hidden />}
      <span className="truncate">{text}</span>
    </span>
  );
}
