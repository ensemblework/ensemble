/**
 * Model calls. Hosted Ensemble posts them to the Python runtime.
 * The desktop sidecar runs the same calls in this process (ENSEMBLE_INPROCESS_RUNTIME,
 * on by default when ENSEMBLE_DESKTOP=1). Keys stay out of the web UI either way.
 */
import type { Settings } from "@ensemble/shared-types";
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

export { RuntimeError };

export async function runtime<T>(path: string, init: RequestInit & { json?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const url = new URL(path, "http://runtime.local");
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
      const detail = error instanceof Error ? error.message : String(error);
      throw new RuntimeError(detail, 502);
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
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuntimeError(`The model runtime is not running. Start it with pnpm dev (or pnpm dev:agent). ${detail}`, 503, true);
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
      reasoningEffort: tier.effort !== "default" ? tier.effort : undefined,
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
