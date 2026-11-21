/*
 * ensemble-disclaim: starts a program as its own responsible process on macOS.
 *
 *   ensemble-disclaim /absolute/path/to/program [arguments...]
 *
 * macOS checks privacy grants (Accessibility, Screen Recording) against the responsible process: normally
 * the app at the top of the process tree, so everything the Ensemble app starts would share its grants.
 * Desktop control starts Cua Driver through this launcher, which replaces itself with the program
 * (posix_spawn with POSIX_SPAWN_SETEXEC: the process id and the stdio pipes stay) after disclaiming
 * responsibility. macOS then asks about, and checks the grants of, the program's own app (Cua Driver), and
 * Ensemble never needs those grants. Nothing runs when the disclaim cannot be set.
 */
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>

extern char **environ;

/* libSystem, macOS 10.14 and later; not in the public headers (xnu: libsyscall/wrappers/spawn/spawn_private.h). */
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim) __attribute__((weak_import));

int main(int argc, char *argv[]) {
  if (argc < 2 || argv[1][0] != '/') {
    fprintf(stderr, "usage: ensemble-disclaim /absolute/path/to/program [arguments...]\n");
    return 64;
  }
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

  error = posix_spawn(NULL, argv[1], NULL, &attrs, &argv[1], environ);
  /* With POSIX_SPAWN_SETEXEC, posix_spawn returns only when the program could not be started. */
  fprintf(stderr, "ensemble-disclaim: %s: %s\n", argv[1], strerror(error));
  posix_spawnattr_destroy(&attrs);
  return 127;
}
