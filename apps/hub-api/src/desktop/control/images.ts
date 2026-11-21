/**
 * Pictures for an agent run by its own CLI (a coding run, or an assistant turn on the owner's own
 * subscription): its MCP server (scripts/ensemble-ask-mcp.mjs) gets tool answers as text. A desktop
 * tool's answer names its screenshot by a marker line (text.ts `imageMarker`); on the computer that took
 * the screenshot, this adds the picture as an `ensemble-image:` line, which the MCP server turns into an
 * image for the agent. Elsewhere (the screenshot was taken on another computer) the marker stays text.
 */
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopDataDir } from "./index.js";
import { IMAGE_MARKER } from "./text.js";

export const IMAGE_LINE = "ensemble-image:";
const MAX_BYTES = 5 * 1024 * 1024;
/** A screenshot older than this is not attached: the marker came from an older answer. */
const FRESH_MS = 30 * 60_000;

function mimeOf(bytes: Buffer): "image/png" | "image/jpeg" | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

/** The answer with its screenshots added as image lines, at most three. */
export async function withDesktopImages<T extends { text: string }>(answer: T, dir: string = join(desktopDataDir(), "captures"), now = Date.now()): Promise<T> {
  if (typeof answer?.text !== "string" || !answer.text.includes("[desktop screenshot cap_")) return answer;
  const ids = [...new Set([...answer.text.matchAll(IMAGE_MARKER)].map((match) => match[1]!))].slice(0, 3);
  const lines: string[] = [];
  for (const id of ids) {
    for (const extension of ["jpg", "png"]) {
      const path = join(dir, `${id}.${extension}`);
      const info = await lstat(path).catch(() => null);
      if (!info?.isFile() || info.size > MAX_BYTES || now - info.mtimeMs > FRESH_MS) continue;
      const bytes = await readFile(path).catch(() => null);
      const mime = bytes ? mimeOf(bytes) : null;
      if (!bytes || !mime) continue;
      lines.push(`${IMAGE_LINE}data:${mime};base64,${bytes.toString("base64")}`);
      break;
    }
  }
  return lines.length ? { ...answer, text: `${answer.text}\n${lines.join("\n")}` } : answer;
}
