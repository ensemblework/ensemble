# Ensemble documentation

Current product and implementation guides for Ensemble. Start with [the overview](00_PROJECT_OVERVIEW.md), [what works today](18_WHAT_IS_REAL.md), then the guide for the area you need. The October 2026 audit separates current guides from historical designs; a design proposal is not evidence that a feature shipped.

Root [README](../README.md) covers setup. [AGENTS](../AGENTS.md) requires docs to change with behavior. Operator-specific hosting/account setup and credentials belong in the ignored `private/` folder.

## Product and architecture

| Guide | Contents |
| --- | --- |
| [00 · Overview](00_PROJECT_OVERVIEW.md) | Product surfaces, deployment forms, current boundaries and domain model |
| [01 · Environment](01_TECH_STACK_AND_ENVIRONMENT.md) | Stack, configuration, models, migration/testing and CI/deployment |
| [02 · Hub](02_MODULE_INTERACTION_HUB_UI.md) | Navigation, Today/Board/Context, documents, settings, accounts and API map |
| [03 · Context](03_MODULE_CONTEXT_ENGINE.md) | Explicit acquisition, identities, relationships, meetings and retrieval |
| [04 · Personal skills](04_MODULE_SKILL_FORGE.md) | Versioned instructions, routing, brief personalization and retention learning |
| [05 · Orchestration](05_MODULE_TASK_ORCHESTRATOR.md) | Durable jobs, queue slots, product schedules, decisions and recovery |
| [06 · Workspace](06_MODULE_WORKSPACE_AND_SURFACES.md) | Assignment, execution, publishing and run evidence |
| [07 · Governance](07_MODULE_GOVERNANCE_AUDIT_METRICS.md) | Access, Apply, audit limits, retention, erasure and measured usage |
| [11 · Assistant architecture](11_HOW_THE_ASSISTANT_WORKS.md) | Prompt/tool routing, context, validation, Apply and extension |
| [13 · Context Bridge architecture](13_MODULE_CONTEXT_BRIDGE.md) | Read-only MCP tools, retrieval, transports and exclusions |
| [17 · Repository map](17_REPOSITORY_STRUCTURE.md) | Applications, packages and change ownership |
| [18 · Current capabilities](18_WHAT_IS_REAL.md) | Implemented paths and explicit limits, without historical release-note clutter |

## Feature references

| Guide | Contents |
| --- | --- |
| [16 · Code](16_CODE_TAB.md) | Review/edit, source control and human terminal |
| [20 · Plots](20_PLOTS_DESIGN.md) | Datasets, specs, browser/native computation and export |
| [20 · Quick capture](20_QUICK_CAPTURE.md) | Separate tray app/global shortcut |
| [21 · Diagram language](21_BLOCK_DIAGRAMS_DSL.md) | Grammar, shapes, layout, JSON and editor |
| [21 · Diagram cheat sheet](21_BLOCK_DIAGRAMS_CHEATSHEET.md) | Compact authoring reference |
| [22 · Diagrams for agents](22_BLOCK_DIAGRAMS_FOR_AGENTS.md) | Mirrored diagram skill instructions |
| [27 · Imports](27_IMPORTS.md) | Preview, mapping, supported sources, background jobs, rerun and Undo |
| [28 · Spaces](28_ENSEMBLE_SPACES.md) | Separate workspaces, scope, settings and export |
| [29 · Sharing](29_SHARING.md) | Roles, public links, private boundaries, presence and live writing |
| [30 · Engines and subscriptions](30_ENGINES.md) | Managed external engines, own-app handoffs, prompts and assistant subscriptions |
| [31 · Connected apps](31_CONNECTORS_IN_USE.md) | Native item actions, catalog connection methods and vendor MCP |
| [32 · Files](32_FILES.md) | Originals, format previews/edits, extraction, conversion, export and caps |
| [33 · Included AI](33_INCLUDED_AI.md) | Configured models, 20,000-credit allowance, reservations and device access |
| [34 · Assistant actions](34_ASSISTANT_ACTIONS.md) | Exact action/tool map, surface/layout awareness and dependent workflows |
| [Context Bridge setup](CONTEXT_BRIDGE.md) | Build, auth, transports and editor configuration |
| [Demo data](DEMO_DATA.md) | Explicit sample-data commands and fixtures |

## Desktop, CLI and shared systems

| Guide | Contents |
| --- | --- |
| [Desktop build/run](DESKTOP.md) | Native shell, local API, packaging and updater |
| [19 · Cross-platform support](19_CROSS_PLATFORM.md) | Current OS/build/backend matrix and verification boundaries |
| [23 · Desktop architecture](23_LOCAL_DESKTOP_DESIGN.md) | Static Hub, shared local runtime, PGlite, pairing and limits |
| [24 · Sandboxing](24_DESKTOP_SANDBOXING.md) | Actual OS backends, trust, outside access, git and residual limits |
| [25 · Remote tasks](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md) | Pairing, leases, files, Code, terminal and local authority |
| [26 · CLI](26_CLI.md) | Installation, terminal UI, commands, runner, MCP and releases |
| [Mac hand checklist](desktop/MAC_CHECKLIST.md) | Installer/platform regression checks |
| [Brand](BRAND.md) | Shared artwork, palettes, motion and generated assets |
| [Caching](CACHING.md) | Current caches, transient relay state and prompt reuse |
| [UI performance](UI_PERF_DESIGN.md) | Measurement method and current performance ownership |

## Plans and historical design

[Design index](design/README.md) identifies planned versus historical/partly implemented notes and points back to current guides. [Real-world follow-ons](design/real-world-next.md) records the explicitly planned unbuilt skill-review, profession-change, permissions and meeting improvements. Historical measurements are preserved with their original scope; they are not today's benchmark.
