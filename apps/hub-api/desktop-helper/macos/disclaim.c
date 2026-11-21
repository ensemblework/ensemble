/*
 * ensemble-disclaim: starts Cua Driver as its own responsible process on macOS.
 *
 *   ensemble-disclaim <this folder>/CuaDriver.app/Contents/MacOS/cua-driver mcp --direct
 *
 * macOS checks privacy grants (Accessibility, Screen Recording) against the responsible process: normally
 * the app at the top of the process tree, so everything the Ensemble app starts would share its grants.
 * Desktop control starts Cua Driver through this launcher, which replaces itself with the driver
 * (posix_spawn with POSIX_SPAWN_SETEXEC: the process id and the stdio pipes stay) after disclaiming
 * responsibility. macOS then asks about, and checks the grants of, Cua Driver, and Ensemble never needs
 * those grants.
 *
 * It starts nothing else: only the Cua Driver beside it (the same file once symbolic links are resolved),
 * only as `mcp --direct`, which speaks MCP on these pipes and opens no socket. Anything else exits 64, and
 * nothing runs when the disclaim cannot be set.
 */
#include <limits.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern char **environ;

/* libSystem, macOS 10.14 and later; not in the public headers (xnu: libsyscall/wrappers/spawn/spawn_private.h). */
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim) __attribute__((weak_import));

static const char DRIVER[] = "/CuaDriver.app/Contents/MacOS/cua-driver";

static int refuse(const char *why) {
  fprintf(stderr, "ensemble-disclaim: %s; it starts only the Cua Driver beside it, as: ensemble-disclaim <folder>%s mcp --direct\n", why, DRIVER);
  return 64;
}

/* The Cua Driver beside this launcher, symbolic links resolved, into `out` (PATH_MAX bytes). */
static int sibling_driver(char *out) {
  char self[PATH_MAX];
  uint32_t size = sizeof(self);
  if (_NSGetExecutablePath(self, &size) != 0) return -1;
  char real[PATH_MAX];
  if (realpath(self, real) == NULL) return -1;
  char *slash = strrchr(real, '/');
  if (slash == NULL) return -1;
  *slash = '\0';
  char driver[PATH_MAX];
  int length = snprintf(driver, sizeof(driver), "%s%s", real, DRIVER);
  if (length < 0 || (size_t)length >= sizeof(driver)) return -1;
  return realpath(driver, out) == NULL ? -1 : 0;
}

int main(int argc, char *argv[]) {
  if (argc != 4 || strcmp(argv[2], "mcp") != 0 || strcmp(argv[3], "--direct") != 0) return refuse("only `mcp --direct` is started");
  char driver[PATH_MAX];
  if (sibling_driver(driver) != 0) return refuse("there is no Cua Driver beside it");
  char wanted[PATH_MAX];
  if (realpath(argv[1], wanted) == NULL || strcmp(wanted, driver) != 0) return refuse("that is not the Cua Driver beside it");
  if (responsibility_spawnattrs_setdisclaim == NULL) {
    fprintf(stderr, "ensemble-disclaim: this macOS cannot start a program as its own responsible process\n");
    return 69;
  }

  posix_spawnattr_t attrs;
  int error = posix_spawnattr_init(&attrs);
  if (error != 0) {
    fprintf(stderr, "ensemble-disclaim: %s\n", strerror(error));
    return 71;
  }
  sigset_t none;
  sigset_t all;
  sigemptyset(&none);
  sigfillset(&all);
  error = posix_spawnattr_setsigmask(&attrs, &none);
  if (error == 0) error = posix_spawnattr_setsigdefault(&attrs, &all);
  if (error == 0) error = posix_spawnattr_setflags(&attrs, POSIX_SPAWN_SETEXEC | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
  if (error == 0) error = responsibility_spawnattrs_setdisclaim(&attrs, 1);
  if (error != 0) {
    fprintf(stderr, "ensemble-disclaim: %s\n", strerror(error));
    posix_spawnattr_destroy(&attrs);
    return 71;
  }

  char mcp[] = "mcp";
  char direct[] = "--direct";
  char *args[] = {driver, mcp, direct, NULL};
  error = posix_spawn(NULL, driver, NULL, &attrs, args, environ);
  /* With POSIX_SPAWN_SETEXEC, posix_spawn returns only when the program could not be started. */
  fprintf(stderr, "ensemble-disclaim: %s: %s\n", driver, strerror(error));
  posix_spawnattr_destroy(&attrs);
  return 127;
}
