/**
 * Client configs for the Context Bridge.
 * Shapes match the files in `apps/context-bridge/clients/` and the repo
 * `.vscode/mcp.json`, `.cursor/mcp.json`, and `.mcp.json`.
 * One-click links follow the current VS Code and Cursor install URLs and
 * never embed the key (those apps read `${env:ENSEMBLE_BRIDGE_TOKEN}`).
 */

export type ConnectOs = "mac" | "windows" | "linux";

export type ConnectFacts = {
  repoRoot: string;
  bridgeScript: string;
  node: string;
  hubApiUrl: string;
  httpUrl: string;
  /** Real `ens_…` key, or null when the person has not created one in this tab. */
  token: string | null;
};

export const TOKEN_PLACEHOLDER = "ens_PASTE_TOKEN";

export function osFromPlatform(platform: string): ConnectOs {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "windows";
  return "linux";
}

export function tokenValue(facts: ConnectFacts): string {
  return facts.token ?? TOKEN_PLACEHOLDER;
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

/** Pretty JSON the copy button can hand to an app. */
export function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

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
    mcpServers: {
      ensemble: {
        type: "local",
        command: "node",
        args: [facts.bridgeScript],
        tools: ["*"],
        env: envBlock(facts, tokenValue(facts)),
      },
    },
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
