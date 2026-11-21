/**
 * Roles (beta, issue #311; docs/35 §8.3): the agent and model a delegated agent run gets by the kind of work
 * it is. Off unless its owner turns Roles on in Node's settings (`settings.node.roles.enabled`) or the server
 * sets ENSEMBLE_NODE_ROLES=1; while off, a run is chosen as it always was.
 *
 * A plan step's run (node/sessions.ts `startSession`) takes its role from the step's kind and resolves its
 * agent and model in a fixed order, the first source that names one winning, with a reason code:
 *
 *   explicit_request      the node's own call named an agent or a model
 *   assignment_override   the lead's assignment of the step named one (its run settings)
 *   profile_role          the run profile's role
 *   global_role           the owner's global role
 *   parent_at_creation    the delegating node's own agent and model, when it runs on one of the owner's agents
 *   subscription_default  the run profile's agent, with its model or the agent's own default
 *   (none)                an error that says what to set: never a silent fallback
 *
 * Each resolution is a decision (`node_decisions`, kind `model`). The run keeps what was asked, what was sent
 * and what its agent reported (`node_runs.settings`: requested, resolved, observed).
 */
import type { FastifyInstance } from "fastify";
import { CODE_ENGINES, isCodeEngine, type NodeRole, type RoleChoice, type RoleMap, type RunProfile, type Settings } from "@ensemble/shared-types";
import { recordDecision } from "./trace.js";

export type RoleReason = "explicit_request" | "assignment_override" | "profile_role" | "global_role" | "parent_at_creation" | "subscription_default";

/** One source's word: an agent, a model and a thinking level, any of them left out. */
export type Choice = { agent?: string; model?: string; effort?: string };

export type RoleSources = {
  explicit?: Choice | null;
  assignment?: Choice | null;
  profileRoles?: RoleMap | null;
  globalRoles?: RoleMap | null;
  parent?: Choice | null;
  subscriptionDefault?: Choice | null;
};

export type RoleResolution = { ok: true; role: NodeRole; reason: RoleReason; choice: Choice } | { ok: false; role: NodeRole; reason: "unresolved"; error: string };

/** The role of a plan step's work, by its kind (node/report.ts `STEP_KINDS`): a check of a build is testing, an independent review is review. */
export function roleForStep(kind: string | null | undefined): NodeRole {
  if (kind === "build") return "implementation";
  if (kind === "verify") return "test";
  if (kind === "review") return "review";
  if (kind === "write") return "writing";
  if (kind === "research") return "research";
  return "general";
}

/** Whether Roles are on for this account (or for the whole server, by ENSEMBLE_NODE_ROLES). */
export function rolesEnabled(settings: Pick<Settings, "node">, flag = process.env.ENSEMBLE_NODE_ROLES): boolean {
  return settings.node?.roles?.enabled === true || flag === "1" || flag === "true";
}

const named = (choice: Choice | null | undefined): choice is Choice => Boolean(choice && (choice.agent || choice.model?.trim()));
/** A role counts only when it names a model (#311): an agent or a thinking level alone does not turn it on. */
const roleOf = (map: RoleMap | null | undefined, role: NodeRole): RoleChoice | null => {
  const entry = map?.[role];
  return entry?.model?.trim() ? entry : null;
};

/** The first source that names an agent or a model, in the fixed order. Pure. */
export function resolveRole(role: NodeRole, sources: RoleSources): RoleResolution {
  const order: Array<[RoleReason, Choice | null | undefined]> = [
    ["explicit_request", sources.explicit],
    ["assignment_override", sources.assignment],
    ["profile_role", roleOf(sources.profileRoles, role)],
    ["global_role", roleOf(sources.globalRoles, role)],
    ["parent_at_creation", sources.parent],
    ["subscription_default", sources.subscriptionDefault],
  ];
  for (const [reason, choice] of order) {
    if (!named(choice)) continue;
    const clean: Choice = {
      ...(choice.agent ? { agent: choice.agent } : {}),
      ...(choice.model?.trim() ? { model: choice.model.trim() } : {}),
      ...(choice.effort ? { effort: choice.effort } : {}),
    };
    return { ok: true, role, reason, choice: clean };
  }
  return {
    ok: false,
    role,
    reason: "unresolved",
    error: `No agent or model is set for ${role} work. Set one for the ${role} role (Node settings, Roles), in the run profile, or name the agent in the step.`,
  };
}

/** The delegating node's own agent and model, when it runs on one of its owner's agents. */
export function parentChoice(node: { provider: string | null; model: string | null }): Choice | null {
  return node.provider && isCodeEngine(node.provider) ? { agent: node.provider, ...(node.model ? { model: node.model } : {}) } : null;
}

/** The run profile's own agent and model: what a run gets with no role. */
export function profileChoice(profile: Pick<RunProfile, "engine" | "model">): Choice | null {
  return isCodeEngine(profile.engine) ? { agent: profile.engine, ...(profile.model.trim() ? { model: profile.model.trim() } : {}) } : null;
}

const KNOWN = new Set<string>(CODE_ENGINES);

/**
 * Resolves a plan step's run and records the decision (kind `model`): the role, which sources named
 * something (never their values beyond the agent and model) and the choice with its reason.
 */
export async function resolveStepRole(
  app: Pick<FastifyInstance, "prisma" | "log">,
  at: { userId: string; nodeId: string; planId: string; stepId: string; stepKind: string | null },
  sources: RoleSources,
): Promise<RoleResolution> {
  const role = roleForStep(at.stepKind);
  const resolution = resolveRole(role, sources);
  const present = Object.fromEntries(
    (["explicit", "assignment", "parent", "subscriptionDefault"] as const).map((key) => [key, named(sources[key]) ? { agent: sources[key]?.agent ?? null, model: sources[key]?.model ?? null } : null]),
  );
  await recordDecision(app, {
    userId: at.userId,
    nodeId: at.nodeId,
    kind: "model",
    inputs: {
      planId: at.planId,
      stepId: at.stepId,
      stepKind: at.stepKind ?? "other",
      role,
      sources: { ...present, profileRole: Boolean(roleOf(sources.profileRoles, role)), globalRole: Boolean(roleOf(sources.globalRoles, role)) },
    },
    choice: resolution.ok
      ? { reason: resolution.reason, agent: resolution.choice.agent ?? null, model: resolution.choice.model ?? null, effort: resolution.choice.effort ?? null, knownAgent: !resolution.choice.agent || KNOWN.has(resolution.choice.agent) }
      : { reason: resolution.reason, error: resolution.error },
  });
  return resolution;
}
