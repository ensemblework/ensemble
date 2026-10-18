# 00 · Ensemble overview

Ensemble is a shared workspace for a person and their agents: tasks, pages, projects, people, files, meetings and code in one place. The web app, desktop app, CLI and editor bridge use the same work context. It is source available under [FSL-1.1-MIT](../LICENSE.md).

This guide describes the implementation inspected on **18 Oct 2026**. It is a code review, not a claim that every external account, installer or model was tested live. [What is real](18_WHAT_IS_REAL.md) summarizes the boundaries; individual guides explain the implementation.

## Direction

1. **Keep the work and its context together.** A task can link a project, repository, people, files, meeting notes and personal skills. Its document and run history stay with it.
2. **Support local and hosted use.** Local development uses Postgres and Redis. Desktop and CLI use a local API with PGlite. Hosted accounts keep separate data and run code on their own paired computers.
3. **Let the person choose what enters the workspace.** Connecting an app does not import its contents. Sync people reads contact metadata; content arrives through explicit search, attachment, upload or import.
4. **Offer several ways to work.** The Hub assistant operates the app. Assigned agents perform research or code work. The CLI and external editors can use the same context.
5. **Keep model choice explicit.** Use personal API keys, supported subscriptions on a paired computer, or operator-provided included models. Included AI has a monthly account allowance; it is not unlimited inference.
6. **Make changes reviewable.** Assistant proposals, run permissions, publishing approvals, revision checks, Undo and retained run evidence have different jobs. A chat reply is not evidence that an action succeeded.
7. **Document current behavior.** Public guides describe implemented behavior with source paths. Planned changes belong in `docs/design/` with a clear status. Hosting credentials and operational runbooks stay in the ignored `private/` folder.

## 1. Product surfaces

| Surface | What it does now | Guide |
| --- | --- | --- |
| Today | Profession desk, briefing, focus tasks, reminders and configurable tiles | [Hub](02_MODULE_INTERACTION_HUB_UI.md) |
| Board and task pages | Triage, prioritize, group, assign, document and review work | [Hub](02_MODULE_INTERACTION_HUB_UI.md), [runs](05_MODULE_TASK_ORCHESTRATOR.md) |
| Context and projects | Maintain people, identities, projects, repositories, preferences and profession-specific records | [Context](03_MODULE_CONTEXT_ENGINE.md) |
| Pages and meeting notes | Structured documents, nested pages, comments, history, templates, mentions and collaboration | [Hub](02_MODULE_INTERACTION_HUB_UI.md#13-document-style-pages) |
| Files | Original uploads, previews, supported edits, app imports and conversion to pages | [Files](32_FILES.md) |
| Diagrams and Plots | Editable diagram sources and datasets/figures with export | [Diagrams](21_BLOCK_DIAGRAMS_DSL.md), [Plots](20_PLOTS_DESIGN.md) |
| Assistant | Read supported open surfaces and propose typed app or connected-app actions | [Architecture](11_HOW_THE_ASSISTANT_WORKS.md), [action map](34_ASSISTANT_ACTIONS.md) |
| Workspace, Code and Needs me | Durable agent jobs, decisions, code review, source control and a human-unlocked terminal | [Workspace](06_MODULE_WORKSPACE_AND_SURFACES.md), [Code](16_CODE_TAB.md) |
| Skills and morning brief | Versioned personal instructions, brief personalization and completed-work learning | [Skills](04_MODULE_SKILL_FORGE.md) |
| Spaces and sharing | Separate workspaces, membership, item shares, public links and presence | [Spaces](28_ENSEMBLE_SPACES.md), [sharing](29_SHARING.md) |
| Connect and settings | App grants, MCP connections, model choices, profiles, appearance, devices and data controls | [Hub](02_MODULE_INTERACTION_HUB_UI.md), [connectors](31_CONNECTORS_IN_USE.md) |

The public app includes signup and recovery. This is no longer a single-account hackathon demo or an engineer-only prototype. Profession/module choices affect which surfaces and records appear.

## 2. How work flows

```text
Person adds work / explicitly imports content
    → tasks, pages, files and linked context
    → Hub assistant actions OR an assigned research/code job
    → review / Apply / Needs me when required
    → saved result, run evidence and history
```

The assistant uses typed tools, selected by request and surface; built-in playbooks explain the calls. Personal skills are saved user instructions. Neither is a general-purpose scheduler. The scheduler currently handles specific product jobs such as reminders, morning briefs, retention and device leases. Arbitrary recurring workflows are not implemented.

## 3. Where Ensemble runs

| Form | Storage and execution |
| --- | --- |
| Local development | Next.js UI, Fastify API, Python model/plot service; Postgres and Redis in Docker |
| Hosted web | Public per-account API and web UI; code/terminal use a paired computer for ordinary accounts |
| Desktop | Tauri shell, static Hub UI and a local Node API with embedded PGlite and in-process model adapters |
| CLI | Terminal UI and the same local runtime; device pairing, agent chat, task execution and MCP setup |
| Context Bridge | Read-only context tools over stdio or HTTP, including the hosted `/mcp` endpoint |

Desktop/CLI pairing is not a bidirectional replication of the entire hosted database. See [desktop](23_LOCAL_DESKTOP_DESIGN.md) and [remote tasks](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md).

## 4. Current limits

- Native connectors, board importers and vendor MCP tools have different coverage. A catalog entry alone does not promise native search or an importer.
- Generic contact sync does not ingest mail/chat/calendar bodies or create tasks. Scheduled connector fetching currently reads nothing.
- The Hub assistant has no native email, Slack or Teams message-send action. Some connected-item update tools and vendor MCP tools can write after approval; these are separate capabilities.
- Surface awareness is structured application state, not a screenshot reader or arbitrary browser controller.
- File text extraction is not OCR, audio transcription or video understanding. Original-file edits are format-specific.
- Semantic/vector retrieval, a full historical Skill Forge mining pipeline, hosted OAuth authorization for external MCP clients and arbitrary recurring workflows are not built.

## 5. Modules and source ownership

| Area | Main implementation | Guide |
| --- | --- | --- |
| Hub | `apps/hub-web/app`, `components`, `lib` | [02](02_MODULE_INTERACTION_HUB_UI.md) |
| Context and connected apps | `apps/hub-api/src/context`, `connectors`, `people`, `projects` | [03](03_MODULE_CONTEXT_ENGINE.md), [31](31_CONNECTORS_IN_USE.md) |
| Personal skills | `apps/hub-api/src/routes/skills.ts`, `jobs/skill-mining.ts`, `cowork/morning-skill.ts` | [04](04_MODULE_SKILL_FORGE.md) |
| Agent execution | `apps/hub-api/src/workspace`, `devices`, `remote` | [05](05_MODULE_TASK_ORCHESTRATOR.md), [06](06_MODULE_WORKSPACE_AND_SURFACES.md) |
| Access, audit and retention | `apps/hub-api/src/lib`, `sharing`, `jobs` | [07](07_MODULE_GOVERNANCE_AUDIT_METRICS.md) |
| Assistant | `apps/hub-api/src/assistant` | [11](11_HOW_THE_ASSISTANT_WORKS.md) |
| Editor context | `apps/context-bridge`, `apps/hub-api/src/bridge` | [13](13_MODULE_CONTEXT_BRIDGE.md) |

## 6. Repository structure

See [17](17_REPOSITORY_STRUCTURE.md) for the directory map and [01](01_TECH_STACK_AND_ENVIRONMENT.md) for configuration, development and checks. Root [README](../README.md) is the setup entry point. `AGENTS.md` defines which docs must move with a code change.

## 7. Core domain model (shared across modules)

The authoritative shapes are `apps/hub-api/prisma/schema.prisma` and `packages/shared-types/src/`. This table describes their roles rather than maintaining a second incomplete TypeScript schema.

| Records | Role |
| --- | --- |
| `User`, `Session`, `AuthIdentity`, `EmailToken`, `AuthFlow` | Account/profile, hashed login sessions, external login identities and recovery/verification flows |
| Additional `User` rows with `ownerId` | Separate Ensemble spaces. Request `userId` is the open space; `accountId` is the signed-in person |
| `SpaceMember`, `Share`, `Contact`, `SpaceTransfer`, `PublicLink` | Membership, item shares, sharing contacts, ownership transfer and public read links |
| `Task`, `TaskPage`, `PageRevision`, `PageTemplate` | Work and its structured documents; task or standalone pages, nested pages, revisions and private templates |
| `Person`, `PersonIdentity`, `Project`, `Repo`, `Deliverable`, project links | Saved context and relationships; external identities are distinct from display names |
| `Artifact`, `ArtifactChunk`, `Extraction`, `ContextSuppression` | Saved source content, extracted metadata and deletion suppressions. Vector columns exist but semantic retrieval is not wired |
| `Skill`, `SkillVersion`, `SkillFeedback` | Current personal instruction, retained versions and feedback; current body is authoritative |
| `WorkspaceJob`, `Run`, `RunStep`, approvals and decisions | Durable assignment, attempts, evidence and exact continuations |
| `AssistantConversation`, `AssistantMessage`, `AssistantWorkflow` | Chat state, tool proposals/receipts and ordered dependent-write checkpoints |
| Files, meetings, plots, diagrams and desk records | Feature-owned content; their owning guides document storage and limits |
| `AuditLedger`, `MetricEvent`, included usage/period records | Action history, observations and metered included-model usage |

Most content is scoped by the open space's `userId`; sharing policy further limits what a guest may read/write. Credentials, personal reminders and personal settings do not become shared just because an item is shared. [28](28_ENSEMBLE_SPACES.md) and [29](29_SHARING.md) define these boundaries.

SQL account-lifetime foreign keys in migration `20261006010000_account_data_lifetime` stop late writes after account deletion. They are `NOT VALID` to preserve legacy rows and are intentionally absent from Prisma's relation model. Do not accept generated migration statements dropping them; `workspace/constraints.integration.test.ts` checks the allowed difference. This is not database row-level security.

## 8. Evidence and product measurement

Run traces and usage records are evidence about actual work; sample data and historical design targets are not measured productivity results. The Metrics page uses recorded events and identifies insufficient observations. Included AI credits are metered separately from provider cost estimates. See [07](07_MODULE_GOVERNANCE_AUDIT_METRICS.md) and [33](33_INCLUDED_AI.md).

## 9. Reading order

Start with this overview, [current capabilities](18_WHAT_IS_REAL.md), [setup](01_TECH_STACK_AND_ENVIRONMENT.md) and [repository map](17_REPOSITORY_STRUCTURE.md), then the guide for the feature you are changing. [The documentation index](README.md) lists current guides and historical designs separately.
