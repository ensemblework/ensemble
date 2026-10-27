import { hasModule, type OptionalModule } from "@ensemble/shared-types/modules";

/** Queue and history keep their API permissions but share the Runs destination. */
export function runsModule(modules: string | null | undefined): OptionalModule {
  return hasModule(modules, "runs") ? "runs" : hasModule(modules, "workspace") ? "workspace" : "runs";
}
