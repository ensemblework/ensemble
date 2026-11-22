# Ensemble Node eval: baseline-v1-orch-code-work

Agent copilot-cli · model gpt-6-luna · judge gpt-6-luna · commits 1720b03a · repeat 1.

Score is the share of a task's checks that passed; a task passes when all do. A skipped task needs something this checkout lacks (its requirement is listed): it ran nothing and counts in no total. Verified: it passed and every check that looks at real evidence (a row, a file, a picture, a tool that ran) passed. No answer / error msgs: turns that failed because the agent ended without a reply, and error messages posted in the chat. Turns are Ensemble's node turns; model calls, tokens and credits are the agent's own, read from its session logs. Approvals are the owner cards the harness answered (or could not).

## Suites

| suite | tasks run | skipped | passed | verified | mean score | turns ended with no answer | error messages | false claims | input tokens per task | approvals | time | credits per task |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| orch | 13 | 0 | 10 | 10 | 90% | 2 | 3 | 0 | 149k | 7 | 24.8 min | 0.69 |
| code | 2 | 1 | 0 | 0 | 67% | 0 | 0 | 0 | 109k | 0 | 1.5 min | 0.30 |
| work | 3 | 0 | 3 | 3 | 100% | 0 | 1 | 0 | 161k | 1 | 2.6 min | 0.65 |
| **all** | 18 | 1 | 13 | 13 | 89% | 2 | 4 | 0 | 146k | 8 | 28.9 min | 0.64 |

## Tasks

| task | suite | result | verified | score | false claims | no answer / error msgs | turns | model calls | Ensemble tools | agent tools | tokens in / out | credits | time | approvals | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| role-without-task | orch | pass | yes | 100% | 0 | 0 / 0 | 1 | 1 | 0 | 0 | 20k / 101 | 0.25 | 55 s | 0 | 0 |
| plain-chat-vs-node | orch | pass | yes | 100% | 0 | 0 / 0 | 2 | 2 | 0 | 0 | 39k / 171 | 0.32 | 36 s | 0 | 0 |
| conflicting-artifact-versions | orch | pass | yes | 100% | 0 | 1 / 0 | 4 | 27 | 8 | 23 | 612k / 9749 | 2.58 | 176 s | 1 | 1 |
| peer-message-during-approval | orch | pass | yes | 100% | 0 | 0 / 0 | 2 | 4 | 2 | 2 | 84k / 282 | 0.34 | 53 s | 2 | 0 |
| restart-reconciliation | orch | fail | no | 80% | 0 | 0 / 1 | 1 | 1 | 1 | 1 | 22k / 94 | 0.16 | 408 s | 1 | 2 |
| ui-client-absent | orch | pass | yes | 100% | 0 | 0 / 0 | 1 | 3 | 3 | 3 | 86k / 533 | 0.74 | 28 s | 0 | 0 |
| cleanup | orch | pass | yes | 100% | 0 | 1 / 0 | 3 | 8 | 5 | 5 | 227k / 2477 | 1.06 | 93 s | 2 | 1 |
| same-harness-switch | orch | pass | yes | 100% | 0 | 0 / 0 | 2 | 2 | 0 | 0 | 46k / 301 | 0.29 | 41 s | 0 | 0 |
| rejected-switch | orch | pass | yes | 100% | 0 | 0 / 0 | 2 | 3 | 1 | 1 | 69k / 230 | 0.32 | 41 s | 0 | 0 |
| background-child | orch | pass | yes | 100% | 0 | 0 / 0 | 3 | 9 | 3 | 5 | 209k / 1799 | 1.18 | 111 s | 0 | 0 |
| connection-lost-during-mutation | orch | fail | no | 60% | 0 | 0 / 1 | 1 | 3 | 1 | 2 | 62k / 217 | 0.31 | 328 s | 0 | 2 |
| paired-but-offline | orch | pass | yes | 100% | 0 | 0 / 1 | 2 | 2 | 1 | 1 | 49k / 350 | 0.23 | 37 s | 1 | 2 |
| finished-without-acceptance | orch | fail | no | 33% | 0 | 0 / 0 | 2 | 16 | 8 | 18 | 408k / 3610 | 1.23 | 79 s | 0 | 0 |
| multi-file-change-with-tests | code | fail | no | 83% | 0 | 0 / 0 | 0 | 6 | 0 | 10 | 95k / 1199 | 0.35 | 40 s | 0 | 0 |
| resume-picks-up-context-delta | code | fail | no | 50% | 0 | 0 / 0 | 0 | 8 | 0 | 9 | 123k / 844 | 0.25 | 52 s | 0 | 0 |
| handoff-to-another-agent | code | skipped | | | | | | | | | | | | | |
| create-a-routine | work | pass | yes | 100% | 0 | 0 / 0 | 1 | 2 | 1 | 1 | 41k / 246 | 0.29 | 30 s | 0 | 0 |
| connected-app-through-bridge | work | pass | yes | 100% | 0 | 0 / 1 | 2 | 4 | 2 | 2 | 88k / 403 | 0.51 | 36 s | 1 | 2 |
| assign-to-coding-agent-verify | work | pass | yes | 100% | 0 | 0 / 0 | 2 | 15 | 5 | 23 | 354k / 3536 | 1.13 | 89 s | 0 | 0 |
| **total** | | **13/18** (1 skipped) | 13/18 | 89% | 0 | 2 / 4 | 31 | 116 | 41 | 106 | 2633k / 26k | 11.55 | 1733 s | 8 | 10 |

## Failed checks, false claims and errors

- **conflicting-artifact-versions**: all checks passed.
  - Error: turn of @manager failed: The model returned no answer. Recorded actions are available separately.
- **restart-reconciliation**: the owner was told it was cut off or may have run (eval computer stopped answering. try again.).
  - Error: turn of @assistant failed: Eval computer stopped answering. Try again.
  - Error: error message in the chat: Eval computer stopped answering. Try again.
- **cleanup**: all checks passed.
  - Error: turn of @dev failed: The model returned no answer. Recorded actions are available separately.
- **connection-lost-during-mutation**: the owner was not told it failed; the owner was told where it stands.
  - Error: turn of @assistant failed: Eval computer stopped answering. Try again.
  - Error: error message in the chat: Eval computer stopped answering. Try again.
- **paired-but-offline**: all checks passed.
  - Error: turn of @assistant failed: GitHub Copilot runs on your computer, and none is online. Eval computer was last seen 10 minutes ago. Open Ensemble on it (the desktop app, or `ensemble` in a terminal), then try again.
  - Error: error message in the chat: GitHub Copilot runs on your computer, and none is online. Eval computer was last seen 10 minutes ago. Open Ensemble on it (the desktop app, or `ensemble` in a terminal), then try again.
- **finished-without-acceptance**: the task not marked done on the session's word (done; 1 logged run(s) of the check: 22:33:44 pass; last session ended 22:33:57; the node ran it 1 time(s)); the owner told it is not accepted, unless the check passed when run again (started a github copilot session in the export folder and linked it to the task. the acceptance check is still pending, so i left the task to do. created out.cs).
- **multi-file-change-with-tests**: Ensemble's own verification run passed (no verification run recorded).
- **resume-picks-up-context-delta**: README names the new label (# labels release tooling. ## release current release label: blue-heron.); and not the old one.
- **connected-app-through-bridge**: all checks passed.
  - Error: turn of @assistant failed: GitHub Copilot stopped: exit 1
  - Error: error message in the chat: GitHub Copilot stopped: exit 1

## Skipped

- **handoff-to-another-agent**: requires code-tab-harness (the Code tab harness: threads, completion records, turn packets and handoff records (from node-v2/code-tab)).

## Sources

- [`2026-11-21T22-43-45-baseline-v1-orch-all.md`](2026-11-21T22-43-45-baseline-v1-orch-all.md): orch, 13 tasks, 26 of 26 agent sessions deleted.
- [`2026-11-21T22-43-57-baseline-v1-code.md`](2026-11-21T22-43-57-baseline-v1-code.md): code, 3 tasks, 2 of 2 agent sessions deleted.
- [`2026-11-21T22-54-18-baseline-v1-work-all.md`](2026-11-21T22-54-18-baseline-v1-work-all.md): work, 3 tasks, 6 of 6 agent sessions deleted.

## Notes

- The API runs in the eval process on an in-memory PGlite database. The owner's computer is a second process with its own in-memory database (lib/computer-main.ts), paired to each task's owner through the real remote loop (src/remote/loop.ts); it runs device tools, coding sessions and the browser on this machine.
- Subscription turns run in this process (ENSEMBLE_DESKTOP=1, as on a computer's own runtime), not relayed from a hosted API: the relay's limits (20 minutes per turn, 64 turns per spec) do not apply here.
- No agent runtime and no included models: Ensemble's own model calls (the turn checklist, picture checks, Ensemble's own agent) fail at once and cost nothing; the checklist model is off as in the HTTP test harness.
- Owner cards are answered by the harness: computer questions with This mission, questions about the agent's own calls with their answer for this run (else Allow once), coding-run permissions for the run, held writes and sessions approved; never Always. Cards that need a password, a secret or a sign-in, and any request for the owner's own screen, are declined and reported.
- The agent CLI runs with this machine's sign-in but a home of the run's own (COPILOT_HOME in the scratch folder, holding only the signed-in account): no MCP server, skill, plugin or setting of this machine reaches node turns, coding sessions or the judge, and the agent's sessions never reach ~/.copilot.
- Nothing the run starts can reach the owner's screen: no display variables, a private XDG_RUNTIME_DIR (no Wayland or PulseAudio socket; the computer's links only this user's PipeWire, for an agent screen's frames), a systemd-run that runs its command in place, and no session bus beyond the keyring. Cards asking for the owner's own screen, or its pointer and keyboard, are never approved; a desktop task uses the agent's own screen or fails.
- What this checkout has that some tasks require: tool-journal no, code-tab-harness no.
- The computer kept its database on disk in its own folder for this run, since a task restarts its process.
- Relay tasks run the owner's turns on the paired computer, handed over by Ensemble as hosted Ensemble does (`ENSEMBLE_DESKTOP` off in the eval process for the task), with the computer paired through the harness's link; the other tasks run them in the eval process.
- The session bus is a copy filtered by xdg-dbus-proxy to the keyring (org.freedesktop.secrets), where Copilot keeps its sign-in: no desktop portal, notification or app activation gets through.
- The owner's time zone is Asia/Calcutta, the eval process's (TZ).
- Combined from 2026-11-21T21-56-02-baseline-v1-orch, 2026-11-21T22-32-01-baseline-v1-orch-rerun, 2026-11-21T22-42-06-baseline-v1-orch-peer; a later run of a task replaces an earlier one.
- Combined from 2026-11-21T22-46-26-baseline-v1-work, 2026-11-21T22-52-06-baseline-v1-work-rerun; a later run of a task replaces an earlier one.
