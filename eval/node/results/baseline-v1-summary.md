# Ensemble Node eval: baseline-v1-summary

Agent copilot-cli · model gpt-6-luna · judge gpt-6-luna · commits 6e522f95, 61fed12e · repeat 1.

Score is the share of a task's checks that passed; a task passes when all do. Verified: it passed and every check that looks at real evidence (a row, a file, a picture, a tool that ran) passed. No answer / error msgs: turns that failed because the agent ended without a reply, and error messages posted in the chat. Turns are Ensemble's node turns; model calls, tokens and credits are the agent's own, read from its session logs. Approvals are the owner cards the harness answered (or could not).

## Suites

| suite | tasks | passed | verified | mean score | turns ended with no answer | error messages | false claims | input tokens per task | approvals | time | credits per task |
|---|---|---|---|---|---|---|---|---|---|---|---|
| core | 11 | 8 | 8 | 85% | 1 | 0 | 0 | 105k | 2 | 8.4 min | 0.43 |
| crew | 4 | 3 | 3 | 96% | 5 | 0 | 0 | 881k | 5 | 35.1 min | 2.95 |
| hard | 10 | 6 | 6 | 65% | 0 | 0 | 0 | 166k | 5 | 8.5 min | 0.67 |
| **all** | 25 | 17 | 17 | 79% | 6 | 0 | 0 | 253k | 12 | 51.9 min | 0.93 |

## Tasks

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
| overdue-in-plan | hard | fail | no | 20% | 0 | 0 / 0 | 1 | 2 | 3 | 3 | 42k / 718 | 0.33 | 29 s | 0 | 0 |
| many-files-index | hard | pass | yes | 100% | 0 | 0 / 0 | 1 | 6 | 6 | 6 | 197k / 1685 | 1.05 | 46 s | 1 | 0 |
| failing-projects | hard | pass | yes | 100% | 0 | 0 / 0 | 1 | 6 | 5 | 5 | 167k / 1121 | 0.55 | 39 s | 1 | 0 |
| memory-old-preference | hard | fail | no | 0% | 0 | 0 / 0 | 1 | 2 | 3 | 3 | 51k / 886 | 0.26 | 29 s | 0 | 0 |
| old-decision-recall | hard | pass | yes | 100% | 0 | 0 / 0 | 1 | 8 | 13 | 13 | 232k / 1177 | 0.95 | 59 s | 0 | 0 |
| desktop-calculator | hard | fail | no | 33% | 0 | 0 / 0 | 1 | 2 | 1 | 1 | 70k / 2349 | 0.47 | 42 s | 0 | 0 |
| desktop-recording | hard | fail | no | 0% | 0 | 0 / 0 | 1 | 5 | 4 | 4 | 155k / 2164 | 0.51 | 77 s | 2 | 0 |
| delivery-truth | hard | pass | yes | 100% | 0 | 0 / 0 | 1 | 4 | 3 | 3 | 113k / 953 | 0.48 | 36 s | 1 | 0 |
| interrupt-amend | hard | pass | yes | 100% | 0 | 0 / 0 | 2 | 14 | 48 | 49 | 566k / 6026 | 1.79 | 121 s | 0 | 0 |
| interrupt-replace | hard | pass | yes | 100% | 0 | 0 / 0 | 2 | 3 | 1 | 3 | 64k / 419 | 0.35 | 34 s | 0 | 0 |
| **total** | | **17/25** | 17/25 | 79% | 0 | 6 / 0 | 41 | 221 | 168 | 297 | 6333k / 77k | 23.29 | 3116 s | 12 | 7 |

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
- **overdue-in-plan**: names the overdue Northwind contract; names the overdue cloud invoice; both overdue tasks come before today's task; calls them overdue.
- **memory-old-preference**: names the aisle seat; names Akasa Air; answers without asking back.
- **desktop-calculator**: a screenshot reached the chat; it is a real screenshot (none).
- **desktop-recording**: a video reached the chat (none); it lasts at least 2 seconds (no video).
  - Cards declined: sudo (an administrator command needs the computer's password).

## Sources

- [`2026-11-21T16-58-47-baseline-v1-iso-all.md`](2026-11-21T16-58-47-baseline-v1-iso-all.md): core, crew, 15 tasks, 32 of 32 agent sessions deleted.
- [`2026-11-21T16-04-55-baseline-v1-hard-all.md`](2026-11-21T16-04-55-baseline-v1-hard-all.md): hard, 10 tasks, 16 of 16 agent sessions deleted.

## Notes

- The API runs in the eval process on an in-memory PGlite database. The owner's computer is a second process with its own in-memory database (lib/computer-main.ts), paired to each task's owner through the real remote loop (src/remote/loop.ts); it runs device tools, coding sessions and the browser on this machine.
- Subscription turns run in this process (ENSEMBLE_DESKTOP=1, as on a computer's own runtime), not relayed from a hosted API: the relay's limits (20 minutes per turn, 64 turns per spec) do not apply here.
- No agent runtime and no included models: Ensemble's own model calls (the turn checklist, picture checks, Ensemble's own agent) fail at once and cost nothing; the checklist model is off as in the HTTP test harness.
- Owner cards are answered by the harness: computer questions with This mission, coding-run permissions for the run, held writes and sessions approved; never Always. Cards that need a password, a secret or a sign-in, and any request for the owner's own screen, are declined and reported.
- The agent CLI runs with this machine's sign-in but a home of the run's own (COPILOT_HOME in the scratch folder, holding only the signed-in account): no MCP server, skill, plugin or setting of this machine reaches node turns, coding sessions or the judge, and the agent's sessions never reach ~/.copilot.
- Nothing the run starts can reach the owner's screen: no display variables, a private XDG_RUNTIME_DIR (no Wayland, PipeWire or PulseAudio socket) and no session bus beyond the keyring. Cards asking for the owner's own screen are never approved; a desktop task that needs a screen must bring its own.
- The session bus is a copy filtered by xdg-dbus-proxy to the keyring (org.freedesktop.secrets), where Copilot keeps its sign-in: no desktop portal, notification or app activation gets through.
- Combined from 2026-11-21T16-13-10-baseline-v1-iso, 2026-11-21T16-12-01-baseline-v1-iso, 2026-11-21T16-21-28-baseline-v1-iso; a later run of a task replaces an earlier one.
- Regraded 2026-11-21T16:04 from the evidence in the traces (overdue-in-plan, memory-old-preference).
- Regraded 2026-11-21T16:04 from the evidence in the traces (old-decision-recall).
- Combined from 2026-11-21T15-51-52-baseline-v1-hard, 2026-11-21T16-02-02-baseline-v1-hard-rerun; a later run of a task replaces an earlier one.
