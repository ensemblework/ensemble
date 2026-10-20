# 18 · What Ensemble does today

**Current-state audit: 18 Oct 2026**, against the code after the assistant workspace-actions and included-model desktop/CLI changes. This is an implementation inventory. “Implemented” means a working code path exists; it does not mean every provider, OS installer or production account was exercised during this documentation audit. Historical release notes have been removed from this page so old limitations do not masquerade as current behavior.

## Starting it

Follow the root [README](../README.md) for prerequisites and setup. `pnpm dev` starts Hub :3000, API :4000 and the Python runtime :5055; `pnpm db:migrate` applies migrations without resetting data. Desktop/CLI use their own local runtime and embedded database. Do not start a second Python runtime beside `pnpm dev`.

## Product and accounts

| Area | Implemented behavior | Boundary / source |
| --- | --- | --- |
| Accounts | Public signup, password and configured social login, verification, recovery, profile, export/deletion | Hosted model/app/agent features require verified email; `routes/auth*.ts`, [02](02_MODULE_INTERACTION_HUB_UI.md#16-accounts-and-public-signup) |
| Spaces | Separate owned spaces, switching, settings copy/sync, export/deletion | Separate content scope, not a shared global graph; [28](28_ENSEMBLE_SPACES.md) |
| Sharing | Space/item roles, incoming/outgoing shares, public links, live presence and document co-editing | Private settings, credentials and reminders remain private; [29](29_SHARING.md) |
| Profile fit | Profession desks and Context tabs; engineer/Builder profiles can enable Code, Workspace, Runs and Skills | Other profiles retain applicable records, Diagrams, Plots and Metrics; hiding a feature does not erase its data |
| Appearance | Shared brand assets, light/dark/system, fonts, text scale, reduced motion, avatars and backgrounds | `packages/brand`, appearance settings and [BRAND](BRAND.md) |

## Work surfaces

| Surface | Implemented behavior | Current limit |
| --- | --- | --- |
| Today | Profession desk, briefing, focus/triage, reminders, add/remove/rearrange/resize tiles | Profile desk and alternate widgets are distinct layout systems |
| Board | Task creation, priority/order, filters, grouping, assignment and overview tiles | Overview strip: at most four fixed-size tiles |
| Tasks and pages | Rich structured editor, nested standalone pages, kind-tinted mention chips, links that open on click (hover or Alt+Enter to edit), comments/AI blocks, file/diagram/plot embeds | Referenced resources retain their own space/access rules |
| History and templates | Page checkpoints with author/time, preview/restore, duplicate and private templates | Up to 30 checkpoints, five-minute coalescing; up to 50 templates per space/profile; owner-only history/templates |
| Context | Saved people/identities, projects, repos, preferences, graph and profile-specific records/tabs | Graph reflects saved data; it is not an automatic provider crawler |
| Meeting notes | Editable manual notes, imported source notes, source links, requested summaries/action-item tasks and task links | Imported source notes are read-only; no recording/transcription service |
| Completed and Trash | Review, reopen, restore, pin and configured retirement/purge | Completed-work and Trash windows are separate; [07](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#11-completed-and-deleted-data-retention) |
| Search/navigation | Compact search and Jump to, keyboard shortcuts, phone navigation | Query results are bounded and access-scoped |

The owning UI and API paths are mapped in [02](02_MODULE_INTERACTION_HUB_UI.md).

## Assistant

The Hub assistant operates the app through typed tools. Built-in Markdown playbooks route a request to a small relevant toolset; saved personal Skills supply user instructions. The dock uses the same action layer across supported pages. [11](11_HOW_THE_ASSISTANT_WORKS.md) explains the loop; [34](34_ASSISTANT_ACTIONS.md) is the tool/action map.

| Capability | Implemented behavior |
| --- | --- |
| Tasks and records | Create/update work, people, projects, repositories and supported profession records; manage supported comments, Trash, conversions and resource history. Clearing a board or a filtered set of tasks is one `hub_delete_tasks` change with one Undo |
| Agent assignment | Assign a task to Ensemble's agent, Claude Code, Codex or Cursor's agent on a paired computer or this server, under the default or a named run profile; waits for Apply, then goes through the normal job queue |
| Open workspace | Read supported surface IDs, selected/visible records, filters and document selection through scoped APIs |
| Layouts | Manage native Today desks, Context panels, Board overview and alternate widget layouts with the relevant version checks |
| Precise documents | Read block paths/revision; replace exact text or insert/replace/delete blocks after schema validation |
| Dependent actions | `hub_run_workflow`: 2–12 ordered writes, one Apply, backward result references and durable successful-step receipts |
| Connected apps | Every prompt names the apps connected in the space (how, account, which tools reach each); `hub_list_connections` lists them in detail without tokens. A message naming a connected app loads its tools. Not shown to guests in a shared space |
| Connected relationships | Search/read, attach/detach/refresh, turn items into tasks, import people, link/unlink project containers and merge people |
| Board imports | Preview connected-source or uploaded-export imports, start after Apply, read progress, cancel/undo |
| Files | Read supported text, hash-checked original-file edits, supported sheet edits, convert to pages and export pages into Files |
| Personal skills | Read/create/edit/enable/disable/restore/Trash through versioned routes |
| Settings/models | Find/read/update allowlisted settings and choose available provider/model/effort; appearance updates apply live |
| Calendars | Google/Outlook list/create/update/cancel/RSVP, attendees/invites, supported recurrence and availability reads |

Hub writes run at once by default ("Just do it (undoable)" in Settings → Assistant); with Preview or Needs me they wait. Connected-app writes, settings changes, workflows and agent assignments always wait for Apply. Starting an import is not finishing it. An unknown interrupted workflow step is not replayed automatically. External calendar invitations can notify guests; general native mail/Teams/Slack sending is not offered.

Surface context is structured app state, not screenshots or unrestricted DOM access. Security credentials, account deletion, sharing permissions, folder trust and similar controls remain human settings. “Manage records” means supported domain operations, not arbitrary database access.

## Connectors and imports

| Path | Current behavior | Guide |
| --- | --- | --- |
| Connect an account | Save that person's grant/token; no automatic content import. The store lists connected apps first and shows a step-by-step guide for each way of connecting; guide steps follow vendor pages as known in Oct 2026 and were not re-checked live | [03](03_MODULE_CONTEXT_ENGINE.md), [31 §3](31_CONNECTORS_IN_USE.md#3-ways-to-connect) |
| Sync people | Bounded contact metadata from Gmail, Outlook, calendars, Slack, Teams and GitHub; filters service/bulk identities | [03 §2](03_MODULE_CONTEXT_ENGINE.md#2-connectors) |
| Scheduled fetch | Returns without provider reads, even if a legacy fetch slot is enabled | [05 §2](05_MODULE_TASK_ORCHESTRATOR.md#2-scheduled-work) |
| Native connected items | Explicit search/read, attach to task/project, add task, people and supported source updates (for example Zotero references and reading-list collections, with notes posted back; Zotero is tested against documented API shapes only) | [31](31_CONNECTORS_IN_USE.md) |
| Vendor MCP | Connected vendor's enabled tools, with schema/approval/access checks. A catalog server that holds your data is signed in to (or given a token); if it answers without an account and has no sign-in it shows as "Connected · public data only". Only AWS Knowledge, Context7 and Exa connect with no account by design. Hugging Face shows the signed-in username; a web page from a vendor's sign-in (Meta's) is reported by host. These were checked against in-process fakes, not the live vendors | Catalog availability and vendor grants vary; not equivalent to native sync/import. [03 §2.2](03_MODULE_CONTEXT_ENGINE.md#22-remote-mcp-connectors) |
| Board imports | Native supported board/container sources and uploaded exports; preview, mapping, background progress, rerun/undo | [27](27_IMPORTS.md) |
| Meeting imports | Explicit supported API-key adapters or vendor tools; source attribution and bounded batch import | [03](03_MODULE_CONTEXT_ENGINE.md#23-meeting-notes-sources) |

The full connector catalog is a connection inventory, not a promise that every app has native search, an importer or background sync. Existing saved artifacts remain available; reading a transient search result does not save every match.

## Files, diagrams and plots

[Files](32_FILES.md) stores private originals with format-aware previews and extraction. Originals are on the database row by default; the hosted site keeps them, and plot tables, in a private Azure Blob container (`ENSEMBLE_FILE_STORAGE=azure-blob`) and its API runs on a home server behind a Cloudflare Tunnel (`infra/deploy/home`). Plot uploads are capped at 20 MB. The hosted site stores no code from people's computers: the Code tab and a run's files are read from the computer when opened, and relayed without being kept ([16](16_CODE_TAB.md), [25 §4.6](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md#46-a-tasks-files-on-the-web)). Supported text/Office/sheet edits preserve the file record and use stale-content checks. Page conversion and export are available; browser downloads keep tables (a real grid in PDFs) and inline formatting, browser export-back can preserve a supported source template, while assistant server export rebuilds a document. Complex spreadsheets and original Office edits have explicit restrictions.

[Diagrams](21_BLOCK_DIAGRAMS_DSL.md) has a source language, parsing/layout, visual editing, Mermaid import and SVG export. Small windows show a read-only pan/zoom/preview; full editing needs 1024 × 640 CSS pixels. [Plots](20_PLOTS_DESIGN.md) supports datasets, saved figure specs, code and exports; hosted browser plotting uses its browser runtime, with a separate server/native worker path.

Image previews, downloadable audio/video and extracted text do not imply OCR, scanned-document understanding or audiovisual comprehension.

## Models and credits

- Personal API keys are checked/stored encrypted per account, with cached provider discovery and explicit refresh. Provider and model are named together; supported effort levels are validated. A catalog entry is not a guarantee of account quota.
- Included AI is an operator-configured provider. Default account allowance is **20,000 credits per UTC month**, subject to the operator's global monthly ceiling and per-call reservation. Enabled deployments determine which models appear.
- Included models work on the hosted app and through a paired desktop/CLI account. Local-only use requires connecting the computer; no Azure key is copied to it.
- Supported subscriptions on paired computers are another source, separate from API keys and included funding. External coding engines use their own local sign-in.
- Run usage distinguishes actual token reports, included credits, estimated prices and unknown prices. See [01](01_TECH_STACK_AND_ENVIRONMENT.md#6-model-usage-policy), [30](30_ENGINES.md), [33](33_INCLUDED_AI.md).

## Assigned agents and Code

Assignment persists a workspace job. The API or a paired computer claims and executes it; it is not just a placeholder queue. Research writes the task page; code runs work in a selected folder/checkout. Supported engines include Ensemble, Claude Code, Codex and Cursor; own-app/terminal handoffs have separate behavior ([30](30_ENGINES.md)).

Profiles retain model, mode, sandbox/network/git permissions, destination and budgets. Conflicting jobs serialize. Needs me holds exact pending decisions; publishing uses saved approvals. Stops/restarts preserve partial work and mark unknown interruption instead of claiming success. Runs retain Results, Files and Traces with linked follow-up feedback.

Code review, editing, source control and a passkey-unlocked human terminal work through a paired computer on the web. Ordinary public accounts cannot access the hosted server's filesystem or terminal. Native sandbox support uses Seatbelt, bubblewrap/Landlock or the Windows sandbox runtime depending on the machine. See [06](06_MODULE_WORKSPACE_AND_SURFACES.md), [16](16_CODE_TAB.md), [24](24_DESKTOP_SANDBOXING.md), [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md).

## Desktop, CLI and editor access

- Tauri desktop packages a static Hub and local API/PGlite; the CLI uses the same local runtime. Local state is not automatic full hosted-data replication.
- CLI provides task/chat tabs, pairing, profiles/models, runner service controls, updates and editor MCP setup ([26](26_CLI.md)).
- Context Bridge exposes read-only tools over stdio/local HTTP/hosted `/mcp` with an `ens_` key. It cannot apply assistant actions or approve a run ([setup](CONTEXT_BRIDGE.md)).
- `release.json` is the canonical version. Desktop update artifacts are signed; updater signing is separate from operating-system code signing/notarization. Availability of a particular published build must be checked on the download/release page.
- Quick capture has a Tauri tray/global-shortcut implementation; it needs a running local API and valid capture authentication ([guide](20_QUICK_CAPTURE.md)).

## Not implemented / deliberately limited

| Area | Boundary |
| --- | --- |
| Arbitrary recurring workflows | Product-specific schedules exist; no general user routine scheduler |
| Semantic retrieval | Vector/tsvector schema fields exist; current shared retrieval uses bounded substring/read paths |
| Historical Skill Forge | Package stub; no bulk first-run/nightly historical mining or auto-discovered procedural skills |
| Skill review proposals | Retention learning applies validated versions after notice; review-first flow remains a design |
| Profession change | Planned one-time change is not a shipped general profile switch |
| Audiovisual/scanned input | No OCR, audio/video transcription or broad visual understanding |
| Arbitrary file redesign | Supported format-specific edits only; no general visual slide/document redesign from chat |
| Universal record/settings control | Only registered operations and allowlisted settings; no arbitrary SQL or secret/permission changes |
| External MCP OAuth server | Ensemble can be an OAuth client to vendor MCP; external clients use Ensemble keys, not a shipped general OAuth authorization-server flow |
| Immutable audit/OTel/eval corpus | Hash-linked app history exists; no INSERT-only deployment role, full content-hash verifier, OpenTelemetry export or populated `eval/` corpus |

Historical designs under [design/](design/) may contain partly shipped or superseded ideas. They are not alternative current product guides.

## Verification scope

This documentation pass reads source and checks documentation links, referenced paths and consistency; it does not run external provider writes or release new application code. Prior feature verification remains in PR/CI evidence. Automated fixture/HTTP tests establish their tested contracts, not universal live-provider success or small-model reliability on every prompt.

One code follow-up remains: `bridge/gaps.ts` contains old diagnostic messages about connector/redaction availability. Those messages lag the current code; the bridge itself remains read-only. This Markdown-only cleanup does not change its runtime diagnostics.

## Data controls and usage (checked 20 Oct 2026)

- The assistant attachment button lists saved Files and inserts an ID-backed file mention; it makes no connector search. Task/project live app-item searches remain explicit actions.
- Settings → Data uses a Danger zone with a scope-specific phrase typed by hand and a separate final modal confirmation. Deletion/receipt are transactional. Everything erases usage details, metrics, baselines and old audit payloads; credits already consumed remain charged.
- Independent monthly HMAC-keyed balances prevent workspace erasure or same-email account recreation from renewing the default 20,000-credit allowance. Legacy charges are recovered only where surviving metric evidence supports them. The public privacy page describes this short-lived credit-enforcement record.
- Metrics filters the daily chart, model/purpose totals and recent calls by provider and date. Calls lacking token reports remain visible. Local/subscription response data is used where available; external plan balances and usage outside Ensemble are not queried.
- The board toolbar has a bounded compact search field. Web and packaged native UI share these components.

The assistant’s connected-app instructions explicitly require a request for remote content or an app item link before searches, reads, recent-item listings, sync/import or MCP content access. General file questions default to saved Ensemble data; connection metadata alone grants no content request (`assistant/apps.ts`, `assistant/tools/app-items.ts`).

Run-profile naming in Assign uses synchronous focus/selection so immediate typing retains the first character; the regression deliberately types before any timer can run.

Opening Metrics automatically retires usage left behind by an older Everything deletion, after preserving known monthly charges; later work survives and no second workspace deletion is required. An empty provider result also retains the actual selected provider in the dropdown. Checked 20 Oct 2026 with HTTP/UI regressions.
