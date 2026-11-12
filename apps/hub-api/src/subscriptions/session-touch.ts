/**
 * Whether someone used an Ensemble chat's agent session outside Ensemble (docs/30 §8): the person
 * opened it in the agent's own app or terminal and sent it prompts of their own. Read from the agent's
 * own transcript (never its credentials): how many prompts the session holds. Ensemble notes the count
 * after each of its turns (turn-sessions.ts `prompts`); a larger count before its next turn means
 * prompts it did not send, and the chat goes on in a new session with Ensemble's own history, so what
 * was said there never enters Ensemble's chat. Known for Claude Code and GitHub Copilot, whose
 * transcripts are plain files; with any other agent, or a transcript Ensemble cannot find, the session
 * is resumed as before.
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { SubscriptionProvider } from "@ensemble/shared-types";

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

type Block = { type?: unknown };

/** A Claude Code transcript line that is a prompt (not a tool result, a command's echo, a hook's note or a compaction summary). */
export function claudePrompt(line: string): boolean {
  if (!line.includes('"user"')) return false;
  try {
    const entry = JSON.parse(line) as { type?: unknown; isMeta?: unknown; isCompactSummary?: unknown; isSidechain?: unknown; message?: { content?: unknown } };
    if (entry.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true || entry.isSidechain === true) return false;
    const content = entry.message?.content;
    if (typeof content === "string") return !/^<(local-)?command-/.test(content.trimStart());
    if (!Array.isArray(content)) return false;
    const blocks = content as Block[];
    return blocks.some((block) => block?.type === "text") && !blocks.some((block) => block?.type === "tool_result");
  } catch {
    return false;
  }
}

/** A GitHub Copilot `events.jsonl` line that is a prompt. */
export const copilotPrompt = (line: string): boolean => line.includes('"type":"user.message"');

/** Claude Code's folder for a working folder's sessions: every character but a letter or digit becomes "-". */
export const claudeProjectName = (folder: string): string => folder.replace(/[^a-zA-Z0-9]/g, "-");

async function claudeTranscript(id: string, folder: string): Promise<string | null> {
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

/** How many prompts the agent's own transcript of this session holds; null when that cannot be read here. */
export async function sessionPrompts(agent: SubscriptionProvider, id: string, folder: string): Promise<number | null> {
  if (!ID.test(id)) return null;
  if (agent === "copilot-cli") return countLines(join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "session-state", id, "events.jsonl"), copilotPrompt);
  if (agent === "claude-code") {
    const path = await claudeTranscript(id, folder);
    return path ? countLines(path, claudePrompt) : null;
  }
  return null;
}
