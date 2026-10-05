/** The abort reason when the app quits. The job ends `interrupted`, never `cancelled`. */
export const SHUTDOWN = "ensemble-shutdown";

export const INTERRUPTED_MESSAGE =
  "Interrupted: Ensemble quit while this was running. Its folder and partial work are kept. Use Run again to start it again.";

/** An abort reason that ends the job `interrupted` with this message, like a quit. */
export class Interruption {
  constructor(readonly message: string) {}
}

export function abortedByShutdown(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === SHUTDOWN;
}

export function interruptionMessage(signal: AbortSignal): string | null {
  if (!signal.aborted) return null;
  if (signal.reason === SHUTDOWN) return INTERRUPTED_MESSAGE;
  if (signal.reason instanceof Interruption) return signal.reason.message;
  return null;
}
