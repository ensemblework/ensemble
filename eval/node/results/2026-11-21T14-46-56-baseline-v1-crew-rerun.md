# Ensemble Node eval: baseline-v1-crew-rerun

Commit `e8232134` · agent copilot-cli · model gpt-6-luna · judge gpt-6-luna · repeat 1 · started 2026-11-21T14:46:56.434Z · finished 2026-11-21T14:52:15.593Z.

Score is the share of a task's checks that passed; a task passes when all do. Verified: it passed and every check that looks at real evidence (a row, a file, a picture, a tool that ran) passed. No answer / error msgs: turns that failed because the agent ended without a reply, and error messages posted in the chat. Turns are Ensemble's node turns; model calls, tokens and credits are the agent's own, read from its session logs. Approvals are the owner cards the harness answered (or could not).

| task | suite | result | verified | score | false claims | no answer / error msgs | turns | model calls | Ensemble tools | agent tools | tokens in / out | credits | time | approvals | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| mid-run-amendment | crew | pass | yes | 100% | 0 | 0 / 0 | 3 | 17 | 4 | 18 | 510k / 4000 | 1.91 | 146 s | 0 | 0 |
| stop-with-children | crew | pass | yes | 100% | 0 | 0 / 0 | 2 | 6 | 3 | 4 | 198k / 2351 | 1.04 | 155 s | 0 | 0 |
| **total** | | **2/2** | 2/2 | 100% | 0 | 0 / 0 | 5 | 23 | 7 | 22 | 708k / 6351 | 2.96 | 301 s | 0 | 0 |

## Suite metrics

| suite | tasks | passed | mean score | turns ended with no answer | error messages | false claims | input tokens per task | credits per task |
|---|---|---|---|---|---|---|---|---|
| crew | 2 | 2 | 100% | 0 | 0 | 0 | 354k | 1.48 |

## Failed checks, false claims and errors

None.

## Cleanup receipt

5 of 5 agent sessions deleted.

| agent | session | kind | task | deleted |
|---|---|---|---|---|
| copilot-cli | `73044a22-3f4e-4b56-beb6-3293fca28c88` | coding | mid-run-amendment | yes |
| copilot-cli | `416fd703-a7d9-4b14-9962-d77ff27af59f` | node-turn | mid-run-amendment | yes |
| copilot-cli | `1f42e386-797d-4b69-a6d7-e974a9eeca77` | node-turn | stop-with-children | yes |
| copilot-cli | `e78367a6-ff9e-4a65-9f55-fe7e5eb5b41e` | coding | stop-with-children | yes |
| copilot-cli | `94dd1210-20aa-4539-86f0-d71aadbefbd8` | node-turn | stop-with-children | yes |

## Notes

- The API runs in the eval process on an in-memory PGlite database. The owner's computer is a second process with its own in-memory database (lib/computer-main.ts), paired to each task's owner through the real remote loop (src/remote/loop.ts); it runs device tools, coding sessions and the browser on this machine.
- Subscription turns run in this process (ENSEMBLE_DESKTOP=1, as on a computer's own runtime), not relayed from a hosted API: the relay's limits (20 minutes per turn, 64 turns per spec) do not apply here.
- No agent runtime and no included models: Ensemble's own model calls (the turn checklist, picture checks, Ensemble's own agent) fail at once and cost nothing; the checklist model is off as in the HTTP test harness.
- Owner cards are answered by the harness: computer questions with This mission, coding-run permissions for the run, held writes and sessions approved; never Always. Cards that need a password, a secret or a sign-in are left and reported.
- The agent CLI runs with this machine's own configuration and sign-in, as on an owner's computer: MCP servers configured for the agent itself (for Copilot, in ~/.copilot) are offered to node turns too.
