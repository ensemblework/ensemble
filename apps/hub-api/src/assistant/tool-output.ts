/**
 * Long tool output kept outside the model's context for one turn (docs/11, Turn limits). A result
 * over the turn's inline budget shows its start and end in place; the whole of it stays here as
 * `out_<n>`, for read_tool_output to read in parts or search. In memory only, for the turn, at most
 * `maxChars` in all: past that the oldest goes, and reading it says so.
 */
import { z } from "zod";
import { headAndTailParts, stripLoneSurrogates } from "../lib/text.js";
import { defineTool, toolOk, ToolBlockedError, type AnyHubTool } from "./types.js";

export const READ_TOOL_OUTPUT = "read_tool_output";

type Kept = { tool: string; text: string; chars: number; lines: number; partial: boolean };

export interface KeptOutput {
  id: string;
  /** Characters of the whole output, and the lines of what was kept. */
  chars: number;
  lines: number;
  /** Only the first `maxChars` of a larger output are kept. */
  partial: boolean;
  /** Ids dropped to make room for this one. */
  dropped: string[];
}

const lineCount = (text: string): number => {
  let lines = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) lines += 1;
  return lines;
};

const number = (value: number): string => value.toLocaleString("en-US");

/** "182 KB", "3.4 MB", "900 characters". */
export function sizeWords(chars: number): string {
  if (chars < 1_000) return `${number(chars)} characters`;
  if (chars < 1_000_000) return `${Math.round(chars / 1_000)} KB`;
  return `${(chars / 1_000_000).toFixed(1)} MB`;
}

export class TurnOutputs {
  private readonly kept = new Map<string, Kept>();
  private readonly gone = new Set<string>();
  private total = 0;
  private next = 1;

  constructor(
    /** Characters of one result the model sees in place. */
    readonly inlineChars: number,
    /** Characters kept for the whole turn. */
    readonly maxChars: number,
  ) {}

  /** Whether anything was kept: read_tool_output joins the turn's tools from then on. */
  get used(): boolean {
    return this.next > 1;
  }

  /** Outputs kept in this turn, dropped ones included. */
  get count(): number {
    return this.next - 1;
  }

  /** Keeps a whole output and names it. The oldest kept outputs go when the turn's total would pass `maxChars`. */
  keep(tool: string, whole: string): KeptOutput {
    const id = `out_${this.next}`;
    this.next += 1;
    const text = stripLoneSurrogates(whole.length > this.maxChars ? whole.slice(0, this.maxChars) : whole);
    const dropped: string[] = [];
    for (const [oldId, old] of this.kept) {
      if (this.total + text.length <= this.maxChars) break;
      this.kept.delete(oldId);
      this.gone.add(oldId);
      this.total -= old.text.length;
      dropped.push(oldId);
    }
    const lines = lineCount(text);
    const partial = text.length < whole.length;
    this.kept.set(id, { tool, text, chars: whole.length, lines, partial });
    this.total += text.length;
    return { id, chars: whole.length, lines, partial, dropped };
  }

  /**
   * A result too long to show in place: its start and end, and where the rest is. `text` is what was
   * kept; a list result is cut at whole items by the caller instead.
   */
  offload(tool: string, text: string): Record<string, unknown> {
    const kept = this.keep(tool, text);
    const { head, tail } = headAndTailParts(text, Math.max(1_000, this.inlineChars - 700));
    const end = text.length - tail.length;
    const shown = tail ? `It shows characters 0 to ${number(head.length)} and ${number(end)} to ${number(text.length)}.` : "";
    const room = kept.dropped.length ? ` To make room, ${kept.dropped.join(", ")} ${kept.dropped.length === 1 ? "is" : "are"} no longer kept.` : "";
    const first = kept.partial ? ` Only its first ${sizeWords(this.maxChars)} are kept.` : "";
    return {
      truncated: true,
      output: kept.id,
      note: `Too long to show whole: the full result is kept as ${kept.id} (${sizeWords(kept.chars)}, ${number(kept.lines)} lines).${first} ${shown} Read the rest with ${READ_TOOL_OUTPUT}: id "${kept.id}" with offset and length in characters, or grep with words to find and context lines around each match.${room}`.replace(/\s+/g, " ").trim(),
      preview: `${head}\n… [${number(end - head.length)} characters not shown] …\n${tail}`,
    };
  }

  /** Part of a kept output: from `offset`, or the lines with `grep` and `context` lines around each. */
  read(id: string, request: { offset?: number; length?: number; grep?: string; context?: number }): { summary: string; data: Record<string, unknown> } {
    const entry = this.kept.get(id);
    if (!entry) {
      if (this.gone.has(id)) {
        throw new ToolBlockedError(`${id} is no longer kept: a turn keeps only its newest ${sizeWords(this.maxChars)} of long output.`, "Call the tool that made it again if you still need it.");
      }
      throw new ToolBlockedError(`There is no output called ${id} in this turn.`, "Use the id a cut result named (out_1, out_2…).");
    }
    const room = Math.max(500, Math.floor(this.inlineChars * 0.7));
    const partial = entry.partial ? { kept: `Only the first ${sizeWords(entry.text.length)} of this output were kept.` } : {};
    if (request.grep?.trim()) return grepOutput(id, entry, request.grep.trim(), request.context ?? 2, room, partial);
    const offset = Math.min(Math.max(0, request.offset ?? 0), entry.text.length);
    let slice = entry.text.slice(offset, offset + Math.min(request.length ?? room, room));
    // The part goes back as JSON: escaped characters must fit the room too.
    while (slice.length > 1 && JSON.stringify(slice).length > room) slice = slice.slice(0, Math.floor(slice.length * 0.9));
    const end = offset + slice.length;
    return {
      summary: `Read ${id}: characters ${number(offset)} to ${number(end)} of ${number(entry.text.length)}`,
      data: { id, tool: entry.tool, offset, end, size: entry.text.length, text: stripLoneSurrogates(slice), ...(end < entry.text.length ? { next: end } : { done: true }), ...partial },
    };
  }
}

function grepOutput(id: string, entry: Kept, words: string, context: number, room: number, extra: Record<string, unknown>): { summary: string; data: Record<string, unknown> } {
  const lines = entry.text.split("\n");
  const needle = words.toLowerCase();
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  const hits = lines.flatMap((line, index) => (line.toLowerCase().includes(needle) ? [index] : []));
  const blocks: string[] = [];
  let used = 0;
  let shown = 0;
  let last = -1;
  for (const hit of hits) {
    const from = Math.max(hit - context, last + 1);
    const to = Math.min(lines.length - 1, hit + context);
    const block = [];
    for (let index = from; index <= to; index += 1) block.push(`${index === hit ? ">" : " "}${index + 1} @${starts[index]}: ${lines[index]!.slice(0, 400)}`);
    const text = `${from > last + 1 && blocks.length ? "…\n" : ""}${block.join("\n")}`;
    if (used + text.length + 64 > room) break;
    blocks.push(text);
    used += text.length + 1;
    shown += 1;
    last = to;
  }
  const summary = hits.length ? `${hits.length} line${hits.length === 1 ? "" : "s"} in ${id} with “${words}”` : `Nothing in ${id} has “${words}”`;
  return {
    summary,
    data: {
      id,
      tool: entry.tool,
      grep: words,
      matches: hits.length,
      shown,
      text: blocks.join("\n") || "No matches.",
      note: "Each line reads: line number, @ the character offset where it starts, then the line (> marks a match). Read around one with offset and length.",
      ...(shown < hits.length ? { more: `${hits.length - shown} more not shown: grep for something narrower.` } : {}),
      ...extra,
    },
  };
}

/** The whole of a result as text to read in parts: JSON, with long text fields written out on their own lines. */
export function readableText(data: unknown): string {
  if (typeof data === "string") return data;
  const blocks: string[] = [];
  const json = JSON.stringify(
    data,
    (_key, value: unknown) => {
      if (typeof value !== "string" || !value.includes("\n")) return value;
      blocks.push(value);
      return `@@text-block-${blocks.length - 1}@@`;
    },
    2,
  );
  if (json === undefined) return "";
  return json.replace(/"@@text-block-(\d+)@@"/g, (match, index: string) => {
    const block = blocks[Number(index)];
    return block === undefined ? match : `\n${block}\n`;
  });
}

/** read_tool_output, for one turn's kept outputs: offered once the turn has kept one. */
export function readToolOutputTool(outputs: TurnOutputs): AnyHubTool {
  return defineTool({
    name: READ_TOOL_OUTPUT,
    area: "context",
    description:
      "Read more of a tool result that was too long to show whole. id: the out_N its note named. Either offset and length (characters; the note says which parts are shown), or grep: words to find, with context lines around each matching line.",
    input: z.object({
      id: z.string().regex(/^out_\d+$/, "An id like out_1."),
      offset: z.number().int().min(0).optional(),
      length: z.number().int().min(1).optional(),
      grep: z.string().max(200).optional(),
      context: z.number().int().min(0).max(20).optional(),
    }),
    isWrite: false,
    parallelSafe: true,
    risk: "low",
    async run(_ctx, input) {
      const part = outputs.read(input.id, input);
      return toolOk(part.summary, part.data);
    },
  });
}
