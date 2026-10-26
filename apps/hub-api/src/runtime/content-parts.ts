/**
 * Pictures and files in model messages. hub-api writes user content as OpenAI chat parts
 * (`{type:"text"}`, `{type:"image_url", image_url:{url:"data:…;base64,…"}}` and
 * `{type:"file", file:{filename, file_data:"data:…;base64,…"}}`); chat-compatible providers take
 * them as they are, and these helpers rewrite them for the Anthropic Messages and OpenAI Responses
 * APIs. The Python runtime mirrors this in ensemble_agent/content_parts.py. Callers add them only
 * for a model that reads them (lib/vision.ts).
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

/** A file part (chat `file`, Responses `input_file`, Anthropic `document`) as name and data URL. */
function fileOf(part: Json): { filename: string; data: string } | null {
  if (part.type === "file" && part.file && typeof part.file === "object") {
    const file = part.file as Json;
    if (typeof file.file_data === "string") return { filename: String(file.filename ?? "file"), data: file.file_data };
  }
  if (part.type === "input_file" && typeof part.file_data === "string") return { filename: String(part.filename ?? "file"), data: part.file_data };
  if (part.type === "document" && part.source && typeof part.source === "object") {
    const source = part.source as Json;
    const filename = String(part.title ?? "file");
    if (source.type === "base64" && typeof source.data === "string") return { filename, data: `data:${String(source.media_type)};base64,${source.data}` };
    if (source.type === "text" && typeof source.data === "string") return { filename, data: `data:text/plain;base64,${Buffer.from(source.data, "utf8").toString("base64")}` };
  }
  return null;
}

export function hasFileParts(content: unknown): boolean {
  return Array.isArray(content) && content.some((part) => part && typeof part === "object" && fileOf(part as Json) !== null);
}

/** Pictures or files: content that must keep its parts on the way to a provider. */
export function hasAttachmentParts(content: unknown): boolean {
  return hasImageParts(content) || hasFileParts(content);
}

const TEXT_MEDIA = /^(text\/|application\/(json|xml|x-ndjson))/i;

/** A file as an Anthropic block: text as a text document, anything else as a base64 document with its own media type (the API decides). */
function anthropicFileBlock(file: { filename: string; data: string }): Json {
  const data = DATA_URL.exec(file.data);
  const mime = data?.[1]?.toLowerCase() ?? "";
  if (data && TEXT_MEDIA.test(mime)) return { type: "document", source: { type: "text", media_type: "text/plain", data: Buffer.from(data[2]!, "base64").toString("utf8") }, title: file.filename };
  if (data) return { type: "document", source: { type: "base64", media_type: mime, data: data[2] }, title: file.filename };
  return { type: "text", text: `[${file.filename} could not be read from its data.]` };
}

/** User content for the Anthropic Messages API: text and image blocks, or the plain string. */
export function anthropicUserContent(content: unknown): string | Json[] {
  if (!hasAttachmentParts(content)) return textOfParts(content);
  const blocks: Json[] = [];
  for (const raw of content as unknown[]) {
    if (raw && typeof raw === "object" && ((raw as Json).type === "image" || (raw as Json).type === "document")) {
      blocks.push(raw as Json);
      continue;
    }
    const file = raw && typeof raw === "object" ? fileOf(raw as Json) : null;
    if (file) {
      blocks.push(anthropicFileBlock(file));
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
  if (!hasAttachmentParts(content)) return textOfParts(content);
  const parts: Json[] = [];
  for (const raw of content as unknown[]) {
    const file = raw && typeof raw === "object" ? fileOf(raw as Json) : null;
    if (file) {
      parts.push({ type: "input_file", filename: file.filename, file_data: file.data });
      continue;
    }
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
