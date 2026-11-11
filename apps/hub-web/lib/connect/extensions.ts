/**
 * AI extensions that run inside an editor (VS Code, Cursor, Windsurf, JetBrains) and keep their own
 * list of MCP servers. Adding Ensemble to the editor's own MCP config does not reach them: each one
 * reads its own file. This says where, and what to add there for each way of connecting.
 */
import type { AppId } from "./catalog";
import type { ConnectFacts, ConnectOs } from "./configs";
import { hostedMcpUrl, hostedTokenValue, pretty } from "./configs";

export type HostId = "vscode" | "cursor" | "windsurf" | "jetbrains";
export const HOSTS: Record<HostId, string> = { vscode: "VS Code", cursor: "Cursor", windsurf: "Windsurf", jetbrains: "JetBrains IDEs" };

export const EXTENSION_IDS = ["claude-code", "codex", "copilot-chat", "gemini-code-assist", "cline", "roo-code", "kilo-code", "continue"] as const;
export type ExtensionId = (typeof EXTENSION_IDS)[number];

export type ExtensionSetup = {
  /** What to do, in order. */
  steps: string[];
  /** The command or config to paste, when there is one. */
  snippet?: { label: string; text: string; path?: string };
};

export type Extension = {
  id: ExtensionId;
  name: string;
  maker: string;
  hosts: HostId[];
  /** The Connect app whose logo it shares; without one it shows its initial. */
  mark?: AppId;
  /** A Connect guide that sets up the same config, when there is one. */
  guide?: AppId;
  /** Where it reads its MCP servers. */
  reads: string;
  cli: (os: ConnectOs) => ExtensionSetup;
  hosted: (facts: ConnectFacts, origin?: string | null) => ExtensionSetup;
  /** How to see that Ensemble is connected. */
  check: string;
  /** A mistake people make with this one. */
  caution?: string;
};

function url(facts: ConnectFacts, origin?: string | null): string {
  return hostedMcpUrl({ publicApiUrl: facts.publicApiUrl, origin });
}

function bearer(facts: ConnectFacts): string {
  return `Bearer ${hostedTokenValue(facts)}`;
}

/** The CLI on PATH, or where `which`/`where` says it is when an app started from the Dock cannot find it. */
const LAUNCHER_HINT = "If the extension cannot start `ensemble`, use its full path: run `which ensemble` (macOS, Linux) or `where ensemble` (Windows) and put that in `command`.";

/** Roo Code and Kilo Code: the same MCP Servers panel and file shape (Kilo Code began as Roo Code). */
function rooLike(name: string): Pick<Extension, "reads" | "cli" | "hosted" | "check"> {
  return {
    reads: `${name}'s own MCP settings: the MCP Servers icon in its panel, then Edit Global MCP (mcp_settings.json), or .roo/mcp.json in a project.`,
    cli: () => ({
      steps: ["Install the CLI and run `ensemble login` (above).", `In ${name}, open MCP Servers, then Edit Global MCP.`, "Add the server below to `mcpServers` and save.", LAUNCHER_HINT],
      snippet: { label: "mcp_settings.json", text: pretty({ mcpServers: { ensemble: { command: "ensemble", args: ["mcp"] } } }) },
    }),
    hosted: (facts, origin) => ({
      steps: ["Create a key above.", `In ${name}, open MCP Servers, then Edit Global MCP.`, "Add the server below to `mcpServers` and save. Keep it in the global file, not a project file that gets committed."],
      snippet: { label: "mcp_settings.json", text: pretty({ mcpServers: { ensemble: { type: "streamable-http", url: url(facts, origin), headers: { Authorization: bearer(facts) } } } }) },
    }),
    check: `${name}'s MCP Servers list shows ensemble with a green dot and its tools.`,
  };
}

export const EXTENSIONS: Extension[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    maker: "Anthropic",
    hosts: ["vscode", "cursor", "windsurf", "jetbrains"],
    mark: "claude-code",
    guide: "claude-code",
    reads: "Claude Code's own list (your user config, ~/.claude.json, or a project's .mcp.json), the same one the claude command uses. It does not read VS Code's mcp.json.",
    cli: () => ({
      steps: ["Install the CLI and run `ensemble login` (above).", "Run the command below in any terminal. It adds Ensemble for your user, so every project and the extension see it.", "Start a new Claude session in the editor."],
      snippet: { label: "Terminal", text: "ensemble mcp setup claude-code" },
    }),
    hosted: (facts, origin) => ({
      steps: [
        "Create a key above.",
        "Run the command below in a terminal. Or in the Claude panel, open the MCP server dialog and enter: name `ensemble`, transport HTTP, the URL, and one header line `Authorization: Bearer <your key>`, with scope User.",
        "Start a new Claude session in the editor.",
      ],
      snippet: { label: "Terminal", text: `claude mcp add --scope user --transport http ensemble ${url(facts, origin)} --header "Authorization: ${bearer(facts)}"` },
    }),
    check: "Servers load when a session starts. Start a new one, then run /mcp in the Claude panel: Ensemble shows connected, failed, or waiting.",
    caution: "Pick scope User. Project writes .mcp.json into the repository, and the key would be committed with it.",
  },
  {
    id: "codex",
    name: "Codex",
    maker: "OpenAI",
    hosts: ["vscode", "cursor", "windsurf"],
    mark: "codex",
    guide: "codex",
    reads: "~/.codex/config.toml, shared with the codex command and the ChatGPT desktop app. Not VS Code's mcp.json.",
    cli: () => ({
      steps: ["Install the CLI and run `ensemble login` (above).", "Run the command below. It writes `[mcp_servers.ensemble]` to ~/.codex/config.toml.", "Reload the editor window so the extension reads it again."],
      snippet: { label: "Terminal", text: "ensemble mcp setup codex" },
    }),
    hosted: (facts, origin) => ({
      steps: ["Create a key above.", "Add the lines below to ~/.codex/config.toml, your own file outside any repository.", "Reload the editor window."],
      snippet: { label: "~/.codex/config.toml", text: ["[mcp_servers.ensemble]", `url = "${url(facts, origin)}"`, `http_headers = { "Authorization" = "${bearer(facts)}" }`].join("\n"), path: "~/.codex/config.toml" },
    }),
    check: "Run `codex mcp list` in a terminal, or open the extension's MCP settings: ensemble is listed. Then ask Codex to use Ensemble.",
  },
  {
    id: "copilot-chat",
    name: "GitHub Copilot Chat",
    maker: "GitHub",
    hosts: ["vscode", "jetbrains"],
    mark: "copilot-cli",
    reads: "VS Code's own MCP config (the user mcp.json this guide sets up) in agent mode. In JetBrains, Copilot's MCP settings (Tools, GitHub Copilot, Model Context Protocol).",
    cli: () => ({
      steps: ["Follow the VS Code steps above: `ensemble mcp setup vscode` writes the user mcp.json Copilot reads.", "In JetBrains, open Copilot's MCP settings, edit mcp.json and add the server below."],
      snippet: { label: "mcp.json", text: pretty({ servers: { ensemble: { type: "stdio", command: "ensemble", args: ["mcp"] } } }) },
    }),
    hosted: (facts, origin) => ({
      steps: ["Create a key above.", "Use the VS Code hosted config above. In JetBrains, add the server below in Copilot's MCP settings."],
      snippet: { label: "mcp.json", text: pretty({ servers: { ensemble: { type: "http", url: url(facts, origin), headers: { Authorization: bearer(facts) } } } }) },
    }),
    check: "Switch Copilot Chat to Agent mode and open the tools list: Ensemble's tools appear. In VS Code, MCP: List Servers shows its state.",
  },
  {
    id: "gemini-code-assist",
    name: "Gemini Code Assist",
    maker: "Google",
    hosts: ["vscode", "jetbrains"],
    mark: "gemini",
    guide: "gemini",
    reads: "~/.gemini/settings.json in agent mode, shared with the gemini command.",
    cli: () => ({
      steps: ["Install the CLI and run `ensemble login` (above).", "Run the command below. It adds Ensemble to ~/.gemini/settings.json.", "Reload the editor and turn on agent mode."],
      snippet: { label: "Terminal", text: "ensemble mcp setup gemini" },
    }),
    hosted: (facts, origin) => ({
      steps: ["Create a key above.", "Add the server below to ~/.gemini/settings.json.", "Reload the editor and turn on agent mode."],
      snippet: { label: "~/.gemini/settings.json", text: pretty({ mcpServers: { ensemble: { httpUrl: url(facts, origin), headers: { Authorization: bearer(facts) } } } }), path: "~/.gemini/settings.json" },
    }),
    check: "In agent mode, type /mcp in the chat: ensemble is listed with its tools.",
  },
  {
    id: "cline",
    name: "Cline",
    maker: "Cline",
    hosts: ["vscode", "cursor", "windsurf", "jetbrains"],
    mark: "cline",
    guide: "cline",
    reads: "Its own cline_mcp_settings.json (MCP Servers icon, then Configure MCP Servers).",
    cli: () => ({
      steps: ["Install the CLI and run `ensemble login` (above).", "Run the command below. It writes Cline's settings file.", "Open Cline's MCP Servers panel."],
      snippet: { label: "Terminal", text: "ensemble mcp setup cline" },
    }),
    hosted: (facts, origin) => ({
      steps: ["Create a key above.", "In Cline, open MCP Servers, then Configure MCP Servers, and add the server below."],
      snippet: { label: "cline_mcp_settings.json", text: pretty({ mcpServers: { ensemble: { type: "streamableHttp", url: url(facts, origin), headers: { Authorization: bearer(facts) } } } }) },
    }),
    check: "Cline's MCP Servers panel shows ensemble with a green dot.",
  },
  { id: "roo-code", name: "Roo Code", maker: "Roo Code", hosts: ["vscode", "cursor", "windsurf"], ...rooLike("Roo Code") },
  { id: "kilo-code", name: "Kilo Code", maker: "Kilo Code", hosts: ["vscode", "cursor", "windsurf", "jetbrains"], ...rooLike("Kilo Code") },
  {
    id: "continue",
    name: "Continue",
    maker: "Continue",
    hosts: ["vscode", "cursor", "windsurf", "jetbrains"],
    mark: "continue",
    guide: "continue",
    reads: "~/.continue/config.yaml (or a block in .continue/mcpServers/ in a project), used in agent mode.",
    cli: () => ({
      steps: ["Install the CLI and run `ensemble login` (above).", "Run the command below and paste what it prints into ~/.continue/config.yaml."],
      snippet: { label: "Terminal", text: "ensemble mcp setup continue --print" },
    }),
    hosted: (facts, origin) => ({
      steps: ["Create a key above.", "Add the block below to ~/.continue/config.yaml."],
      snippet: {
        label: "~/.continue/config.yaml",
        text: ["mcpServers:", "  - name: ensemble", "    type: streamable-http", `    url: ${url(facts, origin)}`, "    requestOptions:", "      headers:", `        Authorization: ${bearer(facts)}`].join("\n"),
        path: "~/.continue/config.yaml",
      },
    }),
    check: "Switch Continue to Agent mode: Ensemble's tools appear under the tools icon.",
  },
];

export function extensionById(id: string | null | undefined): Extension | null {
  return EXTENSIONS.find((item) => item.id === id) ?? null;
}

/** Extensions that run inside this editor. */
export function extensionsFor(host: AppId): Extension[] {
  return (host in HOSTS ? EXTENSIONS.filter((item) => item.hosts.includes(host as HostId)) : []);
}

export function isHost(app: AppId): app is HostId {
  return app in HOSTS;
}
