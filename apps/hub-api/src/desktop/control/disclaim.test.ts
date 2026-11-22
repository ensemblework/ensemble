import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeTestDirectory } from "../../test/temporary.js";

// ensemble-disclaim (desktop-helper/macos/disclaim.c) starts only the Cua Driver beside it, as `mcp --direct`.
// On a Mac it is built as it ships. On Linux, stand-ins replace what only macOS has: the launcher's own path
// (from /proc), POSIX_SPAWN_SETEXEC (an exec) and the disclaim (which does nothing); which program it agrees to
// start is decided by the same code.
const SOURCE = fileURLToPath(new URL("../../../desktop-helper/macos/disclaim.c", import.meta.url));
const root = makeTestDirectory("disclaim-");
after(() => rmSync(root, { recursive: true, force: true }));

const DYLD = `#include <stdint.h>
#include <unistd.h>
static int _NSGetExecutablePath(char *buf, uint32_t *size) {
  ssize_t length = readlink("/proc/self/exe", buf, *size - 1);
  if (length < 0 || (uint32_t)length >= *size - 1) return -1;
  buf[length] = '\\0';
  return 0;
}
`;
const SHIM = `#include <errno.h>
#include <spawn.h>
#include <unistd.h>
#define POSIX_SPAWN_SETEXEC 0x40
#define weak_import weak
__attribute__((unused)) static int shim_posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions, const posix_spawnattr_t *attrs, char *const argv[], char *const envp[]) {
  short flags = 0;
  if (attrs != NULL) posix_spawnattr_getflags(attrs, &flags);
  if (flags & POSIX_SPAWN_SETEXEC) {
    execve(path, argv, envp);
    return errno;
  }
  return posix_spawn(pid, path, actions, attrs, argv, envp);
}
#define posix_spawn shim_posix_spawn
`;
const STUB = `#include <spawn.h>
int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim) {
  (void)attrs;
  return disclaim == 1 ? 0 : 22;
}
`;

function build(): string | null {
  if (process.platform !== "linux" && process.platform !== "darwin") return null;
  const cc = ["cc", "clang", "gcc"].find((name) => spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0);
  if (!cc) return null;
  const out = join(root, "build", "ensemble-disclaim");
  mkdirSync(join(root, "build", "mach-o"), { recursive: true });
  let sources = [SOURCE];
  if (process.platform === "linux") {
    writeFileSync(join(root, "build", "mach-o", "dyld.h"), DYLD);
    writeFileSync(join(root, "build", "shim.h"), SHIM);
    writeFileSync(join(root, "build", "stub.c"), STUB);
    sources = ["-D_GNU_SOURCE", "-I", join(root, "build"), "-include", join(root, "build", "shim.h"), SOURCE, join(root, "build", "stub.c")];
  }
  const compiled = spawnSync(cc, ["-std=gnu11", "-Wall", "-Wextra", "-Werror", "-o", out, ...sources], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  return out;
}

const built = build();

/** A folder as the sidecar's `bin`: the launcher, and beside it a Cua Driver that says how it was started. */
function layout(name: string, withDriver = true): { launcher: string; driver: string } {
  const dir = join(root, name);
  const driver = join(dir, "CuaDriver.app", "Contents", "MacOS", "cua-driver");
  mkdirSync(join(dir, "CuaDriver.app", "Contents", "MacOS"), { recursive: true });
  copyFileSync(built!, join(dir, "ensemble-disclaim"));
  chmodSync(join(dir, "ensemble-disclaim"), 0o755);
  if (withDriver) {
    writeFileSync(driver, '#!/bin/sh\nIFS= read -r line\nprintf \'%s|%s|%s\\n\' "$0" "$*" "$line"\n');
    chmodSync(driver, 0o755);
  }
  return { launcher: join(dir, "ensemble-disclaim"), driver };
}

const run = (launcher: string, args: string[]) => spawnSync(launcher, args, { encoding: "utf8", input: "ping\n" });

test("ensemble-disclaim starts the Cua Driver beside it as mcp --direct, on the caller's pipes", { skip: built ? false : "no C compiler here" }, () => {
  const { launcher, driver } = layout("bin");
  const started = run(launcher, [driver, "mcp", "--direct"]);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.stdout, `${realpathSync(driver)}|mcp --direct|ping\n`);
  // The same file through a link is the same program.
  symlinkSync(driver, join(root, "driver-link"));
  assert.equal(run(launcher, [join(root, "driver-link"), "mcp", "--direct"]).status, 0);
});

test("ensemble-disclaim refuses every other program and every other way to start Cua Driver, with exit 64", { skip: built ? false : "no C compiler here" }, () => {
  const { launcher, driver } = layout("refusing");
  const elsewhere = layout("elsewhere").driver;
  mkdirSync(join(root, "renamed", "CuaDriver.app", "Contents", "MacOS"), { recursive: true });
  symlinkSync("/bin/echo", join(root, "renamed", "CuaDriver.app", "Contents", "MacOS", "cua-driver"));
  const refused: string[][] = [
    ["/bin/echo", "mcp", "--direct"],
    [elsewhere, "mcp", "--direct"],
    [join(root, "renamed", "CuaDriver.app", "Contents", "MacOS", "cua-driver"), "mcp", "--direct"],
    [driver, "serve", "--direct"],
    [driver, "call", "get_screen_size"],
    [driver, "mcp", "--socket"],
    [driver, "mcp"],
    [driver, "mcp", "--direct", "--grant"],
    [driver],
    [],
  ];
  for (const args of refused) {
    const done = run(launcher, args);
    assert.equal(done.status, 64, JSON.stringify(args));
    assert.equal(done.stdout, "", JSON.stringify(args));
    assert.match(done.stderr, /starts only the Cua Driver beside it/);
  }
  // A launcher copied where no Cua Driver is beside it starts nothing.
  const alone = layout("alone", false);
  assert.equal(run(alone.launcher, [driver, "mcp", "--direct"]).status, 64);
});
