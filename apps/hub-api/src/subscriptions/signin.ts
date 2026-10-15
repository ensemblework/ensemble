/**
 * Signing in to an AI subscription on this computer, with the vendor's own sign-in (docs/30 §8):
 * Ensemble opens a terminal window running the tool's own login command (`claude auth login`,
 * `codex login`, `cursor-agent login`, `copilot login`), which opens the vendor's sign-in page in
 * the browser. The tool keeps the sign-in where it always does; Ensemble never sees it. Then the
 * tool is checked again every few seconds until it reports a sign-in, or for six minutes.
 */
import { homedir } from "node:os";
import { SUBSCRIPTION_INFO, type SubscriptionProvider } from "@ensemble/shared-types";
import { openLink } from "../workspace/handoff.js";
import { agentBinary, refreshAgent } from "./detect.js";

export const LOGIN_ARGS: Record<SubscriptionProvider, string[]> = {
  // A Claude subscription, not Console API billing.
  "claude-code": ["auth", "login", "--claudeai"],
  codex: ["login"],
  "cursor-agent": ["login"],
  "copilot-cli": ["login"],
};

const WATCH_MS = 6 * 60_000;
const EVERY_MS = 8_000;
const watching = new Set<SubscriptionProvider>();

export async function startSignIn(
  agent: SubscriptionProvider,
  onChange: () => void,
  open: typeof openLink = openLink,
): Promise<string> {
  const label = SUBSCRIPTION_INFO[agent].label;
  const found = await agentBinary(agent);
  if (!found) {
    const info = SUBSCRIPTION_INFO[agent];
    throw new Error(`${label} is not on this computer. ${info.install.label} (${info.install.url}) first.`);
  }
  await open({ url: null, commands: [], terminal: { folder: homedir(), program: found.path, args: LOGIN_ARGS[agent] } });
  if (!watching.has(agent)) {
    watching.add(agent);
    const started = Date.now();
    const timer = setInterval(() => {
      void refreshAgent(agent)
        .then((row) => {
          if (row?.signedIn || Date.now() - started > WATCH_MS) {
            clearInterval(timer);
            watching.delete(agent);
            onChange();
          }
        })
        .catch(() => undefined);
    }, EVERY_MS);
    timer.unref?.();
  }
  return `A ${label} sign-in window opened on this computer. Finish signing in there; the browser shows ${label}'s own sign-in page.`;
}
