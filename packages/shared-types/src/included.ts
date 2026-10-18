/**
 * Included AI: four models the operator deploys on Azure AI Foundry and pays for. Each account
 * spends a monthly allowance of Ensemble credits on them; people see credits, never dollars.
 * Prices and the dollar ledger live in hub-api only (src/included). docs/33.
 */

/** The provider id a tier stores when it uses an included model. */
export const INCLUDED_PROVIDER = "ensemble" as const;
export const INCLUDED_LABEL = "Included with Ensemble";
/** How an answer paid from included credits names where it came from (the assistant's reply footer). */
export const INCLUDED_SOURCE = "Ensemble included";

/** Monthly credits per account when ENSEMBLE_INCLUDED_MONTHLY_CREDITS is unset. */
export const DEFAULT_MONTHLY_CREDITS = 20_000;

/**
 * The reply-length cap sent on every included call when ENSEMBLE_INCLUDED_MAX_OUTPUT_TOKENS is
 * unset. Reasoning tokens count against it, it bounds the reservation each call holds against the
 * monthly budgets, and Azure counts it against the deployment's tokens-per-minute quota when a
 * request starts. The context window is Azure's default.
 */
export const INCLUDED_DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

/** The thinking levels offered on included models. "default" (Auto) sends none. */
export const INCLUDED_EFFORTS = ["low", "medium", "high"] as const;
export type IncludedEffort = (typeof INCLUDED_EFFORTS)[number];

/**
 * How a deployment is called. responses: the OpenAI v1 Responses API. chat: the OpenAI v1 Chat
 * Completions API. anthropic: Foundry's Anthropic Messages endpoint (no Claude model is offered:
 * Azure credits cannot pay for Claude, which Azure sells through the Marketplace).
 */
export type IncludedApi = "responses" | "chat" | "anthropic";

/** Which host of the Foundry resource answers: {resource}.openai.azure.com or {resource}.services.ai.azure.com. */
export type IncludedHost = "openai" | "services";

export type IncludedModel = {
  /** The model id. It is also the Azure deployment name. */
  id: string;
  /** Name with its version, as people see it. */
  label: string;
  vendor: "OpenAI" | "DeepSeek" | "xAI" | "Anthropic";
  api: IncludedApi;
  host: IncludedHost;
  /** The model version Azure lists for the deployment, where it is a dated release. */
  azureVersion: string | null;
  /** The thinking levels the model takes, lowest first. Empty: the model decides (Auto only). */
  efforts: readonly IncludedEffort[];
  /** The level the model uses when Auto is chosen (its documented default), if it has levels. */
  autoEffort: IncludedEffort | null;
  /** Cost of a typical turn next to GPT-6 Luna. */
  relativeCost: number;
  role: "everyday" | "step-up";
  /** Offered when ENSEMBLE_INCLUDED_MODELS is unset. The others are offered only when it names them. */
  offeredByDefault: boolean;
};

/**
 * Checked 17 Oct 2026 against Azure's model list and price meters (Global Standard, pay per token).
 * All are sold and billed by Microsoft, so Azure credits pay for them. The last two are for testing on
 * an Azure free account, whose quota tier gives no tokens to the first four (Microsoft's "Tier 0":
 * gpt-5-mini 500K and gpt-4.1-mini 200K tokens a minute).
 */
export const INCLUDED_MODELS: readonly IncludedModel[] = [
  { id: "gpt-6-luna", label: "GPT-6 Luna", vendor: "OpenAI", api: "responses", host: "openai", azureVersion: "2026-09-22", efforts: INCLUDED_EFFORTS, autoEffort: "medium", relativeCost: 1, role: "everyday", offeredByDefault: true },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", vendor: "DeepSeek", api: "chat", host: "services", azureVersion: null, efforts: [], autoEffort: null, relativeCost: 2, role: "everyday", offeredByDefault: true },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", vendor: "OpenAI", api: "responses", host: "openai", azureVersion: "2026-09-29", efforts: INCLUDED_EFFORTS, autoEffort: "medium", relativeCost: 20, role: "step-up", offeredByDefault: true },
  { id: "grok-4.7", label: "Grok 4.7", vendor: "xAI", api: "responses", host: "services", azureVersion: null, efforts: INCLUDED_EFFORTS, autoEffort: "high", relativeCost: 20, role: "step-up", offeredByDefault: true },
  { id: "gpt-5-mini", label: "GPT-5 mini", vendor: "OpenAI", api: "responses", host: "openai", azureVersion: "2025-08-07", efforts: INCLUDED_EFFORTS, autoEffort: "medium", relativeCost: 3, role: "everyday", offeredByDefault: false },
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini", vendor: "OpenAI", api: "responses", host: "openai", azureVersion: "2025-04-14", efforts: [], autoEffort: null, relativeCost: 4, role: "everyday", offeredByDefault: false },
];

export function includedModel(id: string | null | undefined): IncludedModel | null {
  return INCLUDED_MODELS.find((model) => model.id === id) ?? null;
}

/** "Grok 4.7" or "GPT-6 Luna (2026-09-22)". */
export function includedModelName(id: string): string {
  const model = includedModel(id);
  if (!model) return id;
  return model.azureVersion ? `${model.label} (${model.azureVersion})` : model.label;
}

/** The calendar month a call counts against, in UTC: "2026-10". */
export function includedPeriod(at: Date = new Date()): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Credits reset at 00:00 UTC on the 1st of the next month. */
export function includedResetsAt(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

/** This account's monthly credits are used up. */
export const INCLUDED_CREDITS_USED = "included_credits_used" as const;
/** The operator's monthly budget for everyone is used up: every included call stops. */
export const INCLUDED_PAUSED = "included_paused" as const;
/** Included models are not set up on this server, or are switched off. */
export const INCLUDED_UNAVAILABLE = "included_unavailable" as const;
/**
 * The desktop app or the CLI is local only: not connected to an Ensemble account, so it has no
 * credits to spend. Included models run on Ensemble's server, for a connected computer only.
 */
export const INCLUDED_LOCAL_ONLY = "included_local_only" as const;
export type IncludedErrorCode = typeof INCLUDED_CREDITS_USED | typeof INCLUDED_PAUSED | typeof INCLUDED_UNAVAILABLE | typeof INCLUDED_LOCAL_ONLY;

export function isIncludedErrorCode(value: unknown): value is IncludedErrorCode {
  return value === INCLUDED_CREDITS_USED || value === INCLUDED_PAUSED || value === INCLUDED_UNAVAILABLE || value === INCLUDED_LOCAL_ONLY;
}

/** Where a local-only desktop app connects to an Ensemble account (Settings → Account → This computer). */
export const CONNECT_COMPUTER_HREF = "/settings?tab=account#this-mac";

export type IncludedErrorBody = {
  code: IncludedErrorCode;
  error: string;
  message: string;
  /** When the credits or the shared budget reset. Null for INCLUDED_UNAVAILABLE and INCLUDED_LOCAL_ONLY. */
  resetsAt: string | null;
  status: 403 | 429 | 503;
};

export type IncludedUsageRow = {
  calls: number;
  /** Every input token: new, read from the prompt cache, and written to it. */
  inputTokens: number;
  /** The part of inputTokens read from the prompt cache, which costs less. */
  cachedTokens: number;
  outputTokens: number;
  inputCredits: number;
  outputCredits: number;
  credits: number;
};

/** GET /api/metrics/credits: this account's included credits for the current month. */
export type IncludedUsage = {
  /** False when the operator has not set up included models. The rest is then empty. */
  available: boolean;
  /** A desktop app or CLI not connected to an Ensemble account: it has no credits to show. */
  localOnly?: boolean;
  models: Array<Pick<IncludedModel, "id" | "label" | "vendor" | "azureVersion" | "efforts" | "autoEffort" | "relativeCost" | "role">>;
  period: string;
  resetsAt: string;
  limit: number;
  used: number;
  remaining: number;
  /** The shared monthly budget is used up: included calls stop for everyone until resetsAt. */
  paused: boolean;
  totals: IncludedUsageRow;
  byModel: Array<IncludedUsageRow & { model: string; label: string }>;
  byPurpose: Array<{ purpose: string; calls: number; credits: number }>;
  days: Array<{ day: string; credits: number; calls: number }>;
};
