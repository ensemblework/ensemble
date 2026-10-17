import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { actorFor } from "../../sharing/context.js";
import { hasModule, OPTIONAL_MODULES, serializeModules } from "@ensemble/shared-types";
import { loadSettings } from "../../lib/settings.js";
import { AppRequestError } from "./apps-common.js";
import { defineTool, toolOk, type ToolContext } from "../types.js";

const Step = z.object({ id: z.string().regex(/^[a-z][a-z0-9_]{0,24}$/), tool: z.string().max(64), input: z.record(z.unknown()) });
const Input = z.object({ title: z.string().min(1).max(160), steps: z.array(Step).min(2).max(12) });
type Plan = z.infer<typeof Input>;
type Saved = { id: string; tool: string; state: "running" | "ok" | "failed"; data?: unknown; summary?: string; href?: string; error?: string };
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
}

export function resolveWorkflowRefs(value: unknown, results: Map<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map(item => resolveWorkflowRefs(item, results));
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length === 1 && typeof row.$ref === "string") {
    const [step, ...path] = row.$ref.split(".");
    let current = results.get(step!);
    for (const key of path) {
      if (["__proto__", "prototype", "constructor"].includes(key) || !current || typeof current !== "object" || !Object.hasOwn(current, key)) throw new Error(`No result at ${row.$ref}.`);
      current = (current as Record<string, unknown>)[key];
    }
    if (current === undefined) throw new Error(`No result at ${row.$ref}.`);
    return current;
  }
  return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, resolveWorkflowRefs(item, results)]));
}

function refs(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(refs);
  const row = value as Record<string, unknown>;
  if (typeof row.$ref === "string") { if (Object.keys(row).length !== 1) throw new Error("A $ref must be the only field in its object."); return [row.$ref]; }
  return Object.values(row).flatMap(refs);
}

function proposedStep(step: z.infer<typeof Step>, plan: Plan): string {
  const describe = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(describe).join(", ");
    if (value && typeof value === "object") {
      const row = value as Record<string, unknown>;
      if (typeof row.$ref === "string") {
        const source = plan.steps.find(item => item.id === row.$ref!.toString().split(".")[0]);
        const label = source?.input.name ?? source?.input.title ?? source?.id ?? "earlier action";
        return `“${String(label)}” from the earlier action`;
      }
      return Object.entries(row).map(([key, item]) => `${key.replace(/Ids?$/, "").replace(/([a-z])([A-Z])/g, "$1 $2")}: ${describe(item)}`).join("; ");
    }
    return String(value ?? "none").slice(0, 700);
  };
  return `${step.tool.replace(/^(hub_|apps_)/, "").replaceAll("_", " ")}: ${describe(step.input)}`;
}

async function validate(ctx: ToolContext, plan: Plan) {
  const { toolsForTurn, writeRefusal, ensureAppAccess } = await import("../apps.js");
  const available = new Map((await toolsForTurn(ctx)).map(tool => [tool.name, tool]));
  const seen = new Set<string>();
  for (const step of plan.steps) {
    const tool = available.get(step.tool);
    if (!tool || step.tool === "hub_run_workflow" || !tool.isWrite) throw new Error(`Choose an available write tool for ${step.id}. Do reads before proposing the workflow.`);
    if (seen.has(step.id)) throw new Error("Step ids must be unique.");
    for (const ref of refs(step.input)) if (!seen.has(ref.split(".")[0]!)) throw new Error(`${ref} must refer to an earlier step.`);
    if (!refs(step.input).length) tool.input.parse(step.input);
    const refusal = writeRefusal(tool, ctx.settings); if (refusal) throw new Error(refusal);
    await ensureAppAccess(ctx, tool);
    seen.add(step.id);
  }
  if (JSON.stringify(plan).length > 100_000) throw new Error("Split this request into smaller workflows.");
  return available;
}

export const workflowTools = [defineTool({
  name: "hub_run_workflow", area: "tasks", description: "Propose 2–12 dependent writes under one Apply. Each step has id, tool and input. Replace a later input value with {\"$ref\":\"earlierStep.resultField\"}, e.g. person.person.id, project.project.id, page.id, tasks.tasks.0.id. Results are checkpointed; retry skips completed steps. Read existing records first. Never put read tools or another workflow inside.",
  input: Input, isWrite: true, risk: "medium", alwaysHold: true, outsideTransaction: true,
  async preview(ctx, plan) {
    const tools = await validate(ctx, plan);
    const lines: string[] = [];
    for (const step of plan.steps) {
      const tool = tools.get(step.tool)!;
      const preview = !refs(step.input).length && tool.preview ? await tool.preview(ctx, tool.input.parse(step.input)) : proposedStep(step, plan);
      lines.push(`${step.id}: ${preview}`);
    }
    return `${plan.title}\n${lines.join("\n")}\nSteps run in order; completed steps remain if a later one fails.`;
  },
  async run(ctx, plan) {
    if (!ctx.conversationId || !ctx.toolCallId) throw new Error("Apply this workflow from its saved conversation.");
    const tools = await validate(ctx, plan);
    const key = createHash("sha256").update(`${ctx.userId}:${actorFor(ctx.userId) ?? ctx.userId}:${ctx.conversationId}:${ctx.toolCallId}`).digest("hex");
    const hash = createHash("sha256").update(JSON.stringify(canonical(plan))).digest("hex");
    const row = await ctx.prisma.assistantWorkflow.upsert({ where: { id: key }, create: { id: key, userId: ctx.userId, conversationId: ctx.conversationId, planHash: hash }, update: {} });
    if (row.planHash !== hash) throw new Error("This workflow's approved plan changed. Propose a new workflow.");
    const saved = row.steps as Saved[];
    const results = new Map(saved.filter(step => step.state === "ok").map(step => [step.id, step.data]));
    const store = () => ctx.prisma.assistantWorkflow.update({ where: { id: key }, data: { steps: saved as unknown as Prisma.InputJsonValue } });
    for (const step of plan.steps) {
      const old = saved.find(item => item.id === step.id);
      if (old?.state === "ok") continue;
      if (old?.state === "running") throw Object.assign(new Error(`Step ${step.id} was interrupted while running. Check its target before proposing a replacement; it will not be replayed.`), { partial: results.size > 0 });
      const tool = tools.get(step.tool)!;
      let entry: Saved | undefined;
      try {
        const input = tool.input.parse(resolveWorkflowRefs(step.input, results));
        // Recheck targets and current permissions at the actual step, after dependencies exist.
        const owner = await ctx.prisma.user.findUnique({ where: { id: ctx.userId }, select: { moduleSet: true } });
        const stepContext = { ...ctx, settings: await loadSettings(ctx.prisma, ctx.userId), modules: serializeModules(OPTIONAL_MODULES.filter(module => (ctx.modules === undefined || hasModule(ctx.modules, module)) && hasModule(owner?.moduleSet, module))), toolCallId: `${ctx.toolCallId}:${step.id}` };
        const currentTools = await validate(stepContext, plan);
        if (!currentTools.has(step.tool)) throw new Error("This action is no longer available.");
        if (tool.preview) await tool.preview(stepContext, input);
        entry = { id: step.id, tool: step.tool, state: "running" };
        const at = saved.findIndex(item => item.id === step.id); if (at < 0) saved.push(entry); else saved[at] = entry;
        await store();
        const { isOutsideWrite, runOutsideWrite } = await import("../apply.js");
        const result = isOutsideWrite(tool) ? await runOutsideWrite(stepContext, tool, input) : await tool.run(stepContext, input);
        entry.state = "ok"; entry.data = result.data ?? {}; entry.summary = result.summary; entry.href = result.href;
        await store();
        results.set(step.id, entry.data);
      } catch (error) {
        const message = error instanceof Error ? error.message : "The step failed.";
        const status = error && typeof error === "object" ? (error as { statusCode?: number }).statusCode : undefined;
        const uncertain = entry && entry.state !== "ok" && (error instanceof AppRequestError && (error.status === 0 || error.status >= 500) || (tool.area === "apps" || tool.outsideTransaction) && (status === undefined || status >= 500));
        if (entry && entry.state !== "ok") { entry.state = uncertain ? "running" : "failed"; entry.error = message; await store(); }
        const done = saved.filter(item => item.state === "ok").map(item => `${item.id}: ${item.summary}`).join("; ");
        throw Object.assign(new Error(`${done ? `Completed: ${done}. ` : ""}Stopped at ${step.id}: ${message}. ${uncertain ? "This action may have completed. Check its target before proposing a replacement; it will not be replayed." : "Retry the same Apply to continue without repeating completed steps."}`), { partial: saved.some(item => item.state === "ok") });
      }
    }
    return toolOk(saved.map(step => step.summary).filter(Boolean).join(" "), { id: key, steps: saved.map(({ id, summary, href }) => ({ id, summary, href })) }, { href: saved.find(step => step.href)?.href, invalidate: ["tasks", "pages", "people", "projects", "layouts", "documents", "skills", "context", "imports"] });
  }
})];
