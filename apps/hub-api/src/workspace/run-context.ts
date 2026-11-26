import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";

const Signature = z.object({
  id: z.string().max(100).nullable(),
  name: z.string().max(200),
  source: z.enum(["ensemble", "owner"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Provenance only: no prompt, skill body, message or attachment text. */
export const RunContext = z.object({
  schema: z.literal("ensemble.run-context/1"),
  promptVersion: z.string().regex(/^[a-f0-9]{12,64}$/),
  skills: z.array(Signature).max(40),
  parts: z.array(z.object({
    name: z.enum(["system", "brief", "prompt"]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    chars: z.number().int().min(0),
  })).max(60),
});
export type RunContext = z.infer<typeof RunContext>;
export type RunSkill = z.infer<typeof Signature>;
type Db = PrismaClient | Prisma.TransactionClient;

export const instructionHash = (text: string): string => createHash("sha256").update(text).digest("hex");
export const contextPart = (name: RunContext["parts"][number]["name"], text: string): RunContext["parts"][number] => ({ name, sha256: instructionHash(text), chars: text.length });

/** One pack per run, updated before dispatch when a retry changes the prompt. */
export async function keepRunContext(db: Db, runId: string, context: RunContext): Promise<void> {
  const record = RunContext.parse(context);
  const run = await db.run.findUniqueOrThrow({ where: { id: runId }, select: { userId: true, taskId: true } });
  const pack = {
    summary: "Agent run context fingerprints. Text is not retained.",
    items: record,
    skillsSuggested: record.skills.flatMap((skill) => skill.id ? [skill.id] : []),
    tokenEstimate: record.parts.reduce((sum, part) => sum + Math.ceil(part.chars / 4), 0),
  };
  await db.run.update({
    where: { id: runId },
    data: {
      promptVersion: record.promptVersion,
      skillIds: pack.skillsSuggested,
      skillSignatures: record.skills,
      contextPack: { upsert: { create: { userId: run.userId, taskId: run.taskId, ...pack }, update: pack } },
    },
  });
}

/** The computer sends the metadata, never its local context-pack id. */
export async function runContextOf(db: Db, runId: string | null): Promise<RunContext | null> {
  if (!runId) return null;
  const run = await db.run.findUnique({ where: { id: runId }, select: { contextPack: { select: { items: true } } } });
  return run?.contextPack ? RunContext.parse(run.contextPack.items) : null;
}
