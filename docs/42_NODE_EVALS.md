# 42 · Ensemble Node evals

`eval/node/` runs a fixed task suite against Ensemble Node in the current checkout, on the owner's own agent subscription, and grades what really happened. The same suite can run on another branch with the same agent and model, so the results compare. Details of every task and option: [eval/node/README.md](../eval/node/README.md).

## At a glance

| Part | What it is |
| --- | --- |
| `eval/node/run.ts` | The command: runs tasks, answers the owner's cards, grades, writes results, deletes the agent sessions it started |
| `eval/node/lib/world.ts` | The API in the eval process on an in-memory PGlite database, turns on the owner's subscription on this computer (`ENSEMBLE_DESKTOP=1`) |
| `eval/node/lib/computer-main.ts` | The owner's computer: a second process with its own in-memory database, paired through the real remote loop, running device tools, coding sessions and the browser on this machine |
| `eval/node/tasks/` | The `core` suite (11 tasks, a DM with one node), the `crew` suite (4 tasks, a lead, a developer and a tester) and the `hard` suite (10 tasks on what Node v2 changes: many reads, old memories and meetings, overdue work, the desktop, honest delivery, interruptions) |
| `eval/node/results/` | Results as JSON and Markdown, and small per-task traces; `baseline-v1-summary.md` is the Ensemble Node v1 baseline (commit 9a418803) on Copilot CLI with gpt-6-luna, all three suites side by side |

## Running it

From the repository root, with the agent installed and signed in on this computer:

```
pnpm --filter @ensemble/hub-api exec tsx ../../eval/node/run.ts --tasks suite:core --agent copilot-cli --model gpt-6-luna --repeat 1 --label baseline-v1
```

`--tasks` takes task ids, `suite:core`, `suite:crew`, `suite:hard` or `all`. `--judge-model` picks the rubric judge's model, `--regrade <results.json>` grades a saved run again from its traces, `--report <results.json>` writes a saved run's summary again, `--summary <results.json>,…` puts several runs' suites side by side in one file, and `--work-dir` moves the scratch folder (outside the repository, with a short path).

## What a run does

1. Boots one API and one computer process. Nothing touches a real database; every folder Ensemble writes is in the run's scratch folder. Nothing reaches the owner's screen: no display, a private runtime folder, and a session bus filtered to the keyring (`xdg-dbus-proxy`), where the agent CLI keeps its sign-in.
2. For each task: a fresh owner, their nodes, crew and rooms, the computer paired to them, a run profile that runs coding sessions there with the agent and model under test, and the task's fixtures (seeded tasks, pages, calendar events, files, a local web page).
3. Sends the owner's messages, some of them while work runs (an amendment, a replacement, `stop`), and waits until nothing runs. Owner cards are answered as the owner would for this run (**This mission**, never **Always**; a stuck plan step's card with finish without it); cards that need a password, a secret, a sign-in or the owner's own screen are reported. A cost fence stops any run on another engine or model.
4. Grades with live ground truth (endoflife.date), database state, the trace (tool calls, turns, runs, cards), files and hidden tests on disk, and a rubric judge (one call on the judge model, its session deleted).
5. Records per task: pass, score, verified pass, false claims, turns that ended with no answer, error messages in the chat, turns, model calls, tool calls, tokens, credits, wall time, approvals and errors; per suite, the same measures in a table of their own.
6. Deletes every agent session the run started with Ensemble's own session deletion, and never one that existed before the run.

## Limits

Turns on the subscription run in the eval process, not relayed from a hosted API. Included models and the checklist model are off. The agent CLI runs with this machine's sign-in but a Copilot home of the run's own (`COPILOT_HOME`), so none of this machine's MCP servers, skills or settings reach a turn. The harness answers cards at once; it approves work for the run and declines what needs a person (a password, a secret, a sign-in) or the owner's own screen. Desktop tasks run only on Linux.
