/**
 * A node run's settings (docs/35 §8.10): what was asked (`requested`: by the step, the owner or the
 * node), what Ensemble sent the agent (`resolved`: the job's own fields) and what the agent itself
 * reported (`observed`, or "not_reported"). They are kept on `node_runs.settings` and on the run card's
 * `data.settings`, so the node and the owner see the same three, and no worker is asked to check its
 * own model. A setting the computer's agent cannot honour is refused before any run is made
 * (`tuningProblem`); nothing is quietly swapped for something else.
 */
import type { NodeRun, PrismaClient } from "@prisma/client";
import { claudeModel, ENGINE_LABELS, isCodeEngine, type SubscriptionAgent, type SubscriptionModel } from "@ensemble/shared-types";
import { mergeObserved, observedFromEvents, type ObservedSettings } from "../workspace/engines/observed.js";
import { contextTierOf, fastOf } from "../workspace/trust.js";
import { patchCard, refreshSessionCards, stableJson } from "./session-queue.js";

export const NOT_REPORTED = "not_reported" as const;
export type NotReported = typeof NOT_REPORTED;
export type RunContext = "default" | "long_context";

/** Settings as asked or as sent. `"default"` is the agent's own default. */
export type SettingValues = { agent?: string; model?: string; effort?: string; context?: RunContext; fast?: boolean };

/** Settings as the engine reported them; anything it did not report is "not_reported". */
export type ObservedValues = {
  agent: string | NotReported;
  model: string | NotReported;
  effort: string | NotReported;
  context: RunContext | NotReported;
  fast: boolean | NotReported;
  /** The context window it used, in tokens, when it said. */
  contextTokens?: number;
};

export type RunSettings = { requested: SettingValues; resolved: SettingValues; observed: ObservedValues };

/** What a call asked for: only the settings it named (the step's run settings count as named). */
export function requestedSettings(input: { agent?: string | null; model?: string | null; effort?: string | null; context?: RunContext | null; fast?: boolean | null }): SettingValues {
  const text = (value: string | null | undefined) => (value?.trim() ? value.trim() : undefined);
  const agent = text(input.agent);
  const model = text(input.model);
  const effort = text(input.effort);
  return {
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(input.context ? { context: input.context } : {}),
    ...(typeof input.fast === "boolean" ? { fast: input.fast } : {}),
  };
}

type JobSettings = { provider: string | null; model: string; reasoningEffort: string | null; context: unknown };

/** What Ensemble sent the agent: the job's own fields. */
export function resolvedSettings(job: JobSettings): SettingValues {
  return {
    ...(job.provider ? { agent: job.provider } : {}),
    model: job.model?.trim() || "default",
    effort: job.reasoningEffort?.trim() || "default",
    context: contextTierOf(job.context) ?? "default",
    fast: fastOf(job.context),
  };
}

/**
 * What the engine reported: the computer's report on the job (`observed_settings`) first, then the
 * job's own `engine` and `engine_context` events (a run on this server, or an older computer that sent
 * only the engine's model). The agent counts as reported once its engine started.
 */
export function observedSettings(job: { provider: string | null; observedSettings?: unknown }, events: ReadonlyArray<{ kind: string; data: unknown }>): ObservedValues {
  const found: ObservedSettings = mergeObserved(job.observedSettings as ObservedSettings | null, observedFromEvents(events));
  const started = events.some((event) => event.kind === "engine") || Boolean(found.model);
  return {
    agent: started && job.provider ? job.provider : NOT_REPORTED,
    model: found.model ?? NOT_REPORTED,
    effort: found.effort ?? NOT_REPORTED,
    context: found.context ?? NOT_REPORTED,
    fast: typeof found.fast === "boolean" ? found.fast : NOT_REPORTED,
    ...(found.contextTokens ? { contextTokens: found.contextTokens } : {}),
  };
}

/** Nothing reported yet. */
export function unreported(): ObservedValues {
  return { agent: NOT_REPORTED, model: NOT_REPORTED, effort: NOT_REPORTED, context: NOT_REPORTED, fast: NOT_REPORTED };
}

const agentName = (agent: string) => (isCodeEngine(agent) ? ENGINE_LABELS[agent] : agent === "ensemble" ? "Ensemble's agent" : agent);
const contextWords = (context: string) => (context === "long_context" ? "long context" : context === "default" ? "default context" : context);
const tokensWords = (tokens: number) => (tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : `${Math.round(tokens / 1000)}K`);

/**
 * One line for people and nodes: the settings asked for (or, for what was not asked, as sent), then what
 * the engine reported, for example "GitHub Copilot · GPT 6.1 Sol · default effort · long context
 * (requested); observed model gpt-6.1-sol, effort not reported, context not reported".
 */
export function settingsLine(settings: Partial<RunSettings> | null | undefined): string {
  const requested = settings?.requested ?? {};
  const resolved = settings?.resolved ?? {};
  const observed = settings?.observed;
  const pick = <K extends keyof SettingValues>(key: K) => requested[key] ?? resolved[key];
  const agent = pick("agent");
  const model = pick("model");
  const effort = pick("effort");
  const context = pick("context");
  const parts = [
    agent ? agentName(agent) : null,
    model ? (model === "default" ? "default model" : model) : null,
    effort ? `${effort} effort` : null,
    context ? contextWords(context) : null,
    pick("fast") ? "fast mode" : null,
  ].filter((part): part is string => Boolean(part));
  const asked = Object.keys(requested).length > 0;
  const first = parts.length ? `${parts.join(" · ")} (${asked ? "requested" : "as sent"})` : "Default settings (as sent)";
  if (!observed) return `${first}; observed: nothing reported yet`;
  const field = (name: string, value: unknown, words: (text: string) => string = (text) => text) => `${name} ${value === NOT_REPORTED || value === undefined ? "not reported" : words(String(value))}`;
  const seen = [
    field("model", observed.model),
    field("effort", observed.effort),
    field("context", observed.context, (text) => `${contextWords(text).replace(/ context$/, "")}${observed.contextTokens ? ` (${tokensWords(observed.contextTokens)})` : ""}`),
    ...(pick("fast") || observed.fast === true ? [field("fast mode", observed.fast, (text) => (text === "true" ? "on" : "off"))] : []),
  ];
  return `${first}; observed ${seen.join(", ")}`;
}

/** The run's settings as stored, read safely. */
export function storedSettings(value: unknown): Partial<RunSettings> {
  const row = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Partial<RunSettings>) : {};
  return { ...(row.requested ? { requested: row.requested } : {}), ...(row.resolved ? { resolved: row.resolved } : {}), ...(row.observed ? { observed: row.observed } : {}) };
}

/** The settings a new run starts with: asked, sent, and nothing reported yet. */
export function startingSettings(requested: SettingValues, job: JobSettings): RunSettings {
  return { requested, resolved: resolvedSettings(job), observed: unreported() };
}

/**
 * Reads the job again and brings the run's observed settings up to date, on `node_runs.settings` and
 * on its run card (`data.settings`). The run watcher calls it as the job goes; returns the settings.
 */
export async function refreshRunSettings(prisma: PrismaClient, run: Pick<NodeRun, "id" | "jobId" | "messageId" | "settings">): Promise<RunSettings | null> {
  const job = await prisma.workspaceJob.findUnique({ where: { id: run.jobId }, select: { provider: true, model: true, reasoningEffort: true, context: true, observedSettings: true } });
  if (!job) return null;
  const events = await prisma.workspaceEvent.findMany({ where: { jobId: run.jobId, kind: { in: ["engine", "engine_context"] } }, orderBy: { sequence: "desc" }, take: 20, select: { kind: true, data: true } });
  const stored = storedSettings(run.settings);
  const settings: RunSettings = { requested: stored.requested ?? {}, resolved: stored.resolved ?? resolvedSettings(job), observed: observedSettings(job, events.reverse()) };
  if (stableJson(stored) === stableJson(settings)) return settings;
  await prisma.nodeRun.update({ where: { id: run.id }, data: { settings: settings as never } });
  if (run.messageId) await patchCard(prisma, run.messageId, { settings });
  return settings;
}

/**
 * Brings a node run's card up to date: its settings (`refreshRunSettings`) and its session's state and
 * queue (`data.session`, node/session-queue.ts). The run watcher calls it when a run's job changes.
 */
export async function refreshRunCard(prisma: PrismaClient, run: Pick<NodeRun, "id" | "userId" | "jobId" | "messageId" | "settings" | "sessionId">): Promise<void> {
  await refreshRunSettings(prisma, run);
  if (run.sessionId) await refreshSessionCards(prisma, run.userId, run.sessionId);
}

/**
 * The line a run's instructions end with when settings were asked for, so the agent never stops to
 * check its own model: "Ensemble already started you with gpt-6.1-sol, xhigh thinking and the long
 * context window. Do not check these settings yourself."
 */
export function appliedLine(resolved: SettingValues): string {
  const parts = [
    resolved.model && resolved.model !== "default" ? resolved.model : null,
    resolved.effort && resolved.effort !== "default" ? `${resolved.effort} thinking` : null,
    resolved.context === "long_context" ? "the long context window" : null,
    resolved.fast ? "fast mode" : null,
  ].filter((part): part is string => Boolean(part));
  if (!parts.length) return "";
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Ensemble already started you with ${list}. Do not check these settings yourself.`;
}

// ── What the computer's agent can honour ─────────────────────────────────────────────────────────

/** Agents with a context window to choose: Copilot's `--context long_context`, Claude Code's `[1m]` models. */
const LONG_CONTEXT_AGENTS = new Set(["copilot-cli", "claude-code"]);
/** Agents with a fast mode: Claude Code's `fastMode`, Codex's fast service tier. */
const FAST_AGENTS = new Set(["claude-code", "codex"]);
const ONE_MILLION = 1_000_000;

export type Tuning = {
  /** The agent's id (claude-code, copilot-cli, …). */
  engine: string;
  /** The computer's name, for the message. */
  computer: string | null;
  /** The computer's listing of that agent (capabilities `agents`), when it sent one. */
  listing: SubscriptionAgent | null | undefined;
  /** The model id sent (null: the agent's own default). */
  model: string | null;
  effort: string | null;
  context: RunContext | null;
  fast: boolean;
  /** The model was named in this call: a thinking level kept from the session is checked against it. */
  modelNamed?: boolean;
  /** Settings kept from the session rather than named now (the message says so). */
  kept?: { effort?: boolean; context?: boolean; fast?: boolean };
};

const windowOf = (model: SubscriptionModel) => model.contexts ?? null;
const hasLong = (contexts: NonNullable<SubscriptionModel["contexts"]>) => contexts.some((row) => row.id === "long_context") || contexts.every((row) => (row.tokens ?? 0) >= ONE_MILLION);

function claudeHasLong(model: string): boolean | null {
  const entry = claudeModel(model);
  if (!entry) return null;
  const window = entry.spec.window;
  return "long" in window || window.fixed >= ONE_MILLION;
}

/**
 * Why the computer's agent cannot run with these settings, or null when it can. Checked only against
 * what that computer reported for the agent (capabilities `agents`): long context, fast mode and a
 * thinking level, for the model, so a setting is never silently dropped there. A computer that did not
 * report its agents is not refused on a guess.
 */
export function tuningProblem(tuning: Tuning): { message: string; remedy: string } | null {
  if (!tuning.listing) return null;
  const label = agentName(tuning.engine);
  const where = tuning.computer ? ` on ${tuning.computer}` : "";
  const models = tuning.listing?.models ?? [];
  const listed = tuning.model ? models.find((row) => row.id === tuning.model || (row.aliases ?? []).includes(tuning.model!)) : models.find((row) => row.isDefault);
  const modelName = listed?.label ?? tuning.model ?? `${label}'s default model`;
  const claude = tuning.engine === "claude-code" && tuning.model && tuning.model !== "default" ? claudeModel(tuning.model) : null;
  const keptNote = (what: keyof NonNullable<Tuning["kept"]>, words: string) => (tuning.kept?.[what] ? ` This session used ${words}, so it was kept.` : "");

  if (tuning.context === "long_context") {
    if (!LONG_CONTEXT_AGENTS.has(tuning.engine)) {
      return { message: `${label} has no long context window to choose.${keptNote("context", "long context")}`, remedy: "Run with the default window (context: default), or use GitHub Copilot or Claude Code for long context." };
    }
    const named = tuning.model && tuning.model !== "default" ? tuning.model : null;
    if (tuning.engine === "claude-code" && !named) {
      return { message: `Claude Code's default model runs with its own window, so long context needs a named model.${keptNote("context", "long context")}`, remedy: "Name a Claude model with a 1M window, or run with the default window (context: default)." };
    }
    const contexts = listed ? windowOf(listed) : null;
    const known = contexts ? hasLong(contexts) : claude ? claudeHasLong(claude.id) : null;
    if (known === false) {
      const offers = models.filter((row) => row.contexts && hasLong(row.contexts)).slice(0, 6).map((row) => row.id);
      return {
        message: `${label}${where} does not offer long context for ${modelName}.${keptNote("context", "long context")}`,
        remedy: `Run with the default window (context: default), or choose another model${offers.length ? ` (long context: ${offers.join(", ")})` : ""}.`,
      };
    }
  }

  if (tuning.fast) {
    if (!FAST_AGENTS.has(tuning.engine)) return { message: `${label} has no fast mode.${keptNote("fast", "fast mode")}`, remedy: "Run without fast mode (fast: false), or use Claude Code or Codex for it." };
    const has = listed ? Boolean(listed.fast) : claude ? claude.spec.fast === true : null;
    if (has === false) {
      const offers = models.filter((row) => row.fast).slice(0, 6).map((row) => row.id);
      return { message: `${modelName} has no fast mode in ${label}${where}.${keptNote("fast", "fast mode")}`, remedy: `Run without fast mode (fast: false), or choose another model${offers.length ? ` (fast mode: ${offers.join(", ")})` : ""}.` };
    }
  }

  // A thinking level named in this call was checked as it was named (`agentModel`); one kept from the
  // session is checked here when the model changes.
  if (tuning.effort && tuning.effort !== "default" && tuning.kept?.effort && tuning.modelNamed) {
    const levels = listed?.efforts ?? claude?.spec.efforts ?? tuning.listing?.efforts ?? [];
    if (levels.length && !levels.includes(tuning.effort)) {
      return { message: `${modelName} does not take thinking “${tuning.effort}”, which this session used.`, remedy: `Name a level it takes (${levels.join(", ")}), or effort: default.` };
    }
  }
  return null;
}
