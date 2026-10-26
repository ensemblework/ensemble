# 00 · Ensemble overview

Ensemble is a shared workspace for a person and their agents: tasks, pages, projects, people, files, meetings and code in one place. The web app, desktop app, CLI and editor bridge share the same work context. It is source available under [FSL-1.1-MIT](../LICENSE.md).

This page maps what works today and its limits; each row links to the guide that owns the details.

## Principles

1. **Work keeps its context.** A task links a project, repositories, people, files, meeting notes and skills; its page and run history stay with it.
2. **The person chooses what comes in.** Connecting an app imports nothing. Content arrives only through explicit search, attach, upload or import.
3. **Several ways to work.** The Hub assistant operates the app, assigned agents do research or code work, and the CLI and editors read the same context.
4. **Model choice is explicit.** Personal API keys, subscriptions on a paired computer, or included models with a monthly allowance.
5. **Changes are reviewable.** Apply and Undo, run permissions, publishing approvals, revision checks and run evidence each have a job. A chat reply is not proof that an action succeeded.

## 1. Where Ensemble runs

| Form | Storage and execution | Guide |
| --- | --- | --- |
| Local development | `pnpm dev`: Hub :3000, API :4000, Python model/plot runtime :5055; Postgres and Redis in Docker | [README](../README.md), [01 §3](01_TECH_STACK_AND_ENVIRONMENT.md#3-local-development-setup) |
| Hosted web | Public signup, per-account data. The API runs on a home server behind a Cloudflare Tunnel (`infra/deploy/home`); file originals and plot tables are in private Azure Blob storage (`ENSEMBLE_FILE_STORAGE=azure-blob`). Code and the terminal run on the person's paired computer | [01 §8](01_TECH_STACK_AND_ENVIRONMENT.md#8-ci-and-deploys), [32 §2](32_FILES.md#2-where-files-live) |
| Desktop | Tauri shell, static Hub export, local Node API with embedded PGlite and in-process model adapters | [DESKTOP](DESKTOP.md) |
| CLI | Terminal UI on the same local runtime: tasks, chat, a read-only Ensemble Node tab, pairing, profiles, runner service, updates, editor MCP setup | [26](26_CLI.md) |
| Ensemble Node | A separate website (`ensemblework/ensemble-node`, `node.ensemblework.com`; testing `node-test.ensemblework.com`) for persistent AI teammates in direct chats, crews of the person's own nodes, and rooms with other people and their nodes. Its backend is hub-api's `node` module: same account, workspace tools, included models and credits; computer work is an ordinary job on the owner's paired computer | [35](35_ENSEMBLE_NODE.md) |
| Context Bridge | Read-only context tools over stdio, local HTTP or hosted `/mcp` with an `ens_` key; cannot apply actions or approve runs | [CONTEXT_BRIDGE](CONTEXT_BRIDGE.md) |
| Quick capture | Tauri tray app with a global shortcut; needs a running local API and capture authentication | [20_QUICK_CAPTURE](20_QUICK_CAPTURE.md) |

- Pairing a desktop or CLI with a hosted account does not replicate the hosted database. The paired computer claims jobs, answers Code and terminal requests and runs subscription calls; its included-model calls go through the hosted account ([25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md)).
- The hosted site stores no code from people's computers: the Code tab and a run's files are read from the computer when opened and relayed without being kept ([16](16_CODE_TAB.md), [25 §4.6](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#46-a-tasks-files-on-the-web)).
- Root `release.json` sets the version of every surface. Desktop updates are signed; OS code signing is not configured.

## 2. How work flows

```text
Person adds work / explicitly imports content
    → tasks, pages, files and linked context
    → Hub assistant action OR an assigned research/code job
    → Apply / review / Needs me when required
    → saved result, run evidence and history
```

The scheduler runs fixed product jobs only (reminders, morning briefs, retention, device leases); there are no user-defined recurring workflows ([05 §2](05_MODULE_TASK_ORCHESTRATOR.md#2-scheduled-work)).

## 3. Accounts, spaces and profiles

| Area | What works | Boundary |
| --- | --- | --- |
| Accounts | Signup, password and social login, email verification, recovery, profile, export, deletion | Hosted model, app and agent features need a verified email ([02 §16](02_MODULE_INTERACTION_HUB_UI.md#16-accounts-and-public-signup)) |
| Spaces | Separate owned spaces, switching, settings copy/sync, export, deletion | Each space is its own content scope ([28](28_ENSEMBLE_SPACES.md)) |
| Sharing | Space and item roles, shares, public links, live presence, page co-editing | Settings, credentials and reminders stay private ([29](29_SHARING.md)) |
| Profiles | Onboarding sets a profession profile, desk and modules. Engineer and Builder profiles can turn on Code, Workspace, Runs and Skills; every profile keeps Diagrams, Plots and Metrics (`packages/shared-types/src/modules.ts`) | The onboarding profile is set once; Settings cannot switch it. Hiding a module keeps its data |
| Appearance | Brand assets, light/dark/system, fonts, text scale, reduced motion, avatars, backgrounds | [BRAND](BRAND.md) |

## 4. Work surfaces

| Surface | What works | Limits | Guide |
| --- | --- | --- | --- |
| Today | Profession desk, briefing, focus and triage, reminders; add, move and resize tiles | Profile desk and alternate widget layout are separate systems | [02 §3.1](02_MODULE_INTERACTION_HUB_UI.md#31-today-morning-briefing) |
| Board | Collapsible Ensemble Kanban; custom page boards with named columns, drag ordering and board-scoped overview tiles | 1–20 columns per custom board; at most four overview tiles per board | [02 §3.2](02_MODULE_INTERACTION_HUB_UI.md#32-board-kanban) |
| Tasks and pages | Structured editor, nested notes, board/column assignment, collapsed board groups in Pages, mentions, links, compact comment overlays, AI blocks, embeds, co-editing | One custom board per page; custom columns do not change task execution status; embedded resources keep their own access rules | [02 §13](02_MODULE_INTERACTION_HUB_UI.md#13-document-style-pages) |
| Testing | Isolated live Hub/API and `ensemble-test` CLI, open signup, fast checks and `testing` → `main` promotion | Test CLI uses only the test backend with separate state/updates; no testing native, landing or Node website | [36](36_WEB_TESTING.md) |
| Page history and templates | Checkpoints with author and time, preview, restore, duplicate, private templates | 30 checkpoints per page, five-minute coalescing; 50 templates per space and profile; owner-only | [02 §13](02_MODULE_INTERACTION_HUB_UI.md#13-document-style-pages) |
| Context and projects | People and identities, projects, repositories, preferences, graph, profession records | The graph shows saved data only | [03](03_MODULE_CONTEXT_ENGINE.md), [02 §3.5](02_MODULE_INTERACTION_HUB_UI.md#35-context) |
| Meeting notes | Manual and imported notes, source links, requested summaries and action-item tasks | Imported notes are read-only; no recording or transcription | [03 §7](03_MODULE_CONTEXT_ENGINE.md#7-meeting-context) |
| Files | Private originals, previews, text extraction, hash-checked text/Office/sheet edits, conversion to pages, page export into Files | Edits are format-specific | [32](32_FILES.md) |
| Images in pages | `/image`, drop and paste (screenshots, HTML with `data:` images) with upload progress; resize handles with a keyboard slider, alignment, width presets, alt text, remove; kept as Files and shown on shared pages and public links; read by agents and kept through Markdown rewrites | 2 MB (2,097,152 bytes) per image, PNG, JPEG, GIF or WebP; no SVG; nothing is compressed; left out of Download | [32 §6](32_FILES.md#images-in-pages) |
| Diagrams | Source language, layout, visual editing, Mermaid import, SVG export | Editing needs a 1024 × 640 CSS-pixel window; smaller windows get a read-only preview | [21](21_BLOCK_DIAGRAMS_DSL.md) |
| Plots | Datasets, figure specs, code, exports; browser runtime on the web, server/native worker elsewhere | Uploads up to 20 MB | [20](20_PLOTS_DESIGN.md) |
| Skills and morning brief | Versioned personal instructions, brief personalization, completed-work learning | Learning writes validated versions after a notice; no review-first flow | [04](04_MODULE_SKILL_FORGE.md) |
| Workspace, Runs, Code, Needs me | Agent jobs, run evidence, pending decisions, code review, source control, passkey-unlocked terminal; stacked phone queues, wrapping answers, full-width run sheets and switchable Code panels | §9 | [06](06_MODULE_WORKSPACE_AND_SURFACES.md), [16](16_CODE_TAB.md), [02 §4](02_MODULE_INTERACTION_HUB_UI.md#4-interaction-patterns) |
| Completed and Trash | Review, reopen, restore, pin; retirement and purge | Separate retention windows | [07 §1.1](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#11-completed-and-deleted-data-retention) |
| Metrics | Model calls, credits and recorded events, filtered by provider and date | Calls without token reports stay visible; external plan balances are not read | [07](07_MODULE_GOVERNANCE_AUDIT_METRICS.md) |
| Search and navigation | Compact search, Jump to, shortcuts, phone navigation | Bounded, access-scoped results | [02](02_MODULE_INTERACTION_HUB_UI.md) |
| Connect and Settings | App grants, MCP connections, models, run profiles, appearance, devices, data controls | | [02](02_MODULE_INTERACTION_HUB_UI.md), [31](31_CONNECTORS_IN_USE.md) |

## 5. Assistant

The Hub assistant operates the app through typed tools. Built-in playbooks (`apps/hub-api/src/assistant/skills/*.md`) route each request to a small toolset; saved personal skills add instructions. [11](11_HOW_THE_ASSISTANT_WORKS.md) explains the loop; [34](34_ASSISTANT_ACTIONS.md) maps every tool.

| Capability | What works |
| --- | --- |
| Tasks and records | Create and update tasks, people, projects, repositories and profession records; comments, Trash, conversions, history. Clearing the board or a filtered set is one `hub_delete_tasks` call with one Undo |
| Agent assignment | Assign to Ensemble's agent, Claude Code, Codex, Cursor's agent, GitHub Copilot, Grok Build, OpenCode, Gemini CLI or Antigravity on a paired computer or this server, with a run profile; waits for Apply, then queues |
| Open workspace | Reads surface IDs, selected and visible records, filters and document selection |
| Layouts and documents | Today desks, Context panels, Board overview, widget layouts; block-level page edits after revision and schema checks |
| Dependent actions | `hub_run_workflow`: 2–12 ordered writes, one Apply, references to earlier results, durable per-step receipts |
| Connected apps | Each prompt names the space's connected apps; `hub_list_connections` lists them without tokens; naming an app loads its tools. Guests in a shared space see none |
| Connected items and imports | Search, read, attach, refresh, make tasks, import or merge people, link project containers; preview, start, follow, cancel or undo board imports |
| Files | Read text, hash-checked original and sheet edits, convert to pages, export pages into Files |
| Skills, settings, models | Versioned skill edits; allowlisted settings; provider, model and effort choice |
| Calendars | Google and Outlook: list, create, update, cancel, RSVP, invites, recurrence, availability |

- Hub writes run at once by default (Settings → Assistant → "Just do it (undoable)"); Preview makes them wait. Connected-app writes, settings, workflows and agent assignments always wait for Apply.
- An interrupted workflow step with an unknown outcome is not replayed. Starting an import is not finishing it.
- There is no native email, Slack or Teams send. Calendar invitations can notify guests; some connected-item updates and vendor MCP tools write after Apply.
- Surface context is structured app state, not screenshots or DOM access. Credentials, account deletion, sharing permissions and folder trust are human-only.
- Connected-app content is read only when the person asks for remote content or gives an item link (`assistant/apps.ts`). The attachment button uploads into Files or lists saved Files and searches no connector.
- Files attached in chat, in Ensemble Node or to a task reach the model as text, and as pictures for models that read images; plots on a task page arrive as settings and data ([38](38_AGENT_READABLE_FILES.md)).
- Replies, receipts and previews name records by title and link to them; ids stay in tool data and link targets, and show only when the person asks ([11 §4.1](11_HOW_THE_ASSISTANT_WORKS.md#41-records-by-title-ids-for-machines)).

## 6. Connected apps and imports

| Path | What works | Guide |
| --- | --- | --- |
| Connect an account | Saves the person's grant or token; imports nothing. The store lists connected apps first and guides each way of connecting | [31 §3](31_CONNECTORS_IN_USE.md#3-ways-to-connect) |
| Sync people | Bounded contact metadata from Gmail, Outlook, calendars, Slack, Teams and GitHub; filters service identities; no bodies, no tasks | [03 §2](03_MODULE_CONTEXT_ENGINE.md#2-connectors) |
| Scheduled fetch | Reads nothing: `fetchAll(…, "schedule")` in `connectors/sync.ts` returns at once | [05 §2](05_MODULE_TASK_ORCHESTRATOR.md#2-scheduled-work) |
| Native connected items | Explicit search/read, attach, add task, people, supported write-backs (for example Zotero notes) | [31](31_CONNECTORS_IN_USE.md) |
| Vendor MCP | The vendor's enabled tools with schema, approval and access checks. A server holding personal data needs sign-in or a token; one that answers without an account shows "Connected · public data only". AWS Knowledge, Context7 and Exa need no account | [03 §2.2](03_MODULE_CONTEXT_ENGINE.md#22-remote-mcp-connectors) |
| Board imports | Native board sources and uploaded exports; preview, mapping, background progress, rerun, undo | [27](27_IMPORTS.md) |
| Meeting imports | API-key adapters or vendor tools; source attribution; bounded batches | [03 §2.3](03_MODULE_CONTEXT_ENGINE.md#23-meeting-notes-sources) |

A catalog entry is a connection option, not a promise of native search, an importer or sync.

## 7. Core domain model (shared across modules)

`apps/hub-api/prisma/schema.prisma` and `packages/shared-types/src/` are authoritative. Roles:

| Records | Role |
| --- | --- |
| `User`, `Session`, `AuthIdentity`, `EmailToken`, `AuthFlow` | Account and profile, hashed sessions, login identities, recovery and verification |
| Extra `User` rows with `ownerId` | Spaces. Request `userId` is the open space; `accountId` is the signed-in person |
| `SpaceMember`, `Share`, `Contact`, `SpaceTransfer`, `PublicLink` | Membership, item shares, contacts, ownership transfer, public links |
| `Task`, `TaskPage`, `PageBoard`, `PageRevision`, `PageTemplate` | Work and its documents, page-board/column membership, board-specific overview tiles, nesting, revisions, private templates |
| `Person`, `PersonIdentity`, `Project`, `Repo`, `Deliverable`, project links | Saved context; external identities are separate from display names |
| `Artifact`, `ArtifactChunk`, `Extraction`, `ContextSuppression` | Saved source content, extracted metadata, deletion suppressions. Vector/tsvector columns are unused |
| `Skill`, `SkillVersion`, `SkillFeedback` | Current personal instruction (authoritative), versions, feedback |
| `WorkspaceJob`, `Run`, `RunStep`, `Approval`, `AgentDecision` | Assignment, attempts, evidence, exact continuations |
| `AssistantConversation`, `AssistantMessage`, `AssistantWorkflow` | Chat, tool proposals and receipts, dependent-write checkpoints |
| `ModelCredential`, `ConnectorApp`, `McpConnection`, `ApiToken`, `Device`, `DevicePairing` | Encrypted keys and grants, API tokens, paired computers |
| `Document`, `MeetingNote`, `PlotDataset`, `Plot`, `BlockDiagram`, `WidgetLayout`, desk records | Feature content; storage and limits are in the owning guide |
| `AuditLedger`, `MetricEvent`, `InteractionEvent`, `IncludedUsage`, `IncludedCreditBalance`, `IncludedPeriod` | Action history, observations, interaction log, included-model usage and allowance |

Content is scoped by the open space's `userId`; sharing policy limits what a guest may read or write. Credentials, reminders and personal settings never become shared with an item ([28](28_ENSEMBLE_SPACES.md), [29](29_SHARING.md)).

Migration `20261006010000_account_data_lifetime` adds SQL foreign keys that stop writes after account deletion. They are `NOT VALID` (existing rows are not checked) and absent from Prisma's relation model. Never accept generated migrations that drop them; `src/workspace/constraints.integration.test.ts` checks the allowed difference. This is not row-level security.

## 8. Models and credits

- Personal API keys are checked and stored encrypted per account. Provider discovery is cached with explicit refresh. Provider and model are always named together; effort levels are validated.
- Included AI is an operator-configured provider: **20,000 credits per account per UTC month** (`DEFAULT_MONTHLY_CREDITS`), within the operator's global monthly ceiling and a per-call reservation. Enabled deployments decide which models appear.
- Included models work on the web, on Ensemble Node and on a paired desktop or CLI, from one list and one allowance per account. A local-only computer must connect first; no Azure key is copied to it.
- Subscriptions on paired computers are a separate source. External coding engines use their own local sign-in.
- Run usage separates reported tokens, included credits, estimated prices and unknown prices.

Details: [01 §6](01_TECH_STACK_AND_ENVIRONMENT.md#6-model-usage-policy), [30](30_ENGINES.md), [33](33_INCLUDED_AI.md).

## 9. Assigned agents and Code

- Assignment creates a durable workspace job that the API or a paired computer claims and runs. Research writes the task page; code work runs in a chosen folder or checkout. Engines: Ensemble, Claude Code, Codex, Cursor, GitHub Copilot, Grok Build, OpenCode, Gemini CLI, Antigravity ([30](30_ENGINES.md)).
- Run profiles hold model, thinking level, context window, mode, sandbox, network and git permissions, destination and budgets. Engines: Claude Code, Codex, Cursor, GitHub Copilot, and through one ACP runner Grok Build, OpenCode, Gemini CLI and Google Antigravity (installed by Ensemble). Each coding agent's menus list the models its computer reports, with that model's own levels, windows and fast mode (Claude's 1M window and fast mode, Codex's levels and fast tier, Copilot's long context), and Settings shows Claude's and Codex's 5-hour and weekly usage. Conflicting jobs run one at a time. Needs me holds exact pending decisions; commands that only read inside the folder never ask, and a folder the person trusts is trusted in the engine too. Publishing uses saved approvals.
- A stop or restart keeps partial work and marks the interruption instead of claiming success; a paired computer that comes back reattaches a run that kept going and carries on one it lost to a restart, at most twice. Runs keep Results, Files (including those changed outside the run's folder) and Traces.
- On the web, code review, editing, source control and the passkey-unlocked terminal go through a paired computer; ordinary accounts cannot reach the server's filesystem or terminal.
- OS sandbox: Seatbelt (macOS), bubblewrap or Landlock (Linux), the sandbox-runtime account (Windows).

Details: [05](05_MODULE_TASK_ORCHESTRATOR.md), [06](06_MODULE_WORKSPACE_AND_SURFACES.md), [16](16_CODE_TAB.md), [24](24_DESKTOP_SANDBOXING.md), [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md).

## 10. Data controls and measurement

- Settings → Data → Danger zone: type a scope-specific phrase, then confirm again. Deletion and its receipt are one transaction. Everything erases usage details, metrics, baselines and audit payloads; used credits stay charged ([07 §6](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#6-data-erasure)).
- `IncludedCreditBalance` is keyed by an HMAC of the account email, so erasing a workspace or recreating the account does not renew the allowance.
- Metrics uses recorded events and says when observations are too few. Included credits are metered apart from provider cost estimates.
- The Hub logs how signed-in people use it (screens, active time, named actions; never content) for the operator's dashboards ([07 §1.3](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#13-the-operators-interaction-log-and-dashboards)).

## 11. Not supported

| Area | Boundary |
| --- | --- |
| Recurring workflows | Fixed product schedules only |
| Semantic retrieval | Vector fields are unused; retrieval is bounded substring matching and direct reads |
| Skill Forge mining | `apps/skill-forge` is a stub; no bulk mining of past work |
| Audio, video, scans | No OCR, transcription or visual understanding |
| File redesign | Format-specific edits only |
| Record and settings control | Registered operations and allowlisted settings only; no SQL, secret or permission changes |
| MCP OAuth server | Ensemble is an OAuth client of vendor MCP servers; external MCP clients use `ens_` keys |
| Audit hardening | Hash-linked ledger only: no INSERT-only role, full content-hash verifier, OpenTelemetry export or `eval/` corpus |

`apps/hub-api/src/bridge/gaps.ts` reports Outlook/Teams connectors and a redaction helper as missing, but both exist (`connectors/microsoft.ts`, `lib/redact.ts`).

## 12. Source map

| Area | Main implementation | Guide |
| --- | --- | --- |
| Hub | `apps/hub-web/app`, `components`, `lib` | [02](02_MODULE_INTERACTION_HUB_UI.md) |
| Context and connected apps | `apps/hub-api/src/context`, `connectors`, `people`, `projects` | [03](03_MODULE_CONTEXT_ENGINE.md), [31](31_CONNECTORS_IN_USE.md) |
| Personal skills | `apps/hub-api/src/routes/skills.ts`, `jobs/skill-mining.ts`, `cowork/morning-skill.ts` | [04](04_MODULE_SKILL_FORGE.md) |
| Agent execution | `apps/hub-api/src/workspace`, `devices`, `remote` | [05](05_MODULE_TASK_ORCHESTRATOR.md), [06](06_MODULE_WORKSPACE_AND_SURFACES.md) |
| Access, audit, retention | `apps/hub-api/src/lib`, `sharing`, `spaces`, `jobs` | [07](07_MODULE_GOVERNANCE_AUDIT_METRICS.md) |
| Assistant | `apps/hub-api/src/assistant` | [11](11_HOW_THE_ASSISTANT_WORKS.md) |
| Ensemble Node | `apps/hub-api/src/node`, `apps/cli/src/tui/node.ts`; the website in `ensemblework/ensemble-node` | [35](35_ENSEMBLE_NODE.md) |
| Files | `apps/hub-api/src/files`, `apps/hub-web/components/files` | [32](32_FILES.md) |
| Editor context | `apps/context-bridge`, `apps/hub-api/src/bridge` | [CONTEXT_BRIDGE](CONTEXT_BRIDGE.md) |

Directory map: [17](17_REPOSITORY_STRUCTURE.md). Configuration, development and CI: [01](01_TECH_STACK_AND_ENVIRONMENT.md). Setup: root [README](../README.md). Which docs move with which code: `AGENTS.md`. All guides: [index](README.md).
