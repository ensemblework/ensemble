/** What the app remembers between runs: the chat model, the coding engine, the run profile. */
import { join } from "node:path";
import { ENGINE_LABELS, type CodeEngine, type ContextTier } from "@ensemble/shared-types";
import { readJsonFile, resolveCliPaths, writeJsonFile, type CliPaths } from "../paths.js";

export type Engine = "ensemble" | CodeEngine;

export const TABS = ["tasks", "chat", "node"] as const;
export type Tab = (typeof TABS)[number];

export type Prefs = {
  /** `provider::model` for Ensemble Code's own replies, or null for the task tier's model. */
  chatModel: string | null;
  /** Who you work with (Chat and /run); null follows the run profile. */
  engine: Engine | null;
  /** The model Claude Code, Codex, Cursor or GitHub Copilot uses in Chat (and Copilot's in /run); null is the agent's own default. */
  agentModel: string | null;
  /** GitHub Copilot's thinking level for that model, one of the model's own; null is the model's default. */
  agentEffort: string | null;
  /** GitHub Copilot's context window for that model: "long_context", or null for the standard one. */
  agentContext: ContextTier | null;
  /** Run profile id or name; null is the default profile. */
  profileId: string | null;
  /** The last tab open. */
  tab: Tab;
  sidebar: boolean;
};

export const DEFAULT_PREFS: Prefs = { chatModel: null, engine: null, agentModel: null, agentEffort: null, agentContext: null, profileId: null, tab: "tasks", sidebar: true };

const file = (paths: CliPaths) => join(paths.configDir, "app.json");

export async function loadPrefs(paths: CliPaths = resolveCliPaths()): Promise<Prefs> {
  const saved = (await readJsonFile<Partial<Prefs>>(file(paths)).catch(() => null)) ?? {};
  const prefs = { ...DEFAULT_PREFS, ...saved };
  return TABS.includes(prefs.tab) ? prefs : { ...prefs, tab: DEFAULT_PREFS.tab };
}

export async function savePrefs(prefs: Prefs, paths: CliPaths = resolveCliPaths()): Promise<void> {
  await writeJsonFile(file(paths), prefs);
}

export const ENGINE_LABEL: Record<Engine, string> = {
  ensemble: "Ensemble agent",
  "claude-code": "Claude Code",
  codex: "Codex",
  "cursor-agent": "Cursor agent",
  "copilot-cli": ENGINE_LABELS["copilot-cli"],
};
