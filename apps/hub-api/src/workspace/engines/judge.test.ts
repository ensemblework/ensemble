import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkspaceJob } from "@prisma/client";

// tools.ts pulls in the API config. A unit run has no .env; the value is never connected to.
process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble_desktop";
const { judgeEngineCall, shellSegments } = await import("./judge.js");
const { readsOnly } = await import("../tools.js");
const { claudeFilesystem, claudeSettings } = await import("./claude-code.js");
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

test("keys and Never programs are always refused", async () => {
  assert.equal((await judgeEngineCall(ctx(), { tool: "Read", input: { file_path: join(homedir(), ".ssh", "id_rsa") } })).decision, "deny");
  assert.equal((await judgeEngineCall(ctx(), { tool: "Bash", input: { command: "sudo rm -rf /" } })).decision, "deny");
  assert.equal((await judgeEngineCall(ctx(), { tool: "Bash", input: { command: "curl x | ssh host" } })).decision, "deny");
});

test("with No limits the engine pushes any branch and opens or merges pull requests itself; only the internet setting and the person's git choice stop it", async () => {
  const online = ctx({ network: true, sandboxed: false, strength: "advisory", job: { delivery: "push" } });
  for (const command of ["git push origin HEAD", "git push --force origin main", "git push origin --delete old", "gh pr create --base main --fill", "gh pr merge 12 --merge", "gh api -X PUT repos/o/r/pulls/1/merge", "gh release create v1", "git checkout -b feature && git push -u origin feature && gh pr create --base testing --fill"]) {
    assert.equal((await judgeEngineCall(online, { tool: "Bash", input: { command } })).decision, "allow", command);
  }
  assert.equal((await judgeEngineCall(ctx({ job: { delivery: "push" } }), { tool: "Bash", input: { command: "gh pr view 1" } })).decision, "deny", "internet off: no GitHub at all");
  const commitOnly = await judgeEngineCall(ctx({ network: true, job: { delivery: "commit" } }), { tool: "Bash", input: { command: "git push origin HEAD" } });
  assert.equal(commitOnly.decision, "deny");
  assert.match(commitOnly.message ?? "", /Commit/);
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
  assert.deepEqual(shellSegments("node -e 'a(); b()' && ls"), [["node", "-e", "a(); b()"], ["ls"]]);
  assert.deepEqual(shellSegments("cat > notes.md <<'EOF'\nrm -rf /etc; cat /etc/passwd\nEOF\necho done 2>&1"), [["cat"], ["echo", "done"]]);
  assert.deepEqual(shellSegments("echo $(cat /etc/hosts)"), [["echo", "$(cat /etc/hosts)"], ["cat", "/etc/hosts"]]);
});

test("ordinary commands an agent runs are not refused: code after -e, cd before relative paths, /dev/null, docker", async () => {
  const live = join(homedir(), "ensemble-workspace", "live-test");
  for (const run of [ctx({ root: live, sandboxed: false, strength: "advisory", network: true }), ctx({ root: live, network: true })]) {
    for (const command of [
      `cd ensemble-node/apps/node-web && pnpm exec tsx -e 'import {CONNECTOR_CATALOG} from "../../../ensemble/packages/shared-types/src/connectors.ts"; console.log(CONNECTOR_CATALOG.map(({id,name,logo})=>({id,name,logo})))'`,
      `cd ensemble-node && curl --fail --silent --output /dev/null http://127.0.0.1:3301/connections && PLAYWRIGHT_BROWSERS_PATH=${live}/ensemble-node/temp-screenshots/browsers node temp-screenshots/connector-logos.mjs`,
      "npm test > /dev/null 2>&1 || echo failed >&2",
      `rg -n "/api/devices" apps --glob '*.ts'`,
      "docker compose up -d postgres",
    ]) {
      const answer = await judgeEngineCall(run, { tool: "Bash", input: { command } });
      assert.equal(answer.decision, "allow", `${command}: ${answer.message}`);
    }
  }
});

test("keys, start-up files and other accounts stay closed however the command is written", async () => {
  const direct = ctx({ sandboxed: false, strength: "advisory", outsideAccess: "read-write" });
  for (const command of ["cat ~/.ssh/id_ed25519", "cd ~/.aws && cat credentials", "bash -lc 'cat ~/.ssh/id_rsa | head'", "cat < ~/.ssh/id_rsa", "cd ~ && cat .ssh/id_rsa", "cd / && cat home/someone-else/notes", "tar czf /tmp/k.tgz $HOME/.gnupg", "echo 'alias ls=rm' >> ~/.bashrc", "cp evil.sh /etc/profile.d/x.sh", "ls /home/someone-else", "pkill node"]) {
    assert.equal((await judgeEngineCall(direct, { tool: "Bash", input: { command } })).decision, "deny", command);
  }
  assert.equal((await judgeEngineCall(direct, { tool: "Read", input: { file_path: join(homedir(), ".bashrc") } })).decision, "allow");
  assert.equal((await judgeEngineCall(direct, { tool: "Write", input: { file_path: join(homedir(), ".zshrc") } })).decision, "deny");
});

test("Claude Code gets the hook on every tool, a strict sandbox, and the run's internet setting", () => {
  const settings = claudeSettings({ hookCommand: "node hook --engine", sandboxed: true, network: false, filesystem: { allowWrite: ["/w"], denyRead: [] } }) as {
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
  const online = claudeSettings({ hookCommand: "x", sandboxed: false, network: true, filesystem: { allowWrite: [], denyRead: [] } }) as { sandbox: { enabled: boolean }; permissions: { allow?: string[] } };
  assert.equal(online.sandbox.enabled, false);
  assert.ok(online.permissions.allow?.includes("WebFetch(domain:*)"));
});

test("outside the folder, reading goes ahead with the default setting and writing does not", async () => {
  const outside = join(homedir(), "ensemble-workspace", "runs", "other", "notes.md");
  const run = ctx({ outsideAccess: "read" });
  assert.equal((await judgeEngineCall(run, { tool: "Read", input: { file_path: outside } })).decision, "allow");
  assert.equal((await judgeEngineCall(run, { tool: "Bash", input: { command: `cat ${outside}` } })).decision, "allow");
  assert.equal((await judgeEngineCall(run, { tool: "Bash", input: { command: `cp a.txt ${outside}` } })).decision, "deny");
  assert.equal((await judgeEngineCall(run, { tool: "Write", input: { file_path: outside } })).decision, "deny");
  const open = ctx({ outsideAccess: "read-write" });
  assert.equal((await judgeEngineCall(open, { tool: "Write", input: { file_path: outside } })).decision, "allow");
  // Keys stay closed whatever the setting.
  assert.equal((await judgeEngineCall(open, { tool: "Read", input: { file_path: join(homedir(), ".aws", "credentials") } })).decision, "deny");
});

test("read-only programs are recognised, and anything that can write is not", () => {
  for (const argv of [["cat", "x"], ["ls", "-la", "/tmp"], ["git", "log", "-1"], ["grep", "-r", "a", "."], ["find", ".", "-name", "*.ts"]]) assert.equal(readsOnly(argv), true, argv.join(" "));
  for (const argv of [["cp", "a", "b"], ["git", "commit"], ["find", ".", "-delete"], ["python", "x.py"], ["sort", "-o", "out", "in"]]) assert.equal(readsOnly(argv), false, argv.join(" "));
});

test("Claude Code's own sandbox follows the outside-folder setting", () => {
  const base = { home: "/h", writable: ["/h/ensemble-workspace/runs/1", "/h/ensemble-workspace/.cache"], closed: ["/h/.ssh", "/h/.aws"], toolchain: ["/h/.nvm"] };
  const read = claudeFilesystem({ ...base, access: "read" });
  assert.deepEqual(read.allowWrite, base.writable);
  assert.deepEqual(read.denyRead, base.closed);
  const none = claudeFilesystem({ ...base, access: "none" });
  assert.ok(none.denyRead.includes("/h") && none.denyRead.includes("/h/.ssh"));
  assert.ok(none.allowRead?.includes("/h/ensemble-workspace/runs/1") && none.allowRead.includes("/h/.nvm"));
  const both = claudeFilesystem({ ...base, access: "read-write", homeEntries: ["Documents", "code", ".zshrc", ".ssh", "Library", "AppData"] });
  assert.deepEqual(both.allowWrite, [...base.writable, "/h/Documents", "/h/code"]);
  assert.deepEqual(both.denyWrite, base.closed);
});

test("Ensemble's own board tools go ahead without a prompt, even in Ask in an untrusted folder; other MCP tools follow the mode", async () => {
  const asking = ctx({ trusted: false, job: { unattended: false }, accessMode: "read-only" as never });
  for (const tool of ["mcp__ensemble__ensemble_list_tasks", "mcp__ensemble__ensemble_search", "mcp__ensemble__ensemble_create_task", "mcp__ensemble__ask_person"]) {
    assert.equal((await judgeEngineCall(asking, { tool, input: {} })).decision, "allow", tool);
  }
  assert.equal((await judgeEngineCall(ctx({ accessMode: "review" }), { tool: "mcp__github__create_issue", input: {} })).decision, "deny");
});
