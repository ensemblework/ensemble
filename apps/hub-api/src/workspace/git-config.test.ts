/**
 * A repository's own git settings and hooks, read without running git (workspace/git-config.ts), for both judges' git
 * reads: what names a program makes a read of that repository not a read; the repository is the one git finds; a bare
 * repository, `commondir`, `config.worktree` and populated submodules count; files that are not plain small files do not pass.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble_desktop";
const { gitDirSafe, indexGitlinks, parseGitConfig, startsProgram } = await import("./git-config.js");
const { gitReadSafeAt } = await import("./tools.js");

const base = mkdtempSync(join(tmpdir(), "ensemble-git-config-"));
after(() => rmSync(base, { recursive: true, force: true }));

/** git itself, with none of this computer's settings. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_CONFIG_NOSYSTEM: "1", HOME: base },
  }).toString();

/** A git folder git itself takes as one: a valid HEAD, objects and refs. */
function gitFolder(folder: string): string {
  mkdirSync(join(folder, "objects"), { recursive: true });
  mkdirSync(join(folder, "refs"), { recursive: true });
  writeFileSync(join(folder, "HEAD"), "ref: refs/heads/main\n");
  return folder;
}

/** A repository with this `.git/config` (and other files under `.git`). */
function repo(name: string, config: string, files: Record<string, string> = {}): string {
  const folder = join(base, name);
  mkdirSync(join(folder, ".git", "hooks"), { recursive: true });
  gitFolder(join(folder, ".git"));
  writeFileSync(join(folder, ".git", "config"), config);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(folder, ".git", path, ".."), { recursive: true });
    writeFileSync(join(folder, ".git", path), text);
  }
  return folder;
}

test("a git config is read as git reads it: sections, quoted subsections, quotes, escapes, comments and joined lines", () => {
  const settings = parseGitConfig(
    [
      "[core]",
      "\trepositoryformatversion = 0",
      "\tbare = false ; a comment",
      '[remote "origin"]',
      '\turl = "https://example.com/a#b" # the # inside quotes stays',
      '[filter "lfs"] clean = git-lfs clean -- %f',
      "[Diff \"Tool\"]",
      "\tcommand = run \\",
      "  me",
      "[branch.main]",
      "\tremote",
    ].join("\n"),
  );
  assert.deepEqual(settings, [
    { name: "core.repositoryformatversion", value: "0", literal: true },
    { name: "core.bare", value: "false", literal: true },
    { name: "remote.origin.url", value: "https://example.com/a#b", literal: false },
    { name: "filter.lfs.clean", value: "git-lfs clean -- %f", literal: true },
    { name: "diff.Tool.command", value: "run   me", literal: false },
    { name: "branch.main.remote", value: "true", literal: true },
  ]);
  // git keeps `\b` as a backspace byte and a lone carriage return as a space: neither is undone here.
  assert.deepEqual(parseGitConfig("[core]\n\tfsmonitor = ./x\\b\\b\\b\n\tpager = fa\rlse\r\n"), [
    { name: "core.fsmonitor", value: "./x\b\b\b", literal: false },
    { name: "core.pager", value: "fa\rlse", literal: false },
  ]);
  assert.equal(parseGitConfig("pager = less"), null, "a setting before any section is not git's");
  assert.equal(parseGitConfig('[core]\n\tpager = "less'), null, "an unclosed quote is not git's");
});

test("settings that name a program, aliases and includes make a repository unsafe to read; plain ones do not", async () => {
  const unsafe = [
    '[filter "lfs"]\n\tsmudge = x\n',
    '[filter "lfs"]\n\tprocess = x\n',
    '[diff "x"]\n\tcommand = x\n',
    '[diff "x"]\n\ttextconv = x\n',
    "[diff]\n\texternal = x\n",
    "[gpg]\n\tprogram = x\n",
    '[gpg "ssh"]\n\tprogram = x\n',
    "[core]\n\talternateRefsCommand = x\n",
    "[core]\n\tfsmonitor = ./watch.sh\n",
    "[core]\n\tpager = x\n",
    "[core]\n\tsshCommand = x\n",
    "[core]\n\thooksPath = /tmp/hooks\n",
    "[core]\n\teditor = x\n",
    "[credential]\n\thelper = x\n",
    '[credential "https://x"]\n\thelper = x\n',
    "[sequence]\n\teditor = x\n",
    "[pager]\n\tlog = x\n",
    "[alias]\n\tst = !x\n",
    "[include]\n\tpath = other.cfg\n",
    '[includeIf "gitdir:~/x/"]\n\tpath = other.cfg\n',
    '[merge "x"]\n\tdriver = x\n',
    "[core\n",
    // A value git keeps as bytes (`\b` is a backspace, not a deletion) can name a hook: only a plain false is off.
    "[core]\n\tfsmonitor = ./watch.sh\\b\\b\\b\\b\\b\\b\\b\\b\\b\\b\\b\n",
    '[core]\n\tfsmonitor = "false"\n',
    "[core]\n\tfsmonitor =\n",
    // Submodule diffs and summaries run git in each submodule; a signature check runs gpg; a partial clone fetches.
    "[diff]\n\tsubmodule = diff\n",
    "[status]\n\tsubmoduleSummary = true\n",
    "[log]\n\tshowSignature = true\n",
    "[extensions]\n\tpartialClone = origin\n",
    '[remote "origin"]\n\tpromisor = true\n',
    // blame prints the first line of the file it names: `fatal: invalid object name: API_KEY=…`.
    "[blame]\n\tignoreRevsFile = ../../.env\n",
    '[hook "audit"]\n\tcommand = ./x\n',
    "[core]\n\tworktree = ../elsewhere\n",
  ];
  for (const [index, config] of unsafe.entries()) assert.equal(await gitDirSafe(join(repo(`unsafe-${index}`, config), ".git")), false, config);
  const plain = repo("plain", "[core]\n\tbare = false\n\tfsmonitor = false\n[remote \"origin\"]\n\turl = https://example.com/r.git\n[branch \"main\"]\n\tremote = origin\n[diff]\n\tsubmodule = log\n", { "hooks/pre-commit.sample": "#!/bin/sh\n" });
  assert.equal(await gitDirSafe(join(plain, ".git")), true);
  for (const value of ["false", "0", "off", "No"]) assert.equal(startsProgram({ name: "core.fsmonitor", value, literal: true }), false, value);
  assert.equal(startsProgram({ name: "core.fsmonitor", value: "true", literal: true }), true, "the built-in daemon is a program too");
});

test("config.worktree counts whenever it is there, and any hook but the samples makes a read unsafe", async () => {
  const worktree = repo("worktree", "[extensions]\n\tworktreeConfig = true\n", { "config.worktree": "[core]\n\tpager = ./run.sh\n" });
  assert.equal(await gitDirSafe(join(worktree, ".git")), false);
  // git takes `worktreeConfig = 2` or `1k` as on too: the file is read whether or not the setting says so.
  const unannounced = repo("worktree-unannounced", "[core]\n\tbare = false\n", { "config.worktree": "[core]\n\tpager = ./run.sh\n" });
  assert.equal(await gitReadSafeAt(["git", "status"], unannounced), false);
  const hooked = repo("hooked", "[core]\n\tbare = false\n", { "hooks/post-index-change": "#!/bin/sh\ntouch planted\n" });
  chmodSync(join(hooked, ".git", "hooks", "post-index-change"), 0o755);
  assert.equal(await gitDirSafe(join(hooked, ".git")), false, "git status runs post-index-change when it refreshes the index");
  assert.equal(await gitReadSafeAt(["git", "status"], join(hooked)), false);
  assert.equal(await gitReadSafeAt(["git", "-C", hooked, "status"], base), false);
});

test("a bare repository's own settings are read too, found from inside it or named with --git-dir", async () => {
  const bare = join(base, "bare.git");
  mkdirSync(join(bare, "objects"), { recursive: true });
  mkdirSync(join(bare, "refs"), { recursive: true });
  writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(bare, "config"), "[core]\n\tbare = true\n\tfsmonitor = ./watch.sh\n");
  assert.equal(await gitReadSafeAt(["git", "log"], bare), false);
  assert.equal(await gitReadSafeAt(["git", "log"], join(bare, "refs")), false, "from a folder inside it");
  assert.equal(await gitReadSafeAt(["git", `--git-dir=${bare}`, "log"], base), false);
  writeFileSync(join(bare, "config"), "[core]\n\tbare = true\n");
  assert.equal(await gitReadSafeAt(["git", "log"], bare), true);
});

test("the repository is the one git finds: past a .git that is not a git folder, HEAD as a link into refs, commondir followed", async () => {
  // An empty .git inside a repository is passed, as git passes it: the outer repository's settings count.
  const outer = repo("outer", "[core]\n\tfsmonitor = ./watch.sh\n");
  mkdirSync(join(outer, "sub", ".git"), { recursive: true });
  assert.equal(await gitReadSafeAt(["git", "-C", join(outer, "sub"), "status"], base), false);
  assert.equal(await gitReadSafeAt(["git", "status"], join(outer, "sub")), false);
  // HEAD may be a link into refs/; a link anywhere else is not a git folder, and git goes on to the outer repository.
  const linked = join(outer, "linked");
  gitFolder(join(linked, ".git"));
  rmSync(join(linked, ".git", "HEAD"));
  symlinkSync("refs/heads/main", join(linked, ".git", "HEAD"));
  assert.equal(await gitReadSafeAt(["git", "status"], linked), true);
  rmSync(join(linked, ".git", "HEAD"));
  symlinkSync("../HEAD", join(linked, ".git", "HEAD"));
  assert.equal(await gitReadSafeAt(["git", "status"], linked), false);
  // commondir names the folder whose settings and hooks git reads: a linked worktree's main repository, or a planted one.
  const main = repo("main", "[core]\n\tfsmonitor = ./watch.sh\n");
  const worktree = join(main, ".git", "worktrees", "x");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, "HEAD"), "ref: refs/heads/x\n");
  writeFileSync(join(worktree, "commondir"), "../..\n");
  assert.equal(await gitReadSafeAt(["git", `--git-dir=${worktree}`, "log"], base), false);
  const planted = repo("planted-common", "[core]\n\tbare = false\n");
  writeFileSync(join(planted, ".git", "commondir"), "../../main/.git\n");
  assert.equal(await gitReadSafeAt(["git", "status"], planted), false);
  const hooks = repo("hooks-common", "[core]\n\tbare = false\n", { "hooks/post-index-change": "#!/bin/sh\n" });
  chmodSync(join(hooks, ".git", "hooks", "post-index-change"), 0o755);
  const sharing = repo("sharing", "[core]\n\tbare = false\n");
  writeFileSync(join(sharing, ".git", "commondir"), `${join(hooks, ".git")}\n`);
  assert.equal(await gitReadSafeAt(["git", "diff"], sharing), false, "the common folder's hooks run");
});

test("a settings file that is not a plain small file is not read and not safe: a FIFO never blocks, a big one is not read", { timeout: 20_000, skip: process.platform === "win32" }, async () => {
  const fifo = repo("fifo", "");
  rmSync(join(fifo, ".git", "config"));
  execFileSync("mkfifo", [join(fifo, ".git", "config")]);
  assert.equal(await gitReadSafeAt(["git", "status"], fifo), false);
  const big = repo("big", `[core]\n\tbare = false\n${"# padding\n".repeat(120_000)}`);
  assert.equal(await gitReadSafeAt(["git", "status"], big), false);
  const device = repo("device", "");
  rmSync(join(device, ".git", "config"));
  symlinkSync("/dev/null", join(device, ".git", "config"));
  assert.equal(await gitReadSafeAt(["git", "status"], device), false);
});

test("a populated submodule makes a read unsafe: git status and diff run git status inside it, with that repository's settings", async () => {
  const outer = join(base, "super");
  mkdirSync(outer);
  git(outer, "init", "-q");
  writeFileSync(join(outer, "a.txt"), "a\n");
  git(outer, "add", "a.txt");
  git(outer, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/lib`);
  assert.equal(await gitReadSafeAt(["git", "status"], outer), true, "a submodule that is not checked out is not entered");
  mkdirSync(join(outer, "vendor", "lib", ".git"), { recursive: true });
  assert.equal(await gitReadSafeAt(["git", "status"], outer), false, "no .gitmodules needed: the index names it");
  git(outer, "update-index", "--index-version", "4");
  assert.deepEqual(indexGitlinks(readFileSync(join(outer, ".git", "index")), 20)?.map(String), ["vendor/lib"], "version 4 names too");
  assert.equal(await gitReadSafeAt(["git", "diff"], outer), false);
  git(outer, "update-index", "--index-version", "3");
  git(outer, "update-index", "--skip-worktree", "a.txt");
  assert.deepEqual(indexGitlinks(readFileSync(join(outer, ".git", "index")), 20)?.map(String), ["vendor/lib"], "version 3, extended flags");
  // An index git may load from offsets of its own, or one split into another file, is not followed: not safe.
  rmSync(join(outer, "vendor"), { recursive: true });
  git(outer, "-c", "index.recordEndOfIndexEntries=true", "-c", "index.recordOffsetTable=true", "update-index", "--index-version", "2");
  assert.equal(indexGitlinks(readFileSync(join(outer, ".git", "index")), 20), null);
  assert.equal(await gitReadSafeAt(["git", "status"], outer), false);
  git(outer, "-c", "index.recordEndOfIndexEntries=false", "-c", "index.recordOffsetTable=false", "update-index", "--split-index");
  assert.equal(await gitReadSafeAt(["git", "status"], outer), false);
  // .gitmodules names one too.
  const listed = repo("listed", "[core]\n\tbare = false\n");
  writeFileSync(join(listed, ".gitmodules"), '[submodule "lib"]\n\tpath = lib\n\turl = https://example.com/lib.git\n');
  assert.equal(await gitReadSafeAt(["git", "status"], listed), true);
  mkdirSync(join(listed, "lib"));
  writeFileSync(join(listed, "lib", ".git"), "gitdir: ../.git/modules/lib\n");
  assert.equal(await gitReadSafeAt(["git", "status"], listed), false);
});
