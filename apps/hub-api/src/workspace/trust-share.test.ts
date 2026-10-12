import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.DATABASE_URL ??= "postgresql://x";
const workspace = mkdtempSync(join(tmpdir(), "trust-share-ws-"));
process.env.ENSEMBLE_WORKSPACE_ROOT = workspace;
const { claudeTrust, codexTrust, copilotTrust, cursorSlug, geminiTrust, setToolTrust, syncSharedTrust, setSharedTrust, loadSharedTrust } = await import("./trust-share.js");

test("Claude Code: trusted per folder, and untrusting keeps the folder's own history", () => {
  const before = JSON.stringify({ numStartups: 3, projects: { "/w/a": { allowedTools: ["Bash(ls)"] } } });
  const on = claudeTrust(before, "/w/a", true);
  const data = JSON.parse(on.text!);
  assert.equal(data.projects["/w/a"].hasTrustDialogAccepted, true);
  assert.deepEqual(data.projects["/w/a"].allowedTools, ["Bash(ls)"]);
  assert.equal(data.numStartups, 3);
  assert.equal(claudeTrust(on.text!, "/w/a", true).already, true);
  const off = JSON.parse(claudeTrust(on.text!, "/w/a", false).text!);
  assert.equal(off.projects["/w/a"].hasTrustDialogAccepted, false);
  assert.deepEqual(off.projects["/w/a"].allowedTools, ["Bash(ls)"]);
  assert.equal(JSON.parse(claudeTrust("{}", "C:\\Users\\a\\x", true).text!).projects["C:/Users/a/x"].hasTrustDialogAccepted, true);
});

test("Codex: a projects table is added and removed whole, and the person's own tables are left alone", () => {
  const before = 'model = "gpt-5"\n\n[projects."/w/own"]\ntrust_level = "trusted"\n';
  const on = codexTrust(before, "/w/a", true);
  assert.equal(on.text, `model = "gpt-5"\n\n[projects."/w/own"]\ntrust_level = "trusted"\n\n[projects.'/w/a']\ntrust_level = "trusted"\n`);
  assert.equal(codexTrust(on.text!, "/w/a", true).already, true);
  assert.equal(codexTrust(before, "/w/own", true).already, true);
  assert.equal(codexTrust(on.text!, "/w/a", false).text, before);
  // A table the person had (here marked untrusted) keeps its other keys and gets its old value back.
  const own = '[projects."/w/b"]\ntrust_level = "untrusted"\nnote = 1\n';
  const marked = codexTrust(own, "/w/b", true);
  assert.equal(marked.was, "untrusted");
  assert.equal(marked.text, '[projects."/w/b"]\ntrust_level = "trusted"\nnote = 1\n');
  assert.equal(codexTrust(marked.text!, "/w/b", false, "untrusted").text, own);
  // Windows paths, in either quoting Codex accepts.
  assert.equal(codexTrust('[projects."C:\\\\code\\\\x"]\ntrust_level = "trusted"\n', "C:\\code\\x", true).already, true);
  assert.match(codexTrust("", "C:\\code\\x", true).text!, /\[projects\.'C:\\code\\x'\]/);
});

test("Copilot CLI: the trustedFolders list, with its comment lines kept", () => {
  const before = '// User settings belong in settings.json.\n// This file is managed automatically.\n{\n  "trustedFolders": ["/w/own"],\n  "theme": "dark"\n}\n';
  const on = copilotTrust(before, "/w/a", true);
  assert.ok(on.text!.startsWith("// User settings belong in settings.json.\n// This file is managed automatically.\n{"));
  const data = JSON.parse(on.text!.split("\n").slice(2).join("\n"));
  assert.deepEqual(data.trustedFolders, ["/w/own", "/w/a"]);
  assert.equal(data.theme, "dark");
  assert.equal(copilotTrust(before, "/w/own", true).already, true);
  assert.deepEqual(JSON.parse(copilotTrust(on.text!, "/w/a", false).text!.split("\n").slice(2).join("\n")).trustedFolders, ["/w/own"]);
});

test("Gemini CLI and Cursor", () => {
  const on = geminiTrust("", "/w/a", true);
  assert.deepEqual(JSON.parse(on.text!), { "/w/a": "TRUST_FOLDER" });
  assert.deepEqual(JSON.parse(geminiTrust(on.text!, "/w/a", false).text!), {});
  assert.equal(geminiTrust('{"/w/a":"DO_NOT_TRUST"}', "/w/a", true).was, "DO_NOT_TRUST");
  assert.equal(cursorSlug("/Users/me/Desktop/codes"), "Users-me-Desktop-codes");
  assert.equal(cursorSlug("/var/folders/1g/x_y/T/a.b"), "var-folders-1g-x-y-T-a-b");
});

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "trust-share-"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: {} }));
  mkdirSync(join(home, ".codex"));
  mkdirSync(join(home, ".cursor", "projects"), { recursive: true });
  // Copilot and Gemini are not installed here.
  return { home, env: {} as NodeJS.ProcessEnv };
}

test("a tool that is not installed is left alone, and a file Ensemble cannot read is not rewritten", async () => {
  const homes = fakeHome();
  const backups = join(homes.home, "backups");
  assert.deepEqual(await setToolTrust("copilot", "/w/a", true, { homes, backups }), { changed: false, already: false });
  assert.equal(existsSync(join(homes.home, ".copilot")), false);
  writeFileSync(join(homes.home, ".claude.json"), "{ not json");
  assert.deepEqual(await setToolTrust("claude", "/w/a", true, { homes, backups }), { changed: false, already: false });
  assert.equal(readFileSync(join(homes.home, ".claude.json"), "utf8"), "{ not json");
});

test("sync marks every trusted folder, removes only Ensemble's own marks, and the switch turns it all off", async () => {
  const homes = fakeHome();
  const state = join(homes.home, "state.json");
  const backups = join(homes.home, "backups");
  // The person already trusted /w/own in Claude Code themselves.
  writeFileSync(join(homes.home, ".claude.json"), JSON.stringify({ projects: { "/w/own": { hasTrustDialogAccepted: true } } }));
  let folders = ["/w/a", "/w/own"];
  const prisma = { decisionRule: { findMany: async () => folders.map((pattern) => ({ pattern })) } } as never;
  const options = { homes, state, backups, force: true };
  await syncSharedTrust(prisma, options);
  const claude = () => JSON.parse(readFileSync(join(homes.home, ".claude.json"), "utf8")).projects;
  const codex = () => readFileSync(join(homes.home, ".codex", "config.toml"), "utf8");
  assert.equal(claude()["/w/a"].hasTrustDialogAccepted, true);
  assert.match(codex(), /\[projects\.'\/w\/a'\]\ntrust_level = "trusted"/);
  assert.ok(existsSync(join(homes.home, ".cursor", "projects", "w-a", ".workspace-trusted")));
  assert.ok(existsSync(join(backups, "claude.first")));
  const marks = (await loadSharedTrust(state)).marks;
  assert.ok(!marks.some((mark) => mark.folder === "/w/own" && mark.tool === "claude"), "the person's own trust is not Ensemble's mark");

  // Untrusted in Ensemble: Ensemble's marks go, the person's own trust stays.
  folders = ["/w/own"];
  await syncSharedTrust(prisma, options);
  assert.equal(claude()["/w/a"].hasTrustDialogAccepted, false);
  assert.doesNotMatch(codex(), /\/w\/a/);
  assert.equal(existsSync(join(homes.home, ".cursor", "projects", "w-a", ".workspace-trusted")), false);
  assert.equal(claude()["/w/own"].hasTrustDialogAccepted, true);

  // Off: every mark Ensemble added is removed; on again puts them back.
  await setSharedTrust(prisma, false, options);
  assert.equal((await loadSharedTrust(state)).marks.length, 0);
  assert.doesNotMatch(codex(), /\/w\/own/);
  assert.equal(claude()["/w/own"].hasTrustDialogAccepted, true);
  await setSharedTrust(prisma, true, options);
  assert.match(codex(), /\/w\/own/);
});

test("Claude Code's config is changed under its own lock, and a stale lock is cleared", async () => {
  const homes = fakeHome();
  const backups = join(homes.home, "backups");
  const lock = join(homes.home, ".claude.json.lock");
  mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.equal((await setToolTrust("claude", "/w/a", true, { homes, backups })).changed, true);
  assert.equal(existsSync(lock), false, "the lock is released");
  assert.equal(JSON.parse(readFileSync(join(homes.home, ".claude.json"), "utf8")).projects["/w/a"].hasTrustDialogAccepted, true);
});
