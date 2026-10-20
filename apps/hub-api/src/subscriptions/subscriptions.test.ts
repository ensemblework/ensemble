/**
 * The person's own AI subscriptions (docs/30 §8): how each agent is found and read, the command
 * lines that keep an agent to Ensemble's tools, the answers to its own requests, which computer
 * runs a turn, and how a conversation is handed to an agent.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentProblem, answerCodexTurn, answerCursorTurn, claudeArgs, copilotArgs } from "./agents.js";
import { copilotOutput } from "./copilot-output.js";
import { bridgeFor, callThroughBridge, openBridge } from "./bridge.js";
import { claudeAppCopy, claudeEfforts, codexModels, copilotEfforts, firstVersion, newestFirst, parseClaudeStatus, parseCopilotModels, parseCursorStatus, parseModelLines } from "./detect.js";
import { LOGIN_ARGS } from "./signin.js";
import { agentConversation, effortFor, howYouRun, jsonFrom, pickComputer } from "./turn.js";

test("Claude Code's sign-in is read from its own status, as JSON or as words", () => {
  assert.deepEqual(parseClaudeStatus({ code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}', stderr: "" }), { signedIn: true, plan: "max" });
  assert.deepEqual(parseClaudeStatus({ code: 0, stdout: '{"loggedIn":true,"authMethod":"api_key"}', stderr: "" }), { signedIn: false, plan: null });
  assert.deepEqual(parseClaudeStatus({ code: 1, stdout: '{"loggedIn":false}', stderr: "" }), { signedIn: false, plan: null });
  assert.deepEqual(parseClaudeStatus({ code: 1, stdout: "Not logged in. Run claude auth login to authenticate.\n", stderr: "" }), { signedIn: false, plan: null });
  assert.deepEqual(parseClaudeStatus({ code: 0, stdout: "Logged in as someone\n", stderr: "" }), { signedIn: true, plan: null });
  assert.deepEqual(parseClaudeStatus({ code: null, stdout: "", stderr: "" }), { signedIn: null, plan: null });
});

test("thinking levels come from each tool's own help", () => {
  const claude = "  --effort <level>                      Effort level for the current session\n                                        (low, medium, high, xhigh, max)\n  --environment <id>";
  assert.deepEqual(claudeEfforts(claude), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(claudeEfforts("  --model <model>  Model"), []);
  const copilot = "      --reasoning-effort <level>\n          Set the reasoning effort level [possible values: none, minimal, low, medium, high, xhigh, max]";
  assert.deepEqual(copilotEfforts(copilot), ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("Copilot's models are the bullets of the `model` entry in `copilot help config`", () => {
  const help = [
    "  `mouse`: whether to enable mouse support",
    "",
    "  `model`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.",
    '    - "claude-sonnet-5.5"',
    '    - "claude-haiku-5.5"',
    '    - "gpt-6-luna"',
    "",
    "  `contextTier`: context window tier",
  ].join("\n");
  const models = parseCopilotModels(help);
  assert.deepEqual(
    models.map((row) => row.id),
    ["auto", "claude-sonnet-5.5", "claude-haiku-5.5", "gpt-6-luna"],
  );
  assert.equal(models[0]!.isDefault, true);
  assert.deepEqual(parseCopilotModels("no model entry here"), []);
});

test("Cursor's status and model lines are read loosely", () => {
  assert.equal(parseCursorStatus("\u001b[32m✓ Logged in as mira@fieldnote.example\u001b[0m"), true);
  assert.equal(parseCursorStatus("Not logged in"), false);
  assert.equal(parseCursorStatus("something else"), null);
  const models = parseModelLines("Available models\n\nauto - Auto (current)\ngpt-5 - GPT-5\nsonnet-4-thinking - Claude Sonnet 4 Thinking\n\nTip: use --model");
  assert.deepEqual(
    models.map((row) => [row.id, row.label, row.isDefault ?? false]),
    [
      ["auto", "Auto", true],
      ["gpt-5", "GPT-5", false],
      ["sonnet-4-thinking", "Claude Sonnet 4 Thinking", false],
    ],
  );
});

test("Codex's model list keeps visible models with their thinking levels", () => {
  const models = codexModels([
    { id: "a", model: "gpt-6-luna", displayName: "GPT-6 Luna", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
    { id: "b", model: "secret", displayName: "Hidden", hidden: true },
    { id: "c", model: "gpt-5.5", displayName: "GPT-5.5" },
  ]);
  assert.deepEqual(models, [
    { id: "gpt-6-luna", label: "GPT-6 Luna", isDefault: true, efforts: ["low", "high"] },
    { id: "gpt-5.5", label: "GPT-5.5" },
  ]);
  assert.equal(firstVersion("codex-cli 0.162.0-alpha.17.2"), "0.162.0-alpha.17.2");
  assert.equal(firstVersion("2.1.296 (Claude Code)"), "2.1.296");
});

test("the Claude app's copy of Claude Code is the newest version folder that has the program", () => {
  const home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ensemble-claude-app-"));
  try {
    const base = join(home, "Library", "Application Support", "Claude", "claude-code");
    const program = (version: string) => {
      const folder = join(base, version, "8433d0d9cd0d", "claude.app", "Contents", "MacOS");
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "claude"), "#!/bin/sh\n");
      chmodSync(join(folder, "claude"), 0o755);
      return join(folder, "claude");
    };
    assert.equal(claudeAppCopy("darwin", home, {}), null);
    program("2.1.29");
    const newest = program("2.1.293");
    mkdirSync(join(base, "2.1.300"), { recursive: true });
    assert.equal(claudeAppCopy("darwin", home, {}), newest, "an empty newer folder is skipped");
    assert.deepEqual(newestFirst(["2.1.29", "2.1.300", "notes", "2.1.293"]), ["2.1.300", "2.1.293", "2.1.29"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Claude Code runs with Ensemble's prompt and tools only, and none of the person's settings", () => {
  const args = claudeArgs({ systemFile: "/t/system.md", mcpFile: "/t/mcp.json", maxTurns: 28, model: "haiku", effort: "low" });
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], "-p");
  assert.equal(after("--system-prompt-file"), "/t/system.md");
  assert.equal(after("--tools"), "", "no built-in tools: no shell, files or web");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(after("--mcp-config"), "/t/mcp.json");
  assert.equal(after("--allowedTools"), "mcp__ensemble");
  assert.equal(after("--setting-sources"), "user", "the person's own settings, where Claude Code keeps how it signs in; never a folder's");
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--include-partial-messages"));
  assert.equal(after("--model"), "haiku");
  assert.equal(after("--effort"), "low");
  assert.ok(!claudeArgs({ systemFile: "s", mcpFile: "m", maxTurns: 2, model: "default", effort: null }).includes("--model"), "the plan's default sends no model");
});

test("Copilot CLI denies its shell, writes and fetches, and Windows gets a prompt that fits its command line", () => {
  const args = copilotArgs({ prompt: "hello", mcpFile: "/t/mcp.json", model: "claude-haiku-5.5", effort: null, platform: "darwin" });
  const denied = args.flatMap((arg, index) => (arg === "--deny-tool" ? [args[index + 1]] : []));
  assert.deepEqual(denied, ["shell", "write", "url"]);
  assert.ok(args.includes("--disable-builtin-mcps"));
  assert.equal(args[args.indexOf("--additional-mcp-config") + 1], "@/t/mcp.json");
  const long = copilotArgs({ prompt: `${"x".repeat(40_000)}END`, mcpFile: "m", model: null, effort: null, platform: "win32" });
  const prompt = long[long.indexOf("-p") + 1]!;
  assert.ok(prompt.length <= 28_000);
  assert.ok(prompt.endsWith("END"), "the newest part of the conversation is kept");
});

test("nothing of Codex's or Cursor's own may run in an assistant turn", async () => {
  assert.deepEqual(await answerCodexTurn("item/commandExecution/requestApproval", {}), { decision: "decline" });
  assert.deepEqual(await answerCodexTurn("item/fileChange/requestApproval", {}), { decision: "decline" });
  assert.deepEqual(await answerCodexTurn("item/permissions/requestApproval", {}), { permissions: {}, scope: "turn" });
  assert.deepEqual(await answerCodexTurn("mcpServer/elicitation/request", { serverName: "ensemble" }), { action: "accept", content: null, _meta: null });
  assert.deepEqual(await answerCodexTurn("mcpServer/elicitation/request", { serverName: "other" }), { action: "decline", content: null, _meta: null });
  await assert.rejects(answerCodexTurn("account/chatgptAuthTokens/refresh", {}));
  const options = [
    { optionId: "a", kind: "allow_once" },
    { optionId: "r", kind: "reject_once" },
    { optionId: "aa", kind: "allow_always" },
  ];
  assert.deepEqual(answerCursorTurn("session/request_permission", { options, toolCall: { title: "ensemble: hub_list_tasks" } }), { outcome: { outcome: "selected", optionId: "a" } });
  assert.deepEqual(answerCursorTurn("session/request_permission", { options, toolCall: { title: "`rm -rf ~`", kind: "execute" } }), { outcome: { outcome: "selected", optionId: "r" } });
  assert.deepEqual(answerCursorTurn("session/request_permission", { options, toolCall: { title: "other: tool" } }), { outcome: { outcome: "selected", optionId: "r" } });
});

test("an agent's failure is read for sign-in and plan limits", () => {
  assert.equal(agentProblem("claude-code", "Invalid API key · Please run /login").problem, "signed_out");
  assert.match(agentProblem("claude-code", "Not logged in").message, /Claude is not signed in on this computer/);
  assert.equal(agentProblem("codex", "You've hit your usage limit. Try again later.").problem, "limit");
  assert.equal(agentProblem("cursor-agent", "boom").problem, "failed");
  assert.match(agentProblem("cursor-agent", "boom").message, /^Cursor stopped: boom/);
});

test("each sign-in is the vendor's own login command", () => {
  assert.deepEqual(LOGIN_ARGS["claude-code"], ["auth", "login", "--claudeai"]);
  assert.deepEqual(LOGIN_ARGS.codex, ["login"]);
});

test("a turn's bridge answers only its own secret, and a changed tool list replaces the old one", async () => {
  const opened = openBridge([{ name: "hub_how_to", description: "d", inputSchema: {} }], async (name) => ({ text: `ran ${name}`, tools: [{ name: "hub_create_diagram", description: "d", inputSchema: {} }] }));
  try {
    const bridge = bridgeFor(opened.credential)!;
    assert.ok(bridge);
    assert.equal(bridgeFor(`${opened.credential.split(".")[0]}.wrong`), null);
    assert.equal(bridgeFor(undefined), null);
    const answer = await callThroughBridge(bridge, "hub_how_to", {});
    assert.equal(answer.text, "ran hub_how_to");
    assert.deepEqual(bridge.tools.map((tool) => tool.name), ["hub_create_diagram"]);
  } finally {
    opened.close();
  }
  assert.equal(bridgeFor(opened.credential), null, "a closed turn is gone");
});

test("the conversation reaches an agent as one system prompt and one message", () => {
  const { system, prompt } = agentConversation(
    [
      { role: "system", content: "You are the Ensemble assistant." },
      { role: "system", content: "Reference material." },
      { role: "user", content: "What's due?" },
      { role: "assistant", content: "Two tasks." },
      { role: "user", content: "Make a diagram of them." },
    ],
    "claude-code",
  );
  assert.match(system, /^You are the Ensemble assistant\.\n\nReference material\.\n\n## How you run here/);
  assert.match(system, /hub_use_tool/);
  assert.equal(prompt, "Earlier in this conversation, oldest first:\n\nPerson: What's due?\n\nYou: Two tasks.\n\n---\n\nThe person's new message:\n\nMake a diagram of them.");
  assert.equal(agentConversation([{ role: "user", content: "hi" }], "codex").prompt, "hi");
  assert.match(howYouRun("codex"), /ChatGPT subscription/);
});

test("a reply's JSON is found inside prose or a fence", () => {
  assert.deepEqual(jsonFrom('Here you go:\n```json\n{"kind":"task","score":3}\n```'), { kind: "task", score: 3 });
  assert.deepEqual(jsonFrom('{"a":[1,2]} and some words'), { a: [1, 2] });
  assert.deepEqual(jsonFrom("[1, 2, 3]"), [1, 2, 3]);
  assert.equal(jsonFrom("no json at all"), undefined);
});

test("a thinking level is sent only when the agent takes it for that model", () => {
  const agent = {
    id: "codex" as const,
    via: "app" as const,
    version: "1",
    signedIn: true,
    models: [{ id: "gpt-6-luna", label: "Luna", efforts: ["low", "high"] }, { id: "plain", label: "Plain" }],
    efforts: ["medium"],
    checkedAt: "",
  };
  assert.equal(effortFor(agent, "gpt-6-luna", "high"), "high");
  assert.throws(() => effortFor(agent, "gpt-6-luna", "max"), /does not take thinking/);
  assert.equal(effortFor(agent, "plain", "medium"), "medium", "the agent's own list when the model has none");
  assert.equal(effortFor(agent, "plain", "default"), null);
  assert.equal(effortFor(null, "x", "low"), "low");
});

type Row = { id: string; userId: string; name: string; lastSeenAt: Date | null; capabilities: unknown; revokedAt: null };

function fakePrisma(rows: Row[]) {
  return {
    device: {
      findMany: async (args: { where: { userId: { in: string[] } } }) => rows.filter((row) => args.where.userId.in.includes(row.userId)).sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0)),
    },
  } as never;
}

const claudeSignedIn = { id: "claude-code", via: "app", version: "2.1.293", signedIn: true, models: [{ id: "haiku", label: "Haiku" }], checkedAt: "now" };

test("the computer for a turn: online, new enough, with the agent signed in; otherwise why not", async () => {
  const previous = process.env.ENSEMBLE_DESKTOP;
  delete process.env.ENSEMBLE_DESKTOP;
  try {
    const now = new Date();
    const old = new Date(Date.now() - 3 * 3_600_000);
    await assert.rejects(pickComputer(fakePrisma([]), "u1", "claude-code", null), /Install Ensemble there/);
    await assert.rejects(pickComputer(fakePrisma([{ id: "d1", userId: "u1", name: "MacBook", lastSeenAt: old, capabilities: {}, revokedAt: null }]), "u1", "claude-code", null), /none is online\. MacBook was last seen 3 hours ago/);
    await assert.rejects(pickComputer(fakePrisma([{ id: "d1", userId: "u1", name: "MacBook", lastSeenAt: now, capabilities: { code: true }, revokedAt: null }]), "u1", "claude-code", null), /Update Ensemble on MacBook/);
    await assert.rejects(
      pickComputer(fakePrisma([{ id: "d1", userId: "u1", name: "MacBook", lastSeenAt: now, capabilities: { assistantTurns: 1, agents: [{ ...claudeSignedIn, signedIn: false }] }, revokedAt: null }]), "u1", "claude-code", null),
      /Claude is not signed in on MacBook/,
    );
    await assert.rejects(pickComputer(fakePrisma([{ id: "d1", userId: "u1", name: "MacBook", lastSeenAt: now, capabilities: { assistantTurns: 1, agents: [] }, revokedAt: null }]), "u1", "codex", null), /MacBook does not have ChatGPT/);
    const two = fakePrisma([
      { id: "d1", userId: "u1", name: "MacBook", lastSeenAt: now, capabilities: { assistantTurns: 1, agents: [claudeSignedIn] }, revokedAt: null },
      { id: "d2", userId: "u1", name: "Studio", lastSeenAt: new Date(Date.now() - 10_000), capabilities: { assistantTurns: 1, agents: [claudeSignedIn] }, revokedAt: null },
      { id: "d3", userId: "someone-else", name: "Theirs", lastSeenAt: now, capabilities: { assistantTurns: 1, agents: [claudeSignedIn] }, revokedAt: null },
    ]);
    const first = await pickComputer(two, "u1", "claude-code", null);
    assert.equal(first.local ? "" : first.id, "d1", "the most recently seen");
    const chosen = await pickComputer(two, "u1", "claude-code", "d2");
    assert.equal(chosen.local ? "" : chosen.id, "d2", "the computer the person chose");
    const missing = await pickComputer(two, "u1", "claude-code", "d9");
    assert.equal(missing.local ? "" : missing.id, "d1", "a chosen computer that is gone falls back");
  } finally {
    if (previous === undefined) delete process.env.ENSEMBLE_DESKTOP;
    else process.env.ENSEMBLE_DESKTOP = previous;
  }
});

test("on the desktop runtime the computer is this one", async () => {
  const previous = process.env.ENSEMBLE_DESKTOP;
  process.env.ENSEMBLE_DESKTOP = "1";
  try {
    const computer = await pickComputer(fakePrisma([]), "u1", "claude-code", null);
    assert.equal(computer.local, true);
  } finally {
    if (previous === undefined) delete process.env.ENSEMBLE_DESKTOP;
    else process.env.ENSEMBLE_DESKTOP = previous;
  }
});


test("Copilot context snapshots, invalid counts and billing units never become call tokens or dollars", () => {
  const output = copilotOutput(null, () => {});
  output.line(JSON.stringify({ type: "session.usage_info", data: { currentTokens: 100000, tokenLimit: 200000 } }));
  output.line(JSON.stringify({ type: "assistant.usage", data: { inputTokens: -1, outputTokens: "200", cost: 5 } }));
  output.line("not JSON");
  output.line(JSON.stringify({ type: "assistant.message", data: { content: "Ready." } }));
  assert.deepEqual(output.finish(), { text: "Ready.", model: null, tokensIn: null, tokensOut: null, costUsd: null });
});
