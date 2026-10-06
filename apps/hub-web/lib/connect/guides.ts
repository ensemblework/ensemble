import type { AppId } from "./catalog";

export type Scene = "key" | "terminal" | "menu" | "paste" | "chat" | "test" | "success";

export type StepKind =
  | "key"
  | "build"
  | "env"
  | "vscode-install"
  | "copilot"
  | "cursor-install"
  | "gemini"
  | "claude-code"
  | "claude-desktop"
  | "codex"
  | "codex-app"
  | "windsurf"
  | "zed"
  | "visual-studio"
  | "jetbrains"
  | "cline"
  | "continue"
  | "opencode"
  | "http-start"
  | "http-config"
  | "enable"
  | "test";

export type GuideStep = {
  kind: StepKind;
  title: string;
  body: string;
  scene: Scene;
  /** Highlighted control inside the illustration. */
  hotspot: string;
  os?: boolean;
  /** The shared connection on port 4010 has to be up for this test to count as success. */
  requiresHttp?: boolean;
};

export type Trouble = { problem: string; fix: string };

const KEY: GuideStep = {
  kind: "key",
  title: "Create your read-only key",
  body: "This key is how an app proves it is you. It can look at your tasks, people, and notes. It cannot add, edit, or send anything. Ensemble shows the key once. Copy it before you move on.",
  scene: "key",
  hotspot: "Create key",
};

const BUILD: GuideStep = {
  kind: "build",
  title: "Prepare the connector",
  body: "Your app starts a small program that lives in your Ensemble folder. Copy this command, paste it into Terminal or PowerShell, and press Enter. When it finishes without an error, come back and press Next.",
  scene: "terminal",
  hotspot: "pnpm bridge:build",
  os: true,
};

const ENV: GuideStep = {
  kind: "env",
  title: "Let your computer remember the key",
  body: "The install button does not put your key in the link. Your app reads it from a value named ENSEMBLE_BRIDGE_TOKEN. Paste this line, press Enter, and leave that window open while you use the app. On Windows this is for PowerShell.",
  scene: "terminal",
  hotspot: "ENSEMBLE_BRIDGE_TOKEN",
  os: true,
};

const TEST: GuideStep = {
  kind: "test",
  title: "Test the connection",
  body: "This checks that Ensemble can answer. Many apps start Ensemble themselves, so you can be ready even when the shared connection is off.",
  scene: "test",
  hotspot: "Test connection",
};

const HTTP_TEST: GuideStep = { ...TEST, requiresHttp: true, body: "This checks the shared connection on this computer. It has to be running before another app can use the address." };

function enable(title: string, body: string, hotspot: string): GuideStep {
  return { kind: "enable", title, body, scene: "chat", hotspot };
}

const STEPS: Record<AppId, GuideStep[]> = {
  vscode: [
    KEY,
    ENV,
    {
      kind: "vscode-install",
      title: "Add Ensemble to VS Code",
      body: "Press Add to VS Code and confirm the prompt. If VS Code does not open, copy the settings into your user file: open the Command Palette and run MCP: Open User Configuration. If you already opened this Ensemble folder, that folder’s settings file is already filled in.",
      scene: "menu",
      hotspot: "Add to VS Code",
      os: true,
    },
    enable(
      "Turn Ensemble on in chat",
      "Open the Command Palette and run MCP: List Servers. Choose ensemble, then Start. In the Chat box, open Configure Tools and switch Ensemble on. If it is missing, run Developer: Reload Window and look again.",
      "Configure Tools",
    ),
    TEST,
  ],
  "copilot-cli": [
    KEY,
    {
      kind: "copilot",
      title: "Add Ensemble to Copilot CLI",
      body: "Copilot CLI keeps its own file. It does not read the VS Code settings. Copy the block below into that file, replacing an older ensemble entry if you see one. You can also run the command, then check the file still contains your key.",
      scene: "paste",
      hotspot: "mcp-config.json",
      os: true,
    },
    enable(
      "See it in a session",
      "Open the folder you care about, run copilot, and type /mcp. Ensemble should be in the list. Type /mcp add only if the file from the last step did not stick.",
      "/mcp",
    ),
    TEST,
  ],
  cursor: [
    KEY,
    ENV,
    {
      kind: "cursor-install",
      title: "Add Ensemble to Cursor",
      body: "Press Add to Cursor and confirm the install prompt. If Cursor does not open, copy the settings into ~/.cursor/mcp.json (on Windows, %USERPROFILE%\\.cursor\\mcp.json). This Ensemble folder already contains a project file named .cursor/mcp.json.",
      scene: "menu",
      hotspot: "Add to Cursor",
    },
    enable(
      "Switch Ensemble on",
      "Open Cursor Settings, then MCP. Find ensemble and switch it on. If the list is empty, restart Cursor and look again.",
      "MCP",
    ),
    TEST,
  ],
  "claude-code": [
    KEY,
    {
      kind: "claude-code",
      title: "Add Ensemble to Claude Code",
      body: "Copy this command and run it in Terminal or PowerShell, from any folder. It saves the server and your key. This Ensemble folder also contains a file named .mcp.json, which Claude Code reads when you work inside the folder — but only after the key is set.",
      scene: "terminal",
      hotspot: "claude mcp add",
      os: true,
    },
    enable(
      "Check it inside Claude Code",
      "Start claude in your project and type /mcp. You should see ensemble. If Claude says the folder is not trusted, trust the folder, then look again.",
      "/mcp",
    ),
    TEST,
  ],
  "claude-desktop": [
    KEY,
    {
      kind: "claude-desktop",
      title: "Paste Ensemble into Claude’s settings",
      body: "In Claude Desktop, open Settings, then Developer, then Edit Config. That opens claude_desktop_config.json. If the file already has other apps, add the ensemble block inside mcpServers. If the file is empty, paste this whole block.",
      scene: "paste",
      hotspot: "Edit Config",
      os: true,
    },
    enable(
      "Restart Claude",
      "Quit Claude Desktop completely, then open it again. Start a new chat. If a tools menu appears, Ensemble should be listed. The first launch can take a few seconds while the program starts.",
      "Restart",
    ),
    TEST,
  ],
  codex: [
    KEY,
    {
      kind: "codex",
      title: "Add Ensemble with one command",
      body: "Copy this command and run it in Terminal or PowerShell. Codex saves it in its config file. The ChatGPT desktop app and the Codex editor extension read that same file, so you do not set them up separately.",
      scene: "terminal",
      hotspot: "codex mcp add",
      os: true,
    },
    {
      kind: "codex-app",
      title: "Or add it from the ChatGPT app",
      body: "ChatGPT in the browser cannot see this computer. The desktop app can. Open Settings, then MCP servers, then Add server. Choose STDIO, name it ensemble, set the command to node, and paste the path from the block below. Save, then Restart. In the message box, type /mcp. The same screen exists in the Codex editor extension under the gear menu.",
      scene: "menu",
      hotspot: "MCP servers",
      os: true,
    },
    TEST,
  ],
  windsurf: [
    KEY,
    {
      kind: "windsurf",
      title: "Paste Ensemble into Windsurf",
      body: "Open Cascade, then Manage MCPs, and open the raw config. Paste this block. If you already have other servers, add ensemble inside mcpServers instead of replacing the whole file.",
      scene: "paste",
      hotspot: "Manage MCPs",
      os: true,
    },
    enable(
      "Refresh Cascade",
      "In Manage MCPs, press Refresh. Ensemble should appear in the list. If a brand-new chat still cannot see it, check that the chat is using Cascade, the agent that reads this file.",
      "Refresh",
    ),
    TEST,
  ],
  gemini: [
    KEY,
    {
      kind: "gemini",
      title: "Paste Ensemble into Gemini CLI",
      body: "Open ~/.gemini/settings.json (on Windows, %USERPROFILE%\\.gemini\\settings.json) and add the ensemble server under mcpServers. If other servers are already there, merge the ensemble entry instead of replacing the file.",
      scene: "paste",
      hotspot: "settings.json",
      os: true,
    },
    TEST,
  ],
  zed: [
    KEY,
    {
      kind: "zed",
      title: "Add a local server in Zed",
      body: "Open Settings, then AI, then MCP Servers. Press Add Server, then Add Local Server. Paste this block into settings, or merge the ensemble entry into context_servers if that key already exists. You can also open the file directly with the command palette action zed: open settings file.",
      scene: "paste",
      hotspot: "Add Local Server",
    },
    enable(
      "Wait for the green dot",
      "Stay on Settings → AI → MCP Servers. Next to ensemble, the dot turns green and the tooltip says the server is active. Then go back to the Agent Panel and ask a question.",
      "Server is active",
    ),
    TEST,
  ],
  "visual-studio": [
    KEY,
    {
      kind: "visual-studio",
      title: "Paste Ensemble into Visual Studio",
      body: "Visual Studio 2022 17.14 and newer reads MCP servers from %USERPROFILE%\\.mcp.json. Add the ensemble block under servers, then restart Visual Studio so AI features can load it.",
      scene: "paste",
      hotspot: ".mcp.json",
      os: true,
    },
    TEST,
  ],
  jetbrains: [
    KEY,
    {
      kind: "jetbrains",
      title: "Add Ensemble in AI Assistant",
      body: "Open Settings, then Tools, then AI Assistant, then Model Context Protocol (MCP). Press Add. Choose the JSON option and paste this block. Set the server level to Global if you want it in every project. You need the AI Assistant plugin switched on.",
      scene: "paste",
      hotspot: "Add",
    },
    enable(
      "Apply and restart the chat",
      "Press Apply, then OK. Open the AI Assistant chat and start a new conversation. If Ensemble says the key is missing, edit the server and add ENSEMBLE_BRIDGE_TOKEN under environment variables, using the key you copied.",
      "Apply",
    ),
    TEST,
  ],
  cline: [
    KEY,
    {
      kind: "cline",
      title: "Add Ensemble in Cline",
      body: "In the Cline panel, click the MCP Servers icon in the top toolbar. Open the Configure tab, then Configure MCP Servers. Paste this block. Leave the type field out — Cline treats a command as a local program. For the Cline terminal app, the same block goes in the file below, or you can run cline mcp and follow the prompts.",
      scene: "paste",
      hotspot: "Configure MCP Servers",
      os: true,
    },
    enable(
      "Confirm the tools are listed",
      "Back on the MCP Servers screen, ensemble should be enabled. If it is not, press the toggle. Ask Cline something about your tasks so it has a reason to call Ensemble.",
      "ensemble",
    ),
    TEST,
  ],
  continue: [
    KEY,
    {
      kind: "continue",
      title: "Drop a file into Continue",
      body: "In your project, create a folder named .continue/mcpServers if it is not there. Save the text below as ensemble.yaml inside that folder. Continue also accepts the JSON other apps use, in that same folder. MCP tools are available in agent mode.",
      scene: "paste",
      hotspot: "ensemble.yaml",
    },
    enable(
      "Ask in agent mode",
      "Open Continue and switch to agent mode. Other modes do not call these tools. Ask one of the example questions. If nothing happens, reload the window so Continue reads the new file.",
      "Agent mode",
    ),
    TEST,
  ],
  opencode: [
    KEY,
    {
      kind: "opencode",
      title: "Paste Ensemble into opencode",
      body: "Open ~/.config/opencode/opencode.json and add the ensemble entry under mcp. If the file already has other MCP servers, merge this entry instead of replacing the whole file.",
      scene: "paste",
      hotspot: "opencode.json",
      os: true,
    },
    TEST,
  ],
};

export function stepsFor(app: AppId, built: boolean): GuideStep[] {
  const steps = STEPS[app];
  if (built) return steps;
  const [first, ...rest] = steps;
  return [first!, BUILD, ...rest];
}

const SHARED_TROUBLE: Trouble[] = [
  {
    problem: "It says Ensemble is not running.",
    fix: "Open Ensemble the same way you opened this page, and leave it open. If you start it from a terminal, that command is pnpm dev, from the Ensemble folder.",
  },
  {
    problem: "It says the key is missing, or it mentions dev-internal-token.",
    fix: "Create a new key on the Connect page. It starts with ens_. Put that value in the step that asks for it. The example ens_PASTE_TOKEN will not work.",
  },
  {
    problem: "The app offers to change or delete something in Ensemble.",
    fix: "This connection cannot do that. If a tool name starts with ensemble_, it is only allowed to look. Anything else is the app’s own tool, not Ensemble.",
  },
];

const EXTRA: Partial<Record<AppId, Trouble[]>> = {
  vscode: [
    {
      problem: "Ensemble never appears in the tools list.",
      fix: "Run Developer: Reload Window. Then MCP: List Servers, start ensemble, and open Configure Tools in Chat. A server that asks you to type the key in a popup is dropped — the key has to be the environment line from the earlier step.",
    },
    {
      problem: "The Add to VS Code button does nothing.",
      fix: "VS Code has to be installed. You can also run the terminal command on that step (code --add-mcp). On Windows, sandboxing for local programs is not available; that does not block Ensemble.",
    },
  ],
  "copilot-cli": [
    {
      problem: "Copilot CLI does not list Ensemble.",
      fix: "The file is ~/.copilot/mcp-config.json, not the VS Code file. The top-level word is mcpServers. In a session, /mcp shows what actually loaded. The key has to be inside that file’s env block.",
    },
  ],
  gemini: [
    {
      problem: "Gemini CLI does not read the server.",
      fix: "The file is ~/.gemini/settings.json and the top-level key is mcpServers. Restart Gemini CLI after saving it.",
    },
  ],
  "visual-studio": [
    {
      problem: "Visual Studio does not list Ensemble.",
      fix: "Use Visual Studio 2022 17.14 or newer. The file is %USERPROFILE%\\.mcp.json and the top-level key is servers.",
    },
  ],
  opencode: [
    {
      problem: "opencode starts but no tools appear.",
      fix: "The local source block goes under mcp. Restart opencode after saving ~/.config/opencode/opencode.json.",
    },
  ],
  cursor: [
    {
      problem: "Cursor installed it, then tools fail immediately.",
      fix: "The key is not inside the link. Run the “remember the key” line in a terminal, quit Cursor completely, and open it again so it sees ENSEMBLE_BRIDGE_TOKEN.",
    },
  ],
  "claude-code": [
    {
      problem: "claude mcp add says the command is not found.",
      fix: "Install Claude Code first, and open a new terminal so it is on your PATH. The word ensemble in the command is the name, and it has to come before the -- that starts the program.",
    },
  ],
  "claude-desktop": [
    {
      problem: "Claude says the config file is broken.",
      fix: "The file has to be valid JSON. If you already had mcpServers, add ensemble inside it instead of pasting a second mcpServers. Then quit Claude from the menu, not only the window.",
    },
  ],
  codex: [
    {
      problem: "ChatGPT on the web still cannot see Ensemble.",
      fix: "The website does not read files on your computer. Use the ChatGPT desktop app, Codex in the terminal, or the Codex extension. They share ~/.codex/config.toml. In a Codex session, /mcp lists what connected.",
    },
  ],
  windsurf: [
    {
      problem: "The file is saved, but a new chat has no Ensemble tools.",
      fix: "Refresh from Manage MCPs. A new chat that uses a different agent may not read ~/.codeium/windsurf/mcp_config.json. Switch to Cascade, which does.",
    },
  ],
  zed: [
    {
      problem: "The dot stays red.",
      fix: "The command is the word node, and the path to index.js is a separate argument. Open Settings → AI → MCP Servers and read the tooltip. The program has to be prepared with pnpm bridge:build first.",
    },
  ],
  jetbrains: [
    {
      problem: "You cannot find Model Context Protocol.",
      fix: "Install or enable the JetBrains AI Assistant plugin, then look under Settings → Tools → AI Assistant. You can also type a slash in the AI chat and choose Add Command.",
    },
  ],
  cline: [
    {
      problem: "Cline tries to connect and immediately fails.",
      fix: "For this local program, do not set a type. A missing type on an address makes Cline use an older style. The local block uses command and args only.",
    },
  ],
  continue: [
    {
      problem: "Continue ignores the file.",
      fix: "The folder name is .continue/mcpServers, with an s. The file needs name, version, and schema at the top when it is YAML. Switch to agent mode. Chat and edit modes do not call these tools.",
    },
  ],
};

export function troubleFor(app: AppId): Trouble[] {
  return [...(EXTRA[app] ?? []), ...SHARED_TROUBLE];
}
