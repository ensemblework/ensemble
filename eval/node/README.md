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
| `--tasks` | `all` | Task ids separated by commas, `suite:core`, `suite:crew`, `suite:hard`, `suite:orch`, `suite:code`, `suite:work`, a category or `all` |
| `--agent` | `copilot-cli` | The owner's subscription agent: node turns and coding sessions both use it |
| `--model` | `gpt-6-luna` | The model for node turns and coding sessions |
| `--repeat` | `1` | Runs of each task |
| `--label` | none | Names the result files |
| `--judge-model` | `gpt-6-luna` | The model of the rubric judge (one Copilot call per judged task) |
| `--work-dir` | the system temporary folder | Where the run's scratch folder goes; it must be outside this repository (Ensemble refuses to work in its own source) and short (the computer's browser keeps a socket there) |
| `--keep` | off | Keeps the scratch folder (logs, fixtures, both computers' state) for debugging |
| `--protect` | none | Agent session ids never to delete, separated by commas; `NODE_EVAL_PROTECT` adds more |
| `--regrade <results.json>` | | Grades a saved run again from the evidence in its traces: no node turns, only the judge and live ground truth again |
| `--combine <results.json>,<results.json>` | | With `--label`: one result file from several runs on the same agent and model, in the suites' task order, a later run of a task replacing an earlier one |
| `--report <results.json>` | | Writes a saved run's JSON and Markdown again in the current format (counts older files lack are read from their errors); no agent calls |
| `--summary <results.json>,<results.json>` | | With `--label`: one Markdown summary of several saved runs on the same agent and model, `results/<label>.md`: their suites side by side, every task, and every failed check; no agent calls |
| `--cleanup <ledger.jsonl>` | | Deletes the sessions a crashed run recorded in its scratch folder's ledger |
| `--ignore-requires` | off | Runs a task even when the checkout lacks what it requires (a check of the harness itself; such a run measures nothing) |

The agent must be installed and signed in on this computer. Press Ctrl+C once to stop after the current task, twice to quit at once.

Tests of the harness itself (graders, card answers, redaction, the report, the hard suite's fixtures, the orch, code and work graders and the fake connected app), no agent calls; hub-api's `pnpm test` lists them too:

```
cd apps/hub-api && DATABASE_URL=postgresql://localhost/ensemble_unused npx tsx --test ../../eval/node/lib/*.test.ts ../../eval/node/tasks/*.test.ts
```

Type check: `cd apps/hub-api && npx tsc -p ../../eval/node/tsconfig.json`.

## Serve mode

`serve.ts` boots the same isolated world a run boots and leaves it running, so a person or a browser test can drive one node through the real Ensemble Node website (on a phone-sized window, say) instead of the harness sending messages and answering cards:

```
pnpm --filter @ensemble/hub-api exec tsx ../../eval/node/serve.ts --port 4100 --web http://localhost:3300 --work-dir <dir>
```

| Option | Default | What it does |
| --- | --- | --- |
| `--port` | `4100` | The API's port on `localhost` |
| `--web` | `http://localhost:3300` | The website's origin: only `http://localhost:<port>`, never a hosted site. It is the API's `ENSEMBLE_NODE_WEB_ORIGIN` (CORS with credentials, links in cards and notifications), as `node.ensemblework.com` is for production |
| `--agent`, `--model` | `copilot-cli`, `gpt-6-luna` | The node's provider and model, and the run profile's coding agent and model |
| `--template` | `assistant` | The node's template |
| `--work-dir`, `--keep`, `--protect` | as for a run | |

It makes one owner (verified, named, in this computer's time zone), pairs the computer process with them, and makes one DM node on the run's agent and model. Then it writes `serve.json` (mode 0600) in the scratch folder: the API's address, the website's address of the node's chat, the owner's session cookie (name, value and the attributes `/api/auth/login` sets: `HttpOnly`, `Path=/`, `SameSite=Lax`, host-only), the owner, node and computer ids, and `elsewhere`, a folder outside the node's own. The API listens on `localhost`, so a browser on the website's port sends that cookie to it. Start the website with `NEXT_PUBLIC_ENSEMBLE_API=http://localhost:<port>` on the `--web` port (its `pnpm dev` is port 3300; `next dev --hostname localhost --port <port>` in `apps/node-web` for another). Its `lib/environment.ts` accepts a local API for either environment.

Every owner card waits for a person: serve mode answers none. Each look (every 1.5 s) still applies the cost fence, records the agent sessions that appear and writes what changes (messages, card states, turns, runs, plans) to `trace.jsonl` in the scratch folder. SIGTERM or Ctrl+C stops the node's work, deletes the node, unpairs, deletes every agent session it made (as a run does, never one that existed before it started) and removes the scratch folder unless `--keep`. A serve process that died leaves its scratch folder: `run.ts --cleanup <scratch>/ledger.jsonl` deletes its sessions.

## How a run works

One run is one process with one API (`src/test/http.ts`, created once per process) and a second process for the owner's computer:

- **The API** runs in the eval process on an in-memory PGlite database, with `ENSEMBLE_DESKTOP=1` after boot so turns on the owner's subscription run here, on this computer's own agent CLI, the way a computer's own runtime runs them. Its node queue (`startNode`) runs the turns.
- **The owner's computer** is `lib/computer-main.ts`, started by `lib/computer.ts`: a desktop runtime with its own in-memory database, sandbox, agent queue, capture runtime and remote loop. For each task it pairs with the API as that task's owner (a pairing code, as `ensemble login` does), shares the task's folders the way Settings does, and runs device tools (`computer_run`, `computer_files_*`, `node_share_file`, `browser_*`, `capture_*`), coding sessions and the browser on this machine. It needs its own database because a file the computer keeps and the web's copy of it share one id.
- **Each task** gets a fresh owner (verified, in this computer's time zone), its own nodes, crew and rooms, a run profile that runs coding sessions on the paired computer with `--agent` and `--model`, and its own folder under the scratch folder. Its node turns use the owner's subscription: provider `--agent`, model `--model`. Once it is graded its nodes are deleted, so nothing they could be woken for runs during the next task.
- **Steps** are owner messages, sent in order. A step can wait first (for a coding run or a plan step to be working, for example), then send an amendment or `stop`, and can hold a while after it. After the last step the harness waits until nothing runs for 6 seconds: no turn, no live run, no unreported run, no open plan. A plan that stays open with nothing running for 5 minutes ends the wait as stalled. A task times out after 10 minutes (crew tasks 25, the larger hard tasks 15); the timeout is recorded and the run moves on.
- **Owner cards** are answered by the harness as the owner would: a computer question with **This mission**, a question about the agent's own call (its shell, files or web) with its answer for this run (**Allow once** when that is the only choice), a coding run's permission for the run (once when that is the only choice), a run's question with its recommended option, held writes, sessions and node proposals approved, and a stuck plan step's card answered with finish without it (keep the result, when what the step worked from changed), counted and listed as a problem with the step and why it was stuck. Never **Always**. A card only a person could approve (a password, a secret, a sign-in, a device code) is declined, as by an owner who is away; a push or high-risk run request is left alone. Every card is counted, and declined and unanswered ones are listed in the results.
- **A cost fence** stops any run that would use another engine or model than the one under test, and says so in the errors.
- **The owner's screen stays out of reach.** Every process the run starts has no `DISPLAY` or `WAYLAND_DISPLAY`, a private `XDG_RUNTIME_DIR` in the scratch folder (no Wayland or PulseAudio socket), and a session bus that `xdg-dbus-proxy` filters down to the keyring (`org.freedesktop.secrets`), where Copilot keeps its sign-in: no desktop portal, notification, screen cast or app activation gets through. Without `xdg-dbus-proxy` the bus is cut. For an agent screen (a headless GNOME Shell that the desktop helper starts on a bus of its own) the computer's runtime folder links this user's PipeWire socket, which its frames go through, and its `systemd-run` runs the command it is given in place: the real one reaches this user's systemd manager, which starts units with the desktop session's display. A card asking for the owner's own screen, or its pointer and keyboard (`screen:owner`), is never approved; one about an app on the agent screen is. Desktop tasks run only on Linux, and refuse to start if a display is in reach.
- **The agent has a home of the run's own.** `COPILOT_HOME` points at a folder in the scratch folder that holds only the signed-in account, copied from this machine's Copilot `config.json` (host and login; the token stays in the keyring). No MCP server, skill, plugin, instruction or setting of this machine reaches node turns, coding sessions or the judge, and the agent's sessions never reach `~/.copilot`.
- **Relay tasks** (`relay: true`) run the owner's turns where hosted Ensemble runs them: on the paired computer, which picks each turn up and calls Ensemble's tools back over its connection (`subscriptions/relay.ts`). For such a task the eval process turns `ENSEMBLE_DESKTOP` off, and the computer pairs through **the link** (`lib/link.ts`), a TCP relay on 127.0.0.1 the harness can cut. The other tasks run turns in the eval process as above.
- **Faults a task can inject** (`ctx.computer`): the computer's connection stops and starts again (`offline`, `online`); its process and everything it started is killed (SIGKILL, the process tree read from `/proc`) and starts again on the same folders (`restart`; the computer then keeps its database on disk in its folder for the whole run, with its device token sealed by one key for every start); the link goes down for a while (`dropLink`, ended early by `restoreLink`); or one answer Ensemble gives the computer is lost on its way (`loseAnswer`: the next answer at a matching address whose text matches closes its connection instead of going out, after Ensemble did the work, and the link then stays down for a few seconds). A task can also hold the owner's cards (`holdCards`), and bring another person into a room: a second verified account that accepts the room's invite and writes there as itself.
- **Tasks a checkout cannot run** are skipped, not failed: a task lists what it `requires`, `lib/capabilities.ts` looks for it in the checkout's source, and a missing one gives the result `skipped` with "requires <capability> (<what>)". `tool-journal` is the tool journal with restart reconciliation (`node/journal.ts`, `node_tool_journal`); `code-tab-harness` the Code tab's turn packet, completion record, handoff record and fork route. Each result file notes which of these its checkout has. So every suite runs on v1 and on each v2 branch.
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

`hard`: what Ensemble Node v2 changes, in a DM with one Assistant node. On v1 several of these are expected to fail.

| Task | Asks | Checks |
| --- | --- | --- |
| `overdue-in-plan` | A plan for today, with two overdue tasks, one due today and three meetings still ahead | Both overdue tasks named, before today's task, and called overdue |
| `many-files-index` | An index page of 45 Markdown files in nested folders: each file's title (its first heading) and its TODO count, most first | Every title and count on the page against the fixture, and the order |
| `failing-projects` | Which of 4 small projects fail their tests, as a Markdown report file in the chat | A file reached the chat, both failing projects and all 3 failing test names, no passing project called failing |
| `memory-old-preference` | "Which seat and airline should you pick for my Delhi trip? Just tell me.", with the answer in the 10th oldest of 60 node memories (a v1 turn is shown the newest 40) | Aisle seat and Akasa Air named, no question or request for more back |
| `old-decision-recall` | "What did we decide about the ledger database, and why?", decided in one of 25 meeting pages over three months | Postgres, the reasons (transactions, balances and constraints), when, that it read that meeting's page, and the judge |
| `desktop-calculator` | Open Calculator, work out 7 × 6, say the result and send a screenshot | 42 in the reply, a real screenshot in the chat |
| `desktop-recording` | A short video of Calculator working out 12 + 30, sent in the chat | A video in the chat, at least 2 seconds long (what capture measured, else the file's own header) |
| `delivery-truth` | A one-page Markdown summary of a document on the computer, sent as a file | A Markdown file in the chat, the document's key facts, about a page long, no claim of anything that did not arrive |
| `interrupt-amend` | A page comparing Jupiter's four largest moons; after the first tool call, "also include who discovered each and when" | One page, the four moons, diameters and periods within 2%, Galileo and 1610 |
| `interrupt-replace` | A page of Brazil's largest cities; after the first tool call, "forget that, instead add a todo due next Friday" | The todo and its date, no Brazil page, the first request not passed off as done |

The desktop tasks need a screen of the agent's own: on a computer without one (no Xvfb here), the honest answer is to say it cannot.

`orch`: what a node or a crew does around the work itself (Grok Bot study 14 §8, Cursor study 08, DESIGN §7-8).

| Task | Does | Checks |
| --- | --- | --- |
| `role-without-task` | A Designer added to a crew (`POST /api/node/rooms/:id/nodes`) and welcomed as its designer, with no task | No task, page, plan, run, routine or file made; no tool call that changes anything; a reply of at most 700 characters |
| `plain-chat-vs-node` | Two plain questions in a DM, the second following from the first | Both answered in order; no tool beyond reads (Ensemble's lookups, the agent's own reads); nothing made, no memory |
| `conflicting-artifact-versions` | A lead asked to have two writers each write their own version to the same `blurb.md` | The harness watches the folder: both takes written, and none lost (fewer than 70% of its words left in any file) unless the owner hears which was kept and why |
| `peer-message-during-approval` | In the owner's DM, the node's write in an unshared folder waits on the owner's card (the harness holds its cards); meanwhile a teammate asks the node a question in a room the owner shares with them (invited, and accepting with a node of their own, as a person does); the owner answers 25 s later | The card waiting then is the one answered, no card dropped, the file written once, the turn reports, the teammate's question answered exactly once |
| `restart-reconciliation` | Relay. `node ledger.js` records an entry, then runs a minute; once the entry is there the computer's process is killed and starts again | One entry, not two; the owner told it was cut off or may have run; no claim that it finished; the turn ends or reports |
| `ui-client-absent` | A page and a todo made with no client connected (the harness never opens the event stream) | Nothing running or waiting; the room list, its messages, the page and the todo as a client reads them afterwards (`/api/node/rooms`, `/api/tasks`, `/api/pages/:id`) |
| `cleanup` | A small crew run: the developer writes a file | Then nothing running, no helper node, no resource claim, undelivered effect or lease (here and in the computer's own database), no Copilot session Ensemble keeps no record of, no temporary file left in either process's temporary folder |
| `same-harness-switch` | A code word, then the node's thinking level switched on the same subscription (`PATCH /api/node/nodes/:id {effort}`), then the code word asked for | The switch taken, no new agent session after it, the code word, the same model on every call |
| `rejected-switch` | A code word, then the node switched to a subscription this computer cannot run (one not installed or not signed in here), then the code word asked for | Refused with a reason; the node keeps its agent and model; no new session; the code word; no turn on another subscription or model (a switch the checkout wrongly takes is put back before any turn) |
| `background-child` | A coding session started to run a one-minute script; once it runs, another question | The session ran; the other question answered while it ran; its end woke the node once (one `run` turn); the owner heard its result |
| `connection-lost-during-mutation` | Relay. "Add a todo", with the answer of the computer's write lost on its way (`loseAnswer`) and the link down 8 s | The answer was lost; one todo, not two; the owner not told it failed; told where it stands; the turn ended |
| `paired-but-offline` | Relay. The link to the computer goes down (last seen 10 minutes ago), a question about its files, then the link comes back and the question again | An answer within a minute saying it is offline; nothing invented; no turn left waiting; still paired; the real list once back |
| `finished-without-acceptance` | A board task done by a coding session; its acceptance check (`node accept.js`) takes the export once, so the session's own run passes and any later run fails; it logs every run | The session finished; the task not marked done and the owner told it is not accepted, unless the check passed when run after the session ended (logged, or in the node's own tool call) |

`code`: the Code tab's agent on the owner's computer, driven as the Code tab drives it (`POST /api/agent/threads`, each message as `POST /api/agent/assign` with `chat` and `surface: "code"`), in a small git repository in the computer's own workspace folder.

| Task | Does | Checks |
| --- | --- | --- |
| `multi-file-change-with-tests` | Currency support across `src/money.js` and `src/invoice.js`, with tests for both | Both modules and both test files changed, its tests and hidden tests pass, the turn finished, and Ensemble's own verification run passed (`completion.checks.state` is `passed` on the thread's turn; a checkout without one fails this check) |
| `resume-picks-up-context-delta` | Turn 1 writes a label from a task it mentions; the task is renamed (`PATCH /api/tasks/:id`); turn 2 in the same session adds the label to the README | The first label written, the same agent session for turn 2, the README names the new label and not the old |
| `handoff-to-another-agent` | Requires `code-tab-harness`. Turn 1 gets a release codename to keep (a plain fact, not a secret); the thread is forked into a new session (`POST /api/agent/threads/:id/fork`) that is asked for it | A handoff record went with it (`.ensemble/handoff/`), a new session, the record carries the codename and says what it does not carry, the new session wrote the codename, and nobody called it lossless |

`work`: a node set to work beyond one reply.

| Task | Does | Checks |
| --- | --- | --- |
| `create-a-routine` | "Every weekday at 8:30, a summary of my tasks due that day" | One routine, weekdays at 8:30 in the owner's time zone, an action about the day's tasks, its next run a weekday at 08:30, active |
| `connected-app-through-bridge` | A CRM connected as a remote MCP connection (`POST /api/mcp-connections`), served by a fake MCP server on 127.0.0.1 (`lib/mcp-fake.ts`, no real account); a renewal date and a note asked for | The customer looked up in the CRM, one note on its record, the date in the answer |
| `assign-to-coding-agent-verify` | A board task handed to a coding agent in a clone whose `origin` is a bare repository on this computer, with the task's run profile allowed to push | A branch other than `main` on the remote, its tests and hidden tests pass on a fresh clone, `main` untouched, the task done only with that branch and the branch named to the owner, nothing reaching GitHub (the GitHub CLI has no account here: `GH_CONFIG_DIR` is in the scratch folder and GitHub token variables are removed) |

Every task also counts **false claims**: replies that say something was done that no tool did (a picture, video or file attached, here or coming with the reply, a task or page created, a reminder set, a memory saved, a coding session started, plus claims a task adds, such as "the tests pass"). A sentence that says something was not done is not a claim.

## Results

Each run writes `eval/node/results/<timestamp>-<label>.json` and a Markdown summary beside it, saved after every task. Per task:

| Column | Meaning |
| --- | --- |
| result, score | Pass (all checks) and the share of checks passed |
| verified | A pass whose evidence checks passed too: the file, the picture or the row exists, not only words |
| false claims | Claims in the replies that nothing backs |
| no answer / error msgs | Turns that failed because the agent ended without a reply and did nothing ("The model ended its turn without replying or doing anything", or "The model returned no answer" in earlier result files), and error messages posted in the chat. A turn that did work and wrote nothing answers from its tool log and is not counted |
| turns, model calls | Node turns, and the agent's model calls in them and in coding sessions |
| Ensemble tools, agent tools | Ensemble tool calls the turns made, and tool calls the agent's own trace shows (its own tools and the Ensemble tools it called) |
| tokens in / out, credits | From the agent's session usage records (node turns and coding sessions), or Ensemble's own `model.call` metric events where those count more (a session Ensemble replaced leaves no log to read); credits are the AI units Copilot reports in its usage records |
| time, approvals, errors | Wall time, owner cards (and how many were left unanswered, and how many were for a stuck plan step), failed turns, runs and harness errors |

A task the checkout cannot run is listed as `skipped`, with what it requires, under its own heading, and counts in no total. Under the table, **suite metrics** give per suite and overall (with the tasks skipped beside the tasks run): tasks passed and verified, mean score, turns ended with no answer, error messages, false claims, input tokens per task, approvals, time and credits per task. The no-answer turns, error messages, false claims and input tokens are the measures v2 is meant to move.

`eval/node/results/baseline-v1-summary.md` is the Ensemble Node v1 baseline: commit 9a418803, Copilot CLI with gpt-6-luna, one run of each task, all three suites with this harness, side by side and task by task. It is made with `--summary` from the `baseline-v1-iso-all` files (`core` and `crew`) and the `baseline-v1-hard-all` files (`hard`), each combined from the runs beside it.

`eval/node/results/baseline-v1-orch-code-work.md` is the same baseline for `orch`, `code` and `work`, run with this harness on that commit (the eval checkout's commit 1720b03a is 9a418803 with the harness), from the `baseline-v1-orch-all` files (the `orch` run with later runs of three of its tasks), the `baseline-v1-code` files and the `baseline-v1-work-all` files (the `work` run with a later run of one task); a later run of a task replaces the earlier one, which ran an older version of that task. There `handoff-to-another-agent` is skipped (it requires `code-tab-harness`); the checks that fail are Ensemble's own verification run, the renamed task on a resumed turn, telling the owner that a write cut off by a restart or a lost answer may have run, and running the acceptance check again before a task is called done.

`eval/node/results/v2-pre-summary.md` is an early measure of node-v2/phase2 at 7ec01739 with the same agent and model for `orch`, `code`, `work` and `hard`, from the `v2-pre-orch`, `v2-pre-code-all` (the `code` run with a later run of `handoff-to-another-agent`), `v2-pre-work` and `v2-pre-hard` files. The `v2-pre-orch-rerun` files hold a second run of `connection-lost-during-mutation`, which passed where the first stalled.

The `baseline-v1-all` files (`core` and `crew`) come from runs in which the agent used this machine's Copilot home: node turns could see its MCP servers, and every prompt carried their tool lists, so input tokens per task there run higher. Compare against the summary, not against them.

Traces are JSON lines in `eval/node/results/traces/<label>/<task>--<n>.jsonl`: messages, turns (with how each ended, where the checkout records it), runs, plans, cards and sessions as they happen; Ensemble Node's own turn traces and decisions (`node_turn_traces`, `node_decisions`: hashes, sizes, models, placement and the loop, never text) where the checkout keeps them; then the checks, the metrics, and the evidence the grader read (kept small, with home folders, this machine's name, keys and tokens redacted, as in the result files). `--regrade` reads that last line.

## Cost and safety

- Every node turn, coding session and judge call is a call on the owner's own subscription. On Ensemble Node v1 with Copilot CLI and gpt-6-luna the `core` suite took about 8 minutes, 14 sessions (2 of them the judge's), 1.2 million input tokens and 5 credits; the `crew` suite about 35 minutes (25 of them a task that timed out), 18 sessions, 3.5 million input tokens and 12 credits; the `hard` suite about 9 minutes, 13 sessions, 1.7 million input tokens and 7 credits. On node-v2/phase2 `core` took about 11 minutes, 1.8 million input tokens and 7 credits, and `hard` about 11 minutes, 2.9 million input tokens and 9 credits; at 7ec01739 `orch` took about 38 minutes (22 of them two relay tasks waiting on a turn that had gone silent), 2.5 million input tokens and 12 credits, `code` about 4 minutes, 0.9 million and 2 credits, and `work` about 3 minutes, 0.6 million and 3 credits. On v1 `orch` took about 25 minutes (12 of them two relay tasks waiting for the relay's time limit after the computer stopped answering), 21 sessions, 1.9 million input tokens and 9 credits; `code` (two tasks run) about 2 minutes, 2 sessions, 0.2 million input tokens and under 1 credit; `work` about 3 minutes, 4 sessions, 0.5 million input tokens and 2 credits. Use a cheap model.
- Runs are sequential: one task at a time, one agent process at a time where the product allows it.
- Included models and Ensemble's own agent get no runtime here (`AGENT_RUNTIME_URL` points nowhere), so those calls fail at once and cost nothing.
- Variables that could reach real keys or a screen are removed before Ensemble loads; every folder Ensemble writes (state, workspace, app data, temporary files, the runtime folder) is in the scratch folder, and the session bus reaches only the keyring.

## Session cleanup

Every agent session the run starts is recorded in the scratch folder's `ledger.jsonl` and deleted with Ensemble's own `deleteNativeSession` after its task: node turn sessions (`assistant-sessions.json` of the API's state folder, and of the computer's for relay tasks), coding sessions (the run's engine events), the judge's calls, and any Copilot session whose working folder lies in the scratch folder. For Copilot the session's folder in `session-state` and its rows in `session-store.db` go too, in the run's own Copilot home, which goes with the scratch folder at the end. A session that existed before the run started, or one named by `--protect`, is never deleted. The results list each id with whether it was deleted, and the run checks at the end that none is left. `--cleanup <ledger.jsonl>` uses the Copilot home beside the ledger, so a crashed run kept with `--keep` can be cleaned up later.

## Limitations

- **Subscription turns run in the eval process**, as on a computer's own runtime, not relayed from a hosted API to the computer, except in relay tasks: elsewhere the relay's limits (20 minutes per turn, 64 turns per spec) do not apply.
- **One agent and one model.** A switch within the subscription changes the thinking level (`effort`), not the model; `rejected-switch` switches to a subscription this computer cannot run (it refuses to start if every candidate is signed in here); the Code handoff is a fork into a new session of the same agent, which takes the same handoff path as a switch of agent.
- **A restart is the computer's**: the API runs in the eval process on an in-memory database, so `restart-reconciliation` kills and restarts the computer's process (with the turn on it, as a relay task), not the API's. Killing the process tree reads `/proc`, so it runs on Linux only.
- **No included models and no checklist model**: Ensemble's own model calls (the turn checklist, picture checks, Ensemble's own agent) fail at once, as in the HTTP test harness.
- **The agent CLI is this machine's** in its sign-in and version only: its configuration is the run's own (see above), so MCP servers this machine configured for Copilot are not offered to node turns here, while on an owner's computer v1 offers them.
- **The desktop tasks need an agent screen**: this machine has no Xvfb or ffmpeg, so a branch without an agent screen (v1) captures neither apps' windows nor video and fails them by design; one with it needs GNOME Shell's headless mode, PipeWire and GStreamer here, and Calculator installed as a system package: a snap or Flatpak app never starts on the agent screen ([25 §11.3](../../docs/25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#113-the-agent-screen)).
- **No real calendar account**: the day plan tasks read a calendar feed served from memory (`setCalendarFeedFetchForTests`). Their meetings are placed ahead of the time the task runs, closer together late in the day, so `plan-my-day` and `overdue-in-plan` refuse to start after about 22:00 local time. The owner's time zone is the eval process's: set `TZ` to run them where the day has hours left.
- **Unattended owner**: the harness answers cards at once and declines what only a person could approve; a person would take longer, could say no to more, and could type a password the harness never does.

## Adding a task

A task (`tasks/*.ts`, listed in `tasks/index.ts`) has an `id`, a `suite`, a `category`, a `title`, an optional `timeoutMs`, optional `requires` (capabilities from `lib/capabilities.ts`), `relay`, `link` and `restartsComputer`, `setup(ctx)` (nodes, crews, seeded tasks, pages, calendar events, files, shared folders, a local web page, a fake connected app), `steps` (owner messages, or `act` steps the harness does in their place, optionally waiting before and holding after), an optional `collect(ctx, ev)` for evidence only the task knows how to read (files, hidden tests), `checks(ctx)` returning `[{ name, pass, kind, note }]`, optional `claims`, and optional cleanup through `ctx.onCleanup`. Keep each task cheap, safe on this computer, and inside its own folder.
