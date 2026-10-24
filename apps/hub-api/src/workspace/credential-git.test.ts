import assert from "node:assert/strict";
import test from "node:test";

// tools.ts pulls in the API config. A unit run has no .env; the value is never connected to.
process.env.DATABASE_URL ??= "******127.0.0.1:1/ensemble_unit";
const { credentialGitRefusal } = await import("./tools.js");
const git = (line: string) => ["git", ...line.split(" ")];

test("network git with the person's sign-in takes any remote, branch and option", () => {
  for (const line of ["fetch", "fetch --prune --tags origin", "fetch origin main:refs/remotes/origin/main", "pull", "pull --rebase origin main", "pull --no-ff upstream testing", "ls-remote origin"]) {
    assert.equal(credentialGitRefusal(git(line), true), null, line);
  }
  assert.equal(credentialGitRefusal(git("fetch ../other"), false), null, "with the sandbox off, another folder is the person's call");
});

test("options that start a program, options before the subcommand, clone, and another folder from a sandboxed run are refused", () => {
  assert.match(credentialGitRefusal(git("fetch --upload-pack=evil origin")) ?? "", /starts a program/);
  assert.match(credentialGitRefusal(["git", "-c", "core.sshCommand=evil", "fetch"]) ?? "", /no options before fetch/);
  assert.match(credentialGitRefusal(git("clone https://github.com/a/b ../../x")) ?? "", /clones the repository when the run starts/);
  assert.match(credentialGitRefusal(git("fetch ../../elsewhere"), true) ?? "", /folder on this computer/);
  assert.match(credentialGitRefusal(git("fetch /etc"), true) ?? "", /folder on this computer/);
});
