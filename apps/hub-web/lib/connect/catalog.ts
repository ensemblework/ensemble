export const APP_IDS = [
  "vscode",
  "copilot",
  "cursor",
  "claude-code",
  "claude-desktop",
  "codex",
  "windsurf",
  "zed",
  "jetbrains",
  "cline",
  "continue",
  "http",
] as const;

export type AppId = (typeof APP_IDS)[number];

export type AppCard = {
  id: AppId;
  name: string;
  get: string;
};

export const APPS: AppCard[] = [
  {
    id: "vscode",
    name: "VS Code",
    get: "GitHub Copilot in Visual Studio Code can look up your tasks, people, and today’s plan.",
  },
  {
    id: "copilot",
    name: "Copilot CLI",
    get: "The Copilot terminal app can read the same Ensemble context while you work in a folder.",
  },
  {
    id: "cursor",
    name: "Cursor",
    get: "Cursor’s agent can see the task behind the branch you have open.",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    get: "Claude Code in the terminal can read your projects, skills, and open decisions.",
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    get: "The Claude app on your computer can answer from your Ensemble, not only from the chat.",
  },
  {
    id: "codex",
    name: "Codex & ChatGPT",
    get: "Codex in the terminal, the Codex editor extension, and the ChatGPT desktop app share one setup.",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    get: "Windsurf’s Cascade agent can read your deliverables, meetings, and notes.",
  },
  {
    id: "zed",
    name: "Zed",
    get: "Zed’s agent can look up people, projects, and what you decided.",
  },
  {
    id: "jetbrains",
    name: "JetBrains",
    get: "AI Assistant in IntelliJ, PyCharm, WebStorm, and the other JetBrains apps can read Ensemble.",
  },
  {
    id: "cline",
    name: "Cline",
    get: "Cline, in the editor or the terminal, can look up your Ensemble before it answers.",
  },
  {
    id: "continue",
    name: "Continue",
    get: "Continue’s agent mode can read Ensemble from VS Code or a JetBrains IDE.",
  },
  {
    id: "http",
    name: "Another app",
    get: "Any app that can connect to a local address can share one running connection.",
  },
];

export function isAppId(value: string): value is AppId {
  return (APP_IDS as readonly string[]).includes(value);
}

export function appById(id: string): AppCard | undefined {
  return APPS.find((app) => app.id === id);
}
