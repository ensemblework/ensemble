/**
 * A coding agent's run that needs its owner to sign in, or to pass a human check (B11): the agent's
 * browser call waits until the sign-in ends. For a run from the web the computer tells the server
 * (`ROUTES.runLogin`), which raises the sign-in card where the run is followed (a node's run: its
 * conversation, on Node and the Hub's Needs me). Otherwise (a run started here, or a server too old)
 * it asks on Needs me with a question: use the saved login, done on this computer (in the window it
 * opens there), or not now. A sign-in seen done by itself withdraws the question.
 */
import type { JobContext } from "../workspace/tools.js";
import type { LoginInfo } from "./requests.js";
import { bindDecision, outcomeNote, resolveLogin, waitForLogin } from "./requests.js";

type Sink = (localJobId: string, login: LoginInfo) => Promise<{ decisionId: string | null } | null>;
let sink: Sink | null = null;

/** Set by the remote loop while it is connected; null when it is not. */
export function setRunLoginSink(next: Sink | null): void {
  sink = next;
}

const SAVED = "Use my saved login";
const SIGNED_IN = "I signed in on this computer";
const PASSED = "I passed it on this computer";
const NOT_NOW = "Not now";

/** Asks on Needs me until the sign-in works or the owner says not now (three tries at most); withdrawn when it is seen done. */
async function askHere(ctx: JobContext, login: LoginInfo): Promise<void> {
  const { askPerson } = await import("../workspace/tools.js");
  const over = new AbortController();
  void waitForLogin(login.loginId, ctx.signal).then(() => over.abort());
  const human = login.purpose === "human_check";
  if (login.display) await resolveLogin(login.loginId, "local").catch(() => null);
  let problem = "";
  for (let round = 0; round < 3; round += 1) {
    if (over.signal.aborted) return;
    const options = [...(human ? [] : [SAVED]), ...(login.display ? [human ? PASSED : SIGNED_IN] : []), NOT_NOW];
    const title = `${human ? `Pass the human check on ${login.origin}` : `Sign in to ${login.origin}`} for this task${problem ? ` (${problem})` : ""}`.slice(0, 300);
    const answer = await askPerson(ctx, { event: "question", toolName: "browser_login_needed", title, options, allowCustom: false, recommended: login.saved && !human ? SAVED : null }, over.signal);
    if (over.signal.aborted) return;
    const chosen = answer.decision === "allow" ? (answer.answer ?? "") : "";
    if (!chosen || chosen.startsWith(NOT_NOW)) break;
    const result = await resolveLogin(login.loginId, chosen.startsWith(SAVED) ? "saved" : "done");
    if (result.status === "signed_in" || result.status === "passed" || result.status === "gone" || result.status === "declined" || result.status === "expired") return;
    problem = result.message ?? (human ? "the check still shows" : "still not signed in");
    if (/No login is saved/.test(problem)) problem = `no login is saved for it here: save one with \`ensemble browser save-login ${login.origin}\`, then pick “${SAVED}”`;
  }
  if (!over.signal.aborted) await resolveLogin(login.loginId, "decline");
}

/** Waits for a run's sign-in to end and says how, for the agent. */
export async function awaitRunLogin(ctx: JobContext, login: LoginInfo): Promise<string> {
  const raised = sink ? await sink(ctx.job.id, login).catch(() => null) : null;
  if (raised?.decisionId) bindDecision(login.loginId, raised.decisionId);
  else void askHere(ctx, login).catch(() => resolveLogin(login.loginId, "decline"));
  return outcomeNote(await waitForLogin(login.loginId, ctx.signal));
}
