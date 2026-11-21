# Ensemble Node eval: baseline-v1-work-all

Commit `1720b03a` · agent copilot-cli · model gpt-6-luna · judge gpt-6-luna · repeat 1 · started 2026-11-21T22:46:26.927Z · finished 2026-11-21T22:53:52.325Z.

Score is the share of a task's checks that passed; a task passes when all do. A skipped task needs something this checkout lacks (its requirement is listed): it ran nothing and counts in no total. Verified: it passed and every check that looks at real evidence (a row, a file, a picture, a tool that ran) passed. No answer / error msgs: turns that failed because the agent ended without a reply, and error messages posted in the chat. Turns are Ensemble's node turns; model calls, tokens and credits are the agent's own, read from its session logs. Approvals are the owner cards the harness answered (or could not).

| task | suite | result | verified | score | false claims | no answer / error msgs | turns | model calls | Ensemble tools | agent tools | tokens in / out | credits | time | approvals | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| create-a-routine | work | pass | yes | 100% | 0 | 0 / 0 | 1 | 2 | 1 | 1 | 41k / 246 | 0.29 | 30 s | 0 | 0 |
| connected-app-through-bridge | work | pass | yes | 100% | 0 | 0 / 1 | 2 | 4 | 2 | 2 | 88k / 403 | 0.51 | 36 s | 1 | 2 |
| assign-to-coding-agent-verify | work | pass | yes | 100% | 0 | 0 / 0 | 2 | 15 | 5 | 23 | 354k / 3536 | 1.13 | 89 s | 0 | 0 |
| **total** | | **3/3** | 3/3 | 100% | 0 | 0 / 1 | 5 | 21 | 8 | 26 | 483k / 4185 | 1.94 | 155 s | 1 | 2 |

## Suite metrics

| suite | tasks run | skipped | passed | verified | mean score | turns ended with no answer | error messages | false claims | input tokens per task | approvals | time | credits per task |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| work | 3 | 0 | 3 | 3 | 100% | 0 | 1 | 0 | 161k | 1 | 2.6 min | 0.65 |

## Failed checks, false claims and errors

- **connected-app-through-bridge**: all checks passed.
  - Error: turn of @assistant failed: GitHub Copilot stopped: exit 1
  - Error: error message in the chat: GitHub Copilot stopped: exit 1

## Cleanup receipt

6 of 6 agent sessions deleted.

| agent | session | kind | task | deleted |
|---|---|---|---|---|
| copilot-cli | `42013abf-59f9-4aaa-b7e2-979b83c11caf` | node-turn | create-a-routine | yes |
| copilot-cli | `3d710e6e-9056-4b7f-8244-61b65ed74ef0` | node-turn | connected-app-through-bridge | yes |
| copilot-cli | `135f0d47-b3e9-422b-92b2-7792e22435dd` | coding | assign-to-coding-agent-verify | yes |
| copilot-cli | `bd263cf5-ff72-49fc-9919-6ddc05489ec0` | node-turn | assign-to-coding-agent-verify | yes |
| copilot-cli | `e1e5db0f-65fa-4d16-972a-915076835611` | node-turn | assign-to-coding-agent-verify | yes |
| copilot-cli | `e5fe6d12-2671-4e6d-b2fe-a718f75f3ebb` | coding | assign-to-coding-agent-verify | yes |

## Notes

- The API runs in the eval process on an in-memory PGlite database. The owner's computer is a second process with its own in-memory database (lib/computer-main.ts), paired to each task's owner through the real remote loop (src/remote/loop.ts); it runs device tools, coding sessions and the browser on this machine.
- Subscription turns run in this process (ENSEMBLE_DESKTOP=1, as on a computer's own runtime), not relayed from a hosted API: the relay's limits (20 minutes per turn, 64 turns per spec) do not apply here.
- No agent runtime and no included models: Ensemble's own model calls (the turn checklist, picture checks, Ensemble's own agent) fail at once and cost nothing; the checklist model is off as in the HTTP test harness.
- Owner cards are answered by the harness: computer questions with This mission, questions about the agent's own calls with their answer for this run (else Allow once), coding-run permissions for the run, held writes and sessions approved; never Always. Cards that need a password, a secret or a sign-in, and any request for the owner's own screen, are declined and reported.
- The agent CLI runs with this machine's sign-in but a home of the run's own (COPILOT_HOME in the scratch folder, holding only the signed-in account): no MCP server, skill, plugin or setting of this machine reaches node turns, coding sessions or the judge, and the agent's sessions never reach ~/.copilot.
- Nothing the run starts can reach the owner's screen: no display variables, a private XDG_RUNTIME_DIR (no Wayland or PulseAudio socket; the computer's links only this user's PipeWire, for an agent screen's frames), a systemd-run that runs its command in place, and no session bus beyond the keyring. Cards asking for the owner's own screen, or its pointer and keyboard, are never approved; a desktop task uses the agent's own screen or fails.
- What this checkout has that some tasks require: tool-journal no, code-tab-harness no.
- The session bus is a copy filtered by xdg-dbus-proxy to the keyring (org.freedesktop.secrets), where Copilot keeps its sign-in: no desktop portal, notification or app activation gets through.
- The owner's time zone is Asia/Calcutta, the eval process's (TZ).
- Combined from 2026-11-21T22-46-26-baseline-v1-work, 2026-11-21T22-52-06-baseline-v1-work-rerun; a later run of a task replaces an earlier one.
