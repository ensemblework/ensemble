"use client";

import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { AgentIcon } from "@/components/agent-icon";
import { useEffect, useId, useRef, useState } from "react";
import { api, type NodeAssignable, type NodeTaskWork, type TaskRecord } from "@/lib/api";
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
      {crew ? <Users size={11} aria-hidden /> : node ? <NodeFace look={node.avatar} paused={node.paused} size={13} /> : <AgentIcon size={11} aria-hidden />}
      <span className="truncate">{text}</span>
    </span>
  );
}

/**
 * Changing the owner of a task a node has: at once while the node has not started (a task just given
 * waits a moment before its node's first model call, so a slip costs nothing), else only after the
 * person sees what stops (`NodeWorkNotice`). `change` runs the change, or asks first.
 */
export function useNodeHandOff(taskId: string, owner: string) {
  const [asking, setAsking] = useState<{ work: NodeTaskWork; go: () => void } | null>(null);
  const [checking, setChecking] = useState(false);
  const change = async (apply: () => void, close: () => void) => {
    const go = () => {
      setAsking(null);
      close();
      apply();
    };
    if (owner !== "node") return go();
    setChecking(true);
    const work = await api.nodeTaskWork(taskId).then((answer) => answer.work, () => null);
    setChecking(false);
    if (!work) return go();
    setAsking({ work, go });
  };
  return { asking, checking, change, reset: () => setAsking(null) };
}

const DOING: Record<NodeTaskWork["doing"], string> = {
  thinking: "is working on this now",
  plan: "is running a plan for this",
  session: "has an agent session on this",
};

/** Inside the owner menu: the node's work under way, and a choice to keep it or stop it with the change. */
export function NodeWorkNotice({ work, mine, onKeep, onStop }: { work: NodeTaskWork; mine: NodeAssignable; onKeep: () => void; onStop: () => void }) {
  const id = useId();
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => keep.current?.focus(), []);
  const node = mine.nodes.find((row) => row.id === work.node.id);
  return (
    <div role="alertdialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} className="node-work-notice">
      <div className="flex items-start gap-2.5">
        <span className="node-work-face" aria-hidden>
          <NodeFace look={node?.avatar} size={22} />
        </span>
        <div className="min-w-0">
          <p id={`${id}-title`} className="text-[13px] font-medium leading-5">
            <span className="break-words">@{work.node.slug}</span> {DOING[work.doing]}
          </p>
          <p id={`${id}-body`} className="mt-0.5 text-[12px] leading-[17px] text-muted">
            Changing the owner stops {work.doing === "thinking" ? "it" : "that work"} where it is.
          </p>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-1.5">
        <button ref={keep} type="button" className="btn-ghost h-7 px-2.5 text-[12.5px]" onClick={onKeep}>
          Keep working
        </button>
        <button type="button" className="node-work-stop h-7 rounded-md px-2.5 text-[12.5px] font-medium" onClick={onStop}>
          Stop and change
        </button>
      </div>
    </div>
  );
}
