import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
  assert.equal((await judgeEngineCall(ctx(), { tool: "Bash", input: { command: "crontab -l" } })).decision, "deny");
  // ssh is the run's mode to decide, and needs the internet.
  assert.equal((await judgeEngineCall(ctx(), { tool: "Bash", input: { command: "curl x | ssh host" } })).decision, "deny");
  assert.equal((await judgeEngineCall(ctx({ network: true }), { tool: "Bash", input: { command: "ssh host uptime" } })).decision, "allow");
});

test("the hard floor's dangerous commands are refused with why, in every mode, before anyone is asked; everyday commands are not", async () => {
  let asked = 0;
  const asking = ctx({ job: { unattended: false }, accessMode: "auto", prisma: { decisionRule: { findFirst: async () => null } }, ask: async () => ((asked += 1), { decision: "allow" }) } as never);
  for (const [tool, command] of [["Bash", "rm -rf ~"], ["Bash", "cd /tmp && dd if=/dev/zero of=/dev/sda bs=1M"], ["Bash", "git status; shutdown -h now"], ["PowerShell", "shutdown -h now"], ["Bash", ":(){ :|:& };:"]] as const) {
    for (const run of [ctx(), asking]) {
      const answer = await judgeEngineCall(run, { tool, input: { command } });
      assert.equal(answer.decision, "deny", command);
      assert.match(answer.message ?? "", /hard floor.*No setting or approval runs it/, command);
    }
  }
  assert.equal(asked, 0, "nobody is asked about a command the floor refuses");
  for (const command of ["rm -rf node_modules dist", "npm test", "docker system prune -af"]) {
    assert.equal((await judgeEngineCall(ctx({ network: true }), { tool: "Bash", input: { command } })).decision, "allow", command);
  }
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

/** A run whose Needs me questions are answered at once with `answer`, recording each question's title. */
function answering(answer: "allow" | "deny", over: Omit<Partial<Ctx>, "job"> & { job?: Partial<WorkspaceJob> } = {}) {
  const asked: string[] = [];
  const saved: string[] = [];
  const prisma = {
    decisionRule: { findFirst: async () => null, findMany: async () => [], create: async ({ data }: { data: { pattern: string } }) => (saved.push(data.pattern), data) },
    agentDecision: { create: async ({ data }: { data: { title: string } }) => (asked.push(data.title), { id: `d${asked.length}` }), updateMany: async () => ({ count: 0 }) },
    notification: { create: async () => ({}) },
  };
  const run = ctx({
    workspace,
    prisma,
    signal: new AbortController().signal,
    waitForPerson: async () => ({ status: "decided", decision: answer, reason: null }),
    ...over,
  } as never);
  return { run, asked, saved };
}

const workspace = join(homedir(), "ensemble-workspace");

test("unattended works anywhere in the workspace and the person's folders, sandboxed or not; the floor still holds", async () => {
  const other = join(workspace, "runs", "other", "notes.md");
  const beyond = join(homedir(), "ensemble-judge-test", "proj", "notes.md");
  for (const run of [ctx({ workspace }), ctx({ workspace, sandboxed: false, strength: "advisory" })]) {
    assert.equal((await judgeEngineCall(run, { tool: "Write", input: { file_path: other } })).decision, "allow");
    assert.equal((await judgeEngineCall(run, { tool: "Write", input: { file_path: beyond } })).decision, "allow");
    assert.equal((await judgeEngineCall(run, { tool: "Bash", input: { command: `pwd && ls ${join(workspace, "runs")} && cp a.txt ${other}` } })).decision, "allow");
    assert.equal((await judgeEngineCall(run, { tool: "Write", input: { file_path: join(workspace, ".askpass", "git-askpass.sh") } })).decision, "deny");
  }
  // The person's own No access beyond the workspace holds when nobody can be asked.
  assert.equal((await judgeEngineCall(ctx({ workspace, outsideAccess: "none" }), { tool: "Write", input: { file_path: beyond } })).decision, "deny");
  assert.equal((await judgeEngineCall(ctx({ workspace, outsideAccess: "none" }), { tool: "Write", input: { file_path: other } })).decision, "allow");
});

test("Review only asks once per folder before changing it, then works there freely; reading never asks", async () => {
  const { run, asked, saved } = answering("allow", { accessMode: "auto", job: { unattended: false } });
  const other = join(workspace, "runs", "other");
  assert.equal((await judgeEngineCall(run, { tool: "Read", input: { file_path: join(homedir(), "ensemble-judge-test", "x.md") } })).decision, "allow");
  assert.equal((await judgeEngineCall(run, { tool: "Bash", input: { command: `ls ${other} && cat ${join(other, "a.md")}` } })).decision, "allow");
  assert.equal(asked.length, 0);
  assert.equal((await judgeEngineCall(run, { tool: "Write", input: { file_path: join(other, "notes.md") } })).decision, "allow");
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /runs\/other/);
  assert.deepEqual(saved, [other]);
  assert.equal((await judgeEngineCall(run, { tool: "Edit", input: { file_path: join(other, "src", "b.ts") } })).decision, "allow");
  assert.equal((await judgeEngineCall(run, { tool: "Bash", input: { command: `cp a.txt ${join(other, "c.txt")} && npm test` } })).decision, "allow");
  assert.equal(asked.length, 1, "the same folder is not asked about again");
  // A command outside the sandbox whose outside paths are all in an allowed folder needs no question either.
  assert.equal((await judgeEngineCall(run, { tool: "Bash", input: { command: `touch ${join(other, "d.txt")}`, dangerouslyDisableSandbox: true } })).decision, "allow");
  assert.equal(asked.length, 1);
  assert.equal((await judgeEngineCall(run, { tool: "Write", input: { file_path: join(workspace, "runs", "third", "x.md") } })).decision, "allow");
  assert.equal(asked.length, 2, "a new folder asks once");
  const no = answering("deny", { accessMode: "auto", job: { unattended: false } });
  const refused = await judgeEngineCall(no.run, { tool: "Write", input: { file_path: join(other, "notes.md") } });
  assert.equal(refused.decision, "deny");
  assert.match(refused.message ?? "", /did not allow/);
});

test("Ask asks before changing another folder and asks one question for a command that does", async () => {
  const { run, asked } = answering("allow", { trusted: false, silentWorkspace: false, job: { unattended: false } });
  assert.equal((await judgeEngineCall(run, { tool: "Bash", input: { command: `cp a.txt ${join(workspace, "runs", "other", "a.txt")}` } })).decision, "allow");
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /^Run cp a\.txt/);
  // Commands still ask in Ask; never refused for being outside.
  assert.equal((await judgeEngineCall(run, { tool: "Bash", input: { command: "npm test" } })).decision, "allow");
  assert.equal(asked.length, 2);
  // Another computer asks too.
  const online = answering("allow", { network: true, job: { unattended: false }, accessMode: "auto" });
  assert.equal((await judgeEngineCall(online.run, { tool: "Bash", input: { command: "ssh build-box uptime" } })).decision, "allow");
  assert.match(online.asked[0] ?? "", /another computer/);
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
  assert.equal(settings.sandbox.allowUnsandboxedCommands, true);
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, ["/w"]);
  assert.deepEqual(settings.sandbox.network, { allowedDomains: [], strictAllowlist: true });
  assert.ok(settings.permissions.deny?.includes("WebFetch"));
  const online = claudeSettings({ hookCommand: "x", sandboxed: false, network: true, filesystem: { allowWrite: [], denyRead: [] } }) as { sandbox: { enabled: boolean }; permissions: { allow?: string[] } };
  assert.equal(online.sandbox.enabled, false);
  assert.ok(online.permissions.allow?.includes("WebFetch(domain:*)"));
});

test("outside the folder, reading goes ahead with the default setting; read and write lets Ask change folders beyond the workspace", async () => {
  const beyond = join(homedir(), "ensemble-judge-test", "proj", "notes.md");
  const asking = answering("deny", { outsideAccess: "read", job: { unattended: false } });
  assert.equal((await judgeEngineCall(asking.run, { tool: "Read", input: { file_path: beyond } })).decision, "allow");
  assert.equal((await judgeEngineCall(asking.run, { tool: "Bash", input: { command: `cat ${beyond}` } })).decision, "allow");
  assert.equal(asking.asked.length, 0);
  assert.equal((await judgeEngineCall(asking.run, { tool: "Write", input: { file_path: beyond } })).decision, "deny");
  assert.equal(asking.asked.length, 1);
  const open = answering("deny", { outsideAccess: "read-write", job: { unattended: false } });
  assert.equal((await judgeEngineCall(open.run, { tool: "Write", input: { file_path: beyond } })).decision, "allow");
  assert.equal(open.asked.length, 0);
  // Keys stay closed whatever the setting.
  assert.equal((await judgeEngineCall(open.run, { tool: "Read", input: { file_path: join(homedir(), ".aws", "credentials") } })).decision, "deny");
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
  const none = claudeFilesystem({ ...base, access: "none", skills: ["/h/.agents/skills", "/h/.claude/skills"] });
  assert.ok(none.denyRead.includes("/h") && none.denyRead.includes("/h/.ssh"));
  assert.ok(none.allowRead?.includes("/h/ensemble-workspace/runs/1") && none.allowRead.includes("/h/.nvm"));
  assert.ok(none.allowRead?.includes("/h/.agents/skills") && !none.allowWrite.includes("/h/.agents/skills"), "skills are read, never written, with No access");
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

test("in Ask in an untrusted folder, commands that only read files in the folder run without asking; anything else still asks", async () => {
  const folder = mkdtempSync(join(tmpdir(), "ensemble-quiet-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "ensemble-quiet-outside-"));
  try {
    mkdirSync(join(folder, ".git"));
    writeFileSync(join(folder, ".git", "config"), "[core]\n\tbare = false\n");
    mkdirSync(join(folder, "src"));
    writeFileSync(join(folder, "src", "a.ts"), "x");
    writeFileSync(join(folder, "README.md"), "hi");
    writeFileSync(join(elsewhere, "id_rsa"), "secret");
    symlinkSync(join(elsewhere, "id_rsa"), join(folder, "notes"));
    mkdirSync(join(folder, "evil", ".git"), { recursive: true });
    writeFileSync(join(folder, "evil", ".git", "config"), "[core]\n\tpager = ./run.sh\n");
    // A saved "Deny for this run" answers the question each non-quiet command would put to the person.
    const prisma = { decisionRule: { findFirst: async () => ({ decision: "deny" }) } };
    const asking = (over: Partial<Ctx> = {}) => ctx({ root: folder, trusted: false, explicitTrust: false, silentWorkspace: false, job: { unattended: false }, prisma, ...over } as never);
    const quiet = ["ls -la", "cat README.md | head -20", "grep -rn foo src && wc -l src/a.ts", "rg TODO src", "find . -name '*.ts' -type f", "ls src/*.ts", "git status", "git log --oneline -5", "cat a 2>/dev/null", "sort data.txt | uniq -c"];
    for (const command of quiet) assert.equal((await judgeEngineCall(asking(), { tool: "Bash", input: { command } })).decision, "allow", command);
    const asks = [
      "npm test",
      "ls > out.txt",
      "cat a && rm b",
      "ls $(rm -rf x)",
      "echo $(git rev-parse HEAD)",
      "cat $SECRET_FILE",
      "cat {README.md,../x}",
      "LD_PRELOAD=./x.so ls",
      "PAGER=./evil; git log",
      "env GIT_EXTERNAL_DIFF=./x git diff",
      "git --config-env=core.pager=SHELL --paginate log -1",
      "cd evil && git log",
      "cat notes",
      "cat *otes",
      "grep -R key .",
      "diff -r src src",
      "rg --pre ./x.sh foo",
      "fd -x rm",
      "sed -n 1p a.txt",
      "sort -oPWN README.md",
      "uniq in.txt out.txt",
      "xxd a.bin out.txt",
      "find . -fprint0 list.txt",
      "git diff --output=patch.txt",
      "bat README.md",
      "less README.md",
      "grep -f ../patterns README.md",
    ];
    for (const command of asks) {
      const answer = await judgeEngineCall(asking(), { tool: "Bash", input: { command } });
      assert.equal(answer.decision, "deny", command);
      assert.match(answer.message ?? "", /denied this for the rest of the run/, command);
    }
    assert.equal((await judgeEngineCall(asking(), { tool: "PowerShell", input: { command: "ls" } })).decision, "deny", "PowerShell is not read as POSIX");
    // Without the sandbox the repository's own git config could start programs, so git still asks; plain reads do not.
    const direct = asking({ sandboxed: false, strength: "advisory" } as never);
    assert.equal((await judgeEngineCall(direct, { tool: "Bash", input: { command: "git status" } })).decision, "deny");
    assert.equal((await judgeEngineCall(direct, { tool: "Bash", input: { command: "ls -la src" } })).decision, "allow");
  } finally {
    rmSync(folder, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a read the person allowed where reading asks never lets the run write there", async () => {
  const { run, asked, saved } = answering("allow", { accessMode: "auto", outsideAccess: "none", job: { unattended: false } });
  const folder = join(homedir(), "ensemble-judge-test", "notes");
  assert.equal((await judgeEngineCall(run, { tool: "Read", input: { file_path: join(folder, "a.md") } })).decision, "allow");
  assert.equal((await judgeEngineCall(run, { tool: "Read", input: { file_path: join(folder, "b.md") } })).decision, "allow");
  assert.equal(asked.length, 1, "one question for reading the folder");
  assert.deepEqual([run.grants ?? [], run.readGrants], [[], [folder]]);
  assert.equal((await judgeEngineCall(run, { tool: "Write", input: { file_path: join(folder, "a.md") } })).decision, "allow");
  assert.equal(asked.length, 2, "changing it is a question of its own");
  assert.deepEqual(saved, [folder, folder]);
});

test("the agents' skill folders are read in every mode, and running a skill's script there does not count as changing them", async () => {
  const base = mkdtempSync(join(tmpdir(), "ensemble-skills-"));
  const saved = process.env.CODEX_HOME;
  try {
    // A skill folder of the agent (Codex's, here) inside the run's workspace, so changing it would be asked about.
    process.env.CODEX_HOME = join(base, "codex");
    const skill = join(base, "codex", "skills", "ui-ux-pro-max");
    mkdirSync(join(skill, "scripts"), { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "# skill");
    writeFileSync(join(skill, "scripts", "search.py"), "print('ok')");
    writeFileSync(join(skill, ".env"), "TOKEN=x");
    const runRoot = join(base, "runs", "job-1");
    mkdirSync(runRoot, { recursive: true });
    const review = () => answering("allow", { root: runRoot, workspace: base, accessMode: "auto", job: { unattended: false } });
    for (const command of [
      `python3 ${join(skill, "scripts", "search.py")} "fintech dashboard" --domain style`,
      `cd ${skill} && python3 scripts/search.py "landing page" --design-system`,
      `${join(skill, "scripts", "search.py")} --stack react`,
      `bash -c 'python3 ${join(skill, "scripts", "search.py")} "x"'`,
    ]) {
      const { run, asked } = review();
      assert.equal((await judgeEngineCall(run, { tool: "Bash", input: { command } })).decision, "allow", command);
      assert.deepEqual(asked, [], command);
    }
    // Writing there is still a change to that folder, asked once.
    for (const [tool, input] of [
      ["Bash", { command: `python3 ${join(skill, "scripts", "search.py")} "x" > ${join(skill, "out.md")}` }],
      ["Bash", { command: `cp notes.md ${join(skill, "SKILL.md")}` }],
      ["Bash", { command: `cd ${skill} && rm -rf scripts` }],
      ["Bash", { command: `python3 -c "print(1)" ${join(skill, "SKILL.md")}` }],
      ["Write", { file_path: join(skill, "SKILL.md") }],
    ] as const) {
      const { run, asked } = review();
      assert.equal((await judgeEngineCall(run, { tool, input })).decision, "allow");
      assert.equal(asked.length, 1, JSON.stringify(input));
      assert.match(asked[0]!, /codex/, JSON.stringify(input));
    }
    // Where reading asks (No access), the skill folders are still read without a question; a credential file there is not.
    process.env.CODEX_HOME = join(homedir(), "ensemble-judge-test", "codex");
    const none = answering("allow", { accessMode: "auto", outsideAccess: "none", job: { unattended: false } });
    assert.equal((await judgeEngineCall(none.run, { tool: "Read", input: { file_path: join(homedir(), "ensemble-judge-test", "codex", "skills", "demo", "SKILL.md") } })).decision, "allow");
    assert.equal((await judgeEngineCall(none.run, { tool: "Bash", input: { command: `cat ${join(homedir(), "ensemble-judge-test", "codex", "skills", "demo", "references", "a.md")}` } })).decision, "allow");
    assert.equal(none.asked.length, 0);
    assert.equal((await judgeEngineCall(none.run, { tool: "Read", input: { file_path: join(homedir(), "ensemble-judge-test", "codex", "skills", "demo", ".env") } })).decision, "allow");
    assert.equal(none.asked.length, 1, "a credential file in a skill folder follows the run's rules");
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
    rmSync(base, { recursive: true, force: true });
  }
});

test("“Allow for this run” covers the same command with other arguments, an edit anywhere in the run's folder and the same site; anything else asks again", async () => {
  const folder = mkdtempSync(join(tmpdir(), "ensemble-kinds-"));
  try {
    writeFileSync(join(folder, "search.py"), "print(1)");
    writeFileSync(join(folder, "other.py"), "print(2)");
    // The answers the person gave "for this run" (the decide route saves them as run rules), and the questions asked after.
    const rules = [
      { toolName: "Bash", pattern: `python3 ${join(folder, "search.py")} "fintech" --domain style`, decision: "allow" },
      { toolName: "Bash", pattern: "npm run build", decision: "allow" },
      { toolName: "Bash", pattern: "npm publish", decision: "deny" },
      { toolName: "write", pattern: join(folder, "src", "a.ts"), decision: "allow" },
      { toolName: "WebFetch", pattern: "https://docs.example.com/a", decision: "allow" },
      { toolName: "mcp__ensemble__browser", pattern: "mcp__ensemble__browser_open", decision: "allow" },
    ];
    const matches = (where: { toolName: string; pattern?: { in: string[] } }) => rules.filter((rule) => rule.toolName === where.toolName && (!where.pattern || where.pattern.in.includes(rule.pattern)));
    const asked: string[] = [];
    const run = ctx({
      root: folder,
      network: true,
      trusted: false,
      explicitTrust: false,
      silentWorkspace: false,
      job: { unattended: false },
      prisma: {
        decisionRule: { findFirst: async ({ where }: never) => matches(where)[0] ?? null, findMany: async ({ where }: never) => matches(where) },
        agentDecision: { create: async ({ data }: { data: { title: string } }) => (asked.push(data.title), { id: `d${asked.length}` }), updateMany: async () => ({ count: 0 }) },
        notification: { create: async () => ({}) },
      },
      signal: new AbortController().signal,
      waitForPerson: async () => ({ status: "decided", decision: "deny", reason: null }),
    } as never);
    const covered: Array<[string, Record<string, unknown>]> = [
      ["Bash", { command: `python3 ${join(folder, "search.py")} "landing page" --design-system` }],
      ["Bash", { command: `cd ${folder} && python3 search.py "x"` }],
      ["Bash", { command: "npm run build -- --prod" }],
      ["Write", { file_path: join(folder, "src", "b.ts") }],
      ["WebFetch", { url: "https://docs.example.com/b?q=1" }],
      // The run's browser tools are one group: allowed for the run once, each of them goes ahead.
      ["mcp__ensemble__browser_click", {}],
    ];
    for (const [tool, input] of covered) assert.equal((await judgeEngineCall(run, { tool, input })).decision, "allow", JSON.stringify(input));
    assert.deepEqual(asked, []);
    const denied = await judgeEngineCall(run, { tool: "Bash", input: { command: "npm publish --tag beta" } });
    assert.equal(denied.decision, "deny");
    assert.equal(asked.length, 0, "a denial for this run covers its kind too");
    for (const [tool, input] of [
      ["Bash", { command: `python3 ${join(folder, "other.py")}` }],
      ["Bash", { command: `python3 -c "import os" ${join(folder, "search.py")}` }],
      ["Bash", { command: "npm run deploy" }],
      ["Bash", { command: "FOO=1 npm run build" }],
      ["WebFetch", { url: "https://evil.example.net/a" }],
      ["mcp__ensemble__capture_video", {}],
      ["mcp__github__delete_repo", {}],
    ] as const) {
      const before: number = asked.length;
      await judgeEngineCall(run, { tool, input });
      assert.equal(asked.length, before + 1, JSON.stringify(input));
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a command's kind is the program and what it does, never inline code, a variable or another computer", async () => {
  const { commandKind } = await import("../command-kind.js");
  assert.equal(commandKind('git commit -m "fix"', "/r"), "git commit");
  assert.equal(commandKind("npm run -s build --prod", "/r"), "npm run build");
  assert.equal(commandKind("npx playwright test --headed", "/r"), "npx playwright test");
  assert.equal(commandKind("docker compose up -d", "/r"), "docker compose up");
  assert.equal(commandKind("python3 -m pytest -x", "/r"), "python3 -m pytest");
  for (const command of ["git -C /x commit", "rm -rf build", "node -e 'x()'", "ssh host uptime", "npm run $TARGET", "FOO=1 npm test", "python3 missing.py"]) {
    assert.equal(commandKind(command, "/r"), null, command);
  }
});

const { grantFolder, granted } = await import("../tools.js");
const { checkProgram, holdsProtected } = await import("../guard.js");
const { openRoots } = await import("./claude-code.js");

test("a folder that holds keys, Ensemble's git helper or its code is never handed over whole", async () => {
  const home = homedir();
  assert.equal(await grantFolder(join(home, ".codex", "config.toml"), workspace), join(home, ".codex", "config.toml"), "~/.codex holds auth.json");
  assert.equal(await grantFolder(join(home, ".claude", "settings.json"), workspace), join(home, ".claude", "settings.json"));
  assert.equal(await grantFolder(workspace, workspace), workspace, "the workspace root narrows to itself, and is never kept");
  assert.equal(holdsProtected(workspace), true);
  assert.equal(holdsProtected(join(workspace, "runs", "x")), false);
  assert.equal(await grantFolder(join(workspace, "runs", "other", "src", "a.ts"), workspace), join(workspace, "runs", "other"));
  // A run allowed the workspace root this once does not keep it.
  const { run } = answering("allow", { accessMode: "auto", job: { unattended: false } });
  assert.equal((await judgeEngineCall(run, { tool: "Write", input: { file_path: workspace } })).decision, "allow");
  assert.deepEqual(run.grants ?? [], []);
  assert.equal(granted({ root, grants: [], readGrants: [workspace] }, join(workspace, "runs", "x"), true), false);
});

test("wrappers do not hide a never-run program, a remote shell or a shell outside the sandbox", () => {
  const agent = { who: "agent" as const, sandboxed: false, network: true };
  for (const line of [["env", "sudo", "id"], ["nohup", "pkill", "node"], ["timeout", "5", "crontab", "-r"], ["env", "FOO=1", "bash", "-c", "x"], ["env", "-u", "PATH", "sudo", "id"], ["env", "-S", "sudo id"], ["timeout", "-s", "KILL", "5", "crontab", "-r"], ["xargs", "sudo", "id"], ["xargs", "-n", "1", "sudo"], ["setsid", "pkill", "node"]]) {
    assert.throws(() => checkProgram(line, agent), /./, line.join(" "));
  }
  assert.throws(() => checkProgram(["env", "ssh", "host"], { ...agent, network: false }), /network/);
  assert.throws(() => checkProgram(["env", "-u", "X", "ssh", "host"], { ...agent, network: false }), /network/);
  assert.equal(checkProgram(["pwd"], agent), "pwd");
  assert.equal(checkProgram(["timeout", "30", "npm", "test"], agent), "timeout");
});

test("a sandbox without a deny list never gets a writable root that holds a closed path", async () => {
  const base = mkdtempSync(join(tmpdir(), "ensemble-roots-"));
  try {
    for (const name of ["code/ensemble", "code/other", "code/more", "ws/.askpass", "ws/runs", "plain"]) mkdirSync(join(base, name), { recursive: true });
    const closed = [join(base, "code", "ensemble"), join(base, "ws", ".askpass")];
    const open = await openRoots([join(base, "code"), join(base, "ws"), join(base, "plain"), join(base, "code", "ensemble", "x")], closed);
    assert.deepEqual(open.sort(), [join(base, "code", "more"), join(base, "code", "other"), join(base, "plain"), join(base, "ws", "runs")].sort());
    // A link to a folder holding Ensemble's code is followed, not trusted by its name.
    symlinkSync(join(base, "code"), join(base, "linked"));
    assert.deepEqual((await openRoots([join(base, "linked")], closed)).sort(), [join(base, "code", "more"), join(base, "code", "other")].sort());
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
