# Ensemble Node evals

A task suite that runs against Ensemble Node as it is in this checkout, on the owner's own agent subscription, so the same tasks can run later against other branches on the same models and the results compare. Each task gives a node (or a crew) a request, lets it work for real on this computer, answers the owner's cards, then grades what actually happened: the database, the trace, files on disk, live ground truth and, for some tasks, a rubric judge.

Nothing here touches a real Ensemble database: the API runs on an in-memory PGlite database that disappears with the process.

## Run it

From the repository root:

```
pnpm --filter @ensemble/hub-api exec tsx ../../eval/node/run.ts --tasks suite:core --agent copilot-cli --model gpt-6-luna --repeat 1 --label baseline-v1
```

| Option | Default | What it does |
| --- | --- | --- |
| `--tasks` | `all` | Task ids separated by commas, `suite:core`, `suite:crew` or `all` |
| `--agent` | `copilot-cli` | The owner's subscription agent: node turns and coding sessions both use it |
| `--model` | `gpt-6-luna` | The model for node turns and coding sessions |
| `--repeat` | `1` | Runs of each task |
| `--label` | none | Names the result files |
| `--judge-model` | `gpt-6-luna` | The model of the rubric judge (one Copilot call per judged task) |
| `--work-dir` | the system temporary folder | Where the run's scratch folder goes; it must be outside this repository (Ensemble refuses to work in its own source) and short (the computer's browser keeps a socket there) |
| `--keep` | off | Keeps the scratch folder (logs, fixtures, both computers' state) for debugging |
| `--protect` | none | Agent session ids never to delete, separated by commas; `NODE_EVAL_PROTECT` adds more |
| `--regrade <results.json>` | | Grades a saved run again from the evidence in its traces: no node turns, only the judge and live ground truth again |
| `--combine <results.json>,<results.json>` | | With `--label`: one result file from several runs on the same agent and model, a later run of a task replacing an earlier one |
| `--cleanup <ledger.jsonl>` | | Deletes the sessions a crashed run recorded in its scratch folder's ledger |

The agent must be installed and signed in on this computer. Press Ctrl+C once to stop after the current task, twice to quit at once.

Tests of the harness itself (graders, card answers, redaction, the report), no agent calls:

```
cd apps/hub-api && DATABASE_URL=postgresql://localhost/ensemble_unused npx tsx --test ../../eval/node/lib/*.test.ts
```

Type check: `cd apps/hub-api && npx tsc -p ../../eval/node/tsconfig.json`.

## How a run works

One run is one process with one API (`src/test/http.ts`, created once per process) and a second process for the owner's computer:

- **The API** runs in the eval process on an in-memory PGlite database, with `ENSEMBLE_DESKTOP=1` after boot so turns on the owner's subscription run here, on this computer's own agent CLI, the way a computer's own runtime runs them. Its node queue (`startNode`) runs the turns.
- **The owner's computer** is `lib/computer-main.ts`, started by `lib/computer.ts`: a desktop runtime with its own in-memory database, sandbox, agent queue, capture runtime and remote loop. For each task it pairs with the API as that task's owner (a pairing code, as `ensemble login` does), shares the task's folders the way Settings does, and runs device tools (`computer_run`, `computer_files_*`, `node_share_file`, `browser_*`, `capture_*`), coding sessions and the browser on this machine. It needs its own database because a file the computer keeps and the web's copy of it share one id.
- **Each task** gets a fresh owner (verified, in this computer's time zone), its own nodes, crew and rooms, a run profile that runs coding sessions on the paired computer with `--agent` and `--model`, and its own folder under the scratch folder. Its node turns use the owner's subscription: provider `--agent`, model `--model`.
- **Steps** are owner messages, sent in order. A step can wait first (for a coding run or a plan step to be working, for example), then send an amendment or `stop`, and can hold a while after it. After the last step the harness waits until nothing runs for 6 seconds: no turn, no live run, no unreported run, no open plan. A plan that stays open with nothing running for 5 minutes ends the wait as stalled. A task times out after 10 minutes (crew tasks: 25); the timeout is recorded and the run moves on.
- **Owner cards** are answered by the harness as the owner would: a computer question with **This mission**, a coding run's permission for the run (once when that is the only choice), a run's question with its recommended option, held writes, sessions and node proposals approved. Never **Always**. A card that needs a password, a secret, a sign-in or a device code, and a push or high-risk run request, is left alone and reported as unanswered. Every card is counted.
- **A cost fence** stops any run that would use another engine or model than the one under test, and says so in the errors.
- **Grading** runs the task's checks. Score is the share of checks passed; pass means all of them. After the checks everything still running is stopped, the computer is unpaired, and the task's agent sessions are deleted.

## The tasks

`core`: a DM with one node made from the Assistant template.

| Task | Asks | Checks |
| --- | --- | --- |
| `fact-with-source` | The newest Node.js LTS line, its latest version and end of support, with a link | Each fact against endoflife.date (fetched once per run), a link, a web lookup in the trace |
| `todo-and-memory` | Add a todo and remember a preference; then, in the next message, what was asked | The task row, a memory row, both recalled |
| `lookup-then-write` | Python 3.14's release date from the web into a seeded todo's notes, "don't ask me anything" | The date (endoflife.date) in the notes, a web lookup, no question, no second todo |
| `multi-part-tasks` | Three tasks with due dates, then a page listing them | Each task and its due date in the owner's time zone, the page and its dates |
| `meeting-to-tasks` | A seeded meeting note page into tasks and a summary page | A task per action item and no extras, a summary page with the decisions |
| `plan-my-day` | A plan for today, with seeded tasks (one overdue) and three meetings still ahead today | The overdue task, today's task and meetings named, the board and calendar read, the judge |
| `computer-largest-files` | A Markdown report of a folder's 3 largest files, saved there and shared in the chat | The report on disk against the real sizes, a file in the chat and that it is the report |
| `coding-fix-tests` | Fix a bug in a small Node project so its tests pass, tests unchanged | Its tests and hidden tests run by the harness, the test file's hash, the explanation |
| `web-screenshot` | A screenshot of a page the harness serves on 127.0.0.1 | A picture in the chat, its size, the computer's browser in the trace, a reply that says what the page shows |
| `research-with-sources` | SQLite against PostgreSQL in 4 to 6 bullets with two sources | Bullets, two sites, the links open, a web lookup, the judge |
| `announce-vs-act` | "Remind me tomorrow at 9 to call the bank" | A reminder, routine or task really exists, for tomorrow at 9:00, about the bank |

`crew`: a crew made from the Manager (lead), Software developer and Tester templates, working in a project folder shared from this computer.

| Task | Asks | Checks |
| --- | --- | --- |
| `three-member-dependency` | Build a tip calculator with tests and a page; the tester checks; the lead reports | The files, its tests, hidden acceptance tests, a plan with both members, the tester's step done, the lead's report |
| `reviewer-rejects-green` | Finish a slug module whose tests pass but which breaks two of four acceptance criteria | The defect caught, hidden acceptance tests, its own tests, the judge on whether the owner heard the truth |
| `mid-run-amendment` | Build a greeting CLI; once a coding run has been building it for 20 seconds, add a `--shout` flag | Both behaviours by running it, still one file with no dependencies, its test, the report mentions the flag |
| `stop-with-children` | Build a small app with tests; once a coding run has been building it for 20 seconds, "stop" | Work had started, every plan and run ended, no turn started and nothing was said after the stop, the owner was told |

Every task also counts **false claims**: replies that say something was done that no tool did (a picture or file attached, a task or page created, a reminder set, a memory saved, a coding session started, plus claims a task adds, such as "the tests pass").

## Results

Each run writes `eval/node/results/<timestamp>-<label>.json` and a Markdown summary beside it, saved after every task. Per task:

| Column | Meaning |
| --- | --- |
| result, score | Pass (all checks) and the share of checks passed |
| verified | A pass whose evidence checks passed too: the file, the picture or the row exists, not only words |
| false claims | Claims in the replies that nothing backs |
| turns, model calls | Node turns, and the agent's model calls in them and in coding sessions |
| Ensemble tools, agent tools | Ensemble tool calls the turns made, and tool calls the agent's own trace shows (its own tools and the Ensemble tools it called) |
| tokens in / out, credits | From the agent's session usage records (node turns and coding sessions), or Ensemble's own `model.call` metric events where the agent kept none; credits are the AI units Copilot reports in its usage records |
| time, approvals, errors | Wall time, owner cards (and how many were left unanswered), failed turns, runs and harness errors |

`eval/node/results/2026-11-21T14-52-32-baseline-v1-all.md` is the Ensemble Node v1 baseline (commit 9a418803, Copilot CLI, gpt-6-luna), combined from the runs beside it.

Traces are JSON lines in `eval/node/results/traces/<label>/<task>--<n>.jsonl`: messages, turns, runs, plans, cards and sessions as they happen, then the checks, the metrics, and the evidence the grader read (kept small and with home folders, keys and tokens redacted). `--regrade` reads that last line.

## Cost and safety

- Every node turn, coding session and judge call is a call on the owner's own subscription. On Copilot CLI with gpt-6-luna the `core` suite took about 12 minutes, 14 sessions (2 of them the judge's), 1.6 million input tokens and 6 credits; the `crew` suite about 21 minutes, 18 sessions, 3.6 million input tokens and 13 credits. Use a cheap model.
- Runs are sequential: one task at a time, one agent process at a time where the product allows it.
- Included models and Ensemble's own agent get no runtime here (`AGENT_RUNTIME_URL` points nowhere), so those calls fail at once and cost nothing.
- Variables that could reach real keys or a screen are removed before Ensemble loads; every folder Ensemble writes (state, workspace, app data, temporary files) is in the scratch folder.

## Session cleanup

Every agent session the run starts is recorded in the scratch folder's `ledger.jsonl` and deleted with Ensemble's own `deleteNativeSession` after its task: node turn sessions (`assistant-sessions.json` of the API's state folder), coding sessions (the run's engine events), the judge's calls, and any Copilot session whose folder lies in the scratch folder. For Copilot the session's folder in `~/.copilot/session-state` and its rows in Copilot's `session-store.db` go too. A session that existed before the run started, or one named by `--protect`, is never deleted. The results list each id with whether it was deleted, and the run checks at the end that none is left in `~/.copilot/session-state`.

## Limitations

- **Subscription turns run in the eval process**, as on a computer's own runtime, not relayed from a hosted API to the computer: the relay's limits (20 minutes per turn, 64 turns per spec) do not apply.
- **No included models and no checklist model**: Ensemble's own model calls (the turn checklist, picture checks, Ensemble's own agent) fail at once, as in the HTTP test harness.
- **The agent CLI is this machine's**: its sign-in, its version and its own configuration. MCP servers configured for the agent itself (for Copilot, in `~/.copilot`) are offered to node turns as they would be on the owner's computer, so a run on another machine can differ.
- **No video**: this machine has no ffmpeg or virtual display, so capture of video and of apps' windows is not offered; no task needs it.
- **No real calendar account**: the calendar task reads a calendar feed served from memory (`setCalendarFeedFetchForTests`). Its meetings are placed ahead of the time the task runs, so `plan-my-day` needs a few hours of the day left: it refuses to start after 22:00 local time.
- **Unattended owner**: the harness answers cards at once; a person would take longer, and could say no.

## Adding a task

A task (`tasks/*.ts`, listed in `tasks/index.ts`) has an `id`, a `suite`, a `category`, a `title`, an optional `timeoutMs`, `setup(ctx)` (nodes, crews, seeded tasks, pages, calendar events, files, shared folders, a local web page), `steps` (owner messages, optionally waiting before and holding after), an optional `collect(ctx, ev)` for evidence only the task knows how to read (files, hidden tests), `checks(ctx)` returning `[{ name, pass, kind, note }]`, optional `claims`, and optional cleanup through `ctx.onCleanup`. Keep each task cheap, safe on this computer, and inside its own folder.
