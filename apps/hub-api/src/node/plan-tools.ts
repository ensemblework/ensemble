/**
 * node_plan and node_plan_revise (ensemble-node docs/design B6): the lead proposes a whole plan, with
 * its requirements and constraints, in one call; code validates it before anything starts, and the
 * errors come back to the lead to fix in the same turn.
 */
import { z } from "zod";
import type { NodeAgent, PrismaClient } from "@prisma/client";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool } from "../assistant/types.js";
import { addNode } from "./store.js";
import { createPlan, loadPlan, missionEnded, PlanError, planVisibility, revisePlan, type PlanNode } from "./plans.js";
import { BRIEF_MAX, Constraints, Deferral, mergeConstraints, PlanInput, RequirementInput, StepInput, validatePlan } from "./plan-contract.js";
import { crewRoomFor, type NodeScope } from "./tools.js";

/** The owner's node for a handle: their own active, lasting nodes (and the lead itself, for its own steps). */
async function nodeFor(prisma: PrismaClient, lead: NodeAgent, handle: string): Promise<NodeAgent> {
  const node = await prisma.nodeAgent.findFirst({ where: { userId: lead.userId, slug: handle, parentNodeId: null } });
  if (!node) {
    const mine = await prisma.nodeAgent.findMany({ where: { userId: lead.userId, status: "active", parentNodeId: null }, select: { slug: true } });
    throw new ToolBlockedError(`There is no node called @${handle}.`, `Your owner's nodes: ${mine.map((row) => `@${row.slug}`).join(", ")}.`);
  }
  if (node.status !== "active") throw new ToolBlockedError(`@${node.slug} is paused.`, "Tell your owner; do not give its work to another node unless they say so.");
  return node;
}

export function planTools(scope: NodeScope): AnyHubTool[] {
  const { prisma, node } = scope;
  if (scope.plan?.planStep) return [];
  return [
    defineTool({
      name: "node_plan",
      area: "tasks",
      description:
        "Propose a whole plan for work by several nodes in one call; code checks it before anything starts. " +
        "goal: one line. requirements: one per deliverable your owner asked for, with acceptance criteria (each with a unique id) when it must be checked. " +
        "constraints: written once for every step (computer, folder, repos, branch, publish none|commit|push|pr, environment, agent, model, effort, context, substitution, order serial when each feature must pass its check before the next starts, notes). " +
        "steps: each with an id, to (a node's handle; your own handle for work you do yourself), kind (build, verify, write, research, other), the requirementIds it covers, a short brief with only its own objective, after (step ids), and for a verify step verifies (the build step's id). " +
        "Anything you will not do now goes in deferred with a reason. Your reply opens the plan: one or two lines.",
      input: PlanInput,
      isWrite: false,
      risk: "low",
      async run(_ctx, input) {
        if (scope.lineage.fromNonOwner) throw new ToolBlockedError("Only your owner can have work handed to their nodes.", "Answer the request yourself, or ask your owner.");
        // In a plan's report turn the plan is still open: change it rather than starting a second one.
        if (scope.plan) throw new ToolBlockedError("This plan is still open.", "Add or change its steps with node_plan_revise (or node_delegate for one more step).");
        const handles = [...new Set(input.steps.map((step) => step.to))];
        const nodes = new Map<string, PlanNode & { row: NodeAgent }>();
        for (const handle of handles) {
          const target = await nodeFor(prisma, node, handle);
          nodes.set(handle, { node: target, handle: target.slug, row: target });
        }
        const problems = validatePlan({ requirements: input.requirements, deferred: input.deferred, constraints: input.constraints, steps: input.steps }, { briefMax: BRIEF_MAX });
        if (problems.length) throw new ToolBlockedError(`The plan needs changes:\n- ${problems.join("\n- ")}`, "Fix these and call node_plan again with the whole plan.");
        const room = scope.room.kind === "crew" ? scope.room : await crewRoomFor(prisma, node);
        for (const target of nodes.values()) {
          const member = await prisma.nodeRoomMember.findFirst({ where: { roomId: room.id, nodeId: target.node.id } });
          target.handle = (member ?? (await addNode(prisma, room.id, target.row))).handle;
        }
        const visibleTo = await planVisibility(prisma, node.userId, room, room.id === scope.room.id ? scope.privateTo : null);
        try {
          const made = await createPlan(prisma, { lead: node, turnId: scope.turnId, room, originRoomId: scope.room.id, originPrivate: Boolean(scope.privateTo), visibleTo, plan: input, nodes });
          const covered = input.requirements.length - input.deferred.length;
          return toolOk(
            `The plan is ready: ${input.steps.length} steps${input.requirements.length ? ` covering ${covered} requirement${covered === 1 ? "" : "s"}${input.deferred.length ? ` (${input.deferred.length} deferred)` : ""}` : ""}. It starts when your turn ends; your reply opens it, so keep it to a line or two.`,
            { planId: made.planId },
          );
        } catch (error) {
          if (error instanceof PlanError) throw new ToolBlockedError(error.message);
          throw error;
        }
      },
    }),
    defineTool({
      name: "node_plan_revise",
      area: "tasks",
      description:
        "Change a plan you lead while it runs, when your owner changes something: new constraints (they apply to every step's next instructions; an empty string clears one), " +
        "steps to add (after may name new step ids, existing step ids from the card, or @handle for that node's latest step), waiting steps to cancel, requirements to add or defer with a reason.",
      input: z
        .object({
          plan: z.string().uuid().describe("The plan's id (the work board lists it)."),
          add: z.array(StepInput).max(20).optional(),
          cancel: z.array(z.string().max(60)).max(30).optional(),
          constraints: Constraints.partial().optional(),
          requirements: z.array(RequirementInput).max(10).optional(),
          defer: z.array(Deferral).max(20).optional(),
        })
        .strict(),
      isWrite: false,
      risk: "low",
      async run(ctx, input) {
        if (scope.lineage.fromNonOwner) throw new ToolBlockedError("Only your owner can change their plans.");
        const plan = await loadPlan(prisma, input.plan);
        if (!plan || plan.mission.leadNodeId !== node.id) throw new ToolBlockedError("That is not a plan you lead.", "Read the ids on your work board.");
        if (missionEnded(plan.mission.status)) throw new ToolBlockedError("That plan has ended; make a new one with node_plan.");
        const nodes = new Map<string, PlanNode & { row: NodeAgent }>();
        for (const handle of [...new Set((input.add ?? []).map((step) => step.to))]) {
          const target = await nodeFor(prisma, node, handle);
          const member = await prisma.nodeRoomMember.findFirst({ where: { roomId: plan.message.roomId, nodeId: target.id } });
          nodes.set(handle, { node: target, handle: (member ?? (await addNode(prisma, plan.message.roomId, target))).handle, row: target });
        }
        // Validate the plan as it would be: existing steps plus the new ones.
        const latest = (ref: string) => [...plan.data.steps].reverse().find((row) => `@${row.handle}` === ref || row.handle === ref.replace(/^@/, ""))?.id;
        const existing = new Set(plan.data.steps.map((row) => row.id));
        const added = (input.add ?? []).map((step) => ({ ...step, after: step.after.map((ref) => (existing.has(ref) ? ref : (latest(ref) ?? ref))), verifies: step.verifies && !existing.has(step.verifies) ? (latest(step.verifies) ?? step.verifies) : step.verifies }));
        const requirements = [...plan.data.requirements.map((row) => ({ id: row.id, acceptance: row.acceptance })), ...(input.requirements ?? [])];
        const problems = validatePlan(
          {
            requirements,
            deferred: [...plan.data.deferred, ...(input.defer ?? [])],
            constraints: { order: input.constraints?.order ?? plan.data.constraints.order },
            steps: [
              ...plan.data.steps.filter((row) => !(input.cancel ?? []).includes(row.id)).map((row) => ({ id: row.id, kind: row.kind, after: row.after, verifies: row.verifies, requirementIds: row.requirementIds })),
              ...added,
            ],
          },
          { briefMax: BRIEF_MAX },
        );
        if (problems.length) throw new ToolBlockedError(`The revision needs changes:\n- ${problems.join("\n- ")}`, "Fix these and call node_plan_revise again.");
        try {
          const result = await revisePlan(ctx.app, plan.mission.id, {
            add: added,
            cancel: input.cancel,
            constraints: input.constraints ? mergeConstraints(plan.data.constraints, input.constraints) : undefined,
            requirements: (input.requirements ?? []).map((row) => ({ id: row.id, text: row.text, status: "open" as const, acceptance: row.acceptance.map((item) => ({ id: item.id, text: item.text, mandatory: item.mandatory !== false })) })),
            defer: input.defer,
            nodes,
          });
          return toolOk(`Revision ${result.revision}: ${result.added.length} step(s) added, ${result.cancelled.length} cancelled. Running steps read the new constraints in their next instructions.`);
        } catch (error) {
          if (error instanceof PlanError) throw new ToolBlockedError(error.message);
          throw error;
        }
      },
    }),
  ];
}
