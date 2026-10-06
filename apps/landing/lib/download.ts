export type OsId = "mac" | "windows" | "linux";

export const HOSTED_MCP_URL = "https://api.ensemblework.com/mcp";
export const RELEASES_URL = "https://github.com/ensemblework/ensemble/releases";
export const WINGET_ACCEPTED = false;
export const NPM_PUBLISHED = false;
export const AUR_AVAILABLE = false;

export const osTabs: Array<{ id: OsId; label: string }> = [
  { id: "mac", label: "macOS" },
  { id: "windows", label: "Windows" },
  { id: "linux", label: "Linux" },
];

export type InstallChannel = {
  id: string;
  label: string;
  commands: string[];
  note?: string;
  uninstall?: string[];
  status?: "available" | "coming-soon";
};

export const installChannels: Record<OsId, InstallChannel[]> = {
  mac: [
    {
      id: "brew",
      label: "Homebrew",
      commands: ["brew install ensemblework/tap/ensemble"],
      uninstall: ["brew uninstall ensemble"],
    },
    {
      id: "script",
      label: "Install script",
      commands: ["curl -fsSL https://ensemblework.com/install.sh | sh"],
      uninstall: ["ensemble runner uninstall", "rm -rf ~/.local/share/ensemble-cli ~/.local/bin/ensemble"],
    },
    {
      id: "npm",
      label: "npm (MCP and login only)",
      commands: ["npm install -g ensemblework", "npx -y ensemblework mcp"],
      note: "Requires Node 20+. MCP and login only; no runner.",
      uninstall: ["npm uninstall -g ensemblework"],
      status: NPM_PUBLISHED ? "available" : "coming-soon",
    },
  ],
  windows: [
    {
      id: "powershell",
      label: "PowerShell",
      commands: ["irm https://ensemblework.com/install.ps1 | iex"],
      uninstall: ["ensemble runner uninstall", "Remove %LOCALAPPDATA%\\Programs\\Ensemble"],
    },
    {
      id: "scoop",
      label: "Scoop",
      commands: ["scoop bucket add ensemblework https://github.com/ensemblework/scoop-bucket", "scoop install ensemblework/ensemble"],
      uninstall: ["scoop uninstall ensemble"],
    },
    {
      id: "winget",
      label: "winget",
      commands: ["winget install EnsembleWork.EnsembleCLI"],
      note: WINGET_ACCEPTED ? undefined : "Coming soon (in review).",
      uninstall: ["winget uninstall EnsembleWork.EnsembleCLI"],
      status: WINGET_ACCEPTED ? "available" : "coming-soon",
    },
    {
      id: "npm",
      label: "npm (MCP and login only)",
      commands: ["npm install -g ensemblework", "npx -y ensemblework mcp"],
      note: "Requires Node 20+. MCP and login only; no runner.",
      uninstall: ["npm uninstall -g ensemblework"],
      status: NPM_PUBLISHED ? "available" : "coming-soon",
    },
  ],
  linux: [
    {
      id: "script",
      label: "Install script",
      commands: ["curl -fsSL https://ensemblework.com/install.sh | sh"],
      uninstall: ["ensemble runner uninstall", "rm -rf ~/.local/share/ensemble-cli ~/.local/bin/ensemble"],
    },
    {
      id: "brew",
      label: "Homebrew on Linux",
      commands: ["brew install ensemblework/tap/ensemble"],
      uninstall: ["brew uninstall ensemble"],
    },
    {
      id: "deb",
      label: "Debian / Ubuntu",
      commands: ["Download ensemble-cli_<version>_amd64.deb (or arm64) from the latest CLI release", "sudo apt install ./ensemble-cli_*_amd64.deb"],
      note: "Open the releases page and filter tags starting cli-v.",
      uninstall: ["sudo apt remove ensemble-cli"],
    },
    {
      id: "rpm",
      label: "Fedora / RHEL",
      commands: ["sudo dnf install ./ensemble-cli-*.x86_64.rpm"],
      uninstall: ["sudo dnf remove ensemble-cli"],
    },
    {
      id: "opensuse",
      label: "openSUSE",
      commands: ["sudo zypper install ./ensemble-cli-*.x86_64.rpm"],
      uninstall: ["sudo zypper remove ensemble-cli"],
    },
    {
      id: "aur",
      label: "Arch AUR",
      commands: ["ensemble-cli-bin"],
      note: "Coming soon.",
      uninstall: ["Remove ensemble-cli-bin with your AUR helper"],
      status: AUR_AVAILABLE ? "available" : "coming-soon",
    },
    {
      id: "npm",
      label: "npm (MCP and login only)",
      commands: ["npm install -g ensemblework", "npx -y ensemblework mcp"],
      note: "Requires Node 20+. MCP and login only; no runner.",
      uninstall: ["npm uninstall -g ensemblework"],
      status: NPM_PUBLISHED ? "available" : "coming-soon",
    },
  ],
};

export const afterInstallCommands = ["ensemble login", "ensemble folders add ~/code/my-repo", "ensemble keys set google", "ensemble runner install"];

type Editor = {
  id: string;
  name: string;
  setupId: string;
  local: string;
  hosted: string;
  note?: string;
  printOnly?: boolean;
};

const json = (value: unknown) => JSON.stringify(value, null, 2);
const hostedHeaders = { Authorization: "Bearer KEY" };

export const editors: Editor[] = [
  {
    id: "vscode",
    name: "VS Code",
    setupId: "vscode",
    local: json({ servers: { ensemble: { type: "stdio", command: "ensemble", args: ["mcp"] } } }),
    hosted: json({ servers: { ensemble: { type: "http", url: HOSTED_MCP_URL, headers: hostedHeaders } } }),
    note: "Config file: macOS ~/Library/Application Support/Code/User/mcp.json, Windows %APPDATA%\\Code\\User\\mcp.json, Linux ~/.config/Code/User/mcp.json.",
  },
  {
    id: "cursor",
    name: "Cursor",
    setupId: "cursor",
    local: json({ mcpServers: { ensemble: { command: "ensemble", args: ["mcp"] } } }),
    hosted: json({ mcpServers: { ensemble: { url: HOSTED_MCP_URL, headers: hostedHeaders } } }),
    note: "Config file: ~/.cursor/mcp.json, or %USERPROFILE%\\.cursor\\mcp.json on Windows.",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    setupId: "windsurf",
    local: json({ mcpServers: { ensemble: { command: "ensemble", args: ["mcp"] } } }),
    hosted: json({ serverUrl: HOSTED_MCP_URL, headers: hostedHeaders }),
    note: "Config file: ~/.codeium/windsurf/mcp_config.json.",
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    setupId: "claude-desktop",
    local: json({ mcpServers: { ensemble: { command: "/opt/homebrew/bin/ensemble", args: ["mcp"] } } }),
    hosted: "Hosted URL is not supported yet for Claude Desktop custom connectors; they need OAuth. Use the CLI local server.",
    note: "Use the absolute path printed by `ensemble mcp setup --print`, typically /opt/homebrew/bin/ensemble or ~/.local/bin/ensemble.",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    setupId: "claude-code",
    local: "claude mcp add --scope user ensemble -- ensemble mcp",
    hosted: `claude mcp add --scope user --transport http ensemble ${HOSTED_MCP_URL} --header "Authorization: Bearer KEY"`,
  },
  {
    id: "codex",
    name: "Codex CLI / IDE",
    setupId: "codex",
    local: ['[mcp_servers.ensemble]', 'command = "ensemble"', 'args = ["mcp"]'].join("\n"),
    hosted: ['export ENSEMBLE_TOKEN=KEY', "", "[mcp_servers.ensemble]", `url = "${HOSTED_MCP_URL}"`, 'bearer_token_env_var = "ENSEMBLE_TOKEN"'].join("\n"),
    note: "Config file: ~/.codex/config.toml.",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    setupId: "gemini",
    local: json({ mcpServers: { ensemble: { command: "ensemble", args: ["mcp"] } } }),
    hosted: json({ mcpServers: { ensemble: { httpUrl: HOSTED_MCP_URL, headers: hostedHeaders } } }),
    note: "Config file: ~/.gemini/settings.json.",
  },
  {
    id: "copilot-cli",
    name: "GitHub Copilot CLI",
    setupId: "copilot-cli",
    local: json({ type: "local", command: "ensemble", args: ["mcp"], tools: ["*"] }),
    hosted: json({ type: "http", url: HOSTED_MCP_URL, headers: hostedHeaders, tools: ["*"] }),
    note: "Config file: ~/.copilot/mcp-config.json.",
  },
  {
    id: "zed",
    name: "Zed",
    setupId: "zed",
    local: json({ context_servers: { ensemble: { source: "custom", command: "ensemble", args: ["mcp"], env: {} } } }),
    hosted: json({ context_servers: { ensemble: { source: "custom", url: HOSTED_MCP_URL, headers: hostedHeaders } } }),
    note: "Settings file: macOS/Linux ~/.config/zed/settings.json, Windows %APPDATA%\\Zed\\settings.json.",
  },
  {
    id: "visual-studio",
    name: "Visual Studio 2022 17.14+",
    setupId: "visual-studio",
    local: json({ servers: { ensemble: { type: "stdio", command: "ensemble", args: ["mcp"] } } }),
    hosted: json({ servers: { ensemble: { type: "http", url: HOSTED_MCP_URL, headers: hostedHeaders } } }),
    note: "Config file: %USERPROFILE%\\.mcp.json.",
  },
  {
    id: "jetbrains",
    name: "JetBrains IDEs",
    setupId: "jetbrains",
    local: json({ mcpServers: { ensemble: { command: "ensemble", args: ["mcp"] } } }),
    hosted: json({ mcpServers: { ensemble: { url: HOSTED_MCP_URL, headers: hostedHeaders } } }),
    note: "AI Assistant / Junie: Settings → Tools → AI Assistant → Model Context Protocol (MCP) → Add → As JSON.",
    printOnly: true,
  },
  {
    id: "cline",
    name: "Cline",
    setupId: "cline",
    local: json({ mcpServers: { ensemble: { command: "ensemble", args: ["mcp"], disabled: false } } }),
    hosted: json({ mcpServers: { ensemble: { type: "streamableHttp", url: HOSTED_MCP_URL, headers: hostedHeaders } } }),
    note: "MCP Servers → Configure → cline_mcp_settings.json.",
  },
  {
    id: "continue",
    name: "Continue",
    setupId: "continue",
    local: ["mcpServers:", "  - name: ensemble", "    command: ensemble", "    args: [mcp]"].join("\n"),
    hosted: ["mcpServers:", "  - name: ensemble", "    type: streamable-http", `    url: ${HOSTED_MCP_URL}`, "    requestOptions:", "      headers:", "        Authorization: Bearer KEY"].join("\n"),
    note: "Config file: ~/.continue/config.yaml.",
    printOnly: true,
  },
  {
    id: "opencode",
    name: "opencode",
    setupId: "opencode",
    local: json({ mcp: { ensemble: { type: "local", command: ["ensemble", "mcp"], enabled: true } } }),
    hosted: json({ mcp: { ensemble: { type: "remote", url: HOSTED_MCP_URL, headers: hostedHeaders } } }),
    note: "Config file: ~/.config/opencode/opencode.json.",
  },
];
