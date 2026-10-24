/**
 * Where a local job came from. A task claimed from Ensemble on the web is a
 * normal local job (doc 25 §2) whose `context` names the hosted job.
 */
export type JobOrigin = "local" | "web";

/** Prisma stores this on `WorkspaceJob.context`, which needs a string index. */
export type WebOrigin = {
  origin: "web";
  hostedJobId: string;
  [key: string]: string;
};

export function webContext(hostedJobId: string): WebOrigin {
  return { origin: "web", hostedJobId };
}

export function jobOrigin(context: unknown): JobOrigin {
  return typeof context === "object" && context !== null && (context as { origin?: unknown }).origin === "web" ? "web" : "local";
}

export function hostedJobIdOf(context: unknown): string | null {
  if (jobOrigin(context) !== "web") return null;
  const id = (context as { hostedJobId?: unknown }).hostedJobId;
  return typeof id === "string" ? id : null;
}
