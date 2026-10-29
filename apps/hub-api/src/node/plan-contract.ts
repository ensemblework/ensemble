/**
 * The mission contract (ensemble-node docs/design B6, plan §7.3–7.4): the lead proposes a whole plan in
 * one call (node_plan) and code validates it before anything starts. Every requested deliverable is a
 * requirement that a step covers or that is deferred with a reason; checks are verify steps naming
 * the build they check; serial work is chained; constraints are written once, on the mission, and
 * rendered into every step's note by code instead of being copied into briefs by a model.
 */
import { z } from "zod";
import { STEP_KINDS } from "./report.js";

const Id = z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "Use letters, digits, dots, dashes or underscores.");
const Handle = z.string().min(1).max(60).transform((value) => value.trim().replace(/^@/, "").toLowerCase());

export const Constraints = z
  .object({
    computer: z.string().trim().max(120).optional(),
    folder: z.string().trim().max(300).optional(),
    repos: z.array(z.string().trim().max(300)).max(10).optional(),
    branch: z.string().trim().max(200).optional(),
    publish: z.enum(["none", "commit", "push", "pr"]).optional(),
    environment: z.string().trim().max(80).optional(),
    agent: z.string().trim().max(40).optional(),
    model: z.string().trim().max(120).optional(),
    effort: z.string().trim().max(20).optional(),
    context: z.enum(["default", "long_context"]).optional(),
    substitution: z.enum(["forbid", "ask", "allow"]).optional(),
    order: z.enum(["serial", "parallel_ok"]).optional(),
    notes: z.array(z.string().trim().min(1).max(500)).max(12).optional(),
  })
  .strict();
export type Constraints = z.infer<typeof Constraints>;

const Acceptance = z.object({ id: Id, text: z.string().trim().min(1).max(500), mandatory: z.boolean().optional() }).strict();

export const RequirementInput = z
  .object({
    id: Id,
    text: z.string().trim().min(1).max(1000),
    acceptance: z.array(Acceptance).max(20).default([]),
    evidence: z.array(z.enum(["screenshot", "test", "commit", "doc", "url", "video"])).max(6).optional(),
  })
  .strict();
export type RequirementInput = z.infer<typeof RequirementInput>;

const Run = z
  .object({ agent: z.string().max(40).optional(), model: z.string().max(120).optional(), effort: z.string().max(20).optional(), context: z.enum(["default", "long_context"]).optional() })
  .strict();

export const StepInput = z
  .object({
    id: Id,
    to: Handle,
    kind: z.enum(STEP_KINDS),
    requirementIds: z.array(Id).max(20).default([]),
    brief: z.string().trim().min(1).max(4000),
    after: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
    verifies: Id.optional(),
    run: Run.optional(),
  })
  .strict();
export type StepInput = z.infer<typeof StepInput>;

export const Deferral = z.object({ requirementId: Id, reason: z.string().trim().min(1).max(500) }).strict();

export const PlanInput = z
  .object({
    goal: z.string().trim().min(1).max(500),
    requirements: z.array(RequirementInput).max(20).default([]),
    constraints: Constraints.default({}),
    steps: z.array(StepInput).min(1).max(30),
    deferred: z.array(Deferral).max(20).default([]),
  })
  .strict();
export type PlanInput = z.infer<typeof PlanInput>;

/** Briefs carry only the step's own objective: constraints are on the mission. */
export const BRIEF_MAX = 1500;

type StepLike = { id: string; kind: string; after: string[]; verifies?: string | null; requirementIds: string[]; brief?: string };

/** Ancestors of a step through `after` (transitively). */
function ancestors(steps: Map<string, StepLike>, id: string, seen = new Set<string>()): Set<string> {
  for (const before of steps.get(id)?.after ?? []) {
    if (seen.has(before)) continue;
    seen.add(before);
    ancestors(steps, before, seen);
  }
  return seen;
}

function hasCycle(steps: Map<string, StepLike>): string | null {
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string): string | null => {
    if (state.get(id) === "done") return null;
    if (state.get(id) === "visiting") return id;
    state.set(id, "visiting");
    for (const before of steps.get(id)?.after ?? []) {
      if (!steps.has(before)) continue;
      const cycle = visit(before);
      if (cycle) return cycle;
    }
    state.set(id, "done");
    return null;
  };
  for (const id of steps.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

export type PlanShape = {
  requirements: Array<{ id: string; acceptance: Array<{ id: string }> }>;
  deferred: Array<{ requirementId: string }>;
  constraints: Pick<Constraints, "order">;
  steps: StepLike[];
  /** Ids of steps that already exist (revisions): `after` may name them. */
  existing?: ReadonlySet<string>;
};

/**
 * What is wrong with a plan, as sentences for the lead to fix (empty when it is valid): unknown or
 * duplicate ids, cycles, requirements no step covers (and not deferred), requirements with acceptance
 * criteria but no verify step, verifications that do not check a build before them, and serial
 * features that are not chained through their checks.
 */
export function validatePlan(plan: PlanShape, options: { briefMax?: number } = {}): string[] {
  const problems: string[] = [];
  const steps = new Map<string, StepLike>();
  for (const step of plan.steps) {
    if (steps.has(step.id)) problems.push(`Two steps have the id “${step.id}”.`);
    steps.set(step.id, step);
  }
  const known = (id: string) => steps.has(id) || Boolean(plan.existing?.has(id));
  const requirementIds = new Set<string>();
  const acceptanceIds = new Set<string>();
  for (const requirement of plan.requirements) {
    if (requirementIds.has(requirement.id)) problems.push(`Two requirements have the id “${requirement.id}”.`);
    requirementIds.add(requirement.id);
    for (const item of requirement.acceptance) {
      if (acceptanceIds.has(item.id)) problems.push(`Two acceptance criteria have the id “${item.id}”; ids must be unique across the plan.`);
      acceptanceIds.add(item.id);
    }
  }
  for (const step of plan.steps) {
    for (const before of step.after) if (!known(before)) problems.push(`Step “${step.id}” comes after “${before}”, which is not a step of this plan.`);
    for (const requirement of step.requirementIds) if (!requirementIds.has(requirement)) problems.push(`Step “${step.id}” covers “${requirement}”, which is not a requirement of this plan.`);
    if (options.briefMax && (step.brief ?? "").length > options.briefMax) problems.push(`Step “${step.id}”'s brief is ${(step.brief ?? "").length} characters; keep it to the step's own objective (at most ${options.briefMax}). Where to work, branches, publishing and agent settings go in constraints.`);
    if (step.kind === "verify") {
      if (!step.verifies) problems.push(`Verify step “${step.id}” must name the build step it checks (verifies).`);
      else if (!known(step.verifies)) problems.push(`Verify step “${step.id}” checks “${step.verifies}”, which is not a step of this plan.`);
      else if (steps.has(step.verifies) && steps.get(step.verifies)!.kind !== "build") problems.push(`Verify step “${step.id}” checks “${step.verifies}”, which is not a build step.`);
      else if (steps.has(step.verifies) && !ancestors(steps, step.id).has(step.verifies)) problems.push(`Verify step “${step.id}” must come after the build it checks (“${step.verifies}”): add it to after.`);
    } else if (step.verifies) problems.push(`Step “${step.id}” has verifies but is not a verify step.`);
  }
  const cycle = hasCycle(steps);
  if (cycle) problems.push(`The steps' order has a cycle through “${cycle}”.`);
  const deferred = new Set(plan.deferred.map((row) => row.requirementId));
  for (const id of deferred) if (!requirementIds.has(id)) problems.push(`Deferred “${id}” is not a requirement of this plan.`);
  const covering = (id: string) => plan.steps.filter((step) => step.requirementIds.includes(id));
  const active = plan.requirements.filter((row) => !deferred.has(row.id));
  for (const requirement of active) {
    const steps = covering(requirement.id);
    if (!steps.length) problems.push(`No step covers requirement “${requirement.id}”: add a step for it, or defer it with a reason.`);
    else if (requirement.acceptance.length && !steps.some((step) => step.kind === "verify")) problems.push(`Requirement “${requirement.id}” has acceptance criteria but no verify step checks it.`);
  }
  if (plan.constraints.order === "serial" && !cycle) {
    for (const step of plan.steps) {
      const features = step.requirementIds.filter((id) => !deferred.has(id));
      if (step.kind === "build" && features.length > 1) problems.push(`Serial order: build step “${step.id}” covers ${features.length} requirements; give each feature its own build step.`);
    }
    for (let index = 1; index < active.length; index += 1) {
      const previous = covering(active[index - 1]!.id);
      const gate = previous.filter((step) => step.kind === "verify");
      const anchors = (gate.length ? gate : previous).map((step) => step.id);
      for (const build of covering(active[index]!.id).filter((step) => step.kind === "build" || step.kind === "write")) {
        const before = ancestors(steps, build.id);
        if (anchors.length && !anchors.some((id) => before.has(id))) {
          problems.push(`Serial order: step “${build.id}” (for “${active[index]!.id}”) must come after ${gate.length ? "the check" : "the work"} of “${active[index - 1]!.id}” (${anchors.map((id) => `“${id}”`).join(" or ")}).`);
        }
      }
    }
  }
  return problems;
}

/** The constraints as lines for a worker's note: the authoritative rules for where and how to work. */
export function renderConstraints(constraints: Constraints | null | undefined): string {
  if (!constraints) return "";
  const lines: string[] = [];
  const where = [constraints.computer ? `computer ${constraints.computer}` : "", constraints.folder ? `folder ${constraints.folder}` : "", constraints.repos?.length ? `repositories ${constraints.repos.join(", ")}` : ""].filter(Boolean);
  if (where.length) lines.push(`- Where: ${where.join("; ")}.`);
  if (constraints.environment) lines.push(`- Environment: ${constraints.environment} only.`);
  if (constraints.branch) lines.push(`- Branch: ${constraints.branch}.`);
  if (constraints.publish) {
    lines.push(
      `- Publish: ${
        constraints.publish === "none"
          ? "nothing — do not commit or push"
          : constraints.publish === "commit"
            ? "commit locally, do not push"
            : constraints.publish === "push"
              ? "commit and push to the branch above"
              : "commit, push and open a pull request"
      }.`,
    );
  }
  const agent = [constraints.agent, constraints.model, constraints.effort ? `${constraints.effort} effort` : "", constraints.context === "long_context" ? "long context" : ""].filter(Boolean);
  if (agent.length) lines.push(`- Agent: ${agent.join(", ")} (already applied to your runs; do not check them).`);
  if (constraints.substitution === "forbid") lines.push("- Never substitute another agent or model.");
  if (constraints.substitution === "ask") lines.push("- Ask before substituting another agent or model.");
  if (constraints.order === "serial") lines.push("- Features go one at a time: each is checked before the next starts.");
  for (const note of constraints.notes ?? []) lines.push(`- ${note}`);
  return lines.join("\n");
}

/** Merges a revision's constraints into the current ones (a key set to an empty string clears it). */
export function mergeConstraints(current: Constraints, change: Partial<Constraints>): Constraints {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(change)) {
    if (value === "" || value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return Constraints.parse(next);
}
