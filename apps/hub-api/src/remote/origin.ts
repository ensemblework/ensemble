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

/** Until the Git gate lands (doc 25 §0), a remote task gets no credential: no private clone, no hosted push. */
export const GIT_GATE_CODE = "GIT_GATE_REQUIRED";
export const GIT_GATE_CLONE =
  "This Mac does not clone private repositories for remote tasks yet. That needs the Git gate (desktop steps 2 and 4), which is not in this build. Use a public repository or a folder you shared on the Mac.";
export const GIT_GATE_PUSH =
  "This Mac does not push remote tasks to a hosted repository yet. That needs the Git gate (desktop steps 2 and 4), which is not in this build. The commits stay on the run branch on this Mac.";

