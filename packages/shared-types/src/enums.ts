import { z } from "zod";

export const TaskSource = z.enum([
  "email",
  "teams",
  "slack",
  "meeting",
  "github",
  "manual",
  "notion",
  "linear",
  "other",
]);
export const TaskOwner = z.enum(["me", "agent", "unassigned"]);
export const TaskStatus = z.enum([
  "proposed",
  "todo",
  "in_progress",
  "waiting_approval",
  "blocked",
  "done",
  "dropped",
]);
export const Priority = z.enum(["p0", "p1", "p2"]);
export const TaskComplexity = z.enum(["easy", "medium", "high", "max"]);
export const ComplexitySource = z.enum(["agent", "me", "default"]);
export const Actor = z.enum(["agent", "me", "system"]);
export const StepStatus = z.enum([
  "pending",
  "running",
  "done",
  "failed",
  "needs_approval",
  "skipped",
]);
export const RunOutcome = z.enum([
  "success",
  "failed",
  "cancelled",
  "needs_info",
  "waiting_approval",
]);
export const ApprovalKind = z.enum(["send_email", "open_pr", "post_teams", "other"]);
export const ApprovalDecision = z.enum(["approved", "edited", "rejected"]);
export const AutonomyLevel = z.enum(["assist", "supervised", "autonomous"]);
export const ArtifactKind = z.enum([
  "email",
  "chat_msg",
  "channel_msg",
  "event",
  "transcript",
  "transcript_segment",
  "file",
  "pr",
  "pr_comment",
  "commit",
  "issue",
  "meeting_note",
]);
export const RepoProvider = z.enum(["github", "other"]);
export const ProjectStatus = z.enum(["active", "done"]);
export const DeliverableStatus = z.enum(["upcoming", "completed"]);
export const TodayFocus = z.enum(["auto", "keep", "hidden"]);
export const ModelRole = z.enum(["planner", "drafter", "classifier", "coder", "embedder"]);

export type TaskSource = z.infer<typeof TaskSource>;
export type TaskOwner = z.infer<typeof TaskOwner>;
export type TaskStatus = z.infer<typeof TaskStatus>;
export type Priority = z.infer<typeof Priority>;
export type TaskComplexity = z.infer<typeof TaskComplexity>;
export type ComplexitySource = z.infer<typeof ComplexitySource>;
export type Actor = z.infer<typeof Actor>;
export type StepStatus = z.infer<typeof StepStatus>;
export type RunOutcome = z.infer<typeof RunOutcome>;
export type ApprovalKind = z.infer<typeof ApprovalKind>;
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;
export type ArtifactKind = z.infer<typeof ArtifactKind>;
export type RepoProvider = z.infer<typeof RepoProvider>;
export type ProjectStatus = z.infer<typeof ProjectStatus>;
export type DeliverableStatus = z.infer<typeof DeliverableStatus>;
export type TodayFocus = z.infer<typeof TodayFocus>;
export type ModelRole = z.infer<typeof ModelRole>;
