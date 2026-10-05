/**
 * The error the HTTP layer shows to the engineer.
 * Kept in its own module so model errors can extend it without importing the runtime client
 * (that client loads the in-process model adapters, which load these errors).
 */
export class RuntimeError extends Error {
  /** The message is written for the engineer, so the error handler shows it. */
  readonly expose = true;
  constructor(
    message: string,
    public readonly statusCode = 502,
    /** True when hosted hub-api could not reach the Python runtime at all. */
    public readonly unreachable = false,
  ) {
    super(message);
  }
}
