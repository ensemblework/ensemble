/**
 * Whether a model reads images sent in a message. Included models say so in their catalog entry
 * (packages/shared-types/src/included.ts); for a person's own keys it follows the model family.
 * A model not known to read images gets text only: unknown is not a yes. Subscription agents run
 * through their own CLI, which Ensemble chat sends text (subscriptions/turn.ts).
 */
import { INCLUDED_PROVIDER, includedModel, isSubscriptionProvider } from "@ensemble/shared-types";
import { hasImageParts } from "../runtime/content-parts.js";

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
