/**
 * Where a dispatched plan step works on the computer, held with resource claims (ensemble-node docs/design
 * B13): the folder's checkout (serial work, an integration step and its check, writing) or a build's own
 * git worktree, and a development-server port when the mission builds in parallel. A step that finds its
 * place taken waits in line, its progress saying for what, and is woken holding it (node/claims.ts).
 * The runs a step starts carry its place to the computer (`missionContext`, the claim's `mission`).
 */
import type { FastifyInstance } from "fastify";
import type { Prisma, PrismaClient, ResourceClaim } from "@prisma/client";
import { claimPort, claimResource, claimsOf, stepHolder, type ClaimKind } from "./claims.js";
import type { AttemptReason } from "./missions-core.js";
import { parallelMode, workplaceOf, worktreeName, type Place, type Workplace } from "./parallel.js";
import { kickMissions, type PlanData, type PlanLink, type PlanStep } from "./plans.js";
import type { MissionSpec } from "../remote/contract.js";

/** The computer and folder label a step works in. */
export type Located = { deviceId: string; deviceName: string; label: string; capabilities: unknown };

export type Placed = { wait: string } | { wait: null; place: Place | null };

/** A computer whose runtime makes worktrees for a claim's `mission.worktree` (`capabilities.worktrees` 1 or more). */
export function deviceWorktrees(capabilities: unknown): boolean {
  const value = capabilities && typeof capabilities === "object" ? (capabilities as { worktrees?: unknown }).worktrees : undefined;
  return typeof value === "number" && value >= 1;
}

async function waitWords(prisma: PrismaClient, data: PlanData, holder: ResourceClaim, what: string): Promise<string> {
  if (holder.missionId === data.missionId && holder.stepId) {
    const step = data.steps.find((row) => row.id === holder.stepId);
    if (step) return `Waiting for @${step.handle}'s step to finish with ${what}.`;
  }
  if (holder.missionId) {
    const other = await prisma.nodeMission.findUnique({ where: { id: holder.missionId }, select: { goal: true } });
    return `Waiting for another plan${other?.goal ? ` (“${other.goal.slice(0, 60)}”)` : ""} to finish with ${what}.`;
  }
  return `Waiting for ${what} to come free.`;
}

/**
 * Takes the step's place for this attempt: its workplace (waiting in line when another step has it),
 * the branch of its worktree, and a port when the mission builds in parallel. Serial work takes the
 * checkout only, so two steps never change one folder at once.
 */
export async function placeStep(app: FastifyInstance, input: { userId: string; data: PlanData; step: PlanStep; reason: AttemptReason; located: Located | null }): Promise<Placed> {
  const { data, step, located } = input;
  if (!located) return { wait: null, place: null };
  const prisma = app.prisma;
  const holder = stepHolder(data.missionId, step.id);
  const own = { userId: input.userId, holder, missionId: data.missionId, stepId: step.id };
  let workplace: Workplace = workplaceOf(data, step.id);
  let note: string | null = null;
  const old = parallelMode(data.constraints) !== "serial" && !deviceWorktrees(located.capabilities);
  if (workplace.kind === "worktree" && old) {
    note = `Ensemble on ${located.deviceName} is too old to make worktrees, so this step works in ${located.label} itself, one step at a time. Update Ensemble there (\`ensemble update\`) for parallel worktrees.`;
    workplace = { kind: "checkout" };
  } else if (step.integrates?.length && old) {
    note = `Ensemble on ${located.deviceName} is too old to make worktrees, so the builds worked in ${located.label} itself, one at a time: what is already there needs no merging. Run the checks again.`;
  }
  const wanted: { kind: ClaimKind; key: string; what: string; data: Record<string, unknown> } =
    workplace.kind === "checkout"
      ? { kind: "checkout", key: `${located.deviceId}:${located.label}`, what: located.label, data: { folder: located.label } }
      : {
          kind: "worktree",
          key: `${located.deviceId}:${located.label}:${workplace.name}`,
          what: `the worktree “${workplace.name}”`,
          data: { folder: located.label, name: workplace.name, branch: workplace.branch, detached: workplace.detached, reuse: workplace.reuse },
        };
  const got = await claimResource(prisma, { ...own, kind: wanted.kind, key: wanted.key, data: { ...wanted.data, attempt: step.attempt, reason: input.reason } });
  if (got.handovers.length) kickMissions(app);
  if (!got.ok) return { wait: await waitWords(prisma, data, got.heldBy, wanted.what) };
  if (workplace.kind === "worktree" && workplace.branch) {
    await claimResource(prisma, { ...own, kind: "branch", key: `${located.deviceId}:${located.label}:${workplace.branch}`, data: { branch: workplace.branch } }, { wait: false });
  }
  const port = parallelMode(data.constraints) === "serial" ? null : await claimPort(prisma, { ...own, scope: located.deviceId });
  return { wait: null, place: { workplace, port, note } };
}

/**
 * What the computer is told about a plan step's run (the job's `context.mission`, the claim's `mission`):
 * its mission and step, the worktree it works in, its port, and the worktrees an integration step brings
 * in (removed after it succeeds, when clean). From the step's claims, so every run of the step (the
 * packet's, a repair, its node's own, an approved card's) works in the same place.
 */
export async function missionContext(db: PrismaClient | Prisma.TransactionClient, plan: PlanLink | null | undefined): Promise<{ mission?: MissionSpec }> {
  if (!plan?.planStep) return {};
  const held = (await claimsOf(db, stepHolder(plan.planId, plan.planStep))).filter((row) => row.state === "held");
  const tree = held.find((row) => row.kind === "worktree")?.data as { name?: unknown; branch?: unknown; detached?: unknown; reuse?: unknown } | undefined;
  const port = held.find((row) => row.kind === "port")?.data as { port?: unknown } | undefined;
  let integrates: string[] = [];
  if (held.some((row) => row.kind === "checkout")) {
    const [mission, step] = await Promise.all([
      db.nodeMission.findUnique({ where: { id: plan.planId }, select: { constraints: true } }),
      db.nodeStep.findUnique({ where: { missionId_id: { missionId: plan.planId, id: plan.planStep } }, select: { integrates: true } }),
    ]);
    const constraints = (mission?.constraints ?? {}) as PlanData["constraints"];
    if (step?.integrates?.length && parallelMode(constraints) !== "serial") integrates = step.integrates.map((id) => worktreeName(constraints.folder, plan.planId, id));
  }
  return {
    mission: {
      id: plan.planId,
      step: plan.planStep,
      ...(tree && typeof tree.name === "string"
        ? { worktree: { name: tree.name, ...(typeof tree.branch === "string" ? { branch: tree.branch } : {}), ...(tree.detached === true ? { detached: true } : {}), ...(tree.reuse === true ? { reuse: true } : {}) } }
        : {}),
      ...(typeof port?.port === "number" ? { port: port.port } : {}),
      ...(integrates.length ? { integrates } : {}),
    },
  };
}
