import assert from "node:assert/strict";
import test from "node:test";
import { appById } from "./catalog";
import { EXTENSIONS, extensionById, extensionsFor } from "./extensions";
import { helpContext, helpQuestions } from "./help";

const URL = "https://api.ensemblework.com/mcp";
const facts = { repoRoot: "", bridgeScript: "", node: "", hubApiUrl: "", httpUrl: "", publicApiUrl: "https://api.ensemblework.com", token: null };

test("each editor lists the extensions that run in it; an agent's own guide lists none", () => {
  assert.ok(extensionsFor("vscode").some((item) => item.id === "claude-code"));
  assert.ok(extensionsFor("jetbrains").some((item) => item.id === "copilot-chat"));
  assert.ok(!extensionsFor("cursor").some((item) => item.id === "copilot-chat"));
  assert.deepEqual(extensionsFor("claude-code"), []);
  for (const item of EXTENSIONS) {
    assert.ok(item.hosts.length && item.reads && item.check, item.id);
    assert.ok(item.cli("mac").steps.length && item.hosted(facts).steps.length, item.id);
  }
});

test("hosted setups use the URL and a placeholder key, never a real one unless it was just made here", () => {
  const claude = extensionById("claude-code")!;
  const hosted = claude.hosted(facts).snippet!.text;
  assert.match(hosted, /claude mcp add --scope user --transport http ensemble https:\/\/api\.ensemblework\.com\/mcp --header "Authorization: Bearer KEY"/);
  assert.match(claude.caution!, /scope User/);
  assert.match(extensionById("roo-code")!.hosted(facts).snippet!.text, /"type": "streamable-http"/);
  assert.match(claude.hosted({ ...facts, token: "ens_made_on_this_page" }).snippet!.text, /Bearer ens_made_on_this_page/);
  // The Claude Code extension reads Claude Code's own list, not VS Code's mcp.json.
  assert.match(claude.reads, /does not read VS Code's mcp\.json/);
});

test("help questions start from where the person is, and always offer the general ones", () => {
  const vscode = appById("vscode")!;
  const withExtension = helpQuestions({ app: vscode, extension: extensionById("codex"), hostedUrl: URL });
  assert.equal(withExtension[0]!.label, "Set up Ensemble in Codex inside VS Code");
  const onlyApp = helpQuestions({ app: vscode, hostedUrl: URL });
  assert.equal(onlyApp[0]!.label, "Walk me through connecting VS Code");
  assert.ok(onlyApp.some((question) => question.id === "extension"), "an editor's guide asks about extensions");
  const general = helpQuestions({ hostedUrl: URL }).map((question) => question.id);
  assert.deepEqual(general, ["which-way", "not-listed", "changes"]);
});

test("the hidden help context has the facts to answer, the picked extension in full, and no key", () => {
  const context = helpContext({ app: appById("vscode"), method: "hosted", os: "mac", extension: extensionById("claude-code"), keys: { count: 2, canWrite: 1 }, hostedUrl: URL });
  assert.match(context, /The VS Code guide, with the Claude Code extension picked, showing Hosted URL \(no install\), for macOS\./);
  assert.match(context, /They have 2 keys for editors; 1 may make changes\./);
  assert.match(context, /ensemble mcp setup <id>/);
  assert.match(context, /Never ask for their ens_ key/);
  assert.match(context, /### Claude Code \(Anthropic/);
  assert.match(context, /- Roo Code \(Roo Code\): reads/);
  assert.match(context, /it can also make changes/);
  assert.doesNotMatch(context, /ens_[A-Za-z0-9]{6,}/);
  assert.doesNotMatch(context, /read-only key/i);
});
