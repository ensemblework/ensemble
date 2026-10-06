import type { AppId } from "./catalog";

/**
 * Client configs for Ensemble CLI/MCP and the developer Context Bridge.
 * CLI/hosted shapes follow the Plan E public guide contract. The "source"
 * helpers are kept for developers running this repository directly.
 */

export type ConnectOs = "mac" | "windows" | "linux";
export type ConnectMethod = "cli" | "hosted" | "source";
export type SnippetFormat = "json" | "toml" | "yaml" | "shell" | "text";

export type ConnectFacts = {
  repoRoot: string;
  bridgeScript: string;
  node: string;
  hubApiUrl: string;
  publicApiUrl?: string | null;
  httpUrl: string;
  /** Real `ens_…` key, or null when the person has not created one in this tab. */
  token: string | null;
};

export type ConnectSnippet = {
  label: string;
  text: string;
  format: SnippetFormat;
  path?: string;
  note?: string;
};

export const TOKEN_PLACEHOLDER = "ens_PASTE_TOKEN";
export const HOSTED_KEY_PLACEHOLDER = "KEY";
export const HOSTED_MCP_FALLBACK_URL = "https://api.ensemblework.com/mcp";
export const RELEASES_URL = "https://github.com/ensemblework/ensemble/releases";
export const WINGET_AVAILABLE = false;
export const NPM_AVAILABLE = false;
export const AUR_AVAILABLE = false;

export const CLI_POST_LOGIN_COMMANDS = [
  "ensemble login",
  "ensemble folders add ~/code/my-repo",
  "ensemble keys set google",
  "ensemble runner install",
  "ensemble runner start",
  "ensemble mcp setup",
  "ensemble status",
  "ensemble doctor",
  "ensemble update",
] as const;

export type InstallChannel = {
  id: string;
  label: string;
  commands: readonly string[];
  note?: string;
  status?: "available" | "coming-soon";
};

export const INSTALL_CHANNELS: Record<ConnectOs, readonly InstallChannel[]> = {
  mac: [
    { id: "brew", label: "Homebrew", commands: ["brew install ensemblework/tap/ensemble"] },
    { id: "script", label: "Install script", commands: ["curl -fsSL https://ensemblework.com/install.sh | sh"] },
    {
      id: "npm",
      label: "npm (MCP and login only)",
      commands: ["npm install -g ensemblework", "npx -y ensemblework mcp"],
      note: "Requires Node 20+. No task runner.",
      status: NPM_AVAILABLE ? "available" : "coming-soon",
    },
  ],
  windows: [
    { id: "powershell", label: "PowerShell", commands: ["irm https://ensemblework.com/install.ps1 | iex"] },
    {
      id: "scoop",
      label: "Scoop",
      commands: ["scoop bucket add ensemblework https://github.com/ensemblework/scoop-bucket", "scoop install ensemblework/ensemble"],
    },
    {
      id: "winget",
      label: "winget",
      commands: ["winget install EnsembleWork.EnsembleCLI"],
      status: WINGET_AVAILABLE ? "available" : "coming-soon",
      note: WINGET_AVAILABLE ? undefined : "Coming soon (in review).",
    },
    {
      id: "npm",
      label: "npm (MCP and login only)",
      commands: ["npm install -g ensemblework", "npx -y ensemblework mcp"],
      note: "Requires Node 20+. No task runner.",
      status: NPM_AVAILABLE ? "available" : "coming-soon",
    },
  ],
  linux: [
    { id: "script", label: "Install script", commands: ["curl -fsSL https://ensemblework.com/install.sh | sh"] },
    { id: "brew", label: "Homebrew on Linux", commands: ["brew install ensemblework/tap/ensemble"] },
    {
      id: "deb",
      label: "Debian / Ubuntu",
      commands: ["Download ensemble-cli_<version>_amd64.deb (or arm64) from the latest CLI release", "sudo apt install ./ensemble-cli_*_amd64.deb"],
      note: `CLI releases are at ${RELEASES_URL}; filter tags starting cli-v.`,
    },
    {
      id: "rpm",
      label: "Fedora / RHEL",
      commands: ["sudo dnf install ./ensemble-cli-*.x86_64.rpm"],
    },
    {
      id: "opensuse",
      label: "openSUSE",
      commands: ["sudo zypper install ./ensemble-cli-*.x86_64.rpm"],
    },
    {
      id: "aur",
      label: "Arch AUR",
      commands: ["ensemble-cli-bin"],
      status: AUR_AVAILABLE ? "available" : "coming-soon",
      note: "Coming soon.",
    },
    {
      id: "npm",
      label: "npm (MCP and login only)",
      commands: ["npm install -g ensemblework", "npx -y ensemblework mcp"],
      note: "Requires Node 20+. No task runner.",
      status: NPM_AVAILABLE ? "available" : "coming-soon",
    },
  ],
};

export const METHOD_LABELS: Record<ConnectMethod, { title: string; short: string; description: string }> = {
  cli: {
    title: "Ensemble CLI (recommended)",
    short: "CLI",
    description: "Install the CLI once. Your editor starts `ensemble mcp`, and the same CLI can run tasks on this computer.",
  },
  hosted: {
    title: "Hosted URL (no install)",
    short: "Hosted URL",
    description: "Use the hosted read-only MCP endpoint with an `ens_` bridge key. Nothing runs on this computer.",
  },
  source: {
    title: "From source (developers)",
    short: "From source",
    description: "Run the Context Bridge from this checkout with Node and `pnpm bridge:build`.",
  },
};

export type EditorSetup = {
  id: AppId;
  setupId: string;
  name: string;
  localPath: Partial<Record<ConnectOs, string>>;
  hostedPath?: Partial<Record<ConnectOs, string>>;
  supportsHosted: boolean;
  printOnly?: boolean;
  notes?: Partial<Record<ConnectMethod, string>>;
};

export const EDITORS: Record<AppId, EditorSetup> = {
  vscode: {
    id: "vscode",
    setupId: "vscode",
    name: "VS Code",
    localPath: {
      mac: "~/Library/Application Support/Code/User/mcp.json",
      windows: "%APPDATA%\\Code\\User\\mcp.json",
      linux: "~/.config/Code/User/mcp.json",
    },
    supportsHosted: true,
    notes: { cli: "You can also open Command Palette → MCP: Open User Configuration." },
  },
  cursor: {
    id: "cursor",
    setupId: "cursor",
    name: "Cursor",
    localPath: { mac: "~/.cursor/mcp.json", windows: "%USERPROFILE%\\.cursor\\mcp.json", linux: "~/.cursor/mcp.json" },
    supportsHosted: true,
  },
  windsurf: {
    id: "windsurf",
    setupId: "windsurf",
    name: "Windsurf",
    localPath: { mac: "~/.codeium/windsurf/mcp_config.json", windows: "~/.codeium/windsurf/mcp_config.json", linux: "~/.codeium/windsurf/mcp_config.json" },
    supportsHosted: true,
  },
  "claude-desktop": {
    id: "claude-desktop",
    setupId: "claude-desktop",
    name: "Claude Desktop",
    localPath: {
      mac: "~/Library/Application Support/Claude/claude_desktop_config.json",
      windows: "%APPDATA%\\Claude\\claude_desktop_config.json",
      linux: "~/.config/Claude/claude_desktop_config.json",
    },
    supportsHosted: false,
    notes: {
      cli: "Use the absolute path printed by `ensemble mcp setup --print` for GUI apps, typically /opt/homebrew/bin/ensemble or ~/.local/bin/ensemble.",
      hosted: "Claude Desktop custom connectors need OAuth, so hosted URL setup is not supported yet. Use the CLI local server.",
    },
  },
  "claude-code": {
    id: "claude-code",
    setupId: "claude-code",
    name: "Claude Code",
    localPath: {},
    supportsHosted: true,
  },
  codex: {
    id: "codex",
    setupId: "codex",
    name: "Codex CLI / IDE",
    localPath: { mac: "~/.codex/config.toml", windows: "%USERPROFILE%\\.codex\\config.toml", linux: "~/.codex/config.toml" },
    supportsHosted: true,
  },
  gemini: {
    id: "gemini",
    setupId: "gemini",
    name: "Gemini CLI",
    localPath: { mac: "~/.gemini/settings.json", windows: "%USERPROFILE%\\.gemini\\settings.json", linux: "~/.gemini/settings.json" },
    supportsHosted: true,
  },
  "copilot-cli": {
    id: "copilot-cli",
    setupId: "copilot-cli",
    name: "GitHub Copilot CLI",
    localPath: { mac: "~/.copilot/mcp-config.json", windows: "%USERPROFILE%\\.copilot\\mcp-config.json", linux: "~/.copilot/mcp-config.json" },
    supportsHosted: true,
  },
  zed: {
    id: "zed",
    setupId: "zed",
    name: "Zed",
    localPath: { mac: "~/.config/zed/settings.json", windows: "%APPDATA%\\Zed\\settings.json", linux: "~/.config/zed/settings.json" },
    supportsHosted: true,
  },
  "visual-studio": {
    id: "visual-studio",
    setupId: "visual-studio",
    name: "Visual Studio 2022 17.14+",
    localPath: { windows: "%USERPROFILE%\\.mcp.json" },
    supportsHosted: true,
  },
  jetbrains: {
    id: "jetbrains",
    setupId: "jetbrains",
    name: "JetBrains IDEs",
    localPath: {},
    supportsHosted: true,
    printOnly: true,
    notes: {
      cli: "Settings → Tools → AI Assistant → Model Context Protocol (MCP) → Add → As JSON.",
      hosted: "Settings → Tools → AI Assistant → Model Context Protocol (MCP) → Add → As JSON.",
    },
  },
  cline: {
    id: "cline",
    setupId: "cline",
    name: "Cline",
    localPath: { mac: "cline_mcp_settings.json", windows: "cline_mcp_settings.json", linux: "cline_mcp_settings.json" },
    supportsHosted: true,
  },
  continue: {
    id: "continue",
    setupId: "continue",
    name: "Continue",
    localPath: { mac: "~/.continue/config.yaml", windows: "%USERPROFILE%\\.continue\\config.yaml", linux: "~/.continue/config.yaml" },
    supportsHosted: true,
    printOnly: true,
  },
  opencode: {
    id: "opencode",
    setupId: "opencode",
    name: "opencode",
    localPath: { mac: "~/.config/opencode/opencode.json", windows: "%USERPROFILE%\\.config\\opencode\\opencode.json", linux: "~/.config/opencode/opencode.json" },
    supportsHosted: true,
  },
};

export function osFromPlatform(platform: string): ConnectOs {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "windows";
  return "linux";
}

export function tokenValue(facts: ConnectFacts): string {
  return facts.token ?? TOKEN_PLACEHOLDER;
}

export function hostedTokenValue(facts: ConnectFacts): string {
  return facts.token ?? HOSTED_KEY_PLACEHOLDER;
}

export function shellQuote(value: string, os: ConnectOs): string {
  if (os === "windows") return `"${value.replace(/"/g, '`"')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function envBlock(facts: ConnectFacts, token: string) {
  return {
    HUB_API_URL: hubUrl(facts),
    ENSEMBLE_BRIDGE_TOKEN: token,
  };
}

function hubUrl(facts: ConnectFacts): string {
  return facts.hubApiUrl || "http://127.0.0.1:4000";
}

function loopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * Hosted Connect steps must use the public API URL. Desktop and local keep
 * the loopback address the bridge already returns as `hubApiUrl`.
 */
export function connectHubUrl(input: { hubApiUrl?: string | null; publicApiUrl?: string | null }): string {
  const pub = input.publicApiUrl?.trim().replace(/\/$/, "") ?? "";
  if (pub && !loopbackUrl(pub)) return pub;
  return input.hubApiUrl?.trim() || "http://127.0.0.1:4000";
}

export function hostedMcpUrl(input: { publicApiUrl?: string | null; origin?: string | null } = {}): string {
  const pub = input.publicApiUrl?.trim().replace(/\/$/, "") ?? "";
  if (pub && !loopbackUrl(pub)) return `${pub}/mcp`;
  const origin = input.origin?.trim();
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.hostname.startsWith("app.")) {
        url.hostname = url.hostname.replace(/^app\./, "api.");
        url.pathname = "/mcp";
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/$/, "");
      }
    } catch {
      return HOSTED_MCP_FALLBACK_URL;
    }
  }
  return HOSTED_MCP_FALLBACK_URL;
}

/** Pretty JSON the copy button can hand to an app. */
export function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function primaryInstallCommand(os: ConnectOs): string {
  return INSTALL_CHANNELS[os][0]?.commands.join("\n") ?? INSTALL_CHANNELS.linux[0]!.commands[0]!;
}

function cliCommandFor(app: AppId, os: ConnectOs): string {
  if (app === "claude-desktop") {
    if (os === "windows") return "%LOCALAPPDATA%\\Programs\\Ensemble\\ensemble.exe";
    if (os === "mac") return "/opt/homebrew/bin/ensemble";
    return "~/.local/bin/ensemble";
  }
  return "ensemble";
}

function authHeader(facts: ConnectFacts): { Authorization: string } {
  return { Authorization: `Bearer ${hostedTokenValue(facts)}` };
}

function vscodeHostedConfig(url: string, facts: ConnectFacts): string {
  // ${input:…} secrets drop the server from VS Code's Agent Host, so the user profile file holds the read-only key.
  return pretty({ servers: { ensemble: { type: "http", url, headers: authHeader(facts) } } });
}

function jsonSnippet(label: string, value: unknown, path?: string, note?: string): ConnectSnippet {
  return { label, text: pretty(value), format: "json", path, note };
}

function commandSnippet(label: string, text: string, note?: string): ConnectSnippet {
  return { label, text, format: "shell", note };
}

function tomlSnippet(label: string, text: string, path?: string, note?: string): ConnectSnippet {
  return { label, text, format: "toml", path, note };
}

function yamlSnippet(label: string, text: string, path?: string, note?: string): ConnectSnippet {
  return { label, text, format: "yaml", path, note };
}

export function setupOneLiner(app: AppId): string {
  const editor = EDITORS[app];
  return `ensemble mcp setup ${editor.setupId}`;
}

export function localCliSnippet(app: AppId, os: ConnectOs): ConnectSnippet {
  const editor = EDITORS[app];
  const command = cliCommandFor(app, os);
  const path = editor.localPath[os];
  switch (app) {
    case "vscode":
      return jsonSnippet("Local MCP config", { servers: { ensemble: { type: "stdio", command, args: ["mcp"] } } }, path, editor.notes?.cli);
    case "cursor":
    case "windsurf":
    case "gemini":
    case "jetbrains":
      return jsonSnippet("Local MCP config", { mcpServers: { ensemble: { command, args: ["mcp"] } } }, path, editor.notes?.cli);
    case "claude-desktop":
      return jsonSnippet("Local MCP config", { mcpServers: { ensemble: { command, args: ["mcp"] } } }, path, editor.notes?.cli);
    case "claude-code":
      return commandSnippet("Local setup command", "claude mcp add --scope user ensemble -- ensemble mcp");
    case "codex":
      return tomlSnippet("Local MCP config", ['[mcp_servers.ensemble]', 'command = "ensemble"', 'args = ["mcp"]', ""].join("\n"), path);
    case "copilot-cli":
      return jsonSnippet("Local MCP config", { type: "local", command: "ensemble", args: ["mcp"], tools: ["*"] }, path);
    case "zed":
      return jsonSnippet("Local MCP config", { context_servers: { ensemble: { source: "custom", command, args: ["mcp"], env: {} } } }, path);
    case "visual-studio":
      return jsonSnippet("Local MCP config", { servers: { ensemble: { type: "stdio", command, args: ["mcp"] } } }, path);
    case "cline":
      return jsonSnippet("Local MCP config", { mcpServers: { ensemble: { command, args: ["mcp"], disabled: false } } }, path);
    case "continue":
      return yamlSnippet("Local MCP config", ["mcpServers:", "  - name: ensemble", "    command: ensemble", "    args: [mcp]", ""].join("\n"), path);
    case "opencode":
      return jsonSnippet("Local MCP config", { mcp: { ensemble: { type: "local", command: ["ensemble", "mcp"], enabled: true } } }, path);
  }
}

export function hostedSnippet(app: AppId, facts: ConnectFacts, os: ConnectOs, origin?: string | null): ConnectSnippet {
  const editor = EDITORS[app];
  const url = hostedMcpUrl({ publicApiUrl: facts.publicApiUrl, origin });
  const key = hostedTokenValue(facts);
  const headers = authHeader(facts);
  const path = editor.hostedPath?.[os] ?? editor.localPath[os];
  switch (app) {
    case "vscode":
      return { label: "Hosted MCP config", text: vscodeHostedConfig(url, facts), format: "json", path, note: "Put this in your user profile mcp.json (MCP: Open User Configuration), not in a repository file. The key is read-only." };
    case "cursor":
    case "jetbrains":
      return jsonSnippet("Hosted MCP config", { mcpServers: { ensemble: { url, headers } } }, path, editor.notes?.hosted);
    case "windsurf":
      return jsonSnippet("Hosted MCP config", { serverUrl: url, headers }, path);
    case "claude-desktop":
      return { label: "Hosted MCP", text: editor.notes?.hosted ?? "Use the CLI local server.", format: "text", path, note: editor.notes?.hosted };
    case "claude-code":
      return commandSnippet("Hosted setup command", `claude mcp add --scope user --transport http ensemble ${url} --header "Authorization: Bearer ${key}"`);
    case "codex":
      return tomlSnippet(
        "Hosted MCP config",
        ['[mcp_servers.ensemble]', `url = "${url}"`, 'bearer_token_env_var = "ENSEMBLE_TOKEN"', ""].join("\n"),
        path,
        `Export ENSEMBLE_TOKEN=${key} before starting Codex.`,
      );
    case "gemini":
      return jsonSnippet("Hosted MCP config", { mcpServers: { ensemble: { httpUrl: url, headers } } }, path);
    case "copilot-cli":
      return jsonSnippet("Hosted MCP config", { type: "http", url, headers, tools: ["*"] }, path);
    case "zed":
      return jsonSnippet("Hosted MCP config", { context_servers: { ensemble: { source: "custom", url, headers } } }, path);
    case "visual-studio":
      return jsonSnippet("Hosted MCP config", { servers: { ensemble: { type: "http", url, headers } } }, path);
    case "cline":
      return jsonSnippet("Hosted MCP config", { mcpServers: { ensemble: { type: "streamableHttp", url, headers } } }, path);
    case "continue":
      return yamlSnippet(
        "Hosted MCP config",
        ["mcpServers:", "  - name: ensemble", "    type: streamable-http", `    url: ${url}`, "    requestOptions:", "      headers:", `        Authorization: Bearer ${key}`, ""].join("\n"),
        path,
      );
    case "opencode":
      return jsonSnippet("Hosted MCP config", { mcp: { ensemble: { type: "remote", url, headers } } }, path);
  }
}

// ── From-source developer config helpers ───────────────────────────────────

export function buildCommand(facts: ConnectFacts, os: ConnectOs): string {
  const dir = shellQuote(facts.repoRoot, os);
  return os === "windows" ? `cd ${dir}; pnpm bridge:build` : `cd ${dir} && pnpm bridge:build`;
}

export function envCommand(facts: ConnectFacts, os: ConnectOs): string {
  const value = tokenValue(facts);
  if (os === "windows") return `$env:ENSEMBLE_BRIDGE_TOKEN = "${value}"`;
  return `export ENSEMBLE_BRIDGE_TOKEN="${value}"`;
}

export function envCommandCmd(facts: ConnectFacts): string {
  return `set ENSEMBLE_BRIDGE_TOKEN=${tokenValue(facts)}`;
}

export function vscodeUserConfig(facts: ConnectFacts): string {
  return pretty({
    servers: {
      ensemble: {
        type: "stdio",
        command: "node",
        args: [facts.bridgeScript],
        env: {
          HUB_API_URL: hubUrl(facts),
          ENSEMBLE_BRIDGE_TOKEN: "${env:ENSEMBLE_BRIDGE_TOKEN}",
        },
      },
    },
  });
}

export function vscodeInstallUrl(facts: ConnectFacts, insiders = false): string {
  const payload = {
    name: "ensemble",
    type: "stdio",
    command: "node",
    args: [facts.bridgeScript],
    env: {
      HUB_API_URL: hubUrl(facts),
      ENSEMBLE_BRIDGE_TOKEN: "${env:ENSEMBLE_BRIDGE_TOKEN}",
    },
  };
  const scheme = insiders ? "vscode-insiders" : "vscode";
  return `${scheme}:mcp/install?${encodeURIComponent(JSON.stringify(payload))}`;
}

export function vscodeCliCommand(facts: ConnectFacts, os: ConnectOs): string {
  const payload = JSON.stringify({
    name: "ensemble",
    type: "stdio",
    command: "node",
    args: [facts.bridgeScript],
    env: {
      HUB_API_URL: hubUrl(facts),
      ENSEMBLE_BRIDGE_TOKEN: "${env:ENSEMBLE_BRIDGE_TOKEN}",
    },
  });
  return `code --add-mcp ${shellQuote(payload, os)}`;
}

export function cursorConfig(facts: ConnectFacts): string {
  return pretty({
    mcpServers: {
      ensemble: {
        command: "node",
        args: [facts.bridgeScript],
        env: {
          HUB_API_URL: hubUrl(facts),
          ENSEMBLE_BRIDGE_TOKEN: "${env:ENSEMBLE_BRIDGE_TOKEN}",
        },
      },
    },
  });
}

export function cursorInstallUrl(facts: ConnectFacts): string {
  const config = {
    command: "node",
    args: [facts.bridgeScript],
    env: {
      HUB_API_URL: hubUrl(facts),
      ENSEMBLE_BRIDGE_TOKEN: "${env:ENSEMBLE_BRIDGE_TOKEN}",
    },
  };
  const encoded = utf8Base64(JSON.stringify(config));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent("ensemble")}&config=${encodeURIComponent(encoded)}`;
}

export function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (typeof btoa === "function") return btoa(binary);
  return Buffer.from(text, "utf8").toString("base64");
}

export function copilotCliConfig(facts: ConnectFacts): string {
  return pretty({
    type: "local",
    command: "node",
    args: [facts.bridgeScript],
    tools: ["*"],
    env: envBlock(facts, tokenValue(facts)),
  });
}

export function copilotCliCommand(facts: ConnectFacts, os: ConnectOs): string {
  return `copilot mcp add ensemble -- node ${shellQuote(facts.bridgeScript, os)}`;
}

export function claudeCodeCommand(facts: ConnectFacts, os: ConnectOs): string {
  const token = shellQuote(tokenValue(facts), os);
  const hub = shellQuote(hubUrl(facts), os);
  const script = shellQuote(facts.bridgeScript, os);
  if (os === "windows") {
    return `claude mcp add --transport stdio --env ENSEMBLE_BRIDGE_TOKEN=${token} --env HUB_API_URL=${hub} ensemble -- node ${script}`;
  }
  return [
    "claude mcp add --transport stdio \\",
    `  --env ENSEMBLE_BRIDGE_TOKEN=${token} \\`,
    `  --env HUB_API_URL=${hub} \\`,
    `  ensemble -- node ${script}`,
  ].join("\n");
}

export function claudeDesktopConfig(facts: ConnectFacts): string {
  return pretty({
    mcpServers: {
      ensemble: {
        command: "node",
        args: [facts.bridgeScript],
        env: envBlock(facts, tokenValue(facts)),
      },
    },
  });
}

export function claudeDesktopPath(os: ConnectOs): string {
  if (os === "mac") return "~/Library/Application Support/Claude/claude_desktop_config.json";
  if (os === "windows") return "%APPDATA%\\Claude\\claude_desktop_config.json";
  return "~/.config/Claude/claude_desktop_config.json";
}

export function codexToml(facts: ConnectFacts): string {
  const script = facts.bridgeScript.replace(/\\/g, "\\\\");
  return [
    "[mcp_servers.ensemble]",
    'command = "node"',
    `args = ["${script}"]`,
    "",
    "[mcp_servers.ensemble.env]",
    `HUB_API_URL = "${hubUrl(facts)}"`,
    `ENSEMBLE_BRIDGE_TOKEN = "${tokenValue(facts)}"`,
    "",
  ].join("\n");
}

export function codexCommand(facts: ConnectFacts, os: ConnectOs): string {
  const token = tokenValue(facts);
  const script = shellQuote(facts.bridgeScript, os);
  return `codex mcp add ensemble --env ENSEMBLE_BRIDGE_TOKEN=${shellQuote(token, os)} --env HUB_API_URL=${shellQuote(hubUrl(facts), os)} -- node ${script}`;
}

export function codexPath(os: ConnectOs): string {
  return os === "windows" ? "%USERPROFILE%\\.codex\\config.toml" : "~/.codex/config.toml";
}

export function windsurfConfig(facts: ConnectFacts): string {
  return pretty({
    mcpServers: {
      ensemble: {
        command: "node",
        args: [facts.bridgeScript],
        env: envBlock(facts, tokenValue(facts)),
      },
    },
  });
}

export function windsurfPath(os: ConnectOs): string {
  return os === "windows" ? "%USERPROFILE%\\.codeium\\windsurf\\mcp_config.json" : "~/.codeium/windsurf/mcp_config.json";
}

export function copilotPath(os: ConnectOs): string {
  return os === "windows" ? "%USERPROFILE%\\.copilot\\mcp-config.json" : "~/.copilot/mcp-config.json";
}

export function zedSnippet(facts: ConnectFacts): string {
  return pretty({
    context_servers: {
      ensemble: {
        command: "node",
        args: [facts.bridgeScript],
        env: envBlock(facts, tokenValue(facts)),
      },
    },
  });
}

export function jetbrainsConfig(facts: ConnectFacts): string {
  return pretty({
    mcpServers: {
      ensemble: {
        command: "node",
        args: [facts.bridgeScript],
        env: envBlock(facts, tokenValue(facts)),
      },
    },
  });
}

export function clineConfig(facts: ConnectFacts): string {
  return pretty({
    mcpServers: {
      ensemble: {
        command: "node",
        args: [facts.bridgeScript],
        env: envBlock(facts, tokenValue(facts)),
        disabled: false,
        autoApprove: [],
      },
    },
  });
}

export function clinePath(os: ConnectOs): string {
  return os === "windows" ? "%USERPROFILE%\\.cline\\mcp.json" : "~/.cline/mcp.json";
}

export function continueYaml(facts: ConnectFacts): string {
  const script = facts.bridgeScript.replace(/\\/g, "\\\\");
  return [
    "name: Ensemble",
    "version: 0.0.1",
    "schema: v1",
    "mcpServers:",
    "  - name: ensemble",
    "    type: stdio",
    "    command: node",
    "    args:",
    `      - "${script}"`,
    "    env:",
    `      HUB_API_URL: "${hubUrl(facts)}"`,
    `      ENSEMBLE_BRIDGE_TOKEN: "${tokenValue(facts)}"`,
    "",
  ].join("\n");
}

export function httpStartCommand(facts: ConnectFacts, os: ConnectOs): string {
  const dir = shellQuote(facts.repoRoot, os);
  const key = envCommand(facts, os);
  return os === "windows" ? `cd ${dir}; ${key}; pnpm bridge:http` : `cd ${dir} && ${key} && pnpm bridge:http`;
}

export function httpVsCodeConfig(facts: ConnectFacts): string {
  return pretty({
    servers: {
      ensemble: {
        type: "http",
        url: facts.httpUrl,
      },
    },
  });
}

export function httpMcpConfig(facts: ConnectFacts): string {
  return pretty({
    mcpServers: {
      ensemble: {
        type: "http",
        url: facts.httpUrl,
      },
    },
  });
}

export function httpClineConfig(facts: ConnectFacts): string {
  return pretty({
    mcpServers: {
      ensemble: {
        type: "streamableHttp",
        url: facts.httpUrl,
        disabled: false,
      },
    },
  });
}
