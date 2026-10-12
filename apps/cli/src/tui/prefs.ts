/** What the app remembers between runs: the chat model, the coding engine, the run profile. */
import { join } from "node:path";
import { readJsonFile, resolveCliPaths, writeJsonFile, type CliPaths } from "../paths.js";

export type Engine = "ensemble" | "claude-code" | "codex" | "cursor-agent";

export type Prefs = {
  /** `provider::model` for Ensemble Code's own replies, or null for the task tier's model. */
  chatModel: string | null;
  /** Who you work with (Chat and /run); null follows the run profile. */
  engine: Engine | null;
  /** The model Claude Code, Codex or Cursor uses in Chat and /run; null is the agent's own default. */
  agentModel: string | null;
  /** Run profile id or name; null is the default profile. */
  profileId: string | null;
  /** The last tab open. */
  tab: "tasks" | "chat";
  sidebar: boolean;
};

export const DEFAULT_PREFS: Prefs = { chatModel: null, engine: null, agentModel: null, profileId: null, tab: "tasks", sidebar: true };

const file = (paths: CliPaths) => join(paths.configDir, "app.json");

export async function loadPrefs(paths: CliPaths = resolveCliPaths()): Promise<Prefs> {
  const saved = (await readJsonFile<Partial<Prefs>>(file(paths)).catch(() => null)) ?? {};
  return { ...DEFAULT_PREFS, ...saved };
}

export async function savePrefs(prefs: Prefs, paths: CliPaths = resolveCliPaths()): Promise<void> {
  await writeJsonFile(file(paths), prefs);
}

export const ENGINE_LABEL: Record<Engine, string> = {
  ensemble: "Ensemble agent",
  "claude-code": "Claude Code",
  codex: "Codex",
  "cursor-agent": "Cursor agent",
};
