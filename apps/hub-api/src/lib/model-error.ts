/** User-facing sentences for model failures. The browser shows these, not vendor JSON. */

export interface ModelFailure {
  status: number;
  kind: "rate_limit" | "quota" | "unavailable" | "auth" | "not_found" | "invalid" | "other";
  message: string;
  quotaId?: string;
  retryAfterSeconds?: number;
}

export function parseRuntimeBody(status: number, raw: string): ModelFailure {
  let message = raw.trim().slice(0, 800);
  let kind: ModelFailure["kind"] = status === 429 ? "rate_limit" : status === 404 ? "not_found" : status === 503 ? "unavailable" : status === 401 || status === 403 ? "auth" : "other";
  let quotaId: string | undefined;
  let retryAfterSeconds: number | undefined;
  try {
    const body = JSON.parse(raw) as { detail?: unknown; error?: unknown; message?: unknown };
    const detail = body.detail ?? body.error ?? body.message;
    if (typeof detail === "string" && detail.trim()) message = detail.trim();
    if (detail && typeof detail === "object") {
      const record = detail as { message?: unknown; kind?: unknown; quotaId?: unknown; retryAfterSeconds?: unknown };
      if (typeof record.message === "string" && record.message.trim()) message = record.message.trim();
      if (typeof record.kind === "string") kind = record.kind as ModelFailure["kind"];
      if (typeof record.quotaId === "string") quotaId = record.quotaId;
      if (typeof record.retryAfterSeconds === "number") retryAfterSeconds = record.retryAfterSeconds;
    }
  } catch {
    // not JSON
  }
  const statusMatch = message.match(/status=(\d+)/);
  const kindMatch = message.match(/kind=([a-z_]+)/);
  const retryMatch = message.match(/retryAfter=(\d+(?:\.\d+)?)/);
  const quotaMatch = message.match(/quotaId=(\S+)/);
  if (statusMatch) status = Number(statusMatch[1]);
  if (kindMatch) kind = kindMatch[1] as ModelFailure["kind"];
  if (retryMatch) retryAfterSeconds = Number(retryMatch[1]);
  if (quotaMatch) quotaId = quotaMatch[1];
  if (message.startsWith("status=")) {
    const tail = message.split(" ").slice(3).join(" ");
    if (tail) message = tail;
  }
  if (status === 429 && kind !== "quota" && /resource_exhausted|resource exhausted/i.test(`${message} ${raw}`)) {
    kind = "quota";
  }
  return { status, kind, message, quotaId, retryAfterSeconds };
}

export function friendlyModelError(failure: ModelFailure): string {
  const wait = failure.retryAfterSeconds != null ? Math.max(1, Math.round(failure.retryAfterSeconds)) : null;
  if (failure.kind === "auth" || /no key for/i.test(failure.message)) {
    return failure.message.includes("No key")
      ? failure.message
      : failure.message.includes("can't be decrypted")
        ? failure.message
        : failure.message || "The model key was rejected. Check it in Settings → Models.";
  }
  if (failure.kind === "rate_limit") {
    const quota = failure.quotaId ? ` (${failure.quotaId})` : "";
    return wait
      ? `Gemini is rate-limiting this key${quota}. Wait about ${wait}s and try again.`
      : `Gemini is rate-limiting this key${quota}. Wait a moment and try again.`;
  }
  if (failure.kind === "quota") {
    return failure.quotaId
      ? `This key is out of quota for that model (${failure.quotaId}).`
      : "This key is out of quota for that model.";
  }
  if (failure.kind === "unavailable") {
    if (/cursor runs delegated|not a completion provider|not a chat provider/i.test(failure.message)) return failure.message;
    return "Gemini is under high demand for this model. Try again, or switch the tier to a model this key can use.";
  }
  if (failure.kind === "not_found") return "That model is not available to this key.";
  if (failure.kind === "invalid" || failure.status === 400) {
    if (/invalid argument|INVALID_ARGUMENT|^\s*\{/.test(failure.message)) {
      return "The model rejected that request. Nothing was changed.";
    }
    return failure.message || "The model rejected that request.";
  }
  if (/^no key for/i.test(failure.message)) return failure.message;
  return failure.message || "The model request failed.";
}
