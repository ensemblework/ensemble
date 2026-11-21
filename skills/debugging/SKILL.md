---
name: debugging
description: Use when a command, build, test, tool call, routine, page or connected app fails, shows an error or behaves unexpectedly, before you try a fix.
license: FSL-1.1-MIT
metadata:
  priority: p0
  keywords: error, errors, fails, failed, failing, failure, build fails, build failed, test fails, tests fail, broken, crash, crashes, crashed, bug, bugs, debug, exception, stack trace, traceback, not working, does not work, doesn't work, unexpected, wrong result, regression, flaky
  source: Ensemble. The order (cause before fix, one change at a time, three failed fixes mean a new approach) follows superpowers systematic-debugging (MIT, see THIRD_PARTY_NOTICES).
---
Find the cause before you change anything.

1. Read the whole error: the message, the code, the file and line, the first step that failed. Keep the exact text.
2. Reproduce it: run the same command or step again and see the same failure. If you cannot, gather more facts before you guess.
3. Look at what changed: recent edits, settings, versions, sign-ins, the data that came in.
4. Compare with something that works: the same command on another file, the last good run, the documented example.
5. Name one cause and why you think so, then test it with the smallest change. One change at a time; never several fixes at once.
6. When you have the cause, fix it where it starts, not where it shows. Then run the step that failed again to prove the fix.

Three fixes that did not work mean the approach is wrong: stop, write down what you tried and what each attempt showed, and change the approach or ask your owner (the stuck-recovery skill).

Never hide a failure: no skipping the failing test, no retry loop that only makes it pass sometimes, no "it works on my side". Report what failed, the cause, the fix and the check that passed.
