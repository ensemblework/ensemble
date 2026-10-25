/**
 * Image input in model messages. hub-api writes user content as OpenAI chat parts
 * (`{type:"text"}` and `{type:"image_url", image_url:{url:"data:…;base64,…"}}`); chat-compatible
 * providers take them as they are, and these helpers rewrite them for the Anthropic Messages and
 * OpenAI Responses APIs. The Python runtime mirrors this in ensemble_agent/content_parts.py.
 * Callers add image parts only for a model that reads images (lib/vision.ts).
 */

type Json = Record<string, unknown>;

const DATA_URL = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.*)$/is;

/** `image_url` parts (chat) or `input_image` parts (Responses). */
function imageUrlOf(part: Json): string | null {
  if (part.type === "image_url") {
    const inner = part.image_url;
    if (typeof inner === "string") return inner;
    if (inner && typeof inner === "object" && typeof (inner as Json).url === "string") return String((inner as Json).url);
  }
  if (part.type === "input_image" && typeof part.image_url === "string") return part.image_url;
  return null;
}

function detailOf(part: Json): string | undefined {
  const inner = part.image_url;
  const detail = inner && typeof inner === "object" ? (inner as Json).detail : part.detail;
  return typeof detail === "string" ? detail : undefined;
}

function textPart(part: unknown): string | null {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return null;
  const value = (part as Json).text;
  return typeof value === "string" ? value : null;
}

export function hasImageParts(content: unknown): boolean {
  return Array.isArray(content) && content.some((part) => part && typeof part === "object" && (imageUrlOf(part as Json) !== null || (part as Json).type === "image"));
}

/** User content for the Anthropic Messages API: text and image blocks, or the plain string. */
export function anthropicUserContent(content: unknown): string | Json[] {
  if (!hasImageParts(content)) return textOfParts(content);
  const blocks: Json[] = [];
  for (const raw of content as unknown[]) {
    if (raw && typeof raw === "object" && (raw as Json).type === "image") {
      blocks.push(raw as Json);
      continue;
    }
    const url = raw && typeof raw === "object" ? imageUrlOf(raw as Json) : null;
    if (url) {
      const data = DATA_URL.exec(url);
      blocks.push(data ? { type: "image", source: { type: "base64", media_type: data[1]!.toLowerCase(), data: data[2] } } : { type: "image", source: { type: "url", url } });
      continue;
    }
    const text = textPart(raw);
    if (text) blocks.push({ type: "text", text });
  }
  return blocks;
}

/** User content for the Responses API: input_text and input_image parts, or the plain string. */
export function responsesUserContent(content: unknown): string | Json[] {
  if (!hasImageParts(content)) return textOfParts(content);
  const parts: Json[] = [];
  for (const raw of content as unknown[]) {
    if (raw && typeof raw === "object" && (raw as Json).type === "image") {
      const source = ((raw as Json).source ?? {}) as Json;
      if (source.type === "base64") parts.push({ type: "input_image", image_url: `data:${String(source.media_type)};base64,${String(source.data)}` });
      else if (typeof source.url === "string") parts.push({ type: "input_image", image_url: source.url });
      continue;
    }
    const url = raw && typeof raw === "object" ? imageUrlOf(raw as Json) : null;
    if (url) {
      const detail = detailOf(raw as Json);
      parts.push({ type: "input_image", image_url: url, ...(detail ? { detail } : {}) });
      continue;
    }
    const text = textPart(raw);
    if (text) parts.push({ type: "input_text", text });
  }
  return parts;
}

/** Text only: what a text model, a log line or a tool result keeps of the content. */
export function textOfParts(content: unknown): string {
  if (Array.isArray(content)) return content.map((part) => textPart(part) ?? "").join("");
  return content == null ? "" : String(content);
}
