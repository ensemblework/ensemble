# Ensemble Node eval: baseline-v1-hard-rerun

Commit `61fed12e` · agent copilot-cli · model gpt-6-luna · judge gpt-6-luna · repeat 1 · started 2026-11-21T16:02:02.058Z · finished 2026-11-21T16:03:16.374Z.

Score is the share of a task's checks that passed; a task passes when all do. Verified: it passed and every check that looks at real evidence (a row, a file, a picture, a tool that ran) passed. No answer / error msgs: turns that failed because the agent ended without a reply, and error messages posted in the chat. Turns are Ensemble's node turns; model calls, tokens and credits are the agent's own, read from its session logs. Approvals are the owner cards the harness answered (or could not).

| task | suite | result | verified | score | false claims | no answer / error msgs | turns | model calls | Ensemble tools | agent tools | tokens in / out | credits | time | approvals | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| old-decision-recall | hard | pass | yes | 100% | 0 | 0 / 0 | 1 | 8 | 13 | 13 | 232k / 1177 | 0.95 | 59 s | 0 | 0 |
| **total** | | **1/1** | 1/1 | 100% | 0 | 0 / 0 | 1 | 8 | 13 | 13 | 232k / 1177 | 0.95 | 59 s | 0 | 0 |

## Suite metrics

| suite | tasks | passed | verified | mean score | turns ended with no answer | error messages | false claims | input tokens per task | approvals | time | credits per task |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hard | 1 | 1 | 1 | 100% | 0 | 0 | 0 | 232k | 0 | 1.0 min | 0.95 |

## Failed checks, false claims and errors

None.

## Cleanup receipt

3 of 3 agent sessions deleted.

| agent | session | kind | task | deleted |
|---|---|---|---|---|
| copilot-cli | `895b9dd2-8644-4b00-85f2-4620cc07b3ee` | judge | old-decision-recall | yes |
| copilot-cli | `ff133a4b-6619-4240-b06e-2e4a89be6c5b` | node-turn | old-decision-recall | yes |
| copilot-cli | `f1a6d23e-3a30-41ff-a337-a1019f280cfa` | judge | old-decision-recall | yes |

## Notes

- The API runs in the eval process on an in-memory PGlite database. The owner's computer is a second process with its own in-memory database (lib/computer-main.ts), paired to each task's owner through the real remote loop (src/remote/loop.ts); it runs device tools, coding sessions and the browser on this machine.
- Subscription turns run in this process (ENSEMBLE_DESKTOP=1, as on a computer's own runtime), not relayed from a hosted API: the relay's limits (20 minutes per turn, 64 turns per spec) do not apply here.
- No agent runtime and no included models: Ensemble's own model calls (the turn checklist, picture checks, Ensemble's own agent) fail at once and cost nothing; the checklist model is off as in the HTTP test harness.
- Owner cards are answered by the harness: computer questions with This mission, coding-run permissions for the run, held writes and sessions approved; never Always. Cards that need a password, a secret or a sign-in, and any request for the owner's own screen, are declined and reported.
- The agent CLI runs with this machine's sign-in but a home of the run's own (COPILOT_HOME in the scratch folder, holding only the signed-in account): no MCP server, skill, plugin or setting of this machine reaches node turns, coding sessions or the judge, and the agent's sessions never reach ~/.copilot.
- Nothing the run starts can reach the owner's screen: no display variables, a private XDG_RUNTIME_DIR (no Wayland, PipeWire or PulseAudio socket) and no session bus beyond the keyring. Cards asking for the owner's own screen are never approved; a desktop task that needs a screen must bring its own.
- The session bus is a copy filtered by xdg-dbus-proxy to the keyring (org.freedesktop.secrets), where Copilot keeps its sign-in: no desktop portal, notification or app activation gets through.
- Regraded 2026-11-21T16:04 from the evidence in the traces (old-decision-recall).
