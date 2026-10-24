/**
 * A coding agent's models as a paired computer reported them (`GET /api/subscriptions`, or the
 * device's own `agents` capability), and what Assign sends for one. GitHub Copilot lists each
 * model's thinking levels, context windows and cost; the other agents take a model name only.
 */
import { EFFORT_LABEL, orderLevels, parseSubscriptionAgents, type CodeEngine, type ContextTier, type EffortLevel, type ModelContext, type ReasoningEffort, type SubscriptionAgent, type SubscriptionModel } from "@ensemble/shared-types";
import type { AssignInput, SubscriptionsView } from "./api";

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** The engine as a computer found it: by computer id, or the local computer when `deviceId` is null. */
export function computerAgent(engine: CodeEngine, view: SubscriptionsView | undefined, deviceId: string | null, capabilities?: unknown): SubscriptionAgent | null {
  const computer = view?.computers.find((row) => (deviceId ? row.id === deviceId : row.local));
  const found = computer?.agents.find((row) => row.id === engine);
  if (found) return found;
  return parseSubscriptionAgents(record(capabilities)?.agents).find((row) => row.id === engine) ?? null;
}

/** Whether Ensemble on the computer runs the engine. A runtime without the `engines` list predates GitHub Copilot. */
export function computerRuns(engine: CodeEngine, capabilities: unknown): boolean {
  const listed = record(capabilities)?.engines;
  return Array.isArray(listed) ? listed.includes(engine) : engine !== "copilot-cli";
}

export type EngineModel = {
  /** The model that runs: the one chosen, else the agent's default. Null when the agent did not list it. */
  model: SubscriptionModel | null;
  /** Thinking levels it takes, lowest first. */
  efforts: EffortLevel[];
  /** The level it uses when none is chosen. */
  defaultEffort: EffortLevel | null;
  /** Context windows to choose from. Empty when the model has one size. */
  contexts: ModelContext[];
};

/** `chosen`: a model id, or empty for the agent's default. */
export function engineModel(agent: SubscriptionAgent | null, chosen: string): EngineModel {
  const models = agent?.models ?? [];
  const id = chosen.trim();
  const model = (id ? models.find((row) => row.id === id) : models.find((row) => row.isDefault)) ?? null;
  return {
    model,
    efforts: model ? orderLevels(model.efforts ?? agent?.efforts ?? []) : [],
    defaultEffort: model?.defaultEffort ? (orderLevels([model.defaultEffort])[0] ?? null) : null,
    contexts: model?.contexts && model.contexts.length > 1 ? model.contexts : [],
  };
}

/** A thinking level or context window the model does not take goes back to its default. */
export function fitEngineChoice(view: EngineModel, effort: ReasoningEffort, context: ContextTier | undefined): { effort: ReasoningEffort; context: ContextTier | undefined } {
  return {
    effort: effort !== "default" && (view.efforts as string[]).includes(effort) ? effort : "default",
    context: context === "long_context" && view.contexts.some((row) => row.id === context) ? context : undefined,
  };
}

/**
 * What Assign sends for a coding agent. GitHub Copilot also gets a thinking level and a context
 * window. With `view` (the model as the computer listed it) only ones that model offers are sent;
 * without it (Quick assign), the saved choice is sent and Copilot's runner checks it.
 */
export function engineAssign(
  engine: CodeEngine,
  choice: { model: string; effort: string; context?: ContextTier | null },
  view?: EngineModel,
): Pick<AssignInput, "engine" | "model" | "reasoningEffort" | "contextTier"> {
  const model = choice.model.trim();
  const base = { engine, ...(model ? { model } : {}) };
  if (engine !== "copilot-cli") return base;
  const effort = choice.effort !== "default" && (!view || (view.efforts as string[]).includes(choice.effort)) ? choice.effort : null;
  const context = view ? (view.contexts.length ? (view.contexts.some((row) => row.id === choice.context) ? choice.context! : "default") : null) : (choice.context ?? null);
  return { ...base, ...(effort ? { reasoningEffort: effort } : {}), ...(context ? { contextTier: context } : {}) };
}

export function effortName(level: string): string {
  return EFFORT_LABEL[level as EffortLevel] ?? level;
}

const CONTEXT_NAME: Record<ContextTier, string> = { default: "Standard", long_context: "Long context" };

/** "Long context · 922K (long context)" */
export function contextChoice(context: ModelContext): string {
  return `${CONTEXT_NAME[context.id]} · ${context.label}`;
}

function tokenSize(tokens: number): string {
  return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.round(tokens / 1000)}K`;
}

/** "200K or 922K context", or "136K context" for one size. */
export function contextSizes(contexts: readonly ModelContext[] | undefined): string {
  if (!contexts?.length) return "";
  const sizes = contexts.map((row) => (row.tokens ? tokenSize(row.tokens) : row.label));
  return `${sizes.length > 1 ? `${sizes.slice(0, -1).join(", ")} or ${sizes[sizes.length - 1]}` : sizes[0]} context`;
}

/** One line about a model, from what its agent reported: "OpenAI · low cost · 200K or 922K context". */
export function modelFacts(model: SubscriptionModel | null): string {
  if (!model) return "";
  return [model.description, model.cost, contextSizes(model.contexts)].filter(Boolean).join(" · ");
}
