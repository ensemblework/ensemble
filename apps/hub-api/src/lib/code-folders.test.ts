/**
 * "Folders Code can use": what may be added, what is skipped at use time, and
 * how a settings save treats the list. No database.
 *
 * HOME points at a scratch folder before the guard loads, so "the home folder"
 * and its dotfiles are real folders this test controls.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// macOS tmpdir() is under /private/var, which blockedReason refuses.
// /tmp resolves to /private/tmp, which it allows.
function scratchRoot(): string {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

const base = realpathSync(mkdtempSync(join(scratchRoot(), "ensemble-code-folders-")));
const home = join(base, "home");
const outside = join(base, "outside");
process.env.HOME = home;
mkdirSync(join(home, "projects", "app"), { recursive: true });
mkdirSync(join(home, "projects", ".secret"), { recursive: true });
mkdirSync(join(home, ".ssh"), { recursive: true });
mkdirSync(join(home, ".local", "src", "tool"), { recursive: true });
writeFileSync(join(home, ".zshrc"), "export X=1\n");
mkdirSync(join(outside, "repo"), { recursive: true });
symlinkSync(outside, join(home, "projects", "out-link"));
symlinkSync(join(home, "projects", "app"), join(home, "app-link"));
symlinkSync(join(home, ".ssh"), join(home, "projects", "keys-link"));
symlinkSync(join(home, ".local"), join(home, "projects", "local-link"));
symlinkSync("/etc", join(home, "projects", "etc-link"));
symlinkSync(join(home, "projects"), join(home, "projects-alias"));

const { checkCodeRootsPatch, dotUnderHome, resolveCodeFolder, usableCodeRoots } = await import("./code-folders.js");
const { GuardError, blockedReason, resolveWorkFolder } = await import("../workspace/guard.js");

test.after(() => rmSync(base, { recursive: true, force: true }));

async function refused(path: string, label: string): Promise<string> {
  try {
    await resolveCodeFolder(path);
  } catch (error) {
    assert.ok(error instanceof GuardError, `${label}: expected GuardError, got ${String(error)}`);
    assert.equal((error as InstanceType<typeof GuardError>).statusCode, 403, label);
    return (error as Error).message;
  }
  assert.fail(`${label}: ${path} was accepted`);
}

test("the scratch home is a place blockedReason allows, so every refusal below is Code's own rule or the shared one", () => {
  assert.equal(blockedReason(join(home, "projects", "app")), null);
});

test("a project folder under home is accepted and comes back as its real path", async () => {
  assert.equal(await resolveCodeFolder(join(home, "projects", "app")), join(home, "projects", "app"));
  assert.equal(await resolveCodeFolder("~/projects/app"), join(home, "projects", "app"));
  // A link inside home that stays inside home resolves to the real folder.
  assert.equal(await resolveCodeFolder("~/projects-alias/app"), join(home, "projects", "app"));
  // Outside home (and not a system folder) is fine too.
  assert.equal(await resolveCodeFolder(join(outside, "repo")), join(outside, "repo"));
});

test("/ and system folders are refused", async () => {
  for (const path of ["/", "/etc", "/etc/ssh", "/usr", "/usr/local/bin", "/var", "/bin", "/opt", "/dev"]) {
    await refused(path, path);
  }
});

test("the home folder itself is refused", async () => {
  await refused("~", "~");
  await refused(home, "home");
});

test("dotfiles and dot-folders in home are refused, including ones the terminal list does not name", async () => {
  for (const path of ["~/.ssh", "~/.zshrc", "~/.local", "~/.local/src/tool", "~/projects/.secret", join(home, ".ssh")]) {
    const message = await refused(path, path);
    assert.match(message, /settings or app data|keys or app data/, path);
  }
  // The terminal's shared check alone would allow ~/.local/src/tool: Code is stricter, the guard is unchanged.
  assert.equal(await resolveWorkFolder(join(home, ".local", "src", "tool")), join(home, ".local", "src", "tool"));
});

test(".. segments are refused before anything is resolved", async () => {
  for (const path of ["~/projects/../.ssh", "~/projects/app/..", `${home}/projects/../projects/app`, "/tmp/../etc", "~\\projects\\..\\.ssh"]) {
    const message = await refused(path, path);
    assert.match(message, /“\.\.”/, path);
  }
});

test("links that resolve outside are refused", async () => {
  // The folder named is itself a link.
  await refused("~/app-link", "link named directly");
  // A link inside home that leads out of home.
  assert.match(await refused("~/projects/out-link/repo", "out of home"), /leads out of your home folder/);
  // A link that leads into a dot-folder in home.
  await refused("~/projects/keys-link", "link to ~/.ssh (named directly)");
  // A link part-way along the path that leads into a dot-folder in home (the path typed has no dot in it).
  assert.match(await refused("~/projects/local-link/src/tool", "through a link into ~/.local"), /\.local in your home folder/);
  // A link that leads to a system folder.
  await refused("~/projects/etc-link/ssh", "link to /etc");
});

test("relative paths, files and missing folders are refused", async () => {
  await refused("projects/app", "relative");
  await refused("", "empty");
  await refused("~/projects/missing", "missing");
  writeFileSync(join(home, "projects", "notes.txt"), "hi");
  await refused("~/projects/notes.txt", "file");
});

test("dotUnderHome names the first dot entry below home and ignores everything else", () => {
  assert.equal(dotUnderHome(join(home, ".ssh", "id"), home), ".ssh");
  assert.equal(dotUnderHome(join(home, "a", ".b", "c"), home), ".b");
  assert.equal(dotUnderHome(join(home, "a", "b"), home), null);
  assert.equal(dotUnderHome(home, home), null);
  assert.equal(dotUnderHome("/srv/.hidden", home), null);
});

test("at use time, saved Code folders that are gone, relative, blocked or dot-folders are skipped", async () => {
  const roots = await usableCodeRoots({
    code: { roots: ["~/projects/app", "~/projects-alias/app", "relative/path", "/etc", "~/.local/src/tool", "~/projects/missing", join(outside, "repo")] },
  });
  assert.deepEqual(roots, [join(home, "projects", "app"), join(outside, "repo")]);
});

test("a settings save may keep or remove Code folders, and every added one is checked and stored as its real path", async () => {
  const current = { code: { roots: ["~/legacy-kept-as-is", join(home, "projects", "app")] } };
  // No code section: passed through untouched.
  const other = { terminal: { roots: ["/anything"] } };
  assert.equal(await checkCodeRootsPatch(current, other), other);
  // Removing and keeping are allowed without a check.
  assert.deepEqual(await checkCodeRootsPatch(current, { code: { roots: ["~/legacy-kept-as-is"] } }), { code: { roots: ["~/legacy-kept-as-is"] } });
  // A new folder is resolved.
  assert.deepEqual(await checkCodeRootsPatch(current, { code: { roots: [join(home, "projects", "app"), "~/projects-alias/app", join(outside, "repo")] } }), {
    code: { roots: [join(home, "projects", "app"), join(outside, "repo")] },
  });
  // Every refused kind of path is refused here too.
  for (const path of ["/", "/etc", "~", "~/.ssh", "~/.zshrc", "~/projects/../.ssh", "~/projects/out-link/repo", "~/app-link"]) {
    await assert.rejects(() => checkCodeRootsPatch(current, { code: { roots: [...current.code.roots, path] } }), GuardError, path);
  }
  await assert.rejects(() => checkCodeRootsPatch(current, { code: { roots: "/etc" } }), (error: Error & { statusCode?: number }) => error.statusCode === 400);
});
