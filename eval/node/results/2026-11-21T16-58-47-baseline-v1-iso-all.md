# Ensemble Node eval: baseline-v1-iso-all

Commit `6e522f95` · agent copilot-cli · model gpt-6-luna · judge gpt-6-luna · repeat 1 · started 2026-11-21T16:12:01.494Z · finished 2026-11-21T16:56:59.443Z.

Score is the share of a task's checks that passed; a task passes when all do. Verified: it passed and every check that looks at real evidence (a row, a file, a picture, a tool that ran) passed. No answer / error msgs: turns that failed because the agent ended without a reply, and error messages posted in the chat. Turns are Ensemble's node turns; model calls, tokens and credits are the agent's own, read from its session logs. Approvals are the owner cards the harness answered (or could not).

| task | suite | result | verified | score | false claims | no answer / error msgs | turns | model calls | Ensemble tools | agent tools | tokens in / out | credits | time | approvals | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fact-with-source | core | pass | yes | 100% | 0 | 0 / 0 | 1 | 5 | 4 | 4 | 123k / 594 | 0.34 | 39 s | 0 | 0 |
| todo-and-memory | core | pass | yes | 100% | 0 | 0 / 0 | 2 | 3 | 2 | 2 | 63k / 265 | 0.45 | 39 s | 0 | 0 |
| lookup-then-write | core | pass | yes | 100% | 0 | 0 / 0 | 1 | 5 | 5 | 5 | 121k / 997 | 0.34 | 38 s | 0 | 0 |
| multi-part-tasks | core | pass | yes | 100% | 0 | 0 / 0 | 1 | 3 | 3 | 3 | 77k / 909 | 0.58 | 30 s | 0 | 0 |
| meeting-to-tasks | core | fail | no | 0% | 0 | 0 / 0 | 1 | 4 | 4 | 4 | 116k / 787 | 0.55 | 32 s | 0 | 0 |
| plan-my-day | core | fail | no | 60% | 0 | 0 / 0 | 1 | 2 | 3 | 3 | 42k / 638 | 0.21 | 41 s | 0 | 0 |
| computer-largest-files | core | pass | yes | 100% | 0 | 0 / 0 | 1 | 3 | 2 | 2 | 77k / 816 | 0.29 | 33 s | 1 | 0 |
| coding-fix-tests | core | pass | yes | 100% | 0 | 0 / 0 | 2 | 12 | 2 | 15 | 269k / 3685 | 1.21 | 75 s | 0 | 0 |
| web-screenshot | core | fail | no | 75% | 0 | 1 / 0 | 1 | 2 | 1 | 1 | 44k / 173 | 0.19 | 24 s | 1 | 1 |
| research-with-sources | core | pass | yes | 100% | 0 | 0 / 0 | 1 | 7 | 10 | 10 | 178k / 1089 | 0.42 | 130 s | 0 | 0 |
| announce-vs-act | core | pass | yes | 100% | 0 | 0 / 0 | 1 | 2 | 1 | 1 | 41k / 270 | 0.18 | 22 s | 0 | 0 |
| three-member-dependency | crew | timeout | no | 83% | 0 | 1 / 0 | 4 | 53 | 11 | 75 | 1744k / 19k | 4.57 | 1505 s | 1 | 2 |
| reviewer-rejects-green | crew | pass | yes | 100% | 0 | 0 / 0 | 4 | 25 | 9 | 27 | 648k / 13k | 2.74 | 228 s | 2 | 0 |
| mid-run-amendment | crew | pass | yes | 100% | 0 | 3 / 0 | 6 | 34 | 20 | 44 | 911k / 13k | 3.53 | 221 s | 2 | 3 |
| stop-with-children | crew | pass | yes | 100% | 0 | 1 / 0 | 2 | 9 | 4 | 11 | 221k / 3869 | 0.95 | 149 s | 0 | 1 |
| **total** | | **11/15** | 11/15 | 88% | 0 | 6 / 0 | 29 | 169 | 81 | 207 | 4676k / 59k | 16.56 | 2605 s | 7 | 7 |

## Suite metrics

| suite | tasks | passed | verified | mean score | turns ended with no answer | error messages | false claims | input tokens per task | approvals | time | credits per task |
|---|---|---|---|---|---|---|---|---|---|---|---|
| core | 11 | 8 | 8 | 85% | 1 | 0 | 0 | 105k | 2 | 8.4 min | 0.43 |
| crew | 4 | 3 | 3 | 96% | 5 | 0 | 0 | 881k | 5 | 35.1 min | 2.95 |
| **all** | 15 | 11 | 11 | 88% | 6 | 0 | 0 | 312k | 7 | 43.4 min | 1.10 |

## Failed checks, false claims and errors

- **meeting-to-tasks**: a task for the pricing page; a task for the CSV export bug; a task for the onboarding email; no more than the action items (0 tasks); a summary page; the summary has the decisions.
- **plan-my-day**: names the overdue task; judge ≥ 0.6 (0.5: It lists today’s meetings and the Q4 budget task, but omits the overdue domain renewal and does not schedule work around the meetings.).
- **web-screenshot**: says what the page shows.
  - Error: turn of @assistant failed: The model returned no answer. Recorded actions are available separately.
- **three-member-dependency** [timeout]: the lead reported to the owner.
  - Error: timed out after 25 min (runs 1, unreported runs 1, missions 1)
  - Error: turn of @tester failed: The model returned no answer. Recorded actions are available separately.
- **mid-run-amendment**: all checks passed.
  - Error: turn of @developer failed: The model returned no answer. Recorded actions are available separately.
  - Error: turn of @tester failed: The model returned no answer. Recorded actions are available separately.
  - Error: turn of @tester failed: The model returned no answer. Recorded actions are available separately.
- **stop-with-children**: all checks passed.
  - Error: turn of @developer failed: The model returned no answer. Recorded actions are available separately.

## Cleanup receipt

32 of 32 agent sessions deleted.

| agent | session | kind | task | deleted |
|---|---|---|---|---|
| copilot-cli | `e9c376df-7ca7-47f6-be52-f8d2c08ca98f` | node-turn | fact-with-source | yes |
| copilot-cli | `a9c723fb-ad96-4553-8748-74b998309116` | node-turn | todo-and-memory | yes |
| copilot-cli | `faab2e04-d0dc-4f89-b063-03221f845ced` | node-turn | lookup-then-write | yes |
| copilot-cli | `c25577e0-a0cc-40ae-91f4-80ed0b94d810` | node-turn | multi-part-tasks | yes |
| copilot-cli | `77cbd5da-8553-48e2-bad3-38a5786db69e` | node-turn | meeting-to-tasks | yes |
| copilot-cli | `26c285b5-fa71-4540-8f00-4135d4bda160` | node-turn | computer-largest-files | yes |
| copilot-cli | `4b02a226-4815-44ed-a91d-e45b11cfda1d` | coding | coding-fix-tests | yes |
| copilot-cli | `997d574e-b775-4333-8481-98f830d63b9b` | node-turn | coding-fix-tests | yes |
| copilot-cli | `8b3dee43-2a98-4c2a-97a3-50af8e77c56d` | node-turn | web-screenshot | yes |
| copilot-cli | `6dab3b29-1d17-497e-b1f2-1a1f4d77b170` | judge | research-with-sources | yes |
| copilot-cli | `8bd18c51-66af-4141-b08a-139fc03e556e` | node-turn | research-with-sources | yes |
| copilot-cli | `f29a8405-ca72-476b-92db-91b10e470be3` | node-turn | announce-vs-act | yes |
| copilot-cli | `8d9b6822-1675-481e-b74b-bed19e4ee6e1` | judge | plan-my-day | yes |
| copilot-cli | `2272509e-ee29-480e-8d8c-659f3a0c5991` | node-turn | plan-my-day | yes |
| copilot-cli | `c30df5ba-66a3-4172-ac18-49917bc4f591` | node-turn | three-member-dependency | yes |
| copilot-cli | `5780d5c9-896d-413b-954c-ffeb65fe6651` | coding | three-member-dependency | yes |
| copilot-cli | `ebb26d44-36fa-414f-9bf4-77b8bac56cdd` | node-turn | three-member-dependency | yes |
| copilot-cli | `38f5ca85-f812-4bda-89db-d0c85516f8d2` | node-turn | three-member-dependency | yes |
| copilot-cli | `3b830d94-c61f-4855-bd0e-440e63bbb482` | node-turn | three-member-dependency | yes |
| copilot-cli | `06017440-a872-4387-9086-6935acf9cb88` | judge | reviewer-rejects-green | yes |
| copilot-cli | `b0985e4d-b3c6-43b7-bb72-f0a74d80565a` | node-turn | reviewer-rejects-green | yes |
| copilot-cli | `04563d3e-9086-40ad-a972-214027936ae7` | node-turn | reviewer-rejects-green | yes |
| copilot-cli | `64862e32-5feb-4a40-91ad-73833a891f5d` | coding | reviewer-rejects-green | yes |
| copilot-cli | `e892a2a6-45ee-4801-bc09-1475a46dfa31` | coding | reviewer-rejects-green | yes |
| copilot-cli | `935dec9f-4bc7-42cc-b7dd-c4f77ebd72b1` | node-turn | mid-run-amendment | yes |
| copilot-cli | `d74a9290-a568-4731-bcad-736b4bfd4d5f` | node-turn | mid-run-amendment | yes |
| copilot-cli | `d75c140b-fcb6-4088-8833-08b8a84c7f6e` | coding | mid-run-amendment | yes |
| copilot-cli | `e3768023-d683-417f-9e20-27a3a873fb71` | node-turn | mid-run-amendment | yes |
| copilot-cli | `dd53b324-b6ab-406c-88be-77c32fd2a2ef` | node-turn | mid-run-amendment | yes |
| copilot-cli | `5e1268a8-9481-4d61-bafe-2e4fbfa571ac` | node-turn | stop-with-children | yes |
| copilot-cli | `bb252cb5-b828-43f9-bfa7-3301334cc4cd` | node-turn | stop-with-children | yes |
| copilot-cli | `97069fad-617e-49cc-b3f5-5a7e45a9234d` | coding | stop-with-children | yes |

## Notes

- The API runs in the eval process on an in-memory PGlite database. The owner's computer is a second process with its own in-memory database (lib/computer-main.ts), paired to each task's owner through the real remote loop (src/remote/loop.ts); it runs device tools, coding sessions and the browser on this machine.
- Subscription turns run in this process (ENSEMBLE_DESKTOP=1, as on a computer's own runtime), not relayed from a hosted API: the relay's limits (20 minutes per turn, 64 turns per spec) do not apply here.
- No agent runtime and no included models: Ensemble's own model calls (the turn checklist, picture checks, Ensemble's own agent) fail at once and cost nothing; the checklist model is off as in the HTTP test harness.
- Owner cards are answered by the harness: computer questions with This mission, coding-run permissions for the run, held writes and sessions approved; never Always. Cards that need a password, a secret or a sign-in, and any request for the owner's own screen, are declined and reported.
- The agent CLI runs with this machine's sign-in but a home of the run's own (COPILOT_HOME in the scratch folder, holding only the signed-in account): no MCP server, skill, plugin or setting of this machine reaches node turns, coding sessions or the judge, and the agent's sessions never reach ~/.copilot.
- Nothing the run starts can reach the owner's screen: no display variables, a private XDG_RUNTIME_DIR (no Wayland, PipeWire or PulseAudio socket) and no session bus beyond the keyring. Cards asking for the owner's own screen are never approved; a desktop task that needs a screen must bring its own.
- The session bus is a copy filtered by xdg-dbus-proxy to the keyring (org.freedesktop.secrets), where Copilot keeps its sign-in: no desktop portal, notification or app activation gets through.
- Combined from 2026-11-21T16-13-10-baseline-v1-iso, 2026-11-21T16-12-01-baseline-v1-iso, 2026-11-21T16-21-28-baseline-v1-iso; a later run of a task replaces an earlier one.
