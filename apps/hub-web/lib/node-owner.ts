import type { NodeAssignable, TaskRecord } from "./api";

export const NO_NODES: NodeAssignable = { nodes: [], crews: [] };

/** How a task with a node or a crew names it: "@tester", or the crew's title (`mine`: my own nodes and crews). */
export function nodeOwnerText(task: Pick<TaskRecord, "owner" | "assigneeNodeId" | "assigneeRoomId" | "nodeAssignee">, mine: NodeAssignable = NO_NODES): string {
  const id = task.assigneeNodeId ?? task.assigneeRoomId;
  const node = mine.nodes.find((row) => row.id === id);
  if (node) return `@${node.slug}`;
  const crew = mine.crews.find((row) => row.roomId === id);
  if (crew) return crew.title;
  const who = task.nodeAssignee;
  if (who && who.id === id) return who.kind === "node" && who.handle ? `@${who.handle}` : who.name;
  return "A node";
}
