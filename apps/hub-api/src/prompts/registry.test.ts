import "../runtime/test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { promptCatalog } from "./registry.js";

const byId = (id: string) => promptCatalog().find((entry) => entry.id === id)!.body;

test("Settings → Prompts lists only prompts Ensemble sends, each built by the code that sends it", () => {
  const ids = promptCatalog().map((entry) => entry.id);
  assert.deepEqual(ids, ["assistant.instructions", "assistant.context", "assistant.subscription", "agent.brief", "agent.chat", "agent.ensemble", "agent.research", "classifier", "skill.miner"]);
  for (const entry of promptCatalog()) assert.ok(entry.body.trim() && entry.when && entry.purpose, entry.id);
});

test("prompts stay small: instructions without records, a message's context without the board, a brief with only the limits that apply", () => {
  const instructions = byId("assistant.instructions");
  assert.ok(instructions.length < 2200, `assistant instructions: ${instructions.length} chars`);
  assert.doesNotMatch(instructions, /Tasks on the board|Projects:|People:|Map of Ensemble|## Playbook|Today is|usually want/);
  const context = byId("assistant.context");
  assert.ok(context.length < 700, `a message's context: ${context.length} chars`);
  const brief = byId("agent.brief");
  assert.ok(brief.length < 1300, `coding-agent notes: ${brief.length} chars`);
  assert.doesNotMatch(brief, /You are working for|Internet: on|Git: No limits|Local/, "nothing the agent can assume, and no placeholder name");
  assert.doesNotMatch(byId("agent.ensemble"), /Network: on|You are Ensemble's/);
});
