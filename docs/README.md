# Ensemble documentation

Guides to how Ensemble works today, with the code paths that implement it. Start with the [overview](00_PROJECT_OVERVIEW.md) (what works and its limits), then the guide for your area. Setup is in the root [README](../README.md); [AGENTS](../AGENTS.md) says which doc to update with which code.

## Product and architecture

| Guide | Contents |
| --- | --- |
| [00 · Overview](00_PROJECT_OVERVIEW.md) | Surfaces, what works and what does not, deployment forms, domain model |
| [01 · Stack and environment](01_TECH_STACK_AND_ENVIRONMENT.md) | Stack, configuration, local setup, models, tests, CI and deploys |
| [02 · Hub](02_MODULE_INTERACTION_HUB_UI.md) | Navigation, Today, Board, pages, Context, settings, accounts, API map |
| [03 · Context](03_MODULE_CONTEXT_ENGINE.md) | Connectors, explicit acquisition, people and identities, meetings, retrieval |
| [04 · Personal skills](04_MODULE_SKILL_FORGE.md) | Versioned instructions, routing, morning brief, completed-work learning |
| [05 · Orchestration](05_MODULE_TASK_ORCHESTRATOR.md) | Scheduler, durable jobs, queue slots, decisions, stop and retry |
| [06 · Workspace](06_MODULE_WORKSPACE_AND_SURFACES.md) | Assignment, execution, publishing, run evidence |
| [07 · Governance](07_MODULE_GOVERNANCE_AUDIT_METRICS.md) | Access, approvals, audit, retention, erasure, metrics, interaction log and dashboards |
| [11 · Assistant](11_HOW_THE_ASSISTANT_WORKS.md) | How a turn works, context, playbooks, Apply and Undo, extending it |
| [34 · Assistant actions](34_ASSISTANT_ACTIONS.md) | Exact action and tool map, tiles and layouts, limits |
| [39 · Ensemble tools](39_ENSEMBLE_TOOLS_AUDIT.md) | What the assistant, a node and a node's agent run can do in each area of Ensemble, what is not offered and why, never Ensemble in a browser |
| [17 · Repository map](17_REPOSITORY_STRUCTURE.md) | Apps, packages, folders and ownership |

## Features

| Guide | Contents |
| --- | --- |
| [16 · Code](16_CODE_TAB.md) | Review and edit, source control, the human terminal |
| [20 · Plots](20_PLOTS_DESIGN.md) | Datasets, charts, browser and server rendering, export |
| [21 · Diagram language](21_BLOCK_DIAGRAMS_DSL.md) · [cheat sheet](21_BLOCK_DIAGRAMS_CHEATSHEET.md) · [22 · for agents](22_BLOCK_DIAGRAMS_FOR_AGENTS.md) | Block diagram DSL, layout, JSON, editor |
| [27 · Imports](27_IMPORTS.md) | Imports from other apps: preview, mapping, jobs, undo |
| [28 · Spaces](28_ENSEMBLE_SPACES.md) | Separate workspaces, scope, settings, export |
| [29 · Sharing](29_SHARING.md) | Roles, public links, presence, live co-editing |
| [30 · Engines and subscriptions](30_ENGINES.md) | External agent engines, handoffs, assistant subscriptions |
| [31 · Connected apps](31_CONNECTORS_IN_USE.md) | Connector catalog, connection methods, item actions, MCP |
| [32 · Files](32_FILES.md) | Originals and blob storage, previews, edits, extraction, caps |
| [33 · Included AI](33_INCLUDED_AI.md) | Operator-provided models, monthly credits, reservations |
| [35 · Ensemble Node](35_ENSEMBLE_NODE.md) | AI teammates in DMs, crews and rooms with other people: requests to join, search, pins, shared sign-in, credits, tools and computer jobs |

## Clients and shared systems

| Guide | Contents |
| --- | --- |
| [Desktop](DESKTOP.md) | Desktop app architecture, build, packaging, updater, OS support |
| [Mac checklist](desktop/MAC_CHECKLIST.md) | Hand checks for macOS installers |
| [24 · Sandboxing](24_DESKTOP_SANDBOXING.md) | OS sandbox backends, trust, outside access, git |
| [25 · Remote tasks](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md) | Pairing, leases, files, Code and terminal on a paired computer |
| [26 · CLI](26_CLI.md) | Install, terminal UI, commands, runner, MCP, releases |
| [Quick capture](20_QUICK_CAPTURE.md) | Tray app with a global shortcut |
| [Context Bridge](CONTEXT_BRIDGE.md) | Read-only MCP server for editors |
| [Brand](BRAND.md) | Shared artwork, palettes, motion, generated assets |
| [Caching and UI performance](CACHING.md) | Caches, relay state, performance budgets |
| [36 · Web and CLI testing](36_WEB_TESTING.md) | Isolated live Hub and testing CLI, fast checks, agent workflow and production promotion |
| [37 · Fast pipeline and paused checks](37_PAUSED_CHECKS.md) | What runs on testing, main and release tags; the slower suites paused in `full-checks.yml` and how to bring them back |
| [38 · Agents and attached files](38_AGENT_READABLE_FILES.md) | How every attached file, picture, plot and diagram reaches models and agents in chat, Ensemble Node and tasks; retries after a provider's refusal; each subscription agent's input form; extracted text off |
| [Demo data](DEMO_DATA.md) | Explicit sample-data commands and fixtures |

Operator-specific hosting, accounts and credentials are in the git-ignored `private/` folder.
