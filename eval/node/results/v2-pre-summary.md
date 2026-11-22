# Ensemble Node eval: v2-pre-summary

Agent copilot-cli · model gpt-6-luna · judge gpt-6-luna · commits 7ec01739 · repeat 1.

Score is the share of a task's checks that passed; a task passes when all do. A skipped task needs something this checkout lacks (its requirement is listed): it ran nothing and counts in no total. Verified: it passed and every check that looks at real evidence (a row, a file, a picture, a tool that ran) passed. No answer / error msgs: turns that failed because the agent ended without a reply, and error messages posted in the chat. Turns are Ensemble's node turns; model calls, tokens and credits are the agent's own, read from its session logs. Approvals are the owner cards the harness answered (or could not); stuck: those for a plan step that got stuck, which the harness finished without, or kept as it was when what the step worked from changed (each is listed below with the step and why).

## Suites

| suite | tasks run | skipped | passed | verified | mean score | turns ended with no answer | error messages | false claims | input tokens per task | approvals | time | credits per task |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| orch | 13 | 0 | 10 | 10 | 89% | 0 | 2 | 0 | 192k | 6 (1 stuck) | 37.5 min | 0.93 |
| code | 3 | 0 | 3 | 3 | 100% | 0 | 0 | 0 | 289k | 0 | 4.3 min | 0.75 |
| work | 3 | 0 | 3 | 3 | 100% | 0 | 0 | 0 | 206k | 1 | 3.4 min | 0.86 |
| hard | 10 | 0 | 10 | 8 | 100% | 0 | 0 | 0 | 276k | 6 | 11.4 min | 0.89 |
| **all** | 29 | 0 | 26 | 24 | 95% | 0 | 2 | 0 | 232k | 13 (1 stuck) | 56.6 min | 0.89 |

## Tasks

| task | suite | result | verified | score | false claims | no answer / error msgs | turns | model calls | Ensemble tools | agent tools | tokens in / out | credits | time | approvals | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| role-without-task | orch | pass | yes | 100% | 0 | 0 / 0 | 1 | 1 | 0 | 0 | 20k / 153 | 0.26 | 59 s | 0 | 0 |
| plain-chat-vs-node | orch | pass | yes | 100% | 0 | 0 / 0 | 2 | 2 | 0 | 0 | 42k / 123 | 0.53 | 39 s | 0 | 0 |
| conflicting-artifact-versions | orch | pass | yes | 100% | 0 | 0 / 0 | 5 | 32 | 16 | 34 | 844k / 14k | 3.97 | 273 s | 1 (1 stuck) | 0 |
| peer-message-during-approval | orch | pass | yes | 100% | 0 | 0 / 0 | 2 | 3 | 1 | 1 | 70k / 410 | 0.59 | 51 s | 2 | 0 |
| restart-reconciliation | orch | fail | no | 80% | 0 | 0 / 1 | 1 | 1 | 1 | 1 | 24k / 313 | 0.32 | 718 s | 1 | 2 |
| ui-client-absent | orch | pass | yes | 100% | 0 | 0 / 0 | 1 | 2 | 2 | 2 | 46k / 268 | 0.33 | 24 s | 0 | 0 |
| cleanup | orch | pass | yes | 100% | 0 | 0 / 0 | 3 | 13 | 10 | 10 | 415k / 2499 | 1.29 | 117 s | 1 | 0 |
| same-harness-switch | orch | pass | yes | 100% | 0 | 0 / 0 | 2 | 3 | 1 | 1 | 75k / 224 | 0.66 | 44 s | 0 | 0 |
| rejected-switch | orch | pass | yes | 100% | 0 | 0 / 0 | 2 | 3 | 1 | 1 | 75k / 211 | 0.42 | 44 s | 0 | 0 |
| background-child | orch | pass | yes | 100% | 0 | 0 / 0 | 3 | 8 | 2 | 4 | 189k / 1375 | 1.09 | 110 s | 0 | 0 |
| connection-lost-during-mutation | orch | fail | no | 40% | 0 | 0 / 0 | 1 | 3 | 1 | 2 | 64k / 244 | 0.32 | 601 s | 0 | 0 |
| paired-but-offline | orch | pass | yes | 100% | 0 | 0 / 1 | 2 | 7 | 8 | 8 | 204k / 2464 | 0.74 | 69 s | 1 | 2 |
| finished-without-acceptance | orch | fail | no | 33% | 0 | 0 / 0 | 2 | 16 | 14 | 23 | 426k / 4107 | 1.51 | 102 s | 0 | 0 |
| multi-file-change-with-tests | code | pass | yes | 100% | 0 | 0 / 0 | 0 | 10 | 0 | 19 | 224k / 4709 | 0.76 | 79 s | 0 | 0 |
| resume-picks-up-context-delta | code | pass | yes | 100% | 0 | 0 / 0 | 0 | 16 | 0 | 18 | 328k / 3385 | 0.72 | 82 s | 0 | 0 |
| handoff-to-another-agent | code | pass | yes | 100% | 0 | 0 / 0 | 0 | 16 | 0 | 24 | 315k / 4043 | 0.77 | 97 s | 0 | 0 |
| create-a-routine | work | pass | yes | 100% | 0 | 0 / 0 | 1 | 3 | 2 | 2 | 76k / 676 | 0.40 | 36 s | 0 | 0 |
| connected-app-through-bridge | work | pass | yes | 100% | 0 | 0 / 0 | 2 | 4 | 2 | 2 | 95k / 531 | 0.69 | 44 s | 1 | 0 |
| assign-to-coding-agent-verify | work | pass | yes | 100% | 0 | 0 / 0 | 2 | 17 | 7 | 23 | 446k / 4582 | 1.50 | 124 s | 0 | 0 |
| overdue-in-plan | hard | pass | no | 100% | 0 | 0 / 0 | 1 | 2 | 3 | 3 | 46k / 728 | 0.23 | 32 s | 0 | 0 |
| many-files-index | hard | pass | yes | 100% | 0 | 0 / 0 | 1 | 5 | 5 | 5 | 158k / 2502 | 0.67 | 51 s | 1 | 0 |
| failing-projects | hard | pass | yes | 100% | 0 | 0 / 0 | 1 | 9 | 14 | 14 | 286k / 1981 | 0.77 | 53 s | 2 | 0 |
| memory-old-preference | hard | pass | no | 100% | 0 | 0 / 0 | 1 | 1 | 0 | 0 | 22k / 208 | 0.28 | 23 s | 0 | 0 |
| old-decision-recall | hard | pass | yes | 100% | 0 | 0 / 0 | 1 | 2 | 3 | 3 | 44k / 358 | 0.32 | 35 s | 0 | 0 |
| desktop-calculator | hard | pass | yes | 100% | 0 | 0 / 0 | 2 | 9 | 7 | 7 | 277k / 1335 | 1.16 | 83 s | 1 | 0 |
| desktop-recording | hard | pass | yes | 100% | 0 | 0 / 0 | 2 | 29 | 27 | 27 | 1447k / 9617 | 3.65 | 245 s | 1 | 0 |
| delivery-truth | hard | pass | yes | 100% | 0 | 0 / 0 | 1 | 4 | 3 | 3 | 107k / 899 | 0.46 | 39 s | 1 | 0 |
| interrupt-amend | hard | pass | yes | 100% | 0 | 0 / 0 | 2 | 11 | 12 | 16 | 307k / 2596 | 0.98 | 83 s | 0 | 0 |
| interrupt-replace | hard | pass | yes | 100% | 0 | 0 / 0 | 2 | 3 | 1 | 2 | 67k / 385 | 0.36 | 39 s | 0 | 0 |
| **total** | | **26/29** | 24/29 | 95% | 0 | 0 / 2 | 46 | 235 | 143 | 255 | 6740k / 65k | 25.77 | 3394 s | 13 (1 stuck) | 4 |

## Failed checks, false claims and errors

- **conflicting-artifact-versions**: all checks passed.
  - Stuck steps finished without them: step s4-2a2e34 stuck: @manager's step in @manager's plan is stuck. Could not perform the independent review: the computer rejected access to the required launch folder because it is outside its allowed workspace. I did not inspect or change blurb.md, so the exact file text and sentence counts remain unverified. It needs you to decide: Provide the artifact in an allowed location or arrange an authorized review path for the specified folder.
- **restart-reconciliation**: the owner was told it was cut off or may have run (eval computer sent nothing for 10 minutes (no reply text and no tool call), so the turn was stopped. try again.).
  - Error: turn of @assistant failed: Eval computer sent nothing for 10 minutes (no reply text and no tool call), so the turn was stopped. Try again.
  - Error: error message in the chat: Eval computer sent nothing for 10 minutes (no reply text and no tool call), so the turn was stopped. Try again.
- **connection-lost-during-mutation**: the owner was not told it failed; the owner was told where it stands; the turn ended.
  - Error: note: Still working 10 min after "Add a todo to my board: 'Call the venue about chairs'. Just that one, nothing else.": turns 1.
- **paired-but-offline**: all checks passed.
  - Error: turn of @assistant failed: GitHub Copilot runs on your computer, and none is online. Eval computer was last seen 10 minutes ago. Open Ensemble on it (the desktop app, or `ensemble` in a terminal), then try again.
  - Error: error message in the chat: GitHub Copilot runs on your computer, and none is online. Eval computer was last seen 10 minutes ago. Open Ensemble on it (the desktop app, or `ensemble` in a terminal), then try again.
- **finished-without-acceptance**: the task not marked done on the session's word (done; 1 logged run(s) of the check: 01:25:57 pass; last session ended 01:26:07; the node ran it 0 time(s)); the owner told it is not accepted, unless the check passed when run again (started a github copilot session in the export folder to create out.csv and run node accept.js. the session is still working; the task remains to do until the a).

## Sources

- [`2026-11-22T00-48-45-v2-pre-orch.md`](2026-11-22T00-48-45-v2-pre-orch.md): orch, 13 tasks, 21 of 21 agent sessions deleted.
- [`2026-11-22T01-55-57-v2-pre-code-all.md`](2026-11-22T01-55-57-v2-pre-code-all.md): code, 3 tasks, 6 of 6 agent sessions deleted.
- [`2026-11-22T01-33-16-v2-pre-work.md`](2026-11-22T01-33-16-v2-pre-work.md): work, 3 tasks, 4 of 4 agent sessions deleted.
- [`2026-11-22T01-37-31-v2-pre-hard.md`](2026-11-22T01-37-31-v2-pre-hard.md): hard, 10 tasks, 13 of 13 agent sessions deleted.

## Notes

- The API runs in the eval process on an in-memory PGlite database. The owner's computer is a second process with its own in-memory database (lib/computer-main.ts), paired to each task's owner through the real remote loop (src/remote/loop.ts); it runs device tools, coding sessions and the browser on this machine.
- Subscription turns run in this process (ENSEMBLE_DESKTOP=1, as on a computer's own runtime), not relayed from a hosted API: the relay's limits (20 minutes per turn, 64 turns per spec) do not apply here.
- No agent runtime and no included models: Ensemble's own model calls (the turn checklist, picture checks, Ensemble's own agent) fail at once and cost nothing; the checklist model is off as in the HTTP test harness.
- Owner cards are answered by the harness: computer questions with This mission, questions about the agent's own calls with their answer for this run (else Allow once), coding-run permissions for the run, held writes and sessions approved; never Always. Cards that need a password, a secret or a sign-in, and any request for the owner's own screen, are declined and reported.
- The agent CLI runs with this machine's sign-in but a home of the run's own (COPILOT_HOME in the scratch folder, holding only the signed-in account): no MCP server, skill, plugin or setting of this machine reaches node turns, coding sessions or the judge, and the agent's sessions never reach ~/.copilot.
- Nothing the run starts can reach the owner's screen: no display variables, a private XDG_RUNTIME_DIR (no Wayland or PulseAudio socket; the computer's links only this user's PipeWire, for an agent screen's frames), a systemd-run that runs its command in place, and no session bus beyond the keyring. Cards asking for the owner's own screen, or its pointer and keyboard, are never approved; a desktop task uses the agent's own screen or fails.
- What this checkout has that some tasks require: tool-journal yes, code-tab-harness yes.
- The computer kept its database on disk in its own folder for this run, since a task restarts its process.
- Relay tasks run the owner's turns on the paired computer, handed over by Ensemble as hosted Ensemble does (`ENSEMBLE_DESKTOP` off in the eval process for the task), with the computer paired through the harness's link; the other tasks run them in the eval process.
- The session bus is a copy filtered by xdg-dbus-proxy to the keyring (org.freedesktop.secrets), where Copilot keeps its sign-in: no desktop portal, notification or app activation gets through.
- The owner's time zone is Asia/Calcutta, the eval process's (TZ).
- Combined from 2026-11-22T01-27-32-v2-pre-code, 2026-11-22T01-50-40-v2-pre-code-rerun; a later run of a task replaces an earlier one.
