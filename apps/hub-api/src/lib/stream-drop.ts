/**
 * A dropped model connection is not a finished answer and not a user Stop.
 * The raw socket error ("terminated", "peer closed connection") must not be saved as the reply.
 * A host that was never reached is a model_unreachable error, not this notice.
 */
import { classifyConnectFailure, isUnreachableNotice, ModelUnreachableError, transportFailure } from "./model-reach.js";

export const CONNECTION_DROPPED_NOTICE = "The connection to the model dropped before it replied. Try again.";

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** The plain notice shown when the connection dies before any assistant text. Not a model reply. */
export function isNonModelNotice(content: string): boolean {
  const text = content.trim();
  return text === CONNECTION_DROPPED_NOTICE || isUnreachableNotice(text);
}

export function isConnectionNotice(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.trim() === CONNECTION_DROPPED_NOTICE;
}

/**
 * A connection that was established and then died before any assistant text.
 * Connection refused, DNS failure, and a down Ollama are not drops: those never connected.
 * User cancellation (AbortError) is not a transport drop. Quota is not a drop.
 */
export function isTransportDrop(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof ModelUnreachableError) return false;
  if (error instanceof Error && error.name === "ModelQuotaError") return false;
  if (isConnectionNotice(error)) return true;
  if (error instanceof Error && error.name === "ConnectionDropped") return true;
  return classifyConnectFailure(error) === "drop";
}

/** Turn a connect failure into a typed unreachable error, or a drop into the plain notice. */
export function normalizeTransportError(
  error: unknown,
  context: { provider: string; model: string; url: string },
): unknown {
  if (isAbortError(error)) return error;
  if (error instanceof ModelUnreachableError) return error;
  if (error instanceof Error && (error.name === "ConnectionDropped" || error.message.trim() === CONNECTION_DROPPED_NOTICE)) {
    return error;
  }
  const failure = transportFailure(error, context);
  if (failure) return failure;
  if (isTransportDrop(error)) {
    const dropped = new Error(CONNECTION_DROPPED_NOTICE);
    dropped.name = "ConnectionDropped";
    return dropped;
  }
  return error;
}
