/**
 * An Ensemble Node (or any chat) on the person's own AI plan keeps one session: changed instructions go in
 * the next message as the lines that changed, a session long in use starts over, and a replaced session is
 * dropped from the store (turn-sessions.ts). The turn's agent gets its own web tools when asked (agents.ts),
 * a node is told how it runs there (turn.ts howYouRun): with all its own tools on a computer that judges them by
 * the node's folder policy, with its own web only on an older one. Its own instructions (node/instructions.ts)
 * stay the same while its room and memories change, with its own shell and files only for a computer that keeps them.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const state = mkdtempSync(join(tmpdir(), "ensemble-node-sessions-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = state;
after(() => rmSync(state, { recursive: true, force: true }));

const { findSession, instructionsUpdate, ROTATE_MESSAGES, saveSession, setNativeDropForTests, UPDATE_HEAD } = await import("./turn-sessions.js");
const dropped: string[] = [];
setNativeDropForTests(async (_agent, id) => dropped.push(id));
const { claudeArgs, copilotArgs } = await import("./agents.js");
const { agentConversation, howYouRun } = await import("./turn.js");

const BASE = ["You are Ada (@ada), an Ensemble Node.", "Room: “Lab”.", "How you work:", "- Only tool calls change anything.", "- Keep replies short."].join("\n");

test("changed instructions become the lines that changed; most of them changed is a new session", () => {
  assert.equal(instructionsUpdate(BASE, BASE), "");
  const update = instructionsUpdate(BASE, `${BASE}\nWhat you remember (newest first):\n- Akash prefers Copilot.`)!;
  assert.ok(update.startsWith(UPDATE_HEAD));
  assert.match(update, /Now part of them:\n.*\n- Akash prefers Copilot\./s);
  assert.doesNotMatch(update, /No longer part of them/);
  const gone = instructionsUpdate(BASE, BASE.replace("- Keep replies short.\n", "").replace("- Keep replies short.", ""))!;
  assert.match(gone, /No longer part of them:\n- Keep replies short\./);
  assert.equal(instructionsUpdate(BASE, "Something else entirely, with nothing in common.\nAnd another line."), null);
});

test("a Copilot chat is resumed with the instructions it had, whatever they say now; a long one starts over", async () => {
  await saveSession("node-chat-0001", "copilot-cli", "sess-a", BASE, { next: 2, keepDays: 7 });
  const found = await findSession("node-chat-0001", "copilot-cli", `${BASE}\n- New rule.`, false, 2);
  assert.deepEqual(found, { id: "sess-a", text: BASE }, "resumed, with the text to send the change against");
  // Claude Code and Codex take the instructions with every turn: nothing to send.
  await saveSession("node-chat-0002", "claude-code", "sess-c", BASE, { next: 2, perTurn: true });
  assert.deepEqual(await findSession("node-chat-0002", "claude-code", "other", true, 2), { id: "sess-c", text: null });
  // The session has carried ROTATE_MESSAGES messages of the chat: a new one starts, with the chat so far.
  await saveSession("node-chat-0001", "copilot-cli", "sess-a", BASE, { next: ROTATE_MESSAGES + 2 });
  assert.equal(await findSession("node-chat-0001", "copilot-cli", BASE, false, ROTATE_MESSAGES + 2), null);
  // Another agent, or a chat that moved on elsewhere: not resumed.
  assert.equal(await findSession("node-chat-0002", "codex", BASE, true, 2), null);
  assert.equal(await findSession("node-chat-0002", "claude-code", BASE, true, 6), null);
});

test("a session that replaces another takes its place in the store; a node's keeps its days and folder", async () => {
  await saveSession("node-chat-0003", "copilot-cli", "old-session", BASE, { next: 2 });
  await saveSession("node-chat-0003", "copilot-cli", "new-session", BASE, { next: 4, folder: join(state, "projects", "ada"), keepDays: 7 });
  const store = JSON.parse(readFileSync(join(state, "assistant-sessions.json"), "utf8")) as Record<string, { id: string; keep?: number; folder?: string; from?: number }>;
  assert.equal(store["node-chat-0003"]!.id, "new-session");
  assert.equal(store["node-chat-0003"]!.keep, 7);
  assert.equal(store["node-chat-0003"]!.from, 2, "the new session began at message 2 of the chat");
  assert.ok(!JSON.stringify(store).includes("old-session"), "the replaced session is gone from the store");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(dropped.includes("old-session"), "and dropped from the agent, so its app is not cluttered");
});

test("the agent's own web tools: on when asked, otherwise closed", () => {
  const claude = (web: boolean) => claudeArgs({ systemFile: "s", mcpFile: "m", maxTurns: 20, model: null, effort: null, web });
  assert.equal(claude(true)[claude(true).indexOf("--tools") + 1], "WebSearch,WebFetch");
  assert.equal(claude(true)[claude(true).indexOf("--allowedTools") + 1], "mcp__ensemble,WebSearch,WebFetch");
  assert.equal(claude(false)[claude(false).indexOf("--tools") + 1], "");
  const copilot = (web: boolean) => copilotArgs({ prompt: "hi", mcpFile: "m", model: null, effort: null, web });
  assert.ok(!copilot(true).includes("url") && !copilot(true).includes("--excluded-tools"));
  assert.ok(copilot(true).includes("shell") && copilot(true).includes("write"), "never a shell or file writes");
  assert.deepEqual(copilot(false).slice(copilot(false).indexOf("url") - 1, copilot(false).indexOf("url") + 3), ["--deny-tool", "url", "--excluded-tools", "web_search"]);
});

test("a node on its owner's plan is told what it has: its own shell, files and web, what Ensemble adds, coding to sessions", () => {
  const node = howYouRun("copilot-cli", { ownWeb: true, node: true, ownTools: true });
  assert.match(node, /all your own tools: your shell, files and web, which their plan pays for/);
  assert.match(node, /browser_\*/);
  assert.match(node, /node_session_start/);
  assert.match(node, /build on it instead of doing it again/);
  assert.doesNotMatch(node, /\u2014|--/, "no long dashes in what the agent reads");
  // An older computer gives a node its own web only: the computer is reached through Ensemble's tools.
  const older = howYouRun("copilot-cli", { ownWeb: true, node: true });
  assert.match(older, /your own web search and page reading, which their plan pays for/);
  assert.match(older, /reached only through Ensemble's tools/);
  assert.match(older, /node_session_start/);
  assert.match(howYouRun("codex"), /no shell, files or web of your own/);
  assert.match(agentConversation([{ role: "system", content: "S" }, { role: "user", content: "hi" }], "claude-code", { ownWeb: true }).system, /^S\n\nYou run on their own Claude subscription/);
});

test("a node on an AI plan drives the browser itself, and looks facts up with its own web search where it has one", async () => {
  const { assembleNode } = await import("../node/instructions.js");
  const copilot = assembleNode(nodeFacts({ ownLoop: true, ownWeb: true })).tiers.stable;
  assert.doesNotMatch(copilot, /web_task/);
  assert.match(copilot, /drive the browser yourself \(browser_open/);
  assert.match(copilot, /your own web search first \(or hub_web_search\), then read the source page itself/);
  const kimi = assembleNode(nodeFacts({ ownLoop: true, ownWeb: false })).tiers.stable;
  assert.doesNotMatch(kimi, /web_task/);
  assert.match(kimi, /hub_web_search first/, "an agent whose own tools are refused in a turn uses Ensemble's search");
  const helper = assembleNode(nodeFacts({ ownLoop: true, ownWeb: true, room: { title: "Auditor", kind: "task" }, helper: { parent: "ada", parentName: "Ada", grant: "computer" } })).tiers.stable;
  assert.match(helper, /several steps on a site: drive the browser yourself/);
  assert.doesNotMatch(helper, /web_task/);
});

test("a node with its own tools does commands and files with them, only where the computer keeps them; sudo still goes to its owner's card", async () => {
  const { assembleNode } = await import("../node/instructions.js");
  const own = assembleNode(nodeFacts({ ownLoop: true, ownWeb: true, ownTools: true })).tiers.stable;
  assert.match(own, /your own shell and files, in your own folder unless your owner names one/);
  assert.match(own, /computer_sudo \(your owner types their password on a card here; you never see it\)\. Download with your own shell first\./);
  assert.doesNotMatch(own, /computer_run or computer_files_write yourself|Download with computer_run first/);
  assert.equal(assembleNode(nodeFacts({ ownLoop: true, ownWeb: true, ownTools: true })).tiers.stable, own, "the same byte for byte for the same node and computer");
  const older = assembleNode(nodeFacts({ ownLoop: true, ownWeb: true, ownTools: false })).tiers.stable;
  assert.match(older, /computer_run or computer_files_write yourself/, "a computer that keeps Ensemble's tools only: its computer tools");
  assert.doesNotMatch(older, /your own shell/);
  const helper = assembleNode(nodeFacts({ ownLoop: true, ownWeb: true, ownTools: true, room: { title: "Auditor", kind: "task" }, helper: { parent: "ada", parentName: "Ada", grant: "computer" } })).tiers.stable;
  assert.match(helper, /commands and files \(your own shell and files\)/);
});

test("a node's instructions on an AI plan stay the same while its room, skills and memories change: no update for its session", async () => {
  const { assembleNode } = await import("../node/instructions.js");
  const system = (facts: Parameters<typeof nodeFacts>[0]) =>
    agentConversation([{ role: "system", content: "You're helping Mira in Ensemble." }, { role: "system", content: assembleNode(nodeFacts(facts)).tiers.stable }, { role: "user", content: "hi" }], "copilot-cli", { ownWeb: true, node: true }).system;
  const first = system({ ownLoop: true, ownWeb: true });
  const later = system({ ownLoop: true, ownWeb: true, memories: ["Mira's launch is on 14 November."], skills: "Research and facts:\n- One search per part.", roster: ["- @mira: Mira (your owner)", "- @ada: you", "- @ben: Ben"] });
  assert.equal(later, first);
  assert.equal(instructionsUpdate(first, later), "");
});

/** A node's facts for its instructions (node/instructions.ts), in a DM its owner reads alone. */
function nodeFacts(over: Record<string, unknown> = {}) {
  return {
    owner: "Mira",
    name: "Ada",
    slug: "ada",
    role: "assistant",
    charter: "",
    room: { title: "Ada", kind: "dm" },
    roster: ["- @mira: Mira (your owner)", "- @ada: you"],
    step: false,
    fromNonOwner: false,
    ownerOnly: true,
    ownLoop: false,
    ownWeb: false,
    ownTools: false,
    runProfile: "a coding agent signed in on the computer, on its default model (the run profile “Default”)",
    computerFiles: false,
    computerWorkAsks: false,
    leadsHere: false,
    lead: "the lead",
    crewOutside: [],
    crewTitle: null,
    crewMates: [],
    crewOthers: [],
    helpers: [],
    rooms: [],
    origin: null,
    skills: "",
    memories: [],
    helper: null,
    ...over,
  } as import("../node/instructions.js").NodeFacts;
}
