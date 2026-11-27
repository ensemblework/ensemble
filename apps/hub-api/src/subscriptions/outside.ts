/**
 * What the person did in an agent's own app in a session Ensemble owns (docs/41 §5): read the next time
 * Ensemble uses the session, never watched. Ensemble notes how many prompts a session holds after each of
 * its turns (turn-sessions.ts `prompts`, session-touch.ts); the exchanges after that count are the person's,
 * brought into Ensemble before Ensemble's next message, and the session goes on.
 *
 * Where each agent keeps them: Claude Code's transcript (`~/.claude/projects/<folder>/<id>.jsonl`), GitHub
 * Copilot's `session-state/<id>/events.jsonl`, Codex's thread (`thread/read` on its app-server), and an ACP
 * agent's history as it replays it on `session/load`. Only the words and a line for the tool calls come in,
 * never a tool's output, at most `MAX_OUTSIDE_TURNS` exchanges and `MAX_OUTSIDE_CHARS` characters.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { SubscriptionProvider } from "@ensemble/shared-types";
import { copilotEventFromSubAgent } from "../workspace/engines/sub-agents.js";
import { claudePrompt, claudeTranscript, copilotEvents, copilotPrompt } from "./session-touch.js";

/** One exchange in the agent's app: the person's message, the agent's answer, a line for its tool calls, the files it changed (where the agent names them), and when (ISO). */
export type OutsideTurn = { prompt: string; answer: string; tools?: string; files?: string[]; at?: string };

/**
 * What came in from the agent's app since Ensemble's last turn: where (`app`, read after "In ": "the Claude
 * app"), the newest exchanges, and how many earlier ones were left out.
 */
export type Outside = { app: string; turns: OutsideTurn[]; earlier: number };

export const MAX_OUTSIDE_TURNS = 20;
export const MAX_OUTSIDE_CHARS = 20_000;
/** At most this many updates of a replayed ACP session are kept to read what the person added; a longer history is not read. */
export const MAX_REPLAYED = 50_000;
/** One message brought in is cut to this. */
const MAX_PART = 4_000;
/** A transcript larger than this is not read. */
const MAX_BYTES = 64 * 1024 * 1024;

/** An exchange's tool calls: every edit (`files`, named or not), the paths named (`named`), commands and other tools. */
type Tally = { files: Set<string>; named?: Set<string>; commands: number; other: number };
const tally = (): Tally => ({ files: new Set(), named: new Set(), commands: 0, other: 0 });
/** The tool line and the files named, as an exchange carries them. */
const toolsOf = (counted: Tally): Pick<OutsideTurn, "tools" | "files"> => {
  const tools = toolLine(counted);
  const files = [...(counted.named ?? [])].slice(0, 20);
  return { ...(tools ? { tools } : {}), ...(files.length ? { files } : {}) };
};
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "Edited 2 files, ran 3 commands": the tool calls of one exchange in one line; none for a turn without any. */
export function toolLine(counted: Tally): string | undefined {
  const parts = [
    counted.files.size ? `edited ${plural(counted.files.size, "file")}` : "",
    counted.commands ? `ran ${plural(counted.commands, "command")}` : "",
    counted.other ? `used ${plural(counted.other, counted.files.size || counted.commands ? "other tool" : "tool")}` : "",
  ].filter(Boolean);
  if (!parts.length) return undefined;
  const line = parts.join(", ");
  return line[0]!.toUpperCase() + line.slice(1);
}

const EDITS = /^(?:edit|multi_?edit|write|notebook_?edit|str_replace(?:_based_edit_tool|_editor)?|create(?:_file)?|apply_patch|edit_file|write_file|replace|delete_file)$/i;
const COMMANDS = /^(?:bash|shell|run_?terminal_?cmd|run_in_terminal|terminal|exec(?:ute)?(?:_command)?|command|powershell)$/i;

/** Counts one tool call by its name and input: an edit (with its file), a command, or another tool. */
function count(into: Tally, name: string, input: unknown): void {
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (EDITS.test(name)) {
    const path = [args.file_path, args.path, args.notebook_path, args.filePath, args.target_file].find((value) => typeof value === "string" && value);
    into.files.add(typeof path === "string" ? path : `${name}-${into.files.size}`);
    if (typeof path === "string") into.named?.add(path);
  } else if (COMMANDS.test(name)) into.commands += 1;
  else into.other += 1;
}

const cut = (text: string) => {
  const clean = text.replace(/\r/g, "").trim();
  return clean.length > MAX_PART ? `${clean.slice(0, MAX_PART - 1)}…` : clean;
};

/** The exchanges after the first `since` ones, the newest that fit, and how many earlier ones were left out. */
export function newestAfter(turns: OutsideTurn[], since: number): { turns: OutsideTurn[]; earlier: number } {
  const after = turns.slice(Math.max(0, since)).map((turn) => ({ ...turn, prompt: cut(turn.prompt), answer: cut(turn.answer) }));
  const kept: OutsideTurn[] = [];
  let chars = 0;
  for (let index = after.length - 1; index >= 0 && kept.length < MAX_OUTSIDE_TURNS; index -= 1) {
    const turn = after[index]!;
    const size = turn.prompt.length + turn.answer.length;
    if (kept.length && chars + size > MAX_OUTSIDE_CHARS) break;
    kept.unshift(turn);
    chars += size;
  }
  return { turns: kept, earlier: after.length - kept.length };
}

async function* lines(path: string): AsyncGenerator<string> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > MAX_BYTES) return;
  yield* createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
}

const parse = (line: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
          .filter(Boolean)
          .join("\n")
      : "";

/** Where a Claude Code prompt was typed, from its transcript's `entrypoint`. */
export function claudeApp(entrypoint: unknown): string {
  if (typeof entrypoint !== "string") return "Claude Code";
  if (entrypoint.startsWith("claude-desktop")) return "the Claude app";
  if (entrypoint === "claude-vscode") return "VS Code";
  if (entrypoint.startsWith("claude-jetbrains")) return "JetBrains";
  if (entrypoint === "cli") return "Claude Code in a terminal";
  return "Claude Code";
}

/**
 * Claude Code's transcript as exchanges, one per prompt as session-touch.ts counts them (`claudePrompt`): the
 * answer is the last text the agent wrote before the next prompt. `app` is where the first prompt after `since` was typed.
 */
export async function claudeTurns(path: string, since = 0): Promise<{ turns: OutsideTurn[]; app: string }> {
  const turns: OutsideTurn[] = [];
  let current: { turn: OutsideTurn; tools: Tally } | null = null;
  let app = "Claude Code";
  const close = () => {
    if (!current) return;
    turns.push({ ...current.turn, ...toolsOf(current.tools) });
    current = null;
  };
  for await (const line of lines(path)) {
    if (claudePrompt(line)) {
      close();
      const entry = parse(line) ?? {};
      const message = (entry.message ?? {}) as { content?: unknown };
      if (turns.length === since) app = claudeApp(entry.entrypoint);
      current = { turn: { prompt: textOf(message.content), answer: "", ...(typeof entry.timestamp === "string" ? { at: entry.timestamp } : {}) }, tools: tally() };
      continue;
    }
    if (!current || !line.includes('"assistant"')) continue;
    const entry = parse(line);
    if (!entry || entry.type !== "assistant" || entry.isSidechain === true) continue;
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    const said = textOf(content);
    if (said.trim()) (current as { turn: OutsideTurn }).turn.answer = said;
    for (const block of content as Array<{ type?: unknown; name?: unknown; input?: unknown }>) if (block?.type === "tool_use" && typeof block.name === "string") count((current as { tools: Tally }).tools, block.name, block.input);
  }
  close();
  return { turns, app };
}

/**
 * GitHub Copilot's `events.jsonl` as exchanges, one per prompt as session-touch.ts counts them (`copilotPrompt`).
 * A sub-agent's task and messages (Copilot's task tool) are not an exchange or its answer; its tool calls are the exchange's work.
 */
export async function copilotTurns(path: string): Promise<OutsideTurn[]> {
  const turns: OutsideTurn[] = [];
  let current: { turn: OutsideTurn; tools: Tally } | null = null;
  const close = () => {
    if (!current) return;
    turns.push({ ...current.turn, ...toolsOf(current.tools) });
    current = null;
  };
  for await (const line of lines(path)) {
    if (!line.includes('"type":"user.message"') && !line.includes('"type":"assistant.message"') && !line.includes('"type":"tool.execution_start"')) continue;
    const event = parse(line);
    const data = (event?.data ?? {}) as Record<string, unknown>;
    const sub = !!event && copilotEventFromSubAgent(event);
    if (event?.type === "user.message") {
      if (!copilotPrompt(line)) continue;
      close();
      current = { turn: { prompt: typeof data.content === "string" ? data.content : "", answer: "", ...(typeof event.timestamp === "string" ? { at: event.timestamp } : {}) }, tools: tally() };
    } else if (current && event?.type === "assistant.message" && !sub && typeof data.content === "string" && data.content.trim()) current.turn.answer = data.content;
    else if (current && event?.type === "tool.execution_start" && typeof data.toolName === "string") count(current.tools, data.toolName, data.arguments);
  }
  close();
  return turns;
}

type CodexItem = { type?: unknown; content?: unknown; text?: unknown; phase?: unknown; changes?: unknown; startedAtMs?: unknown };
type CodexTurn = { items?: CodexItem[]; startedAt?: unknown };

/** Codex's thread (`thread/read` with its turns) as exchanges, one per turn. */
export function codexTurns(thread: { turns?: CodexTurn[] } | null | undefined): OutsideTurn[] {
  return (thread?.turns ?? []).map((turn) => {
    const counted = tally();
    let prompt = "";
    let answer = "";
    let final = "";
    let at: string | undefined;
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        prompt = [prompt, textOf(item.content)].filter(Boolean).join("\n");
        if (!at && typeof item.startedAtMs === "number") at = new Date(item.startedAtMs).toISOString();
      } else if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        answer = item.text;
        if (item.phase === "final_answer") final = item.text;
      } else if (item.type === "commandExecution") counted.commands += 1;
      else if (item.type === "fileChange")
        for (const change of Array.isArray(item.changes) ? (item.changes as Array<{ path?: unknown }>) : []) {
          counted.files.add(String(change?.path ?? counted.files.size));
          if (typeof change?.path === "string") counted.named?.add(change.path);
        }
      else if (typeof item.type === "string" && /ToolCall$|^webSearch$/.test(item.type)) counted.other += 1;
    }
    if (!at && typeof turn.startedAt === "number") at = new Date(turn.startedAt < 1e12 ? turn.startedAt * 1000 : turn.startedAt).toISOString();
    return { prompt, answer: final || answer, ...toolsOf(counted), ...(at ? { at } : {}) };
  });
}

/**
 * An ACP agent's history as `session/load` replays it (`session/update` params, in order) as exchanges: the
 * person's message chunks until the agent answers or uses a tool are one prompt, the agent's last run of
 * message chunks its answer.
 */
export function acpTurns(updates: Array<Record<string, unknown>>): OutsideTurn[] {
  const turns: OutsideTurn[] = [];
  let current: { turn: OutsideTurn; tools: Tally } | null = null;
  let last = "";
  const close = () => {
    if (!current) return;
    turns.push({ ...current.turn, ...toolsOf(current.tools) });
    current = null;
  };
  for (const params of updates) {
    const update = (params.update ?? params) as { sessionUpdate?: unknown; content?: unknown; kind?: unknown; locations?: unknown; title?: unknown };
    const kind = update.sessionUpdate;
    const text = update.content && typeof update.content === "object" && (update.content as { type?: unknown }).type === "text" ? String((update.content as { text?: unknown }).text ?? "") : "";
    if (kind === "user_message_chunk") {
      // A prompt comes in pieces, maybe with other updates between them: a new exchange starts once the agent has answered.
      const answered = current && (current.turn.answer || current.tools.files.size || current.tools.commands || current.tools.other);
      if (!current || answered) {
        close();
        current = { turn: { prompt: "", answer: "" }, tools: tally() };
      }
      current!.turn.prompt += text;
    } else if (current && kind === "agent_message_chunk") {
      current.turn.answer = last === "agent_message_chunk" ? current.turn.answer + text : text;
    } else if (current && kind === "tool_call") {
      const paths = Array.isArray(update.locations) ? (update.locations as Array<{ path?: unknown }>).map((place) => place?.path).filter((path): path is string => typeof path === "string") : [];
      if (update.kind === "edit" || update.kind === "delete" || update.kind === "move") {
        for (const path of paths.length ? paths : [`${String(update.title ?? "file")}-${current.tools.files.size}`]) current.tools.files.add(path);
        for (const path of paths) current.tools.named?.add(path);
      }
      else if (update.kind === "execute") current.tools.commands += 1;
      else current.tools.other += 1;
    }
    if (typeof kind === "string" && kind !== "tool_call_update") last = kind;
  }
  close();
  return turns;
}

/**
 * How many prompts an ACP session holds once `sent` more follow the history it replayed, counted as `acpTurns`
 * will count them in its next replay: a prompt the agent left unanswered (a run that failed) and the next one
 * come back as one exchange.
 */
export function acpPrompts(history: OutsideTurn[], sent: number): number {
  const last = history.at(-1);
  return history.length + sent - (sent > 0 && last && !last.answer && !last.tools ? 1 : 0);
}

/** The agent's app as a chat says it: "In GitHub Copilot". Claude Code says where each prompt was typed. */
export const OUTSIDE_APPS: Partial<Record<SubscriptionProvider, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "copilot-cli": "GitHub Copilot",
  "cursor-agent": "Cursor",
  "grok-cli": "Grok Build",
  opencode: "OpenCode",
  "gemini-cli": "Gemini CLI",
  "mistral-vibe": "Mistral Vibe",
  "qwen-code": "Qwen Code",
  "kimi-code": "Kimi Code",
};

/** What came in, from exchanges counted the way the session's prompts are, after Ensemble's `since`; null when nothing did. */
export function outsideOf(app: string, turns: OutsideTurn[], since: number | undefined): Outside | null {
  if (since === undefined || turns.length <= since) return null;
  return { app, ...newestAfter(turns, since) };
}

/**
 * What the person added in the agent's own app since Ensemble's last turn, read from the agent's transcript
 * file (Claude Code, GitHub Copilot); null when nothing was, or it cannot be read here.
 */
export async function readOutside(agent: SubscriptionProvider, id: string, folder: string, since: number): Promise<Outside | null> {
  if (agent === "claude-code") {
    const path = await claudeTranscript(id, folder);
    if (!path) return null;
    const read = await claudeTurns(path, since);
    return outsideOf(read.app, read.turns, since);
  }
  if (agent === "copilot-cli") return outsideOf(OUTSIDE_APPS["copilot-cli"]!, await copilotTurns(copilotEvents(id)), since);
  return null;
}
