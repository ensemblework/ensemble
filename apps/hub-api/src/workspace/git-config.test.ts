/**
 * A repository's own git settings and hooks, read without running git (workspace/git-config.ts), for both judges' git
 * reads: what names a program makes a read of that repository not a read; a bare repository and `config.worktree` count.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble_desktop";
const { gitDirSafe, parseGitConfig, startsProgram } = await import("./git-config.js");
const { gitReadSafeAt } = await import("./tools.js");

const base = mkdtempSync(join(tmpdir(), "ensemble-git-config-"));
after(() => rmSync(base, { recursive: true, force: true }));

/** A repository with this `.git/config` (and other files under `.git`). */
function repo(name: string, config: string, files: Record<string, string> = {}): string {
  const folder = join(base, name);
  mkdirSync(join(folder, ".git", "hooks"), { recursive: true });
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
    { name: "core.repositoryformatversion", value: "0" },
    { name: "core.bare", value: "false" },
    { name: "remote.origin.url", value: "https://example.com/a#b" },
    { name: "filter.lfs.clean", value: "git-lfs clean -- %f" },
    { name: "diff.Tool.command", value: "run   me" },
    { name: "branch.main.remote", value: "true" },
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
  ];
  for (const [index, config] of unsafe.entries()) assert.equal(await gitDirSafe(join(repo(`unsafe-${index}`, config), ".git")), false, config);
  const plain = repo("plain", "[core]\n\tbare = false\n\tfsmonitor = false\n[remote \"origin\"]\n\turl = https://example.com/r.git\n[branch \"main\"]\n\tremote = origin\n", { "hooks/pre-commit.sample": "#!/bin/sh\n" });
  assert.equal(await gitDirSafe(join(plain, ".git")), true);
  assert.equal(startsProgram({ name: "core.fsmonitor", value: "true" }), true, "the built-in daemon is a program too");
});

test("config.worktree counts once extensions.worktreeConfig is on, and any hook but the samples makes a read unsafe", async () => {
  const worktree = repo("worktree", "[extensions]\n\tworktreeConfig = true\n", { "config.worktree": "[core]\n\tpager = ./run.sh\n" });
  assert.equal(await gitDirSafe(join(worktree, ".git")), false);
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
