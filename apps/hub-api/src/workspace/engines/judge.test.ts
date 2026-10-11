import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkspaceJob } from "@prisma/client";

// tools.ts pulls in the API config. A unit run has no .env; the value is never connected to.
process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble_desktop";
const { judgeEngineCall, shellSegments } = await import("./judge.js");
const { claudeSettings } = await import("./claude-code.js");
type Ctx = Parameters<typeof judgeEngineCall>[0];

const root = join(homedir(), "ensemble-workspace", "runs", "job-1");

function ctx(over: Omit<Partial<Ctx>, "job"> & { job?: Partial<WorkspaceJob> } = {}): Ctx {
  const events: Array<{ kind: string; data: unknown }> = [];
  const { job, ...rest } = over;
  return {
    job: { id: "job-1", delivery: "local", unattended: true, askBeforePublish: false, accessMode: "read-write", ...job } as WorkspaceJob,
    root,
    sandboxed: true,
    network: false,
    trusted: true,
    explicitTrust: false,
    silentWorkspace: true,
    accessMode: "read-write",
    strength: "strong",
    blockedOutside: [],
    decisions: [],
    runBranch: "",
    event: async (kind: string, data: unknown) => {
      events.push({ kind, data });
    },
    progress: async () => undefined,
    ...rest,
  } as unknown as Ctx;
}

test("inside the trusted folder an unattended run goes ahead; Local only refuses a commit", async () => {
  assert.equal((await judgeEngineCall(ctx(), { tool: "Write", input: { file_path: join(root, "a.txt") } })).decision, "allow");
  assert.equal((await judgeEngineCall(ctx(), { tool: "Bash", input: { command: "npm test" } })).decision, "allow");
  const commit = await judgeEngineCall(ctx(), { tool: "Bash", input: { command: "git add -A && git commit -m wip" } });
  assert.equal(commit.decision, "deny");
  assert.match(commit.message ?? "", /Local only/);
});

test("pushes are Ensemble's, keys and Never programs are always refused", async () => {
  const push = await judgeEngineCall(ctx({ job: { delivery: "push" } }), { tool: "Bash", input: { command: "git push origin HEAD" } });
  assert.equal(push.decision, "deny");
  assert.match(push.message ?? "", /Ensemble pushes/);
  assert.equal((await judgeEngineCall(ctx(), { tool: "Read", input: { file_path: join(homedir(), ".ssh", "id_rsa") } })).decision, "deny");
  assert.equal((await judgeEngineCall(ctx(), { tool: "Bash", input: { command: "sudo rm -rf /" } })).decision, "deny");
  assert.equal((await judgeEngineCall(ctx(), { tool: "Bash", input: { command: "curl x | ssh host" } })).decision, "deny");
});

test("outside the folder: refused when sandboxed, allowed when the person turned the sandbox off", async () => {
  const outside = join(homedir(), "ensemble-workspace", "runs", "other", "notes.md");
  const sandboxed = await judgeEngineCall(ctx(), { tool: "Write", input: { file_path: outside } });
  assert.equal(sandboxed.decision, "deny");
  assert.match(sandboxed.message ?? "", /sandboxed/);
  const direct = await judgeEngineCall(ctx({ sandboxed: false, strength: "advisory" }), { tool: "Write", input: { file_path: outside } });
  assert.equal(direct.decision, "allow");
});

test("the internet setting holds for web tools; read-only runs make no changes", async () => {
  assert.equal((await judgeEngineCall(ctx(), { tool: "WebFetch", input: { url: "https://example.com" } })).decision, "deny");
  assert.equal((await judgeEngineCall(ctx({ network: true }), { tool: "WebFetch", input: { url: "https://example.com" } })).decision, "allow");
  assert.equal((await judgeEngineCall(ctx({ accessMode: "review" }), { tool: "Edit", input: { file_path: join(root, "a.txt") } })).decision, "deny");
});

test("unattended answers a question with the recommended option and records it", async () => {
  const run = ctx();
  const answer = await judgeEngineCall(run, {
    tool: "AskUserQuestion",
    input: { questions: [{ question: "Which colour?", options: [{ label: "Red" }, { label: "Blue (Recommended)" }] }] },
  });
  assert.equal(answer.decision, "allow");
  assert.deepEqual((answer.updatedInput as { answers: Record<string, string> }).answers, { "Which colour?": "Blue (Recommended)" });
  assert.deepEqual(run.decisions?.[0]?.recommended, "Blue (Recommended)");
});

test("shell commands are split into programs for the checks", () => {
  assert.deepEqual(shellSegments('git add -A && git commit -m "a b" | tee log'), [["git", "add", "-A"], ["git", "commit", "-m", "a b"], ["tee", "log"]]);
  assert.deepEqual(shellSegments("FOO=1 npm test"), [["npm", "test"]]);
});

test("Claude Code gets the hook on every tool, a strict sandbox, and the run's internet setting", () => {
  const settings = claudeSettings({ hookCommand: "node hook --engine", sandboxed: true, network: false, writable: ["/w"] }) as {
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    sandbox: { enabled: boolean; failIfUnavailable: boolean; allowUnsandboxedCommands: boolean; filesystem: { allowWrite: string[] }; network: { allowedDomains?: string[]; strictAllowlist?: boolean } };
    permissions: { deny?: string[]; allow?: string[] };
  };
  assert.equal(settings.hooks.PreToolUse[0]!.matcher, "*");
  assert.equal(settings.hooks.PreToolUse[0]!.hooks[0]!.command, "node hook --engine");
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, ["/w"]);
  assert.deepEqual(settings.sandbox.network, { allowedDomains: [], strictAllowlist: true });
  assert.ok(settings.permissions.deny?.includes("WebFetch"));
  const online = claudeSettings({ hookCommand: "x", sandboxed: false, network: true, writable: [] }) as { sandbox: { enabled: boolean }; permissions: { allow?: string[] } };
  assert.equal(online.sandbox.enabled, false);
  assert.ok(online.permissions.allow?.includes("WebFetch(domain:*)"));
});
