/**
 * Hosted Ensemble keeps the Python runtime on AGENT_RUNTIME_URL.
 * The desktop sidecar answers the same calls in this process.
 *
 * ENSEMBLE_INPROCESS_RUNTIME=1 forces the TypeScript path.
 * ENSEMBLE_INPROCESS_RUNTIME=0 forces the Python HTTP path, including on desktop.
 * When the variable is unset, desktop (ENSEMBLE_DESKTOP=1) is in-process.
 */
export function useInProcessRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.ENSEMBLE_INPROCESS_RUNTIME?.trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return true;
  if (flag === "0" || flag === "false" || flag === "no") return false;
  return env.ENSEMBLE_DESKTOP === "1";
}
