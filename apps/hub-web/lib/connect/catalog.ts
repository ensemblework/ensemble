export const APP_IDS = [
  "vscode",
  "cursor",
  "windsurf",
  "claude-desktop",
  "claude-code",
  "codex",
  "gemini",
  "copilot-cli",
  "zed",
  "visual-studio",
  "jetbrains",
  "cline",
  "continue",
  "opencode",
] as const;

export type AppId = (typeof APP_IDS)[number];

export type AppCard = {
  id: AppId;
  name: string;
  get: string;
  setupId: string;
};

export const APPS: AppCard[] = [
  {
    id: "vscode",
    name: "VS Code",
    get: "GitHub Copilot in Visual Studio Code can look up your tasks, people, and today’s plan.",
    setupId: "vscode",
  },
  {
    id: "cursor",
    name: "Cursor",
    get: "Cursor’s agent can see the task behind the branch you have open.",
    setupId: "cursor",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    get: "Windsurf’s Cascade agent can read your deliverables, meetings, and notes.",
    setupId: "windsurf",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    get: "Claude Code in the terminal can read your projects, skills, and open decisions.",
    setupId: "claude-code",
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    get: "The Claude app on your computer can answer from your Ensemble, not only from the chat.",
    setupId: "claude-desktop",
  },
  {
    id: "codex",
    name: "Codex & ChatGPT",
    get: "Codex in the terminal, the Codex editor extension, and the ChatGPT desktop app share one setup.",
    setupId: "codex",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    get: "Gemini CLI can read Ensemble context before it answers in your terminal.",
    setupId: "gemini",
  },
  {
    id: "copilot-cli",
    name: "GitHub Copilot CLI",
    get: "The Copilot terminal app can read the same Ensemble context while you work in a folder.",
    setupId: "copilot-cli",
  },
  {
    id: "zed",
    name: "Zed",
    get: "Zed’s agent can look up people, projects, and what you decided.",
    setupId: "zed",
  },
  {
    id: "visual-studio",
    name: "Visual Studio",
    get: "Visual Studio 2022 can use Ensemble as a read-only MCP source for code context.",
    setupId: "visual-studio",
  },
  {
    id: "jetbrains",
    name: "JetBrains",
    get: "AI Assistant in IntelliJ, PyCharm, WebStorm, and the other JetBrains apps can read Ensemble.",
    setupId: "jetbrains",
  },
  {
    id: "cline",
    name: "Cline",
    get: "Cline, in the editor or the terminal, can look up your Ensemble before it answers.",
    setupId: "cline",
  },
  {
    id: "continue",
    name: "Continue",
    get: "Continue’s agent mode can read Ensemble from VS Code or a JetBrains IDE.",
    setupId: "continue",
  },
  {
    id: "opencode",
    name: "opencode",
    get: "opencode can use either the local Ensemble CLI server or the hosted URL.",
    setupId: "opencode",
  },
];

const ALIASES: Record<string, AppId> = {
  copilot: "copilot-cli",
};

export function normalizeAppId(value: string): AppId | undefined {
  if ((APP_IDS as readonly string[]).includes(value)) return value as AppId;
  return ALIASES[value];
}

export function isAppId(value: string): value is AppId {
  return normalizeAppId(value) !== undefined;
}

export function appById(id: string): AppCard | undefined {
  const normalized = normalizeAppId(id);
  return normalized ? APPS.find((app) => app.id === normalized) : undefined;
}
