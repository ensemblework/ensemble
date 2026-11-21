# Ensemble Node eval: baseline-v1-orch-all

Commit `1720b03a` · agent copilot-cli · model gpt-6-luna · judge gpt-6-luna · repeat 1 · started 2026-11-21T21:56:02.958Z · finished 2026-11-21T22:43:18.795Z.

Score is the share of a task's checks that passed; a task passes when all do. A skipped task needs something this checkout lacks (its requirement is listed): it ran nothing and counts in no total. Verified: it passed and every check that looks at real evidence (a row, a file, a picture, a tool that ran) passed. No answer / error msgs: turns that failed because the agent ended without a reply, and error messages posted in the chat. Turns are Ensemble's node turns; model calls, tokens and credits are the agent's own, read from its session logs. Approvals are the owner cards the harness answered (or could not).

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
| **total** | | **10/13** | 10/13 | 90% | 0 | 2 / 3 | 26 | 81 | 33 | 61 | 1932k / 20k | 9.01 | 1486 s | 7 | 8 |

## Suite metrics

| suite | tasks run | skipped | passed | verified | mean score | turns ended with no answer | error messages | false claims | input tokens per task | approvals | time | credits per task |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| orch | 13 | 0 | 10 | 10 | 90% | 2 | 3 | 0 | 149k | 7 | 24.8 min | 0.69 |

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

## Cleanup receipt

26 of 26 agent sessions deleted.

| agent | session | kind | task | deleted |
|---|---|---|---|---|
| copilot-cli | `82623ea5-60a5-424f-84be-06e9f1c6dec7` | node-turn | role-without-task | yes |
| copilot-cli | `2bc7348b-be7f-459f-bdda-591687bf8423` | node-turn | plain-chat-vs-node | yes |
| copilot-cli | `31ba279d-52b2-4c1f-ba0b-68ac9c9a5e9c` | node-turn | conflicting-artifact-versions | yes |
| copilot-cli | `c70578b4-5a51-4ef9-9cbb-8546e8a97d96` | coding | conflicting-artifact-versions | yes |
| copilot-cli | `20da2919-7be0-465f-bea3-5a4d7ce99853` | node-turn | conflicting-artifact-versions | yes |
| copilot-cli | `57435be0-df57-42fb-b9fb-c5b4b56fe208` | coding | conflicting-artifact-versions | yes |
| copilot-cli | `784a1b0f-f643-4596-b1d6-e217bd614267` | node-turn | conflicting-artifact-versions | yes |
| copilot-cli | `3c756cba-2d90-4c04-8754-64c14420963b` | node-turn | peer-message-during-approval | yes |
| copilot-cli | `f5758e47-91a3-45cd-bcf5-c5589362235a` | found | restart-reconciliation | yes |
| copilot-cli | `d4ce8301-98fe-49aa-84ac-809cbb67ded7` | node-turn | ui-client-absent | yes |
| copilot-cli | `a509f3dd-0758-496d-b71d-7e2f390d9969` | node-turn | cleanup | yes |
| copilot-cli | `29d8f4ba-c9af-44ce-b8da-11486a912264` | node-turn | cleanup | yes |
| copilot-cli | `3f3edde2-cee7-4d88-a885-4683cfa319ca` | node-turn | same-harness-switch | yes |
| copilot-cli | `25a24146-b03b-4d17-b129-632e7d63e345` | node-turn | rejected-switch | yes |
| copilot-cli | `6b41ad67-68fc-4826-a98d-fe03151d495a` | coding | background-child | yes |
| copilot-cli | `4c23c137-7eb5-4ad4-836e-4c37d5364a53` | node-turn | background-child | yes |
| copilot-cli | `fe99b009-2488-4dc8-8aba-10a6ec1345f7` | node-turn | connection-lost-during-mutation | yes |
| copilot-cli | `0e98742e-3df3-438f-bbb1-b9b8e53f9d93` | node-turn | paired-but-offline | yes |
| copilot-cli | `04c08c84-16c0-4ed2-9981-a48f74f3cc28` | node-turn | finished-without-acceptance | yes |
| copilot-cli | `5d2c2002-63a4-41a1-9641-d067229e1ab6` | coding | finished-without-acceptance | yes |
| copilot-cli | `0135042f-bfc0-4d32-a1fb-4514a8d5e32b` | node-turn | finished-without-acceptance | yes |
| copilot-cli | `ecfeecfc-beee-4177-bda4-c16bec29a805` | node-turn | paired-but-offline | yes |
| copilot-cli | `556c91fc-f4ce-4dc3-8d27-776b4b0bdc9a` | coding | finished-without-acceptance | yes |
| copilot-cli | `78be0201-9051-41bd-a76f-11060e5d7ade` | node-turn | finished-without-acceptance | yes |
| copilot-cli | `e6455078-c1c7-4258-9f82-fbf12cad6fd8` | node-turn | peer-message-during-approval | yes |
| copilot-cli | `d049a915-0faf-4226-8c06-003706615449` | node-turn | peer-message-during-approval | yes |

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
