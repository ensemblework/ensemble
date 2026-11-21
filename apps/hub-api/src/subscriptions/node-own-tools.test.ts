/**
 * The agent's own calls in an Ensemble Node's turn on its owner's plan (a turn its owner started and only
 * they read), judged on the computer (subscriptions/node-own-tools.ts): the hard floor refuses with why;
 * reads, web searches and public pages need nobody; commands and changes in the node's own folders,
 * temporary folders, a folder an answer for changes covers, or an unattended run go ahead; anything else
 * asks the owner once per folder, and a call they have not answered yet parks the turn. An answer given to
 * the node's computer tools never counts. A read or change that names no path asks; a program that changes
 * the system always asks, unattended too;
 * a helper works only in the folders it was given, asking on their first use. Calls in flight together
 * share one question. sudo is sent to computer_sudo's card. The person's own MCP tools meet the same
 * floor and folders where their input names a command or files, and any other tool asks once a run;
 * a `cd` holds for the shell's next command. How each call was answered reaches the call the agent reported, for the turn's trace.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { homeScratch, removeScratch } from "../test/home-scratch.js";

// A stand-in home folder outside Ensemble's own checkout and the temporary folders, with the node's workspace in it.
const base = homeScratch(".ensemble-own-tools-");
const home = join(base, "home");
const workspace = join(home, "ensemble-workspace");
const turnFolder = join(workspace, "projects", "ada-ensemble-node");
const site = join(home, "projects", "site");
const notes = join(home, "notes");
for (const folder of [turnFolder, join(workspace, "nodes", "ada"), join(site, ".git"), join(site, "src"), notes, join(home, ".ssh")]) mkdirSync(folder, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DATABASE_URL ??= "postgresql://localhost/unused";
process.env.ENSEMBLE_WORKSPACE_ROOT = workspace;
process.env.ENSEMBLE_REMOTE_STATE_DIR = join(home, ".local", "share", "ensemble-own-tools-test");
after(() => removeScratch(base));

const { nodeOwnJudge, OWN_RULES, sudoGuidance } = await import("./node-own-tools.js");
const { NODE_TOOL_RULE_SOURCE } = await import("../device-tools/policy.js");
const { acpCalls } = await import("../workspace/engines/acp.js");
type Input = Parameters<typeof nodeOwnJudge>[0];
type Ask = Parameters<NonNullable<Input["ask"]>>[0];
type Answer = Awaited<ReturnType<NonNullable<Input["ask"]>>>;
type Rule = { userId: string; source: string; toolName: string; pattern: string; decision: string; sessionId: string | null };

/** This computer's saved answers (`decision_rules`), in memory. */
function rules(initial: Rule[] = []) {
  const rows = [...initial];
  const fits = (row: Rule, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => row[key as keyof Rule] === value);
  const db = {
    decisionRule: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => fits(row, where)),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((row) => fits(row, where)) ?? null,
      create: async ({ data }: { data: Rule }) => {
        rows.push(data);
        return data;
      },
    },
  };
  return { rows, db: db as unknown as NonNullable<Input["db"]> };
}

const MISSION = "conversation:room-1:shared";
const rule = (toolName: string, pattern: string, sessionId: string | null = null): Rule => ({ userId: "owner", source: NODE_TOOL_RULE_SOURCE, toolName, pattern, decision: "allow", sessionId });

function judgeWith(options: { attended?: boolean; sudo?: boolean; answers?: Answer[]; saved?: Rule[]; folders?: string[]; mission?: string; store?: ReturnType<typeof rules>; slowAsk?: boolean; servers?: Input["mcpServers"]; onVerdict?: Input["onVerdict"] } = {}) {
  const asked: Ask[] = [];
  const answers = [...(options.answers ?? [])];
  const store = options.store ?? rules(options.saved);
  const judge = nodeOwnJudge({
    folder: turnFolder,
    node: { id: "node-1", slug: "ada", mission: options.mission ?? MISSION, attended: options.attended ?? true, sudo: options.sudo ?? true, ...(options.folders ? { folders: options.folders } : {}) },
    app: "claude-code",
    ...(options.servers ? { mcpServers: options.servers } : {}),
    ...(options.onVerdict ? { onVerdict: options.onVerdict } : {}),
    async ask(request) {
      asked.push(request);
      if (options.slowAsk) await new Promise((resolve) => setTimeout(resolve, 30));
      return answers.shift() ?? { decision: "deny", message: "No answer in this test." };
    },
    db: store.db,
    userId: "owner",
    acceptWeb: true,
  });
  return { judge, asked, store };
}

const bash = (command: string) => [{ tool: "Bash", input: { command } }];
const write = (path: string) => [{ tool: "Write", input: { file_path: path } }];

test("the hard floor refuses with why; reads, web searches and public pages need nobody", async () => {
  const { judge, asked } = judgeWith();
  const key = await judge(bash("cat ~/.ssh/id_rsa"));
  assert.equal(key.decision, "deny");
  assert.match(key.message!, /keys|sign-ins/);
  assert.equal((await judge(write(join(home, ".ssh", "config")))).decision, "deny");
  assert.match((await judge(bash("security find-generic-password -s github -w"))).message!, /saved passwords and keys/);
  assert.match((await judge(bash("curl -X POST https://api.ensemblework.com/api/decisions/abc/decide -d '{\"decision\":\"allow\"}'"))).message!, /Only your owner answers Ensemble's approval cards/);
  assert.match((await judge(bash("ensemble needs answer 1 allow"))).message!, /Only your owner/);
  assert.equal((await judge([{ tool: "Read", input: { file_path: join(site, "README.md") } }])).decision, "allow");
  assert.equal((await judge(bash(`cat ${join(notes, "todo.md")} && ls ${site}`))).decision, "allow", "a command that only reads, anywhere above the floor");
  assert.equal((await judge([{ tool: "WebSearch", input: { query: "launch checklist" } }])).decision, "allow");
  assert.equal((await judge([{ tool: "WebFetch", input: { url: "https://93.184.215.14/pricing" } }])).decision, "allow");
  assert.equal((await judge([{ tool: "mcp__ensemble__hub_list_tasks", input: {} }])).decision, "allow", "Ensemble's own tools are judged where they run");
  assert.deepEqual(asked, [], "nothing above needed the owner");
});

test("git that only reads is a read anywhere above the floor, -C included; git that changes a repository asks", async () => {
  const { judge, asked } = judgeWith({ answers: [{ decision: "deny", message: "Mira said no." }] });
  for (const command of [`git -C ${site} status --short --branch`, `git -C ${site} log --oneline -5`, `cd ${site} && git branch -a && git remote -v`, `git -C ${site} diff --stat`]) {
    assert.equal((await judge(bash(command))).decision, "allow", command);
  }
  assert.equal(asked.length, 0, "reads ask nobody");
  assert.equal((await judge(bash(`git -C ${site} commit -m wip`))).decision, "deny");
  assert.deepEqual([asked.length, asked[0]!.target], [1, site], "a commit in that repository asks about its folder");
});

test("git is a read only by the coding run's own allowlist: helpers, set variables, remotes, abbreviated writes and a repository config that runs programs ask", async () => {
  const documents = join(home, "Documents");
  const hostile = join(home, "projects", "hostile");
  mkdirSync(documents, { recursive: true });
  mkdirSync(join(hostile, ".git"), { recursive: true });
  writeFileSync(join(hostile, ".git", "config"), "[core]\n\tfsmonitor = ./run.sh\n");
  for (const command of [
    `cd ${documents} && git ls-remote --upload-pack='rm -f report.docx;' .`,
    `git -C ${site} ls-remote --upl='rm -f report.docx;' .`,
    `cd ${site} && GIT_EXTERNAL_DIFF='rm -f report.docx' git diff`,
    `cd ${site} && GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0='rm -f report.docx' git status`,
    `cd ${site} && GIT_SSH_COMMAND='rm -f report.docx' git ls-remote ssh://example.com/repo`,
    `git -C ${site} grep -O'rm -f report.docx' foo`,
    `git -C ${site} diff --ext-diff`,
    `git -C ${site} log -p --textconv`,
    `git -C ${site} config --unset-a core.pager`,
    `git -C ${site} branch --set-upstream-t=origin/main`,
    `git -C ${hostile} status`,
  ]) {
    const { judge, asked } = judgeWith();
    assert.equal((await judge(bash(command))).decision, "deny", command);
    assert.equal(asked.length, 1, `${command}: asked, not run`);
  }
  // A config write to --global writes ~/.gitconfig, a start-up file, even from the node's own folder.
  const { judge, asked } = judgeWith();
  const global = await judge([{ tool: "Bash", input: { command: "git config --global core.pager 'rm -f report.docx'", cwd: turnFolder } }]);
  assert.equal(global.decision, "deny");
  assert.match(global.message ?? "", /\.gitconfig runs at sign-in or start-up/);
  assert.equal(asked.length, 0, "refused, never asked");
  for (const command of [`git -C ${site} status --short`, `git -C ${site} log --onel -5`, `git -C ${site} diff --stat`, `cd ${site} && git branch -a`]) {
    const reading = judgeWith();
    assert.equal((await reading.judge(bash(command))).decision, "allow", command);
    assert.equal(reading.asked.length, 0, command);
  }
});

test("the node's own folders, temporary folders, a folder an answer for changes covers and an unattended run need nobody", async () => {
  const { judge, asked } = judgeWith({ saved: [rule(OWN_RULES.write, site)] });
  assert.equal((await judge(write(join(turnFolder, "report.md")))).decision, "allow", "the turn's folder: the node's project folder");
  assert.equal((await judge(bash("npm install express"))).decision, "allow", "a command runs in the turn's folder");
  assert.equal((await judge(bash(`cd ${join(workspace, "nodes", "ada")} && touch notes.md`))).decision, "allow", "the node's own folder of its computer tools");
  assert.equal((await judge(write("/tmp/ensemble-own-tools/scratch.txt"))).decision, "allow");
  assert.equal((await judge(write(join(site, "src", "app.ts")))).decision, "allow", "an answer for the repository covers its folders");
  assert.deepEqual(asked, []);
  const unattended = judgeWith({ attended: false });
  assert.equal((await unattended.judge(write(join(notes, "today.md")))).decision, "allow", "nobody watches a routine's run: a change goes ahead above the floor");
  assert.deepEqual(unattended.asked, []);
});

test("anything else asks its owner once per folder, with what would run; an answer is kept, and no answer yet parks the turn", async () => {
  const { judge, asked, store } = judgeWith({
    answers: [
      { decision: "allow", grant: { id: "decision-1", scope: "mission", target: site } },
      { decision: "deny", waiting: true, message: "Waiting for Mira to answer the card about change today.md in ~/notes. Stop here: end your turn now without a reply. You go on when they answer." },
    ],
  });
  assert.equal((await judge(write(join(site, "src", "app.ts")))).decision, "allow");
  assert.deepEqual(asked[0], { capability: "files", target: site, label: "~/projects/site", scope: "folder", operation: "Change: ~/projects/site/src/app.ts", what: "change src/app.ts" });
  assert.deepEqual(store.rows.map((row) => [row.toolName, row.pattern, row.sessionId]), [[OWN_RULES.write, site, MISSION]], "kept here for this run, as an answer for changes and commands");
  assert.equal((await judge(bash(`cd ${site} && npm run build`))).decision, "allow", "the same folder is not asked again in this run");
  assert.equal(asked.length, 1);

  const parked = await judge(write(join(notes, "today.md")));
  assert.equal(parked.decision, "deny");
  assert.match(parked.message!, /Stop here: end your turn now without a reply/);
  assert.deepEqual([asked.length, asked[1]!.target, asked[1]!.label, asked[1]!.what], [2, notes, "~/notes", "change today.md"]);
  assert.equal((await judge([{ tool: "Read", input: { file_path: join(site, "README.md") } }])).message, parked.message, "a parked turn stops: every later call hears it");
  assert.equal(asked.length, 2, "and nothing more is asked");
});

test("an answer given to the node's computer tools, which run in the OS sandbox, never counts for the agent's own calls", async () => {
  const { judge, asked } = judgeWith({ saved: [rule("folder", site), rule("folder", notes, MISSION)] });
  assert.equal((await judge(write(join(site, "src", "app.ts")))).decision, "deny");
  assert.deepEqual([asked[0]!.capability, asked[0]!.target], ["files", site], "the computer tools' answer for the folder from then on");
  assert.equal((await judge(bash(`cd ${notes} && touch today.md`))).decision, "deny");
  assert.deepEqual([asked[1]!.capability, asked[1]!.target], ["run", notes], "nor theirs for this run");
});

test("a read or a change that names no path asks, as exactly as the agent gave it", async () => {
  const { judge, asked } = judgeWith({ answers: [{ decision: "allow", grant: { id: "decision-2", scope: "once", target: "unused" } }] });
  assert.equal((await judge([{ tool: "Write", input: {} }])).decision, "allow");
  assert.deepEqual([asked[0]!.capability, asked[0]!.scope, asked[0]!.label], ["files", "folder", "files it does not name"]);
  assert.match(asked[0]!.target, /^unnamed:/);
  assert.equal((await judge([{ tool: "Read", input: {} }])).decision, "deny");
  assert.equal(asked[1]!.capability, "read");
  const edit = acpCalls({ kind: "edit", title: "Apply the change", rawInput: { description: "rewrite the config" } } as Parameters<typeof acpCalls>[0]);
  assert.equal((await judge(edit)).decision, "deny");
  assert.deepEqual([asked.length, asked[2]!.capability], [3, "files"], "an ACP agent's edit with no path it can be located by");
  assert.match(asked[2]!.operation, /rewrite the config/);
  assert.equal((await judge([{ tool: "Grep", input: { pattern: "TODO" } }])).decision, "allow", "a search with no folder looks in the turn's folder");
  assert.equal(asked.length, 3);
});

test("a program that changes the system always asks, unattended too, and an answer lasts at most for the run", async () => {
  const unattended = judgeWith({ attended: false });
  assert.equal((await unattended.judge(bash("crontab -l"))).decision, "deny", "not answered: not run");
  assert.deepEqual([unattended.asked[0]!.target, unattended.asked[0]!.label, unattended.asked[0]!.capability], ["program:crontab", "crontab", "run"], "asked, never allowed by the run being unattended");

  const store = rules();
  const run = judgeWith({ store, answers: [{ decision: "allow", grant: { id: "decision-3", scope: "always", target: "program:launchctl" } }] });
  assert.equal((await run.judge(bash("launchctl list"))).decision, "allow");
  assert.equal((await run.judge(bash("launchctl print system"))).decision, "allow", "the answer covers this run");
  assert.equal(run.asked.length, 1);
  assert.deepEqual(store.rows.map((row) => [row.toolName, row.sessionId]), [[OWN_RULES.program, MISSION]], "kept for this run only, whatever the answer said");
  const next = judgeWith({ store, mission: "conversation:room-1:private" });
  assert.equal((await next.judge(bash("launchctl list"))).decision, "deny");
  assert.equal(next.asked.length, 1, "another run asks again");
});

test("calls in flight together share one question and its answer", async () => {
  const { judge, asked } = judgeWith({ slowAsk: true, answers: [{ decision: "allow", grant: { id: "decision-4", scope: "mission", target: site } }] });
  const [one, two] = await Promise.all([judge(write(join(site, "a.md"))), judge(write(join(site, "src", "b.md")))]);
  assert.deepEqual([one.decision, two.decision, asked.length], ["allow", "allow", 1]);
});

test("how each call was answered reaches the call the agent reported, whichever came first, with its time and sizes", async () => {
  const { OwnToolLog, OwnVerdicts } = await import("./own-tools.js");
  const verdicts = new OwnVerdicts();
  const events: Array<Record<string, unknown>> = [];
  const log = new OwnToolLog("claude-code", (event) => events.push(event), verdicts);
  const { judge, asked } = judgeWith({ answers: [{ decision: "allow", grant: { id: "decision-9", scope: "once", target: site } }], onVerdict: verdicts.note });
  // Claude Code reports a call before its hook is judged; Codex is judged first.
  const readme = { file_path: join(site, "README.md") };
  log.start("read-1", "Read", readme);
  assert.equal((await judge([{ tool: "Read", input: readme }])).decision, "allow");
  log.end("read-1", "# Site", true);
  assert.equal((await judge(write(join(site, "a.md")))).decision, "allow");
  log.start("write-1", "Write", { file_path: join(site, "a.md"), content: "hello" });
  log.end("write-1", "Saved.", true);
  const key = { file_path: join(home, ".ssh", "id_ed25519") };
  log.start("key-1", "Read", key);
  assert.equal((await judge([{ tool: "Read", input: key }])).decision, "deny");
  log.end("key-1", "Refused.", false);
  log.start("ls-1", "Bash", { command: "ls" });
  log.end("ls-1", "README.md", true);
  assert.equal(asked.length, 1);
  const ends = events.filter((event) => event.phase === "end");
  assert.deepEqual(
    ends.map((event) => [event.id, event.name, event.ok, event.verdict]),
    [["read-1", "Read", true, "allowed"], ["write-1", "Edit", true, "asked"], ["key-1", "Read", false, "refused"], ["ls-1", "Shell", true, "allowed"]],
  );
  assert.deepEqual([ends[0]!.inChars, ends[0]!.outChars], [JSON.stringify(readme).length, "# Site".length]);
  assert.ok(ends.every((event) => typeof event.ms === "number"), "how long each ran");
});

test("a helper works only in the folders it was given, and their first use asks", async () => {
  const { judge, asked } = judgeWith({ folders: [site], answers: [{ decision: "allow", grant: { id: "decision-5", scope: "mission", target: site } }] });
  assert.equal((await judge(write(join(site, "src", "app.ts")))).decision, "allow");
  assert.deepEqual([asked.length, asked[0]!.target], [1, site], "a folder it was given is not its own: its first use asks");
  assert.equal((await judge([{ tool: "Read", input: { file_path: join(site, "README.md") } }])).decision, "allow");
  assert.equal((await judge(bash("ls"))).decision, "allow", "its own scratch folder");
  assert.equal((await judge(write("/tmp/ensemble-own-tools/helper.txt"))).decision, "allow");
  const outside = await judge(write(join(notes, "today.md")));
  assert.equal(outside.decision, "deny");
  assert.match(outside.message!, /only .*projects\/site/);
  assert.equal((await judge([{ tool: "Read", input: { file_path: join(notes, "today.md") } }])).decision, "deny", "nor reads elsewhere");
  assert.equal((await judge(bash(`cat ${join(notes, "today.md")}`))).decision, "deny");
  assert.equal(asked.length, 1, "nothing outside them is asked about");
});

test("sudo is sent to computer_sudo's card", async () => {
  const { judge, asked } = judgeWith();
  const sudo = await judge(bash("sudo apt install jq"));
  assert.deepEqual([sudo.decision, sudo.message], ["deny", sudoGuidance(true)]);
  assert.match(sudo.message!, /computer_sudo/);
  assert.match((await judgeWith({ sudo: false }).judge(bash("doas pkg_add jq"))).message!, /not run from this turn/);
  assert.equal((await judge(bash("sudo -i"))).decision, "deny", "a root shell stays the hard floor");
  assert.equal(asked.length, 0);
});

test("the person's own MCP tools meet the same floor and folders where their input names a command or files; any other tool asks once a run, unattended too", async () => {
  const servers = [
    { name: "io.github.wonderwhy-er/desktop-commander", source: "user", readOnly: false },
    { name: "github-mcp-server", source: "builtin", readOnly: true },
  ];
  // GitHub Copilot CLI names a server's tool after the server, every character but letters, digits, _ and - as -.
  const commander = (tool: string, input: Record<string, unknown>) => [{ tool: `io-github-wonderwhy-er-desktop-commander-${tool}`, input }];
  const { judge, asked, store } = judgeWith({
    servers,
    answers: [
      { decision: "deny", message: "Not this one." },
      { decision: "deny", message: "Nor this one." },
      { decision: "allow", grant: { id: "decision-6", scope: "mission", target: "tool:io.github.wonderwhy-er/desktop-commander/set_config_value" } },
    ],
  });
  assert.match((await judge(commander("read_file", { path: "~/.ssh/id_rsa" }))).message!, /keys|sign-ins/, "the floor, through a server's tools as through the agent's own");
  assert.match((await judge(commander("start_process", { command: "cat ~/.ssh/id_rsa", timeout_ms: 5000 }))).message!, /keys|sign-ins/);
  assert.equal((await judge(commander("start_search", { path: home, pattern: "password" }))).decision, "deny", "a search through a folder that holds keys");
  assert.equal((await judge([{ tool: "mcp__files__read_text_file", input: { path: join(home, ".ssh", "id_rsa") } }])).decision, "deny", "Claude Code's and ACP agents' names for a server's tool");
  assert.equal((await judge(commander("read_file", { path: join(site, "README.md") }))).decision, "allow");
  assert.equal((await judge(commander("list_directory", { path: notes }))).decision, "allow");
  assert.equal((await judge(commander("start_process", { command: `cd ${turnFolder} && npm install` }))).decision, "allow", "a command in the node's own folder");
  assert.equal((await judge([{ tool: "github-mcp-server-get_file_contents", input: { owner: "octo", repo: "site", path: "README.md" } }])).decision, "allow", "a server that says it only reads");
  assert.equal(asked.length, 0);

  assert.equal((await judge(commander("write_file", { path: join(notes, "today.md"), content: "# Today" }))).decision, "deny");
  assert.deepEqual([asked[0]!.capability, asked[0]!.target], ["files", notes], "a change asks for its folder");
  assert.equal((await judge(commander("start_process", { command: "npm install" }))).decision, "deny");
  assert.deepEqual([asked[1]!.capability, asked[1]!.target], ["run", "command:npm install"], "a command that does not say where it runs asks for itself");
  assert.equal((await judge(commander("set_config_value", { key: "allowedDirectories", value: ["/"] }))).decision, "allow");
  assert.deepEqual(asked[2], {
    capability: "run",
    target: "tool:io.github.wonderwhy-er/desktop-commander/set_config_value",
    label: "set_config_value from io.github.wonderwhy-er/desktop-commander",
    scope: "folder",
    operation: 'Use: set_config_value from io.github.wonderwhy-er/desktop-commander\nWith: {"key":"allowedDirectories","value":["/"]}',
    what: "use set_config_value from io.github.wonderwhy-er/desktop-commander",
  }, "anything else: the tool and its input");
  assert.equal((await judge(commander("set_config_value", { key: "fileReadLineLimit", value: 2000 }))).decision, "allow", "not asked again in this run");
  assert.deepEqual(store.rows.map((row) => [row.toolName, row.pattern, row.sessionId]), [[OWN_RULES.tool, "tool:io.github.wonderwhy-er/desktop-commander/set_config_value", MISSION]]);
  assert.equal((await judge(commander("read_file", { path: "notes/today.md" }))).decision, "deny");
  assert.equal(asked[3]!.target, "tool:io.github.wonderwhy-er/desktop-commander/read_file", "a path not given in full is found where the server runs, which is not known here");
  assert.equal((await judge([{ tool: "BrandNewTool", input: { level: 1 } }])).decision, "deny");
  assert.equal(asked[4]!.target, "tool:BrandNewTool", "a tool of the agent's own that Ensemble does not know");
  for (const tool of ["TodoWrite", "report_intent", "update_todo", "read_bash"]) assert.equal((await judge([{ tool, input: {} }])).decision, "allow", `${tool}: the agent's own bookkeeping`);
  assert.match((await judge([{ tool: "write_bash", input: { sessionId: "s1", input: "cat ~/.ssh/id_rsa\n" } }])).message!, /keys|sign-ins/, "typed into its shell: a command");
  assert.equal(asked.length, 5);

  const unattended = judgeWith({ attended: false, servers });
  assert.equal((await unattended.judge(commander("kill_process", { pid: 4242 }))).decision, "deny");
  assert.deepEqual([unattended.asked.length, unattended.asked[0]!.target], [1, "tool:io.github.wonderwhy-er/desktop-commander/kill_process"], "asked, never allowed by the run being unattended");
});

test("a cd holds for the shell's next command: the folder it went to is judged too", async () => {
  const { judge, asked } = judgeWith();
  assert.equal((await judge(bash(`cd ${notes}`))).decision, "allow", "going there changes nothing");
  assert.equal((await judge(bash("touch today.md"))).decision, "deny", "the shell may be in ~/notes now");
  assert.deepEqual([asked.length, asked[0]!.target], [1, notes]);
  assert.equal((await judge(bash("cd ~"))).decision, "allow");
  assert.match((await judge(bash("cat .ssh/id_rsa"))).message!, /keys|sign-ins/, "the floor, where the shell may be");
  assert.equal((await judge([{ tool: "Bash", input: { command: "touch report.md", cwd: turnFolder } }])).decision, "allow", "a command that says where it runs is judged there");
  assert.equal(asked.length, 1);
});
