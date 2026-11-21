# 42 · Ensemble Node evals

`eval/node/` runs a fixed task suite against Ensemble Node in the current checkout, on the owner's own agent subscription, and grades what really happened. The same suite can run on another branch with the same agent and model, so the results compare. Details of every task and option: [eval/node/README.md](../eval/node/README.md).

## At a glance

| Part | What it is |
| --- | --- |
| `eval/node/run.ts` | The command: runs tasks, answers the owner's cards, grades, writes results, deletes the agent sessions it started |
| `eval/node/lib/world.ts` | The API in the eval process on an in-memory PGlite database, turns on the owner's subscription on this computer (`ENSEMBLE_DESKTOP=1`) |
| `eval/node/lib/computer-main.ts` | The owner's computer: a second process with its own in-memory database, paired through the real remote loop, running device tools, coding sessions and the browser on this machine |
| `eval/node/tasks/` | The `core` suite (11 tasks, a DM with one node) and the `crew` suite (4 tasks, a lead, a developer and a tester) |
| `eval/node/results/` | Results as JSON and Markdown, and small per-task traces |

## Running it

From the repository root, with the agent installed and signed in on this computer:

```
pnpm --filter @ensemble/hub-api exec tsx ../../eval/node/run.ts --tasks suite:core --agent copilot-cli --model gpt-6-luna --repeat 1 --label baseline-v1
```

`--tasks` takes task ids, `suite:core`, `suite:crew` or `all`. `--judge-model` picks the rubric judge's model, `--regrade <results.json>` grades a saved run again from its traces, and `--work-dir` moves the scratch folder (outside the repository, with a short path).

## What a run does

1. Boots one API and one computer process. Nothing touches a real database; every folder Ensemble writes is in the run's scratch folder.
2. For each task: a fresh owner, their nodes, crew and rooms, the computer paired to them, a run profile that runs coding sessions there with the agent and model under test, and the task's fixtures (seeded tasks, pages, calendar events, files, a local web page).
3. Sends the owner's messages, some of them while work runs (an amendment, `stop`), and waits until nothing runs. Owner cards are answered as the owner would for this run (**This mission**, never **Always**); cards that need a password, a secret or a sign-in are reported. A cost fence stops any run on another engine or model.
4. Grades with live ground truth (endoflife.date), database state, the trace (tool calls, turns, runs, cards), files and hidden tests on disk, and a rubric judge (one call on the judge model, its session deleted).
5. Records per task: pass, score, verified pass, false claims, turns, model calls, tool calls, tokens, credits, wall time, approvals and errors.
6. Deletes every agent session the run started with Ensemble's own session deletion, and never one that existed before the run.

## Limits

Turns on the subscription run in the eval process, not relayed from a hosted API. Included models and the checklist model are off. The agent CLI runs with this machine's own sign-in and configuration. The harness answers cards at once and never says no.
