import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";

const NAME_CHARS = 200;
const ID_CHARS = 100;
const SKILLS = 40;
const PARTS = 60;
/** A part's size is capped so the pack's token estimate (an `Int` column) cannot overflow: 60 parts of 10M chars. */
const PART_CHARS = 10_000_000;
const INT_MAX = 2_147_483_647;

const Signature = z.object({
  id: z.string().max(ID_CHARS).nullable(),
  name: z.string().max(NAME_CHARS),
  source: z.enum(["ensemble", "owner"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Provenance only: no prompt, skill body, message or attachment text. */
export const RunContext = z.object({
  schema: z.literal("ensemble.run-context/1"),
  promptVersion: z.string().regex(/^[a-f0-9]{12,64}$/),
  skills: z.array(Signature).max(SKILLS),
  parts: z.array(z.object({
    name: z.enum(["system", "brief", "prompt"]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    chars: z.number().int().min(0).max(PART_CHARS),
  })).max(PARTS),
});
export type RunContext = z.infer<typeof RunContext>;
export type RunSkill = z.infer<typeof Signature>;
type Db = PrismaClient | Prisma.TransactionClient;

export const instructionHash = (text: string): string => createHash("sha256").update(text).digest("hex");
export const contextPart = (name: RunContext["parts"][number]["name"], text: string): RunContext["parts"][number] => ({ name, sha256: instructionHash(text), chars: Math.min(text.length, PART_CHARS) });

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/**
 * A run context from anything (this run's own values, a stored pack, what a computer sent), fitted to the
 * schema's caps: names cut to 200 characters, an over-long id dropped, sizes capped, at most 40 skills and
 * the last 60 parts. Null when it still does not fit.
 */
export function runContextFrom(value: unknown): RunContext | null {
  const raw = record(value);
  if (!raw) return null;
  const skills = Array.isArray(raw.skills)
    ? raw.skills.slice(0, SKILLS).map((item) => {
        const skill = record(item);
        if (!skill) return item;
        return {
          ...skill,
          ...(typeof skill.name === "string" ? { name: skill.name.slice(0, NAME_CHARS) } : {}),
          ...(typeof skill.id === "string" && skill.id.length > ID_CHARS ? { id: null } : {}),
        };
      })
    : raw.skills;
  const parts = Array.isArray(raw.parts)
    ? raw.parts.slice(-PARTS).map((item) => {
        const part = record(item);
        return part && typeof part.chars === "number" && part.chars > PART_CHARS ? { ...part, chars: PART_CHARS } : item;
      })
    : raw.parts;
  const parsed = RunContext.safeParse({ ...raw, skills, parts });
  return parsed.success ? parsed.data : null;
}

/**
 * One pack per run, updated before dispatch when a retry changes the prompt. Throws when the context
 * cannot be read or kept: every caller catches it, as provenance never stops or fails a run.
 */
export async function keepRunContext(db: Db, runId: string, context: unknown): Promise<void> {
  const fitted = runContextFrom(context);
  if (!fitted) throw new Error("The run's context provenance does not fit its schema; it was not kept.");
  const run = await db.run.findUniqueOrThrow({ where: { id: runId }, select: { userId: true, taskId: true } });
  const pack = {
    summary: "Agent run context fingerprints. Text is not retained.",
    items: fitted,
    skillsSuggested: fitted.skills.flatMap((skill) => skill.id ? [skill.id] : []),
    tokenEstimate: Math.min(INT_MAX, fitted.parts.reduce((sum, part) => sum + Math.ceil(part.chars / 4), 0)),
  };
  await db.run.update({
    where: { id: runId },
    data: {
      promptVersion: fitted.promptVersion,
      skillIds: pack.skillsSuggested,
      skillSignatures: fitted.skills,
      contextPack: { upsert: { create: { userId: run.userId, taskId: run.taskId, ...pack }, update: pack } },
    },
  });
}

/** The computer sends the metadata, never its local context-pack id. Null when the run has none or it cannot be read. */
export async function runContextOf(db: Db, runId: string | null): Promise<RunContext | null> {
  if (!runId) return null;
  const run = await db.run.findUnique({ where: { id: runId }, select: { contextPack: { select: { items: true } } } });
  return run?.contextPack ? runContextFrom(run.contextPack.items) : null;
}
