/**
 * The pure parts of Ensemble Node's session control: how a run in a session takes its settings
 * (inherit, the agent's default, or as named), what the engine reported, the one-line summary, what a
 * computer's agent can honour, the order of a session's queue, which agent questions a node may answer
 * and with what quote, the watchdog's error signatures, and why a closed Needs me request is refused.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { SubscriptionAgent } from "@ensemble/shared-types";

process.env.DATABASE_URL ??= "postgresql://localhost/unused";
const { sessionChoices, resolveSessionTuning } = await import("../workspace/assign.js");
const { appliedLine, observedSettings, requestedSettings, resolvedSettings, settingsLine, tuningProblem, NOT_REPORTED } = await import("./settings.js");
const { cleanObserved, mergeObserved, observedFromEvents, observedUpdate, windowTier } = await import("../workspace/engines/observed.js");
const { claudeWindow } = await import("../workspace/engines/claude-code.js");
const { liveOrder, queuedOrder } = await import("../workspace/sessions.js");
const { normalizeQuote, questionRefusal, quoteFound } = await import("./session-questions.js");
const { errorSignature, outsidePath } = await import("./watchdog.js");
const { closedRefusal, ENDED_WITH_WORK, WORK_ENDED } = await import("../lib/decisions.js");
const { sessionState } = await import("./session-queue.js");

const session = { model: "gpt-6.1-sol", effort: "xhigh", contextTier: "long_context" as const, fast: false };

test("a run in a session keeps each setting it does not name, resets the ones named default, and takes the ones named", () => {
  const keep = resolveSessionTuning(session, sessionChoices({ engine: "copilot-cli" }, "copilot-cli"));
  assert.deepEqual(keep, { model: "gpt-6.1-sol", reasoningEffort: "xhigh", contextTier: "long_context" });

  // Naming a model keeps the thinking level and context window (the bug B3 fixes: they were dropped).
  const model = resolveSessionTuning(session, sessionChoices({ engine: "copilot-cli", model: "claude-opus-4.8" }, "copilot-cli"));
  assert.deepEqual(model, { model: "claude-opus-4.8", reasoningEffort: "xhigh", contextTier: "long_context" });

  // "default" is the agent's own default, never the session's.
  const reset = resolveSessionTuning(session, sessionChoices({ engine: "copilot-cli", reasoningEffort: "default", contextTier: "default", model: "default" }, "copilot-cli"));
  assert.deepEqual(reset, {});

  // Explicit values win; fast false is off, not "keep".
  const named = resolveSessionTuning({ ...session, fast: true }, sessionChoices({ engine: "copilot-cli", reasoningEffort: "low", contextTier: "long_context", fast: false }, "copilot-cli"));
  assert.deepEqual(named, { model: "gpt-6.1-sol", reasoningEffort: "low", contextTier: "long_context" });

  // A model named for another agent (Ensemble's own) does not replace the session's.
  assert.equal(resolveSessionTuning(session, sessionChoices({ engine: "ensemble", model: "gpt-5" }, "copilot-cli")).model, "gpt-6.1-sol");
  assert.deepEqual(sessionChoices({ engine: "codex" }, "codex"), { model: { state: "inherit" }, effort: { state: "inherit" }, context: { state: "inherit" }, fast: { state: "inherit" } });
});

test("settings are recorded as asked, as sent and as the engine reported them, in one line", () => {
  const requested = requestedSettings({ agent: "copilot-cli", model: " GPT 6.1 Sol ", effort: "default", context: "long_context", fast: null });
  assert.deepEqual(requested, { agent: "copilot-cli", model: "GPT 6.1 Sol", effort: "default", context: "long_context" });
  const resolved = resolvedSettings({ provider: "copilot-cli", model: "gpt-6.1-sol", reasoningEffort: null, context: { contextTier: "long_context" } });
  assert.deepEqual(resolved, { agent: "copilot-cli", model: "gpt-6.1-sol", effort: "default", context: "long_context", fast: false });

  const observed = observedSettings({ provider: "copilot-cli", observedSettings: null }, [{ kind: "engine", data: { engine: "copilot", model: "gpt-6.1-sol", observed: { model: "gpt-6.1-sol" } } }]);
  assert.deepEqual(observed, { agent: "copilot-cli", model: "gpt-6.1-sol", effort: NOT_REPORTED, context: NOT_REPORTED, fast: NOT_REPORTED });
  assert.equal(
    settingsLine({ requested, resolved, observed }),
    "GitHub Copilot · GPT 6.1 Sol · default effort · long context (requested); observed model gpt-6.1-sol, effort not reported, context not reported",
  );
  // Nothing asked: the line says what was sent; nothing reported yet says so.
  assert.equal(settingsLine({ requested: {}, resolved: { agent: "claude-code", model: "default", effort: "high", context: "default", fast: true } }), "Claude Code · default model · high effort · default context · fast mode (as sent); observed: nothing reported yet");
  // The computer's report comes before the job's events; a window in tokens shows with its tier.
  const reported = observedSettings({ provider: "codex", observedSettings: { effort: "high", context: "default", contextTokens: 272000 } }, [{ kind: "engine", data: { model: "gpt-5.5-codex" } }]);
  assert.deepEqual(reported, { agent: "codex", model: "gpt-5.5-codex", effort: "high", context: "default", fast: NOT_REPORTED, contextTokens: 272000 });
  assert.match(settingsLine({ requested: {}, resolved: { agent: "codex" }, observed: reported }), /observed model gpt-5\.5-codex, effort high, context default \(272K\)$/);
  // The agent's instructions say what is applied, so it never stops to check.
  assert.equal(appliedLine(resolved), "Ensemble already started you with gpt-6.1-sol and the long context window. Do not check these settings yourself.");
  assert.equal(appliedLine({ model: "default", effort: "default", context: "default", fast: false }), "");
});

test("observed settings come only from what the engine said, never from what was asked", () => {
  // A runtime before observed settings: only the engine's own model counts.
  assert.deepEqual(observedFromEvents([{ kind: "engine", data: { engine: "copilot", model: "gpt-6.1-sol", effort: "xhigh", context: "long_context" } }]), { model: "gpt-6.1-sol" });
  assert.deepEqual(
    observedFromEvents([
      { kind: "engine", data: { model: "old", observed: { model: "old" } } },
      { kind: "engine", data: { model: "claude-sonnet-4-6", observed: { model: "claude-sonnet-4-6", effort: "high" } } },
      { kind: "engine_context", data: { used: 1000, size: 1_000_000, context: "long_context" } },
    ]),
    { model: "claude-sonnet-4-6", effort: "high", context: "long_context", contextTokens: 1_000_000 },
  );
  assert.equal(windowTier(990_000, { long: 1_000_000 }), "long_context");
  assert.equal(windowTier(200_000, { standard: 200_000, long: 1_000_000 }), "default");
  assert.equal(windowTier(200_000, {}), undefined);
  assert.deepEqual(cleanObserved({ model: "", effort: 3, context: "huge", contextTokens: -1, fast: "yes" }), {});
  assert.deepEqual(mergeObserved({ model: "a" }, { model: "b", effort: "low" }), { model: "a", effort: "low" });
  assert.deepEqual(observedUpdate({}), {});
  assert.deepEqual(observedUpdate({ model: "gpt-6.1-sol", fast: false }), { observedSettings: { model: "gpt-6.1-sol", fast: false } });
  // Claude Code's result names the window per model: the main one, as the model's tier.
  assert.deepEqual(claudeWindow({ "claude-sonnet-4-6": { contextWindow: 1_000_000, outputTokens: 900 }, "claude-haiku-4-5": { contextWindow: 200_000, outputTokens: 10 } }, "claude-sonnet-4-6[1m]"), { size: 1_000_000, context: "long_context" });
  assert.deepEqual(claudeWindow({ "claude-sonnet-4-6": { contextWindow: 200_000 } }, null), { size: 200_000, context: "default" });
  assert.equal(claudeWindow({ x: {} }, null), null);
});

const copilot = (models: SubscriptionAgent["models"]): SubscriptionAgent => ({ id: "copilot-cli", via: "cli", version: "1", signedIn: true, models, checkedAt: new Date().toISOString() });

test("a setting the computer's agent cannot honour is refused once, with what to do instead", () => {
  const listing = copilot([
    { id: "gpt-6.1-sol", label: "GPT 6.1 Sol", efforts: ["low", "medium", "high"], contexts: [{ id: "default", label: "200K", tokens: 200_000 }] },
    { id: "claude-opus-4.8", label: "Claude Opus 4.8", efforts: ["low", "high", "xhigh"], contexts: [{ id: "default", label: "200K", tokens: 200_000 }, { id: "long_context", label: "1M", tokens: 1_000_000 }] },
  ]);
  const base = { engine: "copilot-cli", computer: "Mira's laptop", listing, effort: null, fast: false };
  const long = tuningProblem({ ...base, model: "gpt-6.1-sol", context: "long_context" });
  assert.equal(long?.message, "GitHub Copilot on Mira's laptop does not offer long context for GPT 6.1 Sol.");
  assert.match(long!.remedy, /context: default.*claude-opus-4\.8/);
  assert.equal(tuningProblem({ ...base, model: "claude-opus-4.8", context: "long_context" }), null);
  assert.match(tuningProblem({ ...base, model: "gpt-6.1-sol", context: "long_context", kept: { context: true } })!.message, /This session used long context, so it was kept\./);
  // A kept thinking level is checked against a newly named model; a named one was checked as named.
  assert.match(tuningProblem({ ...base, model: "gpt-6.1-sol", context: null, effort: "xhigh", modelNamed: true, kept: { effort: true } })!.message, /does not take thinking “xhigh”, which this session used/);
  assert.equal(tuningProblem({ ...base, model: "gpt-6.1-sol", context: null, effort: "xhigh", kept: { effort: true } }), null);
  // Engines without the choice at all.
  const codex: SubscriptionAgent = { ...copilot([{ id: "gpt-5.5-codex", label: "GPT-5.5 Codex", fast: "priority" }, { id: "gpt-5", label: "GPT-5" }]), id: "codex" };
  assert.match(tuningProblem({ ...base, engine: "codex", listing: codex, model: "gpt-5", context: "long_context" })!.message, /^Codex has no long context window to choose\./);
  assert.match(tuningProblem({ ...base, engine: "codex", listing: codex, model: "gpt-5", context: null, fast: true })!.message, /^GPT-5 has no fast mode in Codex on Mira's laptop\./);
  assert.equal(tuningProblem({ ...base, engine: "codex", listing: codex, model: "gpt-5.5-codex", context: null, fast: true }), null);
  assert.match(tuningProblem({ ...base, model: "gpt-6.1-sol", context: null, fast: true })!.message, /^GitHub Copilot has no fast mode\./);
  // Claude Code: long context needs a named model with a 1M window.
  const claude: SubscriptionAgent = { ...copilot([]), id: "claude-code" };
  assert.match(tuningProblem({ ...base, engine: "claude-code", listing: claude, model: null, context: "long_context" })!.message, /default model runs with its own window/);
  assert.match(tuningProblem({ ...base, engine: "claude-code", listing: claude, model: "claude-haiku-4-5", context: "long_context" })!.message, /does not offer long context/);
  assert.equal(tuningProblem({ ...base, engine: "claude-code", listing: claude, model: "claude-sonnet-4-6", context: "long_context" }), null);
  assert.equal(tuningProblem({ ...base, engine: "claude-code", listing: claude, model: "claude-opus-4-7", context: "long_context" }), null, "a fixed 1M window is the long one");
  // A computer that did not report its agents is not refused on a guess.
  assert.equal(tuningProblem({ ...base, listing: null, model: "gpt-6.1-sol", context: "long_context" }), null);
});

const at = (minute: number) => new Date(Date.UTC(2026, 10, 2, 9, minute));
const run = (id: string, status: string, minute: number, extra: { continueFromJobId?: string | null; queuePosition?: number | null } = {}) => ({ id, status, createdAt: at(minute), continueFromJobId: extra.continueFromJobId ?? null, queuePosition: extra.queuePosition ?? null });

test("a session's queue runs in position order, its first run always first; a queue from before positions follows the chain", () => {
  const legacy = [run("root", "succeeded", 0), run("a", "running", 1, { continueFromJobId: "root" }), run("steer", "queued", 3, { continueFromJobId: "a" }), run("b", "queued", 2, { continueFromJobId: "steer" })];
  assert.deepEqual(queuedOrder(legacy, "root").map((row) => row.id), ["steer", "b"], "a steer moved what was queued behind it");
  assert.deepEqual(liveOrder(legacy, "root").map((row) => row.id), ["a", "steer", "b"]);
  const positioned = [run("root", "succeeded", 0), run("a", "queued", 1, { continueFromJobId: "root", queuePosition: 2 }), run("b", "queued", 2, { continueFromJobId: "a", queuePosition: 1 }), run("c", "queued", 3, { continueFromJobId: "b" })];
  assert.deepEqual(queuedOrder(positioned, "root").map((row) => row.id), ["b", "a", "c"], "positions first, then a run not placed yet");
  const fresh = [run("root", "queued", 0), run("a", "queued", 1, { continueFromJobId: "root", queuePosition: 1 })];
  assert.deepEqual(queuedOrder(fresh, "root").map((row) => row.id), ["root", "a"], "the session's first run stays first");
  assert.equal(sessionState(liveOrder(positioned, "root")), "queued");
  assert.equal(sessionState([{ status: "waiting_approval" }]), "waiting");
  assert.equal(sessionState([{ status: "stopping" }]), "working");
  assert.equal(sessionState([]), "idle");
});

const question = (title: string, extra: Record<string, unknown> = {}) => ({ event: "question", source: "ensemble", title, detail: { options: [], ...extra } });

test("a node may answer only questions of fact, with a quote found word for word", () => {
  assert.equal(questionRefusal(question("Which branch should I work on?")), null);
  assert.equal(questionRefusal(question("Is dark mode required?", { options: ["Yes", "No"] })), null);
  assert.match(questionRefusal({ ...question("Run `npm install`?"), event: "permission" })!, /permission/);
  assert.match(questionRefusal(question("May I write outside the folder, in another repository?"))!, /scope/);
  assert.match(questionRefusal(question("Should I put the API key in the config?"))!, /security/);
  assert.match(questionRefusal(question("This needs a paid plan. Should I buy it?"))!, /cost/);
  assert.match(questionRefusal(question("Can I delete the old migrations?"))!, /destructive/);
  assert.match(questionRefusal(question("Which branch?", { tier: "high_risk" }))!, /confirmation/);
  assert.match(questionRefusal({ ...question("Which branch?"), source: "claude" })!, /not from one of your runs/);
  assert.match(questionRefusal(question("Which way?", { options: ["Keep it", "Force-push over it"] }))!, /destructive/, "options are read too");

  const owner = "Fix the login redirect in ensemble.\nWork on the testing branch, and   keep dark mode.";
  assert.ok(quoteFound("work on the  testing branch", owner));
  assert.ok(quoteFound("“Work on the testing branch,”", owner), "quote marks and a trailing comma do not matter");
  assert.ok(!quoteFound("testing", owner), "one word is not a quote");
  assert.ok(!quoteFound("work on the main branch", owner), "words must match");
  assert.equal(normalizeQuote("A  ‘b’\n“C”"), "a 'b' \"c\"");
});

test("the watchdog reads an error as its kind, and a path outside the run's folder as outside", () => {
  assert.equal(errorSignature("npm test failed at 12:01 (exit 1) in job 3f1c2d9e-0000-4000-8000-123456789abc"), errorSignature("npm test failed at 12:07 (exit 1) in job 9a1c2d9e-0000-4000-8000-aaaaaaaaaaaa"));
  assert.notEqual(errorSignature("npm test failed"), errorSignature("npm run lint failed"));
  for (const path of ["/etc/hosts", "~/notes.md", "../other/file.ts", "C:\\Users\\x\\a.txt"]) assert.ok(outsidePath(path), path);
  for (const path of ["src/app.ts", "README.md", ".github/ci.yml"]) assert.ok(!outsidePath(path), path);
});

test("a request closed with its work refuses a late answer with that reason", () => {
  assert.equal(closedRefusal({ status: "expired", reason: WORK_ENDED }), ENDED_WITH_WORK);
  assert.equal(ENDED_WITH_WORK, "This request ended with its work.");
  assert.match(closedRefusal({ status: "expired", reason: null }), /stopped waiting/);
  assert.equal(closedRefusal({ status: "decided", reason: "yes" }), "Already answered.");
  assert.equal(closedRefusal({ status: "settled", reason: null }), "Already answered in the tool.");
});
