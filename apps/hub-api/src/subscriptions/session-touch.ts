/**
 * Whether someone used an Ensemble chat's agent session outside Ensemble (docs/41 §5): the person opened
 * it in the agent's own app or terminal and sent it prompts of their own. Read from the agent's own
 * transcript (never its credentials): how many prompts the session holds. Ensemble notes the count after
 * each of its turns (turn-sessions.ts `prompts`); a larger count before its next turn means prompts it did
 * not send, which are brought into Ensemble before it goes on in the same session (outside.ts). Read here
 * for Claude Code and GitHub Copilot, whose transcripts are plain files; Codex and the ACP agents count
 * their turns as they reopen the session (subscriptions/agents.ts).
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { SubscriptionProvider } from "@ensemble/shared-types";
import { copilotEventFromSubAgent } from "../workspace/engines/sub-agents.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
/** A transcript larger than this is not read through on every turn. */
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FOLDERS = 5000;

async function countLines(path: string, matches: (line: string) => boolean): Promise<number | null> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > MAX_BYTES) return null;
  let count = 0;
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) if (matches(line)) count += 1;
  return count;
}

type Block = { type?: unknown; text?: unknown };

/** What Claude Code writes as a user line that nobody typed: a command's echo, or a background sub-agent's result waking the session. */
const NOT_TYPED = /^<(?:(?:local-)?command-|task-notification>)/;

/**
 * A Claude Code transcript line that is a prompt: not a tool result, a command's echo, a hook's note, a
 * compaction summary, or a background sub-agent's result (`origin.kind: "task-notification"`), which wakes the
 * session as a user line of its own.
 */
export function claudePrompt(line: string): boolean {
  if (!line.includes('"user"')) return false;
  try {
    const entry = JSON.parse(line) as { type?: unknown; isMeta?: unknown; isCompactSummary?: unknown; isSidechain?: unknown; origin?: { kind?: unknown } | null; message?: { content?: unknown } };
    if (entry.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true || entry.isSidechain === true) return false;
    if (entry.origin?.kind === "task-notification") return false;
    const content = entry.message?.content;
    if (typeof content === "string") return !NOT_TYPED.test(content.trimStart());
    if (!Array.isArray(content)) return false;
    const blocks = content as Block[];
    const first = blocks.find((block) => block?.type === "text");
    return !!first && !(typeof first.text === "string" && NOT_TYPED.test(first.text.trimStart())) && !blocks.some((block) => block?.type === "tool_result");
  } catch {
    return false;
  }
}

/** A GitHub Copilot `events.jsonl` line that is a prompt: a `user.message`, but not a sub-agent's task (its envelope names the agent). */
export function copilotPrompt(line: string): boolean {
  if (!line.includes('"type":"user.message"')) return false;
  try {
    const event = JSON.parse(line) as { type?: unknown; agentId?: unknown; data?: Record<string, unknown> } | null;
    return event?.type === "user.message" && !copilotEventFromSubAgent(event);
  } catch {
    return false;
  }
}

/** Claude Code's folder for a working folder's sessions: every character but a letter or digit becomes "-". */
export const claudeProjectName = (folder: string): string => folder.replace(/[^a-zA-Z0-9]/g, "-");

/** Where Claude Code keeps this session's transcript: in its folder's project, else wherever it is found by id. */
export async function claudeTranscript(id: string, folder: string): Promise<string | null> {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  const direct = join(root, claudeProjectName(folder), `${id}.jsonl`);
  if (await stat(direct).then((info) => info.isFile(), () => false)) return direct;
  // Another spelling of the folder (a link resolved, another platform's rule): find the session by its id.
  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of names.slice(0, MAX_FOLDERS)) {
    const path = join(root, name, `${id}.jsonl`);
    if (await stat(path).then((info) => info.isFile(), () => false)) return path;
  }
  return null;
}

/** GitHub Copilot's events of this session. */
export const copilotEvents = (id: string): string => join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "session-state", id, "events.jsonl");

/** How many prompts the agent's own transcript of this session holds; null when that cannot be read here. */
export async function sessionPrompts(agent: SubscriptionProvider, id: string, folder: string): Promise<number | null> {
  if (!ID.test(id)) return null;
  if (agent === "copilot-cli") return countLines(copilotEvents(id), copilotPrompt);
  if (agent === "claude-code") {
    const path = await claudeTranscript(id, folder);
    return path ? countLines(path, claudePrompt) : null;
  }
  return null;
}
