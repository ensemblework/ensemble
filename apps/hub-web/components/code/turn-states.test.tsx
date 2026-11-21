import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { TurnCompletion } from "@/lib/api";
import { SessionStart, TurnStates, checkLines, stateParts } from "./turn-states.js";

(globalThis as { React?: typeof React }).React = React;

const completion = (over: Partial<TurnCompletion> = {}): TurnCompletion => ({
  conversation: { state: "finished" },
  files: { state: "changed", count: 2, added: 14, removed: 3 },
  checks: {
    state: "failed",
    passed: 1,
    failed: 1,
    notRun: 0,
    claimed: 3,
    runs: [
      { name: "export test", id: "AC-1", command: "npm test", claimed: "pass", verdict: "fail", reason: "It exited 1.", exitCode: 1, ms: 900, output: "" },
      { name: "build", id: null, command: "npm run build", claimed: "pass", verdict: "pass", reason: null, exitCode: 0, ms: 3000, output: "" },
    ],
  },
  accepted: { state: "pending", by: null, at: null },
  pr: { state: "opened", url: "https://github.com/fieldnote/web/pull/12", source: "observed" },
  claim: { outcome: "pass" },
  ...over,
});

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return { host, done: async () => { await act(async () => root.unmount()); host.remove(); } };
}

test("a turn's states each stand apart: finished, files, checks Ensemble ran again, accepted, pull request", async () => {
  assert.deepEqual(stateParts(completion()).map((part) => part.text), ["Finished", "2 files changed", "Checks failed (1 of 3)", "Not accepted yet", "PR opened"]);
  assert.deepEqual(stateParts(completion({ checks: { ...completion().checks, state: "passed", passed: 2, failed: 0, claimed: 2 }, accepted: { state: "accepted", by: "owner", at: null }, pr: { state: "none", url: null, source: null } })).map((part) => part.text), ["Finished", "2 files changed", "Checks passed (2)", "Accepted"]);
  assert.deepEqual(stateParts(completion({ conversation: { state: "stopped" }, files: { state: "none", count: 0, added: 0, removed: 0 }, checks: { ...completion().checks, state: "none", runs: [], claimed: 0 }, pr: { state: "none", url: null, source: null } })).map((part) => part.text), ["Stopped", "No file changes"]);
  assert.equal(checkLines(completion())[0], "AC-1 export test: the agent said pass; Ensemble's run failed. It exited 1.");
  const view = await render(<TurnStates completion={completion()} />);
  try {
    const row = view.host.querySelector('[data-testid="agent-turn-states"]')!;
    assert.match(row.textContent ?? "", /^Finished·2 files changed·Checks failed \(1 of 3\)·Not accepted yet·PR opened/);
    assert.equal(row.querySelector("a")?.getAttribute("href"), "https://github.com/fieldnote/web/pull/12");
    assert.doesNotMatch(row.textContent ?? "", /—|--/);
  } finally {
    await view.done();
  }
});

test("a new session says where it came from; a turn in the same session says nothing", async () => {
  const handed = await render(<SessionStart turn={{ provider: "codex", packet: null, handoff: { id: "hof_20261121_abc123", reason: "agent", from: "claude-code", model: "claude-sonnet-4-5", chars: 2400 } }} />);
  const forked = await render(<SessionStart turn={{ provider: "claude-code", packet: { mode: "full", operation: "fork", version: "v", base: "v", chars: 10, sections: 3, items: { sent: 0, changed: 0, added: 0, removed: 0 }, skills: [], criteria: [] }, handoff: null }} />);
  const same = await render(<SessionStart turn={{ provider: "claude-code", packet: null, handoff: null }} />);
  try {
    assert.match(handed.host.textContent ?? "", /New session with Codex, handed over from Claude Code/);
    assert.match(forked.host.textContent ?? "", /Forked: a new session with Claude Code/);
    assert.equal(same.host.textContent, "");
  } finally {
    await handed.done();
    await forked.done();
    await same.done();
  }
});
