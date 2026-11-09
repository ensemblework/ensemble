/** Which agent can run which model, and whether it is there to run (lib/agent-fit.ts). */
import assert from "node:assert/strict";
import test from "node:test";
import type { SubscriptionAgent } from "@ensemble/shared-types";
import { engineNamed, makerProblem, modelMaker, readinessProblem } from "./agent-fit.js";

const agent = (id: string, signedIn: boolean | null, models: string[] = []) => ({ id, via: "cli", version: "1", signedIn, models: models.map((model) => ({ id: model, label: model })) }) as unknown as SubscriptionAgent;

test("agents are read as people and models write them", () => {
  for (const [name, id] of [["copilot", "copilot-cli"], ["GitHub Copilot", "copilot-cli"], ["copilot-cli", "copilot-cli"], ["Claude", "claude-code"], ["Claude Code", "claude-code"], ["codex", "codex"], ["Cursor", "cursor-agent"], ["Grok Build", "grok-cli"], ["Gemini CLI", "gemini-cli"], ["OpenCode", "opencode"]] as const) {
    assert.equal(engineNamed(name), id, name);
  }
  assert.equal(engineNamed("ensemble"), undefined);
  assert.equal(engineNamed("my favourite agent"), undefined);
});

test("a model's maker comes from its name, when the name says it", () => {
  assert.equal(modelMaker("GPT-6.1-Sol"), "OpenAI");
  assert.equal(modelMaker("gpt-6-luna"), "OpenAI");
  assert.equal(modelMaker("claude-opus-5.5"), "Claude");
  assert.equal(modelMaker("sonnet[1m]"), "Claude");
  assert.equal(modelMaker("gemini-3-pro"), "Gemini");
  assert.equal(modelMaker("default"), null);
  assert.equal(modelMaker("auto"), null);
  assert.equal(modelMaker("kimi-k3"), null);
});

test("an agent that runs one maker's models refuses another's, and says which agents run it", () => {
  const copilot = agent("copilot-cli", true, ["gpt-6.1-sol"]);
  const problem = makerProblem("claude-code", "GPT-6.1-Sol", agent("claude-code", true, ["opus"]), [copilot]);
  assert.match(problem!.message, /Claude Code runs Claude models only, and GPT-6.1-Sol is an OpenAI model/);
  assert.match(problem!.remedy, /with GitHub Copilot/);
  assert.equal(makerProblem("claude-code", "opus", null), null);
  assert.equal(makerProblem("codex", "gpt-6.1-sol", null), null);
  assert.equal(makerProblem("copilot-cli", "claude-opus-5.5", null), null, "Copilot runs several makers' models");
  assert.equal(makerProblem("claude-code", "kimi-k3", null), null, "a name that says nothing is left to the agent");
  assert.equal(makerProblem("codex", "claude-oddity", agent("codex", true, ["claude-oddity"])), null, "a model the computer lists for the agent stands");
});

test("an agent not installed or signed out is not there to run; a computer that lists no agents is not refused on a guess", () => {
  const agents = [agent("claude-code", false), agent("copilot-cli", true)];
  assert.match(readinessProblem("claude-code", "HomeServer", agents)!.message, /Claude Code is not signed in on HomeServer/);
  assert.match(readinessProblem("claude-code", "HomeServer", agents)!.remedy, /Use GitHub Copilot/);
  assert.match(readinessProblem("codex", "HomeServer", agents)!.message, /Codex is not installed on HomeServer/);
  assert.equal(readinessProblem("copilot-cli", "HomeServer", agents), null);
  assert.equal(readinessProblem("claude-code", "HomeServer", []), null);
  assert.equal(readinessProblem("claude-code", "HomeServer", [agent("claude-code", null)]), null, "signed-in state unknown: not refused");
});
