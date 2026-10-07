import { z } from "zod";
import {
  Actor,
  ApprovalDecision,
  ApprovalKind,
  AutonomyLevel,
  ComplexitySource,
  Priority,
  RunOutcome,
  StepStatus,
  TaskComplexity,
  TaskOwner,
  TaskSource,
  TaskStatus,
} from "./enums.js";

export const PageMention = z.object({
  kind: z.enum(["people", "project", "repo", "task", "deliverable", "skill", "diagram", "plot", "dataset", "date"]),
  id: z.string(),
  label: z.string(),
});
export type PageMention = z.infer<typeof PageMention>;

export type PageNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PageNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
};

export const PageNode: z.ZodType<PageNode> = z.object({
  type: z.string(),
  attrs: z.record(z.unknown()).optional(),
  content: z.array(z.lazy(() => PageNode)).optional(),
  text: z.string().optional(),
  marks: z.array(z.object({ type: z.string(), attrs: z.record(z.unknown()).optional() })).optional(),
});

export const PageDocument = z.object({
  type: z.literal("doc"),
  content: z.array(PageNode).default([]),
});
export type PageDocument = z.infer<typeof PageDocument>;

export const EMPTY_PAGE: PageDocument = { type: "doc", content: [{ type: "paragraph" }] };

export const PageAnnotation = z.object({
  id: z.string(),
  kind: z.string(),
  from: z.number().optional(),
  to: z.number().optional(),
  data: z.record(z.unknown()).optional(),
});
export type PageAnnotation = z.infer<typeof PageAnnotation>;

export const TaskPageContent = z.object({
  taskId: z.string(),
  revision: z.number(),
  content: PageDocument.nullable(),
  notes: z.string(),
  annotations: z.array(PageAnnotation),
  mentions: z.array(PageMention),
  notesChangedExternally: z.boolean(),
  updatedAt: z.string().nullable(),
});
export type TaskPageContent = z.infer<typeof TaskPageContent>;

export const SaveTaskPage = z.object({
  revision: z.number(),
  content: PageDocument,
  notes: z.string().optional(),
  annotations: z.array(PageAnnotation).optional(),
});
export type SaveTaskPage = z.infer<typeof SaveTaskPage>;

export const TaskDto = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  notes: z.string(),
  boardOrder: z.number(),
  todayFocus: z.string(),
  skillIds: z.array(z.string()),
  sourceKind: TaskSource,
  sourceRef: z.string(),
  sourceUrl: z.string().nullable(),
  excerpt: z.string().nullable(),
  owner: TaskOwner,
  status: TaskStatus,
  priority: Priority,
  complexity: TaskComplexity,
  complexitySource: ComplexitySource,
  autonomy: AutonomyLevel,
  due: z.string().nullable(),
  projectId: z.string().nullable(),
  repoId: z.string().nullable(),
  deliverableId: z.string().nullable(),
  people: z.array(z.string()),
  taskType: z.string().nullable(),
  snoozedUntil: z.string().nullable(),
  blockedQuestion: z.unknown().nullable(),
  createdBy: Actor,
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskDto = z.infer<typeof TaskDto>;

export const CreateTask = z.object({
  title: z.string().trim().min(1, "Enter a task title."),
  description: z.string().optional(),
  notes: z.string().optional(),
  owner: TaskOwner.optional(),
  status: TaskStatus.optional(),
  priority: Priority.optional(),
  complexity: TaskComplexity.optional(),
  due: z.string().datetime().nullable().optional(),
  projectId: z.string().nullable().optional(),
  people: z.array(z.string()).optional(),
  sourceKind: TaskSource.optional(),
  todayFocus: z.enum(["auto", "keep", "hidden"]).optional(),
  taskType: z
    .string()
    .max(24)
    .regex(/^[\w .'-]*$/, "taskType has an unsupported character")
    .nullable()
    .optional(),
  measure: z.number().int().min(0).max(100000).nullable().optional(),
});
export type CreateTask = z.infer<typeof CreateTask>;

export const PatchTask = CreateTask.partial().extend({
  todayFocus: z.enum(["auto", "keep", "hidden"]).optional(),
  boardOrder: z.number().optional(),
  snoozedUntil: z.string().datetime().nullable().optional(),
  repoId: z.string().nullable().optional(),
  deliverableId: z.string().nullable().optional(),
  skillIds: z.array(z.string()).optional(),
});
export type PatchTask = z.infer<typeof PatchTask>;

export const ApprovalDto = z.object({
  id: z.string(),
  runId: z.string(),
  taskId: z.string().nullable(),
  kind: ApprovalKind,
  title: z.string(),
  preview: z.unknown(),
  decision: ApprovalDecision.nullable(),
  requestedAt: z.string(),
});
export type ApprovalDto = z.infer<typeof ApprovalDto>;

export const PlanStepDto = z.object({
  id: z.string(),
  title: z.string(),
  status: StepStatus,
  toolCalls: z.unknown(),
});
export type PlanStepDto = z.infer<typeof PlanStepDto>;

export const RunDto = z.object({
  id: z.string(),
  taskId: z.string(),
  worker: z.string(),
  outcome: RunOutcome.nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});
export type RunDto = z.infer<typeof RunDto>;

export const UNDO_DEPTH = 50;
export const UndoEntryKind = z.enum(["create", "update", "delete", "batch"]);
export type UndoEntryKind = z.infer<typeof UndoEntryKind>;
