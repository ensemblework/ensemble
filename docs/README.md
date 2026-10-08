# Ensemble docs

Design and operating docs for Ensemble, the source-available, localhost-first digital coworker ([FSL-1.1-MIT](../LICENSE.md)).

**Start at [`00`](00_PROJECT_OVERVIEW.md)** for the product direction, then [`18`](18_WHAT_IS_REAL.md) for what the code actually does today. Module docs (`02`–`07`, `13`) mix design intent with as-built notes. When a module doc and `18` disagree, `18` and the code win.

Keeping these files current is part of every change. See [`AGENTS.md`](../AGENTS.md).

## Product and modules

| # | File | Module |
|---|---|---|
| 00 | [Project overview](00_PROJECT_OVERVIEW.md) | Vision, direction, domain model, feature index |
| 01 | [Tech stack & environment](01_TECH_STACK_AND_ENVIRONMENT.md) | Languages, services, local env, pluggable models |
| 02 | [Interaction Hub UI](02_MODULE_INTERACTION_HUB_UI.md) | M1 — Notion-like pages, board, approvals, assistant chrome |
| 03 | [Context Engine](03_MODULE_CONTEXT_ENGINE.md) | M2 — pluggable connectors, Engineer Graph, context packs |
| 04 | [Skill Forge](04_MODULE_SKILL_FORGE.md) | M3 — personal skills mined from history (design; miners not built) |
| 05 | [Task Orchestrator](05_MODULE_TASK_ORCHESTRATOR.md) | M4 — scheduled jobs, planner, workers, HITL |
| 06 | [Workspace & surfaces](06_MODULE_WORKSPACE_AND_SURFACES.md) | M5 — coding workspace |
| 07 | [Governance, audit & metrics](07_MODULE_GOVERNANCE_AUDIT_METRICS.md) | M6 — identity, policy, ledger, before/after |
| 11 | [How the assistant works](11_HOW_THE_ASSISTANT_WORKS.md) | Hub Action Layer walkthrough |
| 13 | [Context Bridge design](13_MODULE_CONTEXT_BRIDGE.md) | M7 — design for the read-only MCP server |
| 16 | [Code tab](16_CODE_TAB.md) | Review, rewrite, commit, guarded terminal |
| 17 | [Repository structure](17_REPOSITORY_STRUCTURE.md) | What lives where in this repo |
| 18 | [What is real](18_WHAT_IS_REAL.md) | Built and tested vs. still a placeholder |

## Features

| # | File | Topic |
|---|---|---|
| 20 | [Plots](20_PLOTS_DESIGN.md) | The Plots tab: chart model, matplotlib export |
| 20 | [Quick capture](20_QUICK_CAPTURE.md) | Tauri tray app and global shortcut |
| 21 | [Block diagrams](21_BLOCK_DIAGRAMS_DSL.md) | Diagram language, shapes, layout, examples |
| — | [Diagram cheat sheet](21_BLOCK_DIAGRAMS_CHEATSHEET.md) | Short prompt for an agent writing a diagram |
| 22 | [Block diagrams for agents](22_BLOCK_DIAGRAMS_FOR_AGENTS.md) | The diagram skill the assistant loads |
| 28 | [Ensemble spaces](28_ENSEMBLE_SPACES.md) | Separate spaces per account: storage, isolation, switching, settings copy and sync |
| 29 | [Sharing](29_SHARING.md) | Sharing a space or one item: contacts, roles, what stays private, runs on your own computer, live presence |
| 27 | [Imports](27_IMPORTS.md) | Import from Notion, Linear, Jira, Trello, Asana, Todoist, ClickUp, monday.com, GitHub and spreadsheets; re-runs and undo |
| — | [Context Bridge setup](CONTEXT_BRIDGE.md) | What the bridge runs, and editor config |
| — | [Demo data](DEMO_DATA.md) | The Branch desk demo and `pnpm seed:demo` |

## Desktop, hosting and platform

| # | File | Topic |
|---|---|---|
| 19 | [Cross-platform readiness](19_CROSS_PLATFORM.md) | macOS / Windows / Linux findings |
| 23 | [Local-first desktop design](23_LOCAL_DESKTOP_DESIGN.md) | Local-only Tauri app: install, architecture, permissions, build order |
| 24 | [Desktop sandboxing](24_DESKTOP_SANDBOXING.md) | OS-native sandboxes, trusted folders, unattended mode, stacked tasks |
| 25 | [Remote tasks on your computer](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md) | Hosted assign, run on the person's Mac: device claim, lease, approvals |
| 26 | [Ensemble CLI](26_CLI.md) | `ensemble`: install channels, runner, `ensemble mcp`, hosted `/mcp`, editor setup, releases |
| — | [Desktop app](DESKTOP.md) | How to run and build `apps/desktop` |
| — | [Mac checklist](desktop/MAC_CHECKLIST.md) | Hand test for the unsigned `.dmg` |
| — | [UI and performance](UI_PERF_DESIGN.md) | Measured baseline and the perf design |
| — | [Caching](CACHING.md) | Which caches exist, and which deliberately do not |

## Design notes

[`design/`](design/) holds design specs and working notes for larger features (assistant and trash, Context redesign, widgets and templates, marketplace, the Today desk). They record intent at the time they were written; check the code before relying on them.
