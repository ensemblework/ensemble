/**
 * Confirm before sending, check 4 (ensemble-node design B20): before a step's screenshots or videos may
 * reach its owner, a model that reads pictures judges each against what was asked: the requirements that
 * asked for pictures, with their acceptance criteria. Its verdict is one more check on the step's report,
 * like the worker's own. On a verification a picture that does not show what was asked fails the check,
 * so the repair loop runs (B2); on any other step it only keeps that picture from being shown.
 *
 * Only pictures a passing check names are judged (the ones that could be shown), uploaded ones only: a
 * held or local file is not on the server, and a held one waits for its owner's preview anyway. A video
 * is judged by its poster. When no model can judge (none reads pictures, the owner's included credits are
 * used up, the call fails), the report stands as the worker made it.
 */
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { INCLUDED_PROVIDER, includedModel } from "@ensemble/shared-types";
import { includedModelOn } from "../included/config.js";
import { assertIncludedOpen } from "../included/budget.js";
import { evidenceContent } from "../evidence/store.js";
import { askRuntimeStream, type ModelMessage } from "../lib/model-turn.js";
import { truncateText } from "../lib/text.js";
import { checkedMedia } from "./media.js";
import type { Check, StepReport } from "./report.js";

/** Pictures judged per report, and the largest one sent. */
const MAX_PICTURES = 4;
const MAX_BYTES = 8 * 1024 * 1024;
const PREFIX = "Vision:";
const ORDER = ["gpt-6.1-sol", "gpt-6-luna", "gpt-5-mini", "gpt-4.1-mini"];

/** The included model that judges pictures: `ENSEMBLE_NODE_VISION_MODEL` ("off" for none), else the first offered one that reads them. */
export function visionModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const chosen = env.ENSEMBLE_NODE_VISION_MODEL?.trim();
  if (chosen === "off") return null;
  for (const id of chosen ? [chosen] : ORDER) {
    if (includedModelOn(id, env) && includedModel(id)?.images === true) return id;
  }
  return null;
}

type Requirement = { id?: unknown; text?: unknown; evidence?: unknown; acceptance?: Array<{ text?: unknown }> };

/** What the pictures must show: each requirement of the step that asked for a screenshot or video, with its criteria. */
export function picturesAsked(requirements: readonly Requirement[], requirementIds: readonly string[]): string[] {
  return requirements
    .filter((row) => typeof row.id === "string" && requirementIds.includes(row.id) && Array.isArray(row.evidence) && row.evidence.some((kind) => kind === "screenshot" || kind === "video"))
    .map((row) => {
      const criteria = (row.acceptance ?? []).map((item) => (typeof item.text === "string" ? item.text : "")).filter(Boolean);
      return `${String(row.text ?? "")}${criteria.length ? `\n  Acceptance: ${criteria.join("; ")}` : ""}`;
    });
}

type Judged = { id: string; verdict: "pass" | "fail"; reason: string };

/** The model's answer: one verdict per picture it was shown, by id; anything else is ignored. */
export function parseJudgement(text: string, ids: readonly string[]): Judged[] {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const rows = Array.isArray((parsed as { pictures?: unknown })?.pictures) ? ((parsed as { pictures: unknown[] }).pictures as Array<Record<string, unknown>>) : [];
  const out: Judged[] = [];
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id : "";
    const verdict = row.verdict === "pass" || row.verdict === "fail" ? row.verdict : null;
    if (!ids.includes(id) || !verdict || out.some((item) => item.id === id)) continue;
    out.push({ id, verdict, reason: truncateText(typeof row.reason === "string" ? row.reason : "", 500) });
  }
  return out;
}

type Picture = { id: string; name: string; caption: string | null; mime: string; bytes: Buffer };

/** The uploaded pictures a report could show (a video by its poster), at most four. */
async function picturesOf(prisma: PrismaClient, ownerId: string, report: StepReport): Promise<Picture[]> {
  const named = [...(checkedMedia(report, true) ?? [])];
  if (!named.length) return [];
  const rows = await prisma.jobEvidence.findMany({ where: { id: { in: named }, userId: ownerId, held: false, local: false, variantOf: null } });
  const posters = await prisma.jobEvidence.findMany({ where: { variantOf: { in: rows.filter((row) => row.kind === "video").map((row) => row.id) }, variant: "poster", held: false, local: false } });
  const captions = new Map((report.evidence ?? []).map((ref) => [ref.ref, ref.caption ?? null]));
  const pictures: Picture[] = [];
  for (const row of rows) {
    const shown = row.kind === "video" ? posters.find((poster) => poster.variantOf === row.id) : row.mime.startsWith("image/") ? row : null;
    if (!shown || !shown.mime.startsWith("image/") || shown.size > MAX_BYTES) continue;
    const bytes = await evidenceContent(shown).catch(() => null);
    if (!bytes?.length) continue;
    pictures.push({ id: row.id, name: row.name, caption: captions.get(row.id) ?? null, mime: shown.mime, bytes });
    if (pictures.length >= MAX_PICTURES) break;
  }
  return pictures;
}

/**
 * The report with a vision check per picture it could show, when the step's requirements asked for
 * pictures. Unchanged when they asked for none, when it already has them, or when no model could judge.
 */
export async function withVisionChecks(app: FastifyInstance, input: { ownerId: string; missionId: string; stepId: string; report: StepReport }): Promise<StepReport> {
  const { report } = input;
  if ((report.checks ?? []).some((check) => check.name.startsWith(PREFIX))) return report;
  const prisma = app.prisma;
  const [mission, step] = await Promise.all([
    prisma.nodeMission.findUnique({ where: { id: input.missionId }, select: { requirements: true } }),
    prisma.nodeStep.findUnique({ where: { missionId_id: { missionId: input.missionId, id: input.stepId } }, select: { kind: true, requirementIds: true } }),
  ]);
  if (!mission || !step) return report;
  const asked = picturesAsked((Array.isArray(mission.requirements) ? mission.requirements : []) as Requirement[], step.requirementIds);
  if (!asked.length) return report;
  const model = visionModel();
  if (!model) return report;
  const pictures = await picturesOf(prisma, input.ownerId, report);
  if (!pictures.length) return report;
  try {
    await assertIncludedOpen(input.ownerId, model);
    const messages: ModelMessage[] = [
      {
        role: "system",
        content:
          "You check screenshots before they are sent to a person as proof of finished work. For each picture, decide only from what is visible in it whether it shows what was asked. " +
          "pass: it clearly shows it working as asked. fail: it is blank, an error, a loading or sign-in screen, the wrong page or app, or it does not show what was asked. " +
          'Answer with JSON only: {"pictures":[{"id":"…","verdict":"pass"|"fail","reason":"one short sentence"}]}.',
      },
      {
        role: "user",
        content: [
          { type: "text", text: `What was asked:\n${asked.map((line) => `- ${line}`).join("\n")}\n\nThe step's own summary (a claim, not proof): ${truncateText(report.summary, 600)}` },
          ...pictures.flatMap((picture) => [
            { type: "text", text: `Picture id ${picture.id}: ${picture.name}${picture.caption ? ` (${picture.caption})` : ""}` },
            { type: "image_url", image_url: { url: `data:${picture.mime};base64,${picture.bytes.toString("base64")}` } },
          ]),
        ],
      },
    ] as ModelMessage[];
    const turn = await askRuntimeStream({ messages, model, provider: INCLUDED_PROVIDER, reasoningEffort: "low", userId: input.ownerId, activityId: `node-vision:${input.missionId}:${input.stepId}`, chatTools: [], responsesTools: [], timeoutMs: 120_000, purpose: "Node vision check" });
    const judged = parseJudgement(turn.text, pictures.map((picture) => picture.id));
    if (!judged.length) return report;
    const verify = step.kind === "verify";
    const checks: Check[] = judged.map((row) => {
      const picture = pictures.find((item) => item.id === row.id)!;
      return {
        name: `${PREFIX} ${truncateText(picture.caption ?? picture.name, 120)} shows what was asked`,
        // Anywhere but a verification, a picture that fails only stays unshown: the step itself stands.
        verdict: row.verdict === "pass" ? "pass" : verify ? "fail" : "blocked",
        detail: row.reason || (row.verdict === "pass" ? "It shows what was asked." : "It does not show what was asked."),
        evidence: [row.id],
      };
    });
    return { ...report, checks: [...(report.checks ?? []), ...checks].slice(0, 50) };
  } catch (error) {
    app.log.warn({ err: error, missionId: input.missionId, stepId: input.stepId }, "Node vision check could not run");
    return report;
  }
}
