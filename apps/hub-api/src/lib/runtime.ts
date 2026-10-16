import { ASSISTANT_UNAVAILABLE } from "@ensemble/shared-types";
/**
 * Model calls. Hosted Ensemble posts them to the Python runtime.
 * The desktop sidecar runs the same calls in this process (ENSEMBLE_INPROCESS_RUNTIME,
 * on by default when ENSEMBLE_DESKTOP=1). Keys stay out of the web UI either way.
 */
import { isSubscriptionProvider, type Settings } from "@ensemble/shared-types";
import { env } from "../config.js";
import { dispatchRuntime, DispatchError } from "../runtime/dispatch.js";
import { useInProcessRuntime } from "../runtime/mode.js";
import { isPaused } from "./activity.js";
import { recordMetric } from "./metrics.js";
import { redis } from "./redis.js";
import { estimateUsd } from "./pricing.js";
import { prisma } from "./prisma.js";
import { errorFromRuntimeBody } from "../runtime/errors.js";
import { truncateText } from "./text.js";
import { RuntimeError } from "./runtime-error.js";
import { requireHostAccess, requireVerifiedUser } from "./hosted-access.js";
import { keysFor } from "../sharing/context.js";
import { effortToSend } from "./model-meta.js";
import { jsonFrom, runSubscriptionTurn } from "../subscriptions/turn.js";

export { RuntimeError };

export async function runtime<T>(path: string, init: RequestInit & { json?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const url = new URL(path, "http://runtime.local");
  // The runtime reads userId only for model keys, pacing and host access: in a space shared
  // with you, those are yours, never the owner's.
  if (init.json && typeof init.json === "object" && "userId" in init.json && typeof init.json.userId === "string") {
    init = { ...init, json: { ...init.json, userId: keysFor(init.json.userId) } };
  }
  const queried = url.searchParams.get("userId");
  if (queried && keysFor(queried) !== queried) {
    url.searchParams.set("userId", keysFor(queried));
    path = `${url.pathname}${url.search}`;
  }
  const body = init.json && typeof init.json === "object" && "userId" in init.json ? init.json : null;
  const userId = body && typeof body.userId === "string" ? body.userId : url.searchParams.get("userId");
  if (["/api/complete", "/api/chat/tools", "/api/chat/tools/stream", "/api/search", "/api/models"].includes(url.pathname)) await requireVerifiedUser(userId);
  if (["/api/plots/run", "/api/plots/parse"].includes(url.pathname)) await requireHostAccess(userId, "Hosted Python");
  const { json, timeoutMs = 120_000, ...rest } = init;
  if (useInProcessRuntime()) {
    try {
      return (await dispatchRuntime(path, {
        method: rest.method,
        json,
        signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
      })) as T;
    } catch (error) {
      if (error instanceof DispatchError) throw new RuntimeError(error.message, error.statusCode);
      throw new RuntimeError(ASSISTANT_UNAVAILABLE, 503, true);
    }
  }
  let response: Response;
  try {
    response = await fetch(`${env.AGENT_RUNTIME_URL}${path}`, {
      ...rest,
      body: json === undefined ? rest.body : JSON.stringify(json),
      headers: {
        "Content-Type": "application/json",
        "x-ensemble-internal": env.ENSEMBLE_INTERNAL_TOKEN,
        ...(rest.headers ?? {}),
      },
      signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new RuntimeError(ASSISTANT_UNAVAILABLE, 503, true);
  }
  if (!response.ok) {
    const text = await response.text();
    const failure = errorFromRuntimeBody(response.status, text);
    throw new RuntimeError(failure.message, failure.statusCode);
  }
  return (await response.json()) as T;
}

export type Tier = keyof Pick<Settings["models"], "easy" | "medium" | "high" | "max">;

/** One completion on a complexity tier, for triage and extraction. */
export async function complete(args: {
  userId: string;
  settings: Settings;
  tier?: Tier;
  system?: string;
  prompt: string;
  json?: boolean;
  /** "triage" or "plan". The runtime skips JSON values that are not that shape. */
  jsonShape?: "triage" | "plan";
  purpose?: string;
}): Promise<{ text: string; json?: unknown; model: string; tokensIn: number | null; tokensOut: number | null }> {
  const tier = args.settings.models[args.tier ?? "easy"];
  if (await isPaused(redis, args.userId)) {
    throw new RuntimeError("The agent is paused. Resume it from the top bar to allow model calls.", 409);
  }
  if (isSubscriptionProvider(tier.provider)) return completeOnSubscription({ ...args, provider: tier.provider, model: tier.model, effort: tier.effort });
  const result = await runtime<{ text: string; json?: unknown; model: string; tokensIn: number | null; tokensOut: number | null }>("/api/complete", {
    method: "POST",
    json: {
      userId: args.userId,
      provider: tier.provider,
      model: tier.model,
      system: args.system,
      prompt: args.prompt,
      json: args.json ?? false,
      jsonShape: args.jsonShape,
      ollamaUrl: args.settings.models.ollamaUrl,
      reasoningEffort: await effortToSend(args.userId, tier.provider, tier.model, tier.effort),
    },
  });
  const model = result.model || tier.model;
  await recordMetric(prisma, {
    userId: args.userId,
    kind: "model.call",
    meta: {
      provider: tier.provider,
      model,
      purpose: args.purpose ?? "Other",
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      estimatedUsd: estimateUsd(model, result.tokensIn, result.tokensOut),
      title: truncateText(args.prompt, 80),
    },
  }).catch(() => undefined);
  return result;
}

/** The same completion on the person's own subscription (docs/30 §8): a turn with no tools. */
async function completeOnSubscription(args: Parameters<typeof complete>[0] & { provider: Parameters<typeof runSubscriptionTurn>[0]["agent"]; model: string; effort: string }): ReturnType<typeof complete> {
  const system = [
    args.system?.trim() || "Answer the request below directly.",
    args.json ? "Reply with one JSON value and nothing else: no prose, no code fence." : "",
    "You have no tools in this request. Answer from the text you are given.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const done = await runSubscriptionTurn({
    userId: args.userId,
    settings: args.settings,
    agent: args.provider,
    model: args.model,
    effort: args.effort,
    system,
    prompt: args.prompt,
    tools: [],
    maxTurns: 2,
    call: async () => ({ text: "There are no tools in this request.", isError: true }),
  });
  const json = args.json ? jsonFrom(done.text) : undefined;
  await recordMetric(prisma, {
    userId: args.userId,
    kind: "model.call",
    meta: { provider: args.provider, model: done.model || args.model, purpose: args.purpose ?? "Other", tokensIn: done.tokensIn, tokensOut: done.tokensOut, estimatedUsd: 0, computer: done.computer, title: truncateText(args.prompt, 80) },
  }).catch(() => undefined);
  return { text: done.text, ...(json === undefined ? {} : { json }), model: done.model || args.model, tokensIn: done.tokensIn, tokensOut: done.tokensOut };
}
