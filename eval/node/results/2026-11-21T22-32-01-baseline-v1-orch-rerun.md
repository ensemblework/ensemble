# Ensemble Node eval: baseline-v1-orch-rerun

Commit `1720b03a` · agent copilot-cli · model gpt-6-luna · judge gpt-6-luna · repeat 1 · started 2026-11-21T22:32:01.926Z · finished 2026-11-21T22:34:19.743Z.

Score is the share of a task's checks that passed; a task passes when all do. A skipped task needs something this checkout lacks (its requirement is listed): it ran nothing and counts in no total. Verified: it passed and every check that looks at real evidence (a row, a file, a picture, a tool that ran) passed. No answer / error msgs: turns that failed because the agent ended without a reply, and error messages posted in the chat. Turns are Ensemble's node turns; model calls, tokens and credits are the agent's own, read from its session logs. Approvals are the owner cards the harness answered (or could not).

| task | suite | result | verified | score | false claims | no answer / error msgs | turns | model calls | Ensemble tools | agent tools | tokens in / out | credits | time | approvals | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| peer-message-during-approval | orch | error | no | 17% | 0 | 0 / 0 | 0 | 0 | 0 | 0 | 0 / 0 | 0.00 | 4 s | 0 | 1 |
| paired-but-offline | orch | pass | yes | 100% | 0 | 0 / 1 | 2 | 2 | 1 | 1 | 49k / 350 | 0.23 | 37 s | 1 | 2 |
| finished-without-acceptance | orch | fail | no | 33% | 0 | 0 / 0 | 2 | 16 | 8 | 18 | 408k / 3610 | 1.23 | 79 s | 0 | 0 |
| **total** | | **1/3** | 1/3 | 50% | 0 | 0 / 1 | 4 | 18 | 9 | 19 | 458k / 3960 | 1.46 | 120 s | 1 | 3 |

## Suite metrics

| suite | tasks run | skipped | passed | verified | mean score | turns ended with no answer | error messages | false claims | input tokens per task | approvals | time | credits per task |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| orch | 3 | 0 | 1 | 1 | 50% | 0 | 1 | 0 | 153k | 1 | 2.0 min | 0.49 |

## Failed checks, false claims and errors

- **peer-message-during-approval** [error]: a card waited for the owner when the teammate wrote (none); the message left it waiting, and that card was the one answered (waiting then 0, answered 0); the operation ran once (no file); the waiting turn finished and said so; the teammate's question answered exactly once (0 answer(s) with 42).
  - Error: harness: The teammate could not join the room: 400 {"error":"nodeIds: Required"}
- **paired-but-offline**: all checks passed.
  - Error: turn of @assistant failed: GitHub Copilot runs on your computer, and none is online. Eval computer was last seen 10 minutes ago. Open Ensemble on it (the desktop app, or `ensemble` in a terminal), then try again.
  - Error: error message in the chat: GitHub Copilot runs on your computer, and none is online. Eval computer was last seen 10 minutes ago. Open Ensemble on it (the desktop app, or `ensemble` in a terminal), then try again.
- **finished-without-acceptance**: the task not marked done on the session's word (done; 1 logged run(s) of the check: 22:33:44 pass; last session ended 22:33:57; the node ran it 1 time(s)); the owner told it is not accepted, unless the check passed when run again (started a github copilot session in the export folder and linked it to the task. the acceptance check is still pending, so i left the task to do. created out.cs).

## Cleanup receipt

3 of 3 agent sessions deleted.

| agent | session | kind | task | deleted |
|---|---|---|---|---|
| copilot-cli | `ecfeecfc-beee-4177-bda4-c16bec29a805` | node-turn | paired-but-offline | yes |
| copilot-cli | `556c91fc-f4ce-4dc3-8d27-776b4b0bdc9a` | coding | finished-without-acceptance | yes |
| copilot-cli | `78be0201-9051-41bd-a76f-11060e5d7ade` | node-turn | finished-without-acceptance | yes |

## Notes

- The API runs in the eval process on an in-memory PGlite database. The owner's computer is a second process with its own in-memory database (lib/computer-main.ts), paired to each task's owner through the real remote loop (src/remote/loop.ts); it runs device tools, coding sessions and the browser on this machine.
- Subscription turns run in this process (ENSEMBLE_DESKTOP=1, as on a computer's own runtime), not relayed from a hosted API: the relay's limits (20 minutes per turn, 64 turns per spec) do not apply here.
- No agent runtime and no included models: Ensemble's own model calls (the turn checklist, picture checks, Ensemble's own agent) fail at once and cost nothing; the checklist model is off as in the HTTP test harness.
- Owner cards are answered by the harness: computer questions with This mission, questions about the agent's own calls with their answer for this run (else Allow once), coding-run permissions for the run, held writes and sessions approved; never Always. Cards that need a password, a secret or a sign-in, and any request for the owner's own screen, are declined and reported.
- The agent CLI runs with this machine's sign-in but a home of the run's own (COPILOT_HOME in the scratch folder, holding only the signed-in account): no MCP server, skill, plugin or setting of this machine reaches node turns, coding sessions or the judge, and the agent's sessions never reach ~/.copilot.
- Nothing the run starts can reach the owner's screen: no display variables, a private XDG_RUNTIME_DIR (no Wayland or PulseAudio socket; the computer's links only this user's PipeWire, for an agent screen's frames), a systemd-run that runs its command in place, and no session bus beyond the keyring. Cards asking for the owner's own screen, or its pointer and keyboard, are never approved; a desktop task uses the agent's own screen or fails.
- What this checkout has that some tasks require: tool-journal no, code-tab-harness no.
- Relay tasks run the owner's turns on the paired computer, handed over by Ensemble as hosted Ensemble does (`ENSEMBLE_DESKTOP` off in the eval process for the task), with the computer paired through the harness's link; the other tasks run them in the eval process.
- The session bus is a copy filtered by xdg-dbus-proxy to the keyring (org.freedesktop.secrets), where Copilot keeps its sign-in: no desktop portal, notification or app activation gets through.
- The owner's time zone is Asia/Calcutta, the eval process's (TZ).
