import assert from "node:assert/strict";
import test from "node:test";

// tools.ts pulls in the API config. A unit run has no .env; the value is never connected to.
process.env.DATABASE_URL ??= "postgresql://ensemble:unused@127.0.0.1:1/ensemble_unit";
const { credentialGitRefusal } = await import("./tools.js");

test("git with the person's sign-in fetches and fast-forwards by name only", () => {
  for (const args of [["fetch"], ["fetch", "origin"], ["fetch", "--quiet", "origin", "main"], ["fetch", "origin", "main:refs/remotes/origin/main"], ["pull", "--ff-only"], ["pull", "--ff-only", "origin", "main"]]) {
    assert.equal(credentialGitRefusal(args), null, args.join(" "));
  }
});

test("options that run a program, paths that leave the folder, clone and plain pull are refused", () => {
  assert.match(credentialGitRefusal(["fetch", "--upload-pack=touch /tmp/x", "."]) ?? "", /not allowed/);
  assert.match(credentialGitRefusal(["fetch", "../../elsewhere"]) ?? "", /not a remote or branch name/);
  assert.match(credentialGitRefusal(["fetch", "/etc"]) ?? "", /not a remote or branch name/);
  assert.match(credentialGitRefusal(["clone", "https://github.com/a/b", "../../x"]) ?? "", /clones the repository when the run starts/);
  assert.match(credentialGitRefusal(["pull", "origin", "main"]) ?? "", /--ff-only/);
  assert.match(credentialGitRefusal(["push"]) ?? "", /not run with your sign-in/);
});
