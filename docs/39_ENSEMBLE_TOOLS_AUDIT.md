# 39 · Ensemble tools: what the assistant, a node and its agent runs can do

What each of Ensemble's agents can do in Ensemble itself, area by area: the Hub assistant, an Ensemble Node, and a node's agent run (a coding agent started on the owner's computer). The tool names are in [34](34_ASSISTANT_ACTIONS.md), the node's own tools in [35 §6](35_ENSEMBLE_NODE.md#6-node-tools), the run's MCP server in [30 §9](30_ENGINES.md).

## 1. How each one reaches Ensemble

| Who | Reaches Ensemble through | Where it acts |
| --- | --- | --- |
| Hub assistant | The registry's Hub tools (`assistant/registry.ts`), routed by playbooks ([11 §3](11_HOW_THE_ASSISTANT_WORKS.md#playbook-routing)) | The space the chat is in, with the person's access there |
| Ensemble Node | The same Hub tools, each with an optional `space` (`node/spaces.ts`), plus the node tools (`node/tools.ts`, `node/device-tools.ts`) | Every space its owner can open, with their current role in each; only the room's shared space where other people read ([35 §5.4](35_ENSEMBLE_NODE.md#54-every-space-its-owner-can-open)) |
| A node's agent run | Its brief (the task's title, description, page and files) and the run's `ensemble` MCP server (`scripts/ensemble-ask-mcp.mjs`) | The run's folder on the computer. The MCP server answers on the computer's loopback (`/api/engine/*`) from that computer's own Ensemble |

Each one is already signed in as its owner. None of them opens Ensemble's web app in a browser (§4).

## 2. The matrix

A dash means nothing in that column reaches the area. "Same" means the assistant's tools, in every space the node's owner can open.

| Area | Hub assistant | Ensemble Node | Node's agent run |
| --- | --- | --- | --- |
| Tasks on the Ensemble board | List, read, create, update, delete, restore; what is due (`hub_list_tasks`, `hub_create_tasks`, `hub_update_task`, `hub_delete_tasks`, `hub_list_due`) | Same | Its own task, from the brief. In Chat: `ensemble_list_tasks`, `ensemble_create_task`, `ensemble_search` on that computer's Ensemble |
| Custom boards (`/board?board=<id>`) | List; read by link, id or title; make, change (title, description, tiles, columns), delete; put, place, move and take off tasks and notes (`hub_list_boards`, `hub_read_board`, `hub_create_board`, `hub_update_board`, `hub_delete_board`, `hub_move_to_board`, `hub_remove_from_board`); `hub_read_surface` reads the open one | Same | — |
| Board overview and layouts | `hub_read_layout`; `hub_edit_layout` (the space owner's only) | Same | — |
| Projects and deliverables | List, create, update, complete, delete | Same | From the brief |
| Pages and notes | List, read, create, append or rewrite, block edits, move, delete, export to a file, file to page | Same | In Chat: `ensemble_search` |
| Page history, templates, copies | — | — | — |
| Comments | Read, add, edit, resolve, delete internal comments (`hub_read_record_details`, `hub_manage_record`) | Same | — |
| Meeting notes | List, read, write, change, delete; import from a meeting app (waits for Apply) | Same | In Chat: `ensemble_search` |
| People | List, add, change, delete; import an app's people | Same | — |
| Repositories | List, link, unlink, describe; read a file or an overview | Same | Works in its own checkout |
| Reminders and watchers | Reminders: list, add, change, dismiss, delete. Watchers: add, list, stop (`hub_list_watchers`, `hub_cancel_watcher`). The space owner's own | Same, in its owner's own spaces | — |
| Today, recap, profile lists | `hub_list_due`, `hub_weekly_recap`, desk lists, `hub_read_surface` | Same, plus `node_overview` across every space | — |
| Files | List, open, save from a web link, copy from an app, edit an original, tags, Trash | Same, plus `node_share_file` and `hub_save_file` from the computer or its evidence | `attach_evidence` (the run's evidence, not Files) |
| Diagrams | List, read, check, make, edit, explain, copy, delete, restore a version | Same | — |
| Plots and datasets | List, read, make, change; import a dataset; rename, delete | Same | — |
| Personal skills | List, read; make or change (waits for Apply) | Same | — |
| Connected apps | What is connected; search, read, attach, post updates; built-in app tools; MCP tools; whole-board imports | Same, from its owner's account space; none in a space shared with them | — (an engine that loads the person's own MCP setup has theirs) |
| Calendars | Saved events; Google and Outlook events and availability | Same | — |
| Settings and models | Allowlisted settings and model choice (wait for Apply) | Same | — |
| Spaces and sharing | One space per chat; reads spaces and sharing | Every space its owner can open, with their role there | The job's space only |
| Agent runs | Assign to an agent (waits for Apply), sessions, runs, what is running, stop | Its own sessions (`node_session_*`), runs, stop; plans and helpers | `report_result`, `attach_evidence`, `ask_person`, `secret_http` |
| Needs me | Reads what waits (`hub_list_approvals`) | Same, and its own cards in the chat | `ask_person` |
| Code folders and agent changes | Reads them | Same, plus its own hands on the computer | Its own folder |
| Trash and Completed | Read them; restore a trashed record | Same | — |
| The web | `hub_web_search` | Same, plus the browser and capture tools, `web_task`, `browser_shop` | The computer's browser and capture tools |
| Ensemble Node itself | — | Rooms, crews, nodes, routines, memories (`node_*`) | — |
| Ensemble's web app in a browser | — | Refused (§4) | Told not to (§4) |

## 3. Gaps and where they stand

| Gap | Where it stands |
| --- | --- |
| Custom boards could not be read or changed by any tool, so a node did not find a board by its name or link | The seven board tools (§2) share `pages/boards.ts` with `routes/page-boards.ts`: the same checks, spaces and sharing as the Board screen. The `boards` playbook routes "my EnsembleWork board", "custom board" and a pasted `/board?board=<id>` link. A node reaches a board in any space its owner can open |
| Watchers could be made but not listed or stopped | `hub_list_watchers`, `hub_cancel_watcher` (with Undo) |
| A node asked its owner to sign in to Ensemble's web app | Refused before the computer, with the tools to use (§4) |

Not offered, and why:

| Not offered | Why |
| --- | --- |
| Ensemble's records in a node's agent run (tasks, boards, pages from Claude Code, Codex, Copilot…) | The run's MCP server answers on the computer's loopback from that computer's own Ensemble; a hosted account's records are not there. It needs a relay to the hosted API that acts for the job's owner in the job's space, checked as the space gateway checks a node. Until then the brief carries the task, and the node does the Ensemble work around a run itself |
| Chat's board tools reaching a hosted account | For the same reason, `ensemble_list_tasks`, `ensemble_create_task` and `ensemble_search` work on the computer's own Ensemble |
| Undo for custom-board changes | `PageBoard` is not an undo model, and a card's move changes page rows whose Trash undo depends on them. Deleting a board always waits for Apply instead |
| Page history, private templates, page copies | Owner-only routes with their own flows on the page (restore a version, save as a template) |
| Ordering tasks inside an Ensemble board column | A drag on the Board screen (`POST /api/tasks/:id/move`); status changes are `hub_update_task` |
| Deciding Needs me items, accepting agent changes, retrying a run | Approvals and code review are the person's decisions ([07](07_MODULE_GOVERNANCE_AUDIT_METRICS.md)) |
| Spaces, sharing, members, connections, keys, folder trust | Permission and credential changes stay the person's own ([11 §8.3](11_HOW_THE_ASSISTANT_WORKS.md#83-running-work-code-and-settings)) |

## 4. Never Ensemble in a browser

A node and its runs act in Ensemble as their owner already. Opening Ensemble's web app to sign in is never needed.

| Where | What happens |
| --- | --- |
| A node's browser and capture tools, `browser_shop` and `web_task` (`refuseEnsembleApp` in `node/device-tools.ts`, called before anything is sent to the computer) | A `url` (or a store in `browser_shop`) on Ensemble's web app is refused: "… is Ensemble itself, not a website to open or sign in to. Use your Ensemble tools: …", naming the board, task and page tools. A `goto` inside `web_task` is refused the same way |
| The origins (`lib/ensemble-origins.ts`) | `app.`, `test.`, `api.`, `api-test.`, `node.` and `node-test.ensemblework.com`, and the server's `HUB_WEB_ORIGIN` and `ENSEMBLE_NODE_WEB_ORIGIN` unless they are on the computer's own addresses (a Hub in development on `localhost` is an app being built). The landing page `ensemblework.com` is a website like any other |
| The node's rules (`node/brain.ts`) | One routing row: the owner's work (tasks, boards, Ensemble links) and apps through its tools, never a sign-in to Ensemble in a browser. The sign-in skill (`node/skills.ts`) says the same |
| A node's agent run | The run's MCP server tells the agent when it starts (`instructions` in its `initialize` answer, `instructionsFor`): it acts in Ensemble through that server and its brief, and never opens Ensemble's web app to sign in or to read the person's work. Testing Ensemble's web app as a product is a run's work, not a sign-in |

## 5. Tests

| Test | Covers |
| --- | --- |
| `assistant/tools/boards.integration.test.ts` | Reading a board by link, id or title; a long board in one result; columns; placing, moving and taking off cards; a task's status kept; deleting held; a node reading where its owner views and changing boards only where they edit |
| `assistant/spaces.integration.test.ts` | Every board and watcher tool stays in its space |
| `assistant/skills/skills.test.ts` | Board requests and pasted links route to the `boards` playbook |
| `node/web-task.integration.test.ts` | Ensemble's web app refused before the computer; the run's MCP instructions |
| `node/persona.integration.test.ts` | The routing row, within the persona's length budget |
