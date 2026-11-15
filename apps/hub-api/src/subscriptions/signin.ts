/**
 * Signing in to an AI subscription on this computer, with the vendor's own sign-in (docs/30 §8):
 * Ensemble opens a terminal window running the tool's own login command (`claude auth login`,
 * `codex login`, `cursor-agent login`, `copilot login`, `grok login`, `opencode auth login`, or
 * `gemini` or `qwen`, whose first start asks how to sign in, `vibe-acp --setup`, `kimi login`), which opens the vendor's sign-in page in the
 * browser. Antigravity has no command: Ensemble installs its agent when needed and opens the Google
 * sign-in page it prints (`antigravity.ts`). The tool keeps the sign-in where it always does;
 * Ensemble never sees it. Then the tool is checked again every few seconds until it reports a
 * sign-in, or for six minutes.
 *
 * Setting up an agent whose app is here without it (the Cursor app, VS Code with Copilot;
 * `agent-apps.ts`): the terminal window runs the vendor's own installer first, the one the Cursor
 * app's `cursor agent` runs or GitHub's for Copilot CLI, then the same login.
 */
import { homedir } from "node:os";
import { AGENT_APP_INFO, AGENT_APPS, SUBSCRIPTION_INFO, type AgentApp, type SubscriptionProvider } from "@ensemble/shared-types";
import { openLink, psQuote, shQuote, type HandoffOpen } from "../workspace/handoff.js";
import { appPresence, installedProgram, type Where } from "./agent-apps.js";
import { signInAntigravity } from "./antigravity.js";
import { agentBinary, refreshAgent } from "./detect.js";

export const LOGIN_ARGS: Record<Exclude<SubscriptionProvider, "antigravity">, string[]> = {
  // A Claude subscription, not Console API billing.
  "claude-code": ["auth", "login", "--claudeai"],
  codex: ["login"],
  "cursor-agent": ["login"],
  "copilot-cli": ["login"],
  "grok-cli": ["login"],
  opencode: ["auth", "login"],
  // Gemini CLI has no login command: its first start asks how to sign in (Sign in with Google).
  "gemini-cli": [],
  // Mistral Vibe's setup: sign in with the Mistral account in the browser, or paste an API key.
  "mistral-vibe": ["--setup"],
  // Qwen Code (built from Gemini CLI) asks how to sign in on its first start; `/auth` there later.
  "qwen-code": [],
  // Kimi Code's device-code sign-in: it prints a link and a code, and waits for the browser.
  "kimi-code": ["login"],
};

const WATCH_MS = 6 * 60_000;
/** A set up also waits for the vendor's download and install before the sign-in. */
const SETUP_WATCH_MS = 20 * 60_000;
const EVERY_MS = 8_000;
const watching = new Set<SubscriptionProvider>();

/** Checks the agent again every few seconds until it reports a sign-in or the time is up, then says so once. */
function watchSignIn(agent: SubscriptionProvider, forMs: number, onChange: () => void): void {
  if (watching.has(agent)) return;
  watching.add(agent);
  const started = Date.now();
  const timer = setInterval(() => {
    void refreshAgent(agent)
      .then((row) => {
        if (row?.signedIn || Date.now() - started > forMs) {
          clearInterval(timer);
          watching.delete(agent);
          onChange();
        }
      })
      .catch(() => undefined);
  }, EVERY_MS);
  timer.unref?.();
}

export async function startSignIn(
  agent: SubscriptionProvider,
  onChange: () => void,
  open: typeof openLink = openLink,
): Promise<string> {
  const label = SUBSCRIPTION_INFO[agent].label;
  if (agent === "antigravity") {
    // Installs the agent (once), then opens Google's sign-in page from it; checked again when it ends.
    void signInAntigravity((url) => open({ url, commands: [] }))
      .catch(() => undefined)
      .finally(() => void refreshAgent(agent).finally(onChange));
    return "Antigravity is being set up on this computer: Ensemble installs Google's agent the first time (a large download), then Google's sign-in page opens in the browser.";
  }
  const found = await agentBinary(agent);
  if (!found) {
    const info = SUBSCRIPTION_INFO[agent];
    throw new Error(`${label} is not on this computer. ${info.install.label} (${info.install.url}) first.`);
  }
  await open({ url: null, commands: [], terminal: { folder: homedir(), program: found.path, args: [...(found.args ?? []), ...LOGIN_ARGS[agent]] } });
  watchSignIn(agent, WATCH_MS, onChange);
  return `A ${label} sign-in window opened on this computer. Finish signing in there; the browser shows ${label}'s own sign-in page.`;
}

const SET_UP: Record<AgentApp, { app: string; program: string; installer: string; signIn: string }> = {
  "cursor-app": { app: "The Cursor app", program: "Cursor's agent", installer: "Cursor's installer", signIn: "Cursor's sign-in" },
  "vscode-copilot": { app: "VS Code with GitHub Copilot", program: "Copilot CLI", installer: "GitHub's installer", signIn: "Copilot's sign-in" },
};

const NOT_FINISHED = "Setup did not finish.";

/**
 * What Set up runs in the terminal window: the vendor's own installer (`AGENT_APP_INFO`'s command, WinGet
 * for Copilot on Windows), then the agent's login from where that installer put it. A window that would
 * close by itself stays open when either fails, so the person can read why.
 */
export function setupCommand(app: AgentApp, input: Partial<Pick<Where, "platform" | "home" | "env">> = {}): Pick<NonNullable<HandoffOpen["terminal"]>, "program" | "args"> {
  const platform = input.platform ?? process.platform;
  const info = AGENT_APP_INFO[app];
  const login = LOGIN_ARGS[info.agent as Exclude<SubscriptionProvider, "antigravity">];
  if (platform === "win32") {
    // Cursor's installer puts its folder on the PATH; WinGet's new Links folder needs the PATH read again.
    const program = app === "cursor-app" ? "$program = Join-Path $env:LOCALAPPDATA 'cursor-agent\\cursor-agent.exe'" : "$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User'); $program = (Get-Command copilot -ErrorAction SilentlyContinue).Source";
    const install = app === "cursor-app" ? info.install.windows : `if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Write-Host ${psQuote(`WinGet is not on this computer. Install Copilot CLI from ${SUBSCRIPTION_INFO[info.agent].install.url}, then press Sign in.`)}; exit 1 }; ${info.install.windows} --exact --source winget`;
    const script = `${install}; ${program}; if ($program -and (Test-Path -LiteralPath $program)) { & $program ${login.map(psQuote).join(" ")} } else { Write-Host ${psQuote(NOT_FINISHED)} }`;
    return { program: "powershell.exe", args: ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] };
  }
  const installed = installedProgram(app, { platform, home: input.home ?? homedir(), env: input.env ?? process.env });
  const script = [
    info.install.unix,
    `if [ -x ${shQuote(installed)} ]; then ${[installed, ...login].map(shQuote).join(" ")} && exit 0; fi`,
    "echo",
    `printf '%s ' ${shQuote(`${NOT_FINISHED} Press Return to close this window.`)}`,
    "read -r _",
  ].join("\n");
  return { program: "/bin/sh", args: ["-c", script] };
}

/**
 * Set up for an agent whose app is here without it: a terminal window runs the vendor's installer, then the
 * agent's sign-in, and the agent is checked again until it is signed in. With the agent already here, only the sign-in.
 */
export async function startSetUp(agent: SubscriptionProvider, onChange: () => void, open: typeof openLink = openLink): Promise<string> {
  const info = SUBSCRIPTION_INFO[agent];
  const app = AGENT_APPS.find((row) => AGENT_APP_INFO[row].agent === agent);
  if (!app) throw new Error(`Ensemble sets up only Cursor's agent and Copilot CLI. ${info.install.label} (${info.install.url}).`);
  if (!appPresence().includes(app)) throw new Error(`${SET_UP[app].app} was not found on this computer. ${info.install.label} (${info.install.url}) instead.`);
  if (await agentBinary(agent)) return startSignIn(agent, onChange, open);
  await open({ url: null, commands: [], terminal: { folder: homedir(), ...setupCommand(app) } });
  watchSignIn(agent, SETUP_WATCH_MS, onChange);
  const copy = SET_UP[app];
  return `A terminal window opened on this computer: it installs ${copy.program} with ${copy.installer}, then opens ${copy.signIn}. Finish signing in there.`;
}

/** The web's words for a set up started on another computer. */
export function setUpMessage(app: AgentApp, computer: string): string {
  const copy = SET_UP[app];
  return `A terminal window is opening on ${computer}: it installs ${copy.program} with ${copy.installer}, then opens ${copy.signIn}. Finish signing in there.`;
}
