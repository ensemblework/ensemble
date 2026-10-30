/**
 * The saved secrets an Ensemble Node run may have in its environment (build block B7, scoped run
 * secrets): the names the owner saved for this node's own secret requests, or for any request in the
 * conversation the run belongs to (node/node-secrets.ts), and the names its plan step or mission names.
 * None by default: a node run never gets every secret saved on the computer, as a run from the Hub or
 * the CLI still does. The computer applies the list (lib/run-secrets.ts `secretScopeOf`).
 */
import type { NodeAgent, NodeRoom, PrismaClient } from "@prisma/client";
import { secretNameProblem } from "../lib/run-secrets.js";
import type { PlanLink } from "./plans.js";

const MAX_NAMES = 100;

/** Names in a JSON value's `secrets` list, when it has one. */
function namesIn(value: unknown): string[] {
  const list = value && typeof value === "object" && !Array.isArray(value) ? (value as { secrets?: unknown }).secrets : undefined;
  return Array.isArray(list) ? list.filter((name): name is string => typeof name === "string") : [];
}

export async function secretScopeFor(
  prisma: Pick<PrismaClient, "nodeMessage" | "nodeMission" | "nodeStep">,
  input: { node: Pick<NodeAgent, "id" | "userId">; room: Pick<NodeRoom, "id">; plan?: PlanLink | null },
): Promise<string[]> {
  const names = new Set<string>();
  const saved = await prisma.nodeMessage.findMany({
    where: {
      kind: "approval",
      userId: input.node.userId,
      OR: [{ authorNodeId: input.node.id }, { roomId: input.room.id }],
      AND: [{ data: { path: ["type"], equals: "secret" } }, { data: { path: ["status"], equals: "saved" } }],
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { data: true },
  });
  for (const card of saved) {
    const name = (card.data as { name?: unknown } | null)?.name;
    if (typeof name === "string") names.add(name);
  }
  const plan = input.plan;
  if (plan?.planId) {
    const mission = await prisma.nodeMission.findUnique({ where: { id: plan.planId }, select: { constraints: true, userId: true } });
    if (mission?.userId === input.node.userId) for (const name of namesIn(mission.constraints)) names.add(name);
    if (plan.planStep) {
      const step = await prisma.nodeStep.findUnique({ where: { missionId_id: { missionId: plan.planId, id: plan.planStep } }, select: { run: true } });
      for (const name of namesIn(step?.run)) names.add(name);
      // A plan made before missions were tables keeps its steps on its card.
      const card = await prisma.nodeMessage.findUnique({ where: { id: plan.planId }, select: { kind: true, userId: true, data: true } });
      const steps = card?.kind === "plan" && card.userId === input.node.userId ? (card.data as { steps?: unknown } | null)?.steps : undefined;
      const own = Array.isArray(steps) ? (steps as Array<{ id?: unknown; run?: unknown }>).find((row) => row.id === plan.planStep) : undefined;
      for (const name of namesIn(own?.run)) names.add(name);
    }
  }
  return [...names].filter((name) => !secretNameProblem(name)).sort().slice(0, MAX_NAMES);
}
