/**
 * Whether a model reads pictures and documents sent in a message. Included models say so in their
 * catalog entry (packages/shared-types/src/included.ts); for a person's own keys it follows the
 * model family. A model not known to read something gets Ensemble's text instead: unknown is not
 * a yes. Subscription agents get the files through their own CLI (subscriptions/agents.ts).
 */
import { INCLUDED_PROVIDER, includedModel, isSubscriptionProvider, modelFileMime } from "@ensemble/shared-types";
import { hasFileParts, hasImageParts } from "../runtime/content-parts.js";

/** Model ids, after any vendor prefix (OpenRouter's "openai/…", Gemini's "models/…") is removed. */
const FAMILIES: RegExp[] = [
  /^(gpt-4o|chatgpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|gpt-4-vision|gpt-5|gpt-6|o1(?!-mini|-preview)|o3(?!-mini)|o4-mini|computer-use)/,
  /^claude-(3|opus|sonnet|haiku)/,
  /^gemini-(?!embedding|.*-tts)/,
  /^gemma-?3(?!.*[:-]1b)/,
  /^grok-(4|2-vision|vision)/,
  /^(pixtral|mistral-(small|medium)-(latest|25\d\d)|mistral-large-2[56]\d\d)/,
  /^(qwen-vl|qwen[\w.]*-vl|qwen2\.5vl|qvq|qwen3\.5|qwen[\w.]*-omni)/,
  /^(kimi-k2\.5|kimi-latest|kimi-vl|moonshot-v1-[\w-]*vision)/,
  /^(llama-?4|llama-?3\.2-(11|90)b-vision|llama3\.2-vision)/,
  /^(llava|bakllava|minicpm-v|moondream|granite3\.2-vision|mistral-small3\.[12])/,
];

export function modelId(model: string): string {
  return model.trim().toLowerCase().replace(/^models\//, "").replace(/^[a-z0-9-]+\//, "");
}

export function modelReadsImages(provider: string | null | undefined, model: string | null | undefined): boolean {
  if (!model) return false;
  if (provider === INCLUDED_PROVIDER) return includedModel(model)?.images === true;
  if (!provider || isSubscriptionProvider(provider) || provider === "mock" || provider === "cursor") return false;
  const id = modelId(model);
  return FAMILIES.some((family) => family.test(id));
}

/** Claude models that take PDFs (3.5 and later). */
const CLAUDE_DOCUMENTS = /^claude-(3[-.][5-9]|(opus|sonnet|haiku)-[4-9]|[4-9])/;
const TEXT_MEDIA = /^(text\/|application\/json$)/;

/**
 * Which documents a model takes as the file itself (a `file` part), by file name. Included models
 * read PDF, Word, PowerPoint, Excel, CSV, Markdown, JSON and text (checked against each Foundry
 * deployment); Claude reads PDFs and text; OpenAI's own models read PDFs. Others get Ensemble's text.
 */
export function documentsFor(provider: string | null | undefined, model: string | null | undefined): (filename: string) => boolean {
  const none = () => false;
  if (!model || !provider) return none;
  const mime = (filename: string) => modelFileMime(filename);
  if (provider === INCLUDED_PROVIDER) return includedModel(model)?.documents === true ? (filename) => mime(filename) !== null : none;
  const id = modelId(model);
  if (provider === "anthropic" && CLAUDE_DOCUMENTS.test(id)) return (filename) => {
    const type = mime(filename);
    return type === "application/pdf" || (type !== null && TEXT_MEDIA.test(type));
  };
  if (provider === "openai" && modelReadsImages(provider, model)) return (filename) => mime(filename) === "application/pdf";
  return none;
}

/** The provider refused image input for this model: the request can go again without images. */
export function imagesRefused(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return (
    /\b(image|images|vision|image_url|input_image|multimodal)\b/i.test(text) &&
    /\b(not|only|unsupported|invalid|cannot|can't|enable|enabled|disabled|exceeds?|too large|too big|maximum)\b/i.test(text)
  );
}

export const IMAGES_REFUSED_NOTE = "[The model refused the image, so it was not sent. Say you could not look at it, and work from its name and any text.]";

/** The same messages with every image part replaced by a note, for a model that refused images. */
export function withoutImages<T extends Record<string, unknown>>(messages: T[]): T[] {
  return messages.map((message) => {
    const content = message.content;
    if (!hasImageParts(content)) return message;
    const parts = (content as unknown[]).map((part) => {
      const kind = part && typeof part === "object" ? (part as Record<string, unknown>).type : null;
      return kind === "image_url" || kind === "input_image" || kind === "image" ? { type: "text", text: IMAGES_REFUSED_NOTE } : part;
    });
    return { ...message, content: parts };
  });
}

/** The provider refused a file in the request (its type, size or page count): it can go again with each file as a note. */
export function filesRefused(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return /\b(input_file|file_data|files?|documents?|pdf)\b/i.test(text) && /\b(invalid|unsupported|not supported|not allowed|cannot|can't|exceeds?|too large|too big|maximum|too many pages)\b/i.test(text);
}

/** The same messages with every file part replaced by a note naming the file the provider refused. */
export function withoutFiles<T extends Record<string, unknown>>(messages: T[]): T[] {
  return messages.map((message) => {
    const content = message.content;
    if (!hasFileParts(content)) return message;
    const parts = (content as unknown[]).map((part) => {
      const record = part && typeof part === "object" ? (part as Record<string, unknown>) : null;
      if (!record || !["file", "input_file", "document"].includes(String(record.type))) return part;
      const file = (record.file ?? record) as Record<string, unknown>;
      const name = String(file.filename ?? record.title ?? "the file");
      return { type: "text", text: `[The model's provider refused “${name}” as a file, so it was not given. Say you could not open it rather than guess.]` };
    });
    return { ...message, content: parts };
  });
}
