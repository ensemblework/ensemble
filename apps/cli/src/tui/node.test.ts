import assert from "node:assert/strict";
import test from "node:test";
import { nodePane, nodeWebUrl } from "./node.js";
import { lineText } from "./text.js";

test("the Node website follows the account's Ensemble", () => {
  assert.equal(nodeWebUrl("https://app.ensemblework.com", ""), "https://node.ensemblework.com");
  assert.equal(nodeWebUrl("https://ensemblework.com", ""), "https://node.ensemblework.com");
  assert.equal(nodeWebUrl("http://localhost:3000", ""), "http://localhost:3300");
  assert.equal(nodeWebUrl("not a url", ""), "https://node.ensemblework.com");
  assert.equal(nodeWebUrl("https://app.ensemblework.com", "https://node.example.com/"), "https://node.example.com");
});

test("the Node pane asks to sign in, says when it cannot load, and says when there is nothing yet", () => {
  const text = (lines: ReturnType<typeof nodePane>) => lines.map(lineText).join("\n");
  assert.match(text(nodePane({ data: null, error: null, loading: false }, 60, Date.now(), false, "https://n")), /Sign in to see your nodes/);
  assert.match(text(nodePane({ data: null, error: "This Ensemble server does not have Ensemble Node yet.", loading: false }, 60, Date.now(), true, "https://n")), /does not have Ensemble Node yet/);
  const empty = { nodes: [], rooms: [], approvals: [], runs: [], credits: null };
  assert.match(text(nodePane({ data: empty, error: null, loading: false }, 60, Date.now(), true, "https://n")), /No rooms yet\. Make your first node on https:\/\/n/);
});
