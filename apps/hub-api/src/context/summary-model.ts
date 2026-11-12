/**
 * The model call behind a file's summary (docs/32 §4, docs/38 §1). The file itself goes to the model or
 * agent of the tier Settings › Assistant › Automations › Summarize files names, in that model's own input
 * form, as a file attached in chat does: a model with a key or an included model gets it as an image or
 * file part (files/model-input.ts); the person's own AI plan gets it inside its agent's message
 * (subscriptions/turn-files.ts), as a one-off turn that leaves no session behind. Ensemble's text of the
 * file stands in only where the file cannot go: larger than one request carries, refused by the provider,
 * a kind the agent's message has no place for, or a reply that says the file could not be opened. A file
 * that can go neither way is not summarized, and the reason is kept on the file.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { INCLUDED_PROVIDER, isSubscriptionProvider, SUBSCRIPTION_INFO, type SubscriptionProvider } from "@ensemble/shared-types";
import { turnFilesFor } from "../assistant/attachments.js";
import { describeFile, fileOriginal, filesByIds, type AttachedFile } from "../files/attached.js";
import { attachmentForModel, MODEL_ATTACH_TOTAL_BYTES } from "../files/model-input.js";
import { beginActivity, endActivity, isPaused } from "../lib/activity.js";
import { recordMetric } from "../lib/metrics.js";
import { askRuntime } from "../lib/model-turn.js";
import { callCost } from "../lib/pricing.js";
import { redis } from "../lib/redis.js";
import { complete, RuntimeError } from "../lib/runtime.js";
import { loadSettings } from "../lib/settings.js";
import { truncateText } from "../lib/text.js";
import { attachmentsRefused, documentsFor, modelReadsImages } from "../lib/vision.js";
import { runSubscriptionTurn } from "../subscriptions/turn.js";
import { couldNotOpen, fileSummaryPrompt, PICTURES, planTakesFile, SUMMARY_SYSTEM, summaryPrompt, type SummaryRow } from "./summarize.js";

const MB = 1024 * 1024;
const TEXT_BACKUP = 16_000;

/** The file cannot go to this model or agent as itself; Ensemble's text of it may still. */
class CannotGo extends Error {}

/** Whether an included model reads this kind as a file (its catalog flags), checked before sending. */
function includedReads(model: string, file: AttachedFile): boolean {
  return file.kind === "image" && PICTURES.has(file.format.toLowerCase()) ? modelReadsImages(INCLUDED_PROVIDER, model) : documentsFor(INCLUDED_PROVIDER, model)(file.filename);
}

const kindWords = (file: AttachedFile) => (file.kind === "image" ? "this kind of picture" : file.kind === "audio" ? "audio" : file.kind === "video" ? "video" : "this kind of file");

/** The summary's text, from the file itself where the tier's model or agent takes it. */
export async function summarizeDocument(app: FastifyInstance, row: SummaryRow): Promise<string> {
  const document = await app.prisma.document.findUnique({ where: { id: row.id }, select: { userId: true } });
  if (!document) throw new Error("That file is no longer in Files.");
  const userId = document.userId;
  if (await isPaused(redis, userId)) throw new RuntimeError("The agent is paused. Resume it from the top bar to allow model calls.", 409);
  const settings = await loadSettings(app.prisma, userId);
  const tierName = settings.automations.fileSummaries.tier;
  const tier = settings.models[tierName];
  if (!tier.model) throw new RuntimeError(`No model is set for the ${tierName} tier. Pick one in Settings › Models.`, 409);
  const [file] = await filesByIds(app.prisma, userId, [row.id]);
  if (!file) throw new Error("That file is no longer in Files.");
  const hasText = Boolean(row.text.trim());
  const fromText = async (why: string): Promise<string> => {
    if (!hasText) throw new Error(why);
    const answer = await complete({ userId, settings, tier: tierName, system: SUMMARY_SYSTEM, prompt: summaryPrompt(row), purpose: "Document summary" });
    return answer.text;
  };
  if (file.kind === "audio" || file.kind === "video" || file.kind === "other") return fromText(`Ensemble does not summarize ${kindWords(file)}.`);

  try {
    if (isSubscriptionProvider(tier.provider)) {
      const agent = tier.provider;
      if (!planTakesFile(agent, file)) throw new CannotGo(`${SUBSCRIPTION_INFO[agent].label} cannot take ${kindWords(file)} in a summary, and Ensemble read no text from it.`);
      const reply = await onPlan(app, { userId, settings, agent, model: tier.model, effort: tier.effort }, row, file);
      if (couldNotOpen(reply)) throw new CannotGo(`${SUBSCRIPTION_INFO[agent].label} could not open the file: ${truncateText(reply.trim(), 160)}`);
      return reply;
    }
    if (file.byteSize > MODEL_ATTACH_TOTAL_BYTES) throw new CannotGo(`The file is larger than one model request carries (${MODEL_ATTACH_TOTAL_BYTES / MB} MB), and Ensemble read no text from it.`);
    if (tier.provider === INCLUDED_PROVIDER && !includedReads(tier.model, file)) throw new CannotGo(`${tier.model} cannot read ${kindWords(file)}, and Ensemble read no text from it.`);
    const reply = await onRuntime(app, { userId, settings, provider: tier.provider, model: tier.model, effort: tier.effort }, row, file);
    if (couldNotOpen(reply)) throw new CannotGo(`${tier.model} could not open the file: ${truncateText(reply.trim(), 160)}`);
    return reply;
  } catch (error) {
    if (error instanceof CannotGo) return fromText(error.message);
    // The provider refused the attachment (its type, size or pages): the text, when there is one.
    if (!isSubscriptionProvider(tier.provider) && attachmentsRefused(error)) return fromText(`${tier.model} refused the file: ${error instanceof Error ? truncateText(error.message, 160) : "unsupported"}.`);
    throw error;
  }
}

type Who = { userId: string; settings: Awaited<ReturnType<typeof loadSettings>>; model: string; effort: string };

/** A one-off turn on the person's own plan, with the file inside the agent's message. */
async function onPlan(app: FastifyInstance, who: Who & { agent: SubscriptionProvider }, row: SummaryRow, file: AttachedFile): Promise<string> {
  // Copilot's and the ACP agents' own handling of a PDF may drop a scan or the text layer: Ensemble's text goes too.
  const backup = who.agent !== "claude-code" && file.format.toLowerCase() === "pdf" && row.text.trim() ? `\n\nIf the attached file did not reach you, this is the text Ensemble read from it:\n${row.text.slice(0, TEXT_BACKUP)}` : "";
  const done = await runSubscriptionTurn({
    userId: who.userId,
    settings: who.settings,
    agent: who.agent,
    model: who.model,
    effort: who.effort,
    system: `${SUMMARY_SYSTEM}\n\nYou have no tools in this request: answer from the attached file.`,
    prompt: `${fileSummaryPrompt(row, describeFile(file))}${backup}`,
    files: {
      list: await turnFilesFor(app.prisma, [file], who.userId),
      read: async (id) => (await fileOriginal(app.prisma, who.userId, id))?.bytes ?? null,
      fallback: row.text.trim() ? `Ensemble's text of the file:\n${row.text.slice(0, TEXT_BACKUP)}` : "",
    },
    tools: [],
    maxTurns: 2,
    call: async () => ({ text: "There are no tools in this request.", isError: true }),
  });
  await recordMetric(app.prisma, {
    userId: who.userId,
    kind: "model.call",
    meta: { provider: who.agent, model: done.model || who.model, purpose: "Document summary", tokensIn: done.tokensIn, tokensOut: done.tokensOut, estimatedUsd: 0, computer: done.computer, title: truncateText(row.filename, 80) },
  }).catch(() => undefined);
  return done.text;
}

/** A model with a key or an included model, with the file as an image or file part. */
async function onRuntime(app: FastifyInstance, who: Who & { provider: string }, row: SummaryRow, file: AttachedFile): Promise<string> {
  const got = await attachmentForModel(app.prisma, who.userId, file);
  if ("problem" in got) throw new CannotGo(got.problem);
  const activityId = `model:${randomUUID()}`;
  await beginActivity(redis, who.userId, { id: activityId, kind: "model", label: "Document summary", model: who.model });
  try {
    const turn = await askRuntime({
      messages: [
        { role: "system", content: SUMMARY_SYSTEM },
        { role: "user", content: [{ type: "text", text: fileSummaryPrompt(row, describeFile(file)) }, got.attachment.part] },
      ],
      model: who.model,
      provider: who.provider,
      ollamaUrl: who.settings.models.ollamaUrl,
      reasoningEffort: who.effort,
      userId: who.userId,
      activityId,
      chatTools: [],
      responsesTools: [],
      purpose: "Document summary",
    });
    const model = turn.model || who.model;
    await recordMetric(app.prisma, {
      userId: who.userId,
      kind: "model.call",
      meta: { provider: who.provider, model, purpose: "Document summary", tokensIn: turn.tokensIn, tokensOut: turn.tokensOut, ...callCost(who.provider, model, turn.tokensIn, turn.tokensOut, turn.credits), title: truncateText(row.filename, 80) },
    }).catch(() => undefined);
    return turn.text;
  } finally {
    await endActivity(redis, who.userId, activityId);
  }
}
