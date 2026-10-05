/**
 * What the Mac accepts from Ensemble on the web (doc 25 §5, §6). The server is
 * untrusted input: these checks run here whatever it sent, and they only ever
 * narrow what a local assignment could do.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { redactText } from "../lib/redact.js";
import type { AssignInput } from "../workspace/assign.js";
import { OUTSIDE_TOOL } from "../workspace/tools.js";
import type { HostedAnswer, JobSpec } from "./contract.js";
import { GIT_GATE_CLONE, GIT_GATE_CODE } from "./origin.js";
import type { RemoteSettings, SharedFolder } from "./store.js";

export { GIT_GATE_CLONE, GIT_GATE_CODE, GIT_GATE_PUSH } from "./origin.js";

export type Refusal = { code: string; message: string };

export type LocalPlan = {
  title: string;
  description: string;
  assign: Omit<AssignInput, "taskId">;
  /** An https URL the Mac must confirm is public (cloned without any credential) before the job is created. */
  publicCheck: string | null;
};

export function sharedFolder(settings: RemoteSettings, label: string): SharedFolder | null {
  return settings.folders.find((row) => row.label === label) ?? null;
}

/** Labels, kinds and access only. Never a path (§4.2, §12). */
export function publishedFolders(settings: RemoteSettings) {
  return settings.folders.map((row) => ({ label: row.label, kind: row.kind, access: row.access }));
}

function httpsRepo(value: string): string | null {
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return `https://github.com/${value}.git`;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    if (!/^[\w.@:/~-]+$/.test(url.pathname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The hosted spec as a local assignment, or the reason the Mac refuses it.
 * `continueFrom` maps a hosted job id to the local job that ran it, when this
 * Mac ran it.
 */
export function planLocalJob(spec: JobSpec, settings: RemoteSettings, continueFrom: (hostedId: string) => string | null): LocalPlan | Refusal {
  const title = (spec.task?.title ?? spec.title ?? "").trim() || "Task from Ensemble on the web";
  const description = (spec.task?.description ?? "").trim();
  if (spec.useCredentials) return { code: GIT_GATE_CODE, message: GIT_GATE_CLONE };
  if ((spec.branchMode && spec.branchMode !== "as-is") || spec.branch?.trim()) {
    return {
      code: "BRANCH_NOT_ALLOWED",
      message: "A remote task works only on its own run branch (ensemble/<run-id>/…). Another branch can be chosen on the Mac.",
    };
  }
  // `networkAccess` on the claim is the server's setting. It is not copied.
  // Omitting `network` makes createJob use this Mac's orchestration.sandboxNetwork.
  // Trust stays "none": a label from the web is not a trust grant. Unattended is
  // the claim's flag, then doc 25 §6 checks it against trust that already exists here.
  const assign: LocalPlan["assign"] = {
    kind: spec.kind,
    instructions: (spec.instructions ?? "").slice(0, 8000),
    branchMode: "as-is",
    delivery: spec.delivery,
    askBeforePublish: true,
    useCredentials: false,
    sandbox: true,
    markDone: true,
    unattended: spec.unattended,
    trust: "none",
    ...(spec.model?.trim() ? { model: spec.model.trim() } : {}),
    ...(spec.provider?.trim() ? { provider: spec.provider.trim() } : {}),
    ...(spec.reasoningEffort?.trim() ? { reasoningEffort: spec.reasoningEffort.trim() } : {}),
  };
  let publicCheck: string | null = null;
  const label = (spec.folderLabel ?? spec.folder ?? "").trim();
  if (spec.kind === "code") {
    const previous = spec.continueFromJobId ? continueFrom(spec.continueFromJobId) : null;
    if (previous) {
      assign.continueFromJobId = previous;
    } else if (label) {
      const shared = sharedFolder(settings, label);
      if (!shared) return { code: "UNKNOWN_FOLDER", message: `This Mac has not shared a folder called “${label.slice(0, 60)}”. Add it on the Mac first.` };
      if (shared.kind === "repo") {
        assign.repoUrl = shared.path;
      } else {
        assign.folder = shared.path;
        assign.accessMode = shared.access === "review" || spec.accessMode === "review" ? "review" : "read-write";
      }
    } else if (spec.repoUrl?.trim()) {
      const value = spec.repoUrl.trim();
      if (value.startsWith("git@") || value.startsWith("ssh:")) return { code: GIT_GATE_CODE, message: GIT_GATE_CLONE };
      const url = httpsRepo(value);
      if (!url) return { code: "REPO_NOT_ALLOWED", message: "A remote task names a public https repository or a folder shared on the Mac, not a path." };
      assign.repoUrl = url;
      publicCheck = url;
    }
  }
  return { title, description, assign, publicCheck };
}

export function isRefusal(value: LocalPlan | Refusal): value is Refusal {
  return "code" in value;
}

export type LocalDecision = {
  id: string;
  event: string;
  toolName: string;
  title: string;
  detail: unknown;
  status: string;
};

const detailOf = (row: LocalDecision) => (typeof row.detail === "object" && row.detail !== null ? (row.detail as Record<string, unknown>) : {});

export function decisionOptions(row: LocalDecision): string[] {
  const options = detailOf(row).options;
  return Array.isArray(options) ? options.filter((item): item is string => typeof item === "string") : [];
}

/** What the phone answer is bound to: this local question, this tool, this command. */
export function actionHash(row: LocalDecision): string {
  const command = detailOf(row).command;
  return createHash("sha256")
    .update(JSON.stringify([row.id, row.event, row.toolName, row.title, typeof command === "string" ? command : null, decisionOptions(row)]))
    .digest("hex");
}

/**
 * The tier is decided here, when the Mac asks (§5.1, §12). High risk is a
 * push the §5.1 setting does not cover, a path outside the folder, or a new
 * grant of trust. A phone Yes does not answer those.
 */
export function riskOf(row: LocalDecision, input: { runBranchPush: boolean; ownRunBranch: boolean; trusted: boolean; pushTargetLocal: boolean }): "ordinary" | "high" {
  if (row.toolName === "git push") return input.runBranchPush && input.ownRunBranch && input.trusted && input.pushTargetLocal ? "ordinary" : "high";
  if (row.toolName === OUTSIDE_TOOL) return "high";
  if (decisionOptions(row).some((option) => /trust/i.test(option))) return "high";
  return "ordinary";
}

export type AnswerVerdict =
  | { kind: "wait" }
  | { kind: "stop"; why: string }
  | { kind: "apply"; decision: "allow" | "deny"; reason: string | null }
  | { kind: "refuse"; why: string };

/**
 * A hosted answer is applied only to the question the Mac asked: the same
 * hosted id, the same action, still pending here, scope once, and a tier a
 * phone may answer. First answer wins, on the Mac or the phone.
 */
export function judgeAnswer(input: { askedId: string; hash: string; risk: "ordinary" | "high"; local: LocalDecision | null; answer: HostedAnswer }): AnswerVerdict {
  const { answer, local } = input;
  if (!local || local.status !== "pending") return { kind: "stop", why: "answered on the Mac" };
  if (answer.id && answer.id !== input.askedId) return { kind: "refuse", why: "The answer was for a different question." };
  if (answer.status === "pending") return { kind: "wait" };
  if (answer.status === "expired") return { kind: "stop", why: "expired on the web" };
  if (!answer.decision) return { kind: "refuse", why: "The answer had no allow or deny." };
  if (answer.actionHash && answer.actionHash !== input.hash) return { kind: "refuse", why: "The answer was for a different action." };
  if (answer.scope && answer.scope !== "once") return { kind: "refuse", why: `A remote answer is for this question only, not “${answer.scope}”.` };
  if (answer.decision === "deny") return { kind: "apply", decision: "deny", reason: null };
  if (input.risk === "high") return { kind: "refuse", why: "This needs a confirmation on the Mac." };
  if (local.event !== "question") return { kind: "apply", decision: "allow", reason: null };
  const options = decisionOptions(local);
  const custom = detailOf(local).allowCustom === true;
  const reason = answer.reason?.slice(0, 500) ?? null;
  if (reason !== null && options.length && !custom && !options.includes(reason)) return { kind: "refuse", why: "The answer was not one of the choices the Mac offered." };
  return { kind: "apply", decision: "allow", reason };
}

const HOME = homedir();

/** Outgoing text: known secret shapes removed, the home folder shortened. */
export function scrubOutgoing(value: string): string {
  const shortened = HOME && HOME !== "/" ? value.split(HOME).join("~") : value;
  return redactText(shortened);
}
