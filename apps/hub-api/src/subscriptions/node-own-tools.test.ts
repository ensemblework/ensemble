/**
 * The agent's own calls in an Ensemble Node's turn on its owner's plan, judged on the computer
 * (subscriptions/node-own-tools.ts): the hard floor refuses with why; reads, web searches and public
 * pages need nobody; commands and changes in the node's own folders, temporary folders, a folder an
 * answer covers, or an unattended run go ahead; anything else asks the owner once per folder, and a
 * call they have not answered yet parks the turn. A turn someone else started asks about every
 * command and change, and before reading the owner's files outside the node's own folders, once per
 * folder per run. sudo is sent to computer_sudo's card.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
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

const { nodeOwnJudge, sudoGuidance } = await import("./node-own-tools.js");
const { NODE_TOOL_RULE_SOURCE } = await import("../device-tools/policy.js");
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
function judgeWith(options: { trusted?: boolean; attended?: boolean; sudo?: boolean; answers?: Answer[]; saved?: Rule[] } = {}) {
  const asked: Ask[] = [];
  const answers = [...(options.answers ?? [])];
  const store = rules(options.saved);
  const judge = nodeOwnJudge({
    folder: turnFolder,
    node: { id: "node-1", slug: "ada", mission: MISSION, attended: options.attended ?? true, trusted: options.trusted ?? true, sudo: options.sudo ?? true },
    app: "claude-code",
    async ask(request) {
      asked.push(request);
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

test("the node's own folders, temporary folders, a folder an answer covers and an unattended run need nobody", async () => {
  const { judge, asked } = judgeWith({ saved: [{ userId: "owner", source: NODE_TOOL_RULE_SOURCE, toolName: "folder", pattern: site, decision: "allow", sessionId: null }] });
  assert.equal((await judge(write(join(turnFolder, "report.md")))).decision, "allow", "the turn's folder: the node's project folder");
  assert.equal((await judge(bash("npm install express"))).decision, "allow", "a command runs in the turn's folder");
  assert.equal((await judge(bash(`cd ${join(workspace, "nodes", "ada")} && touch notes.md`))).decision, "allow", "the node's own folder of its computer tools");
  assert.equal((await judge(write("/tmp/ensemble-own-tools/scratch.txt"))).decision, "allow");
  assert.equal((await judge(write(join(site, "src", "app.ts")))).decision, "allow", "an answer for the repository covers its folders");
  assert.deepEqual(asked, []);
  const unattended = judgeWith({ attended: false });
  assert.equal((await unattended.judge(write(join(notes, "today.md")))).decision, "allow", "nobody watches a routine's run: it goes ahead above the floor");
  assert.equal((await unattended.judge(bash("crontab -l"))).decision, "allow");
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
  assert.deepEqual(store.rows.map((row) => [row.pattern, row.sessionId]), [[site, MISSION]], "kept here for this run");
  assert.equal((await judge(bash(`cd ${site} && npm run build`))).decision, "allow", "the same folder is not asked again in this run");
  assert.equal(asked.length, 1);

  const parked = await judge(write(join(notes, "today.md")));
  assert.equal(parked.decision, "deny");
  assert.match(parked.message!, /Stop here: end your turn now without a reply/);
  assert.deepEqual([asked.length, asked[1]!.target, asked[1]!.label, asked[1]!.what], [2, notes, "~/notes", "change today.md"]);
  assert.equal((await judge([{ tool: "Read", input: { file_path: join(site, "README.md") } }])).message, parked.message, "a parked turn stops: every later call hears it");
  assert.equal(asked.length, 2, "and nothing more is asked");
});

test("a turn someone other than the owner started asks about every command and change, once per folder per run", async () => {
  const { judge, asked } = judgeWith({
    trusted: false,
    saved: [{ userId: "owner", source: NODE_TOOL_RULE_SOURCE, toolName: "folder", pattern: site, decision: "allow", sessionId: null }],
    answers: [
      { decision: "allow", grant: { id: "decision-2", scope: "always", target: turnFolder } },
      { decision: "deny", message: "Your owner chose not to allow this: change src/app.ts in ~/projects/site." },
    ],
  });
  assert.equal((await judge(bash("ls"))).decision, "allow");
  assert.deepEqual([asked[0]!.capability, asked[0]!.target], ["run", turnFolder], "even a command in the node's own folder asks");
  assert.equal((await judge(write(join(turnFolder, "notes.md")))).decision, "allow", "answered for this run: not asked again");
  assert.equal(asked.length, 1);
  const refused = await judge(write(join(site, "src", "app.ts")));
  assert.deepEqual([refused.decision, asked.length, asked[1]!.target], ["deny", 2, site], "an answer for the folder from then on does not count for another person's turn");
});

test("a turn someone other than the owner started asks before reading the owner's files; the node's folders, temporary folders and public pages stay open", async () => {
  const { judge, asked } = judgeWith({
    trusted: false,
    answers: [
      { decision: "allow", grant: { id: "decision-4", scope: "mission", target: site } },
      { decision: "deny", message: "Your owner chose not to allow this: read ~/notes." },
      { decision: "allow", grant: { id: "decision-5", scope: "mission", target: turnFolder } },
    ],
  });
  const read = (path: string) => judge([{ tool: "Read", input: { file_path: path } }]);
  assert.equal((await read(join(turnFolder, "brief.md"))).decision, "allow", "the node's own folder");
  assert.equal((await read(join(workspace, "nodes", "ada", "notes.md"))).decision, "allow", "its folder for its computer tools");
  assert.equal((await read("/tmp/ensemble-own-tools/scratch.txt")).decision, "allow", "a temporary folder");
  assert.equal((await judge([{ tool: "WebFetch", input: { url: "https://93.184.215.14/pricing" } }])).decision, "allow", "a public page");
  assert.equal((await judge([{ tool: "WebSearch", input: { query: "launch checklist" } }])).decision, "allow");
  assert.equal(asked.length, 0);

  assert.equal((await read(join(site, "src", "app.ts"))).decision, "allow");
  assert.deepEqual(asked[0], { capability: "read", target: site, label: "~/projects/site", scope: "folder", operation: "Read: ~/projects/site/src/app.ts", what: "read src/app.ts" });
  assert.equal((await judge([{ tool: "Grep", input: { pattern: "TODO", path: join(site, "src") } }])).decision, "allow", "answered for this run: the folder is not asked about again");
  assert.equal(asked.length, 1);
  const glob = await judge([{ tool: "Glob", input: { pattern: `${notes}/**/*.md` } }]);
  assert.deepEqual([glob.decision, asked.length, asked[1]!.capability, asked[1]!.target], ["deny", 2, "read", notes], "a glob asks about where it looks");

  // A command asks about the folder it runs in, and about the folders it reads: here, one already answered.
  assert.equal((await judge(bash(`cat ${join(site, "README.md")}`))).decision, "allow");
  assert.deepEqual([asked.length, asked[2]!.capability, asked[2]!.target], [3, "run", turnFolder]);
  assert.equal((await judge(bash(`head -5 ${join(notes, "today.md")}`))).decision, "deny", "it reads a folder nobody allowed");
  assert.equal(asked[3]!.target, notes);

  const owners = judgeWith();
  assert.equal((await owners.judge([{ tool: "Read", input: { file_path: join(notes, "today.md") } }])).decision, "allow", "the owner's own turn reads without asking");
  assert.equal((await owners.judge(bash(`cat ${join(notes, "today.md")}`))).decision, "allow");
  assert.deepEqual(owners.asked, []);
});

test("sudo is sent to computer_sudo's card; a program that changes the system asks on its own", async () => {
  const { judge, asked } = judgeWith({ answers: [{ decision: "allow", grant: { id: "decision-3", scope: "always", target: "program:crontab" } }] });
  const sudo = await judge(bash("sudo apt install jq"));
  assert.deepEqual([sudo.decision, sudo.message], ["deny", sudoGuidance(true)]);
  assert.match(sudo.message!, /computer_sudo/);
  assert.match((await judgeWith({ sudo: false }).judge(bash("doas pkg_add jq"))).message!, /not run from this turn/);
  assert.equal((await judge(bash("sudo -i"))).decision, "deny", "a root shell stays the hard floor");
  assert.equal(asked.length, 0);
  assert.equal((await judge(bash("crontab -e"))).decision, "allow");
  assert.deepEqual([asked[0]!.target, asked[0]!.label, asked[0]!.capability], ["program:crontab", "crontab", "run"], "asked about crontab itself, even in the node's own folder");
  assert.equal((await judge(bash("crontab -l"))).decision, "allow", "and allowed from then on");
  assert.equal(asked.length, 1);
});
