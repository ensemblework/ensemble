# 18 · What is real, and what is still a placeholder

Updated 2026-09-27. Corrections on 2 Oct and 5 Oct 2026 come from reading the code, not from a new live run, except where a line says it was run. Read this before trusting a button. "Real" here means the code talks to the actual service and was exercised against it; where a live test was not possible, the entry says so.

**Checked 6 Oct 2026:** public signup/OAuth/recovery and hosted safety passed automated HTTP/PGlite tests; Hub and landing production builds passed. Live Gemini plain completion worked, but the deployed assistant's old catalog was rejected for a boolean `exclusiveMinimum`; the draft-7 catalog fix is in code and has a complete-catalog regression. Post-deploy consent/email/assistant checks still require configured provider accounts. The route inventory covers all endpoints for generic gates but currently records 155 explicit resource-contract gaps; this is not a complete API audit. The wider local Python plot worker could not be started, so rendering was not re-verified.

## Changes after review (2 Oct 2026)

The old placeholder said Assign to agent records a job and nothing runs it. That was wrong. `apps/hub-api/src/workspace/worker.ts` claims queued jobs, and `workspace/agent.ts` runs them. The queue is started from `index.ts`. Model turns still go to agent-runtime. See **Code on this computer**. The rest of this page was not re-tested on that date.

## Starting it

```bash
pnpm infra:up
pnpm db:migrate
pnpm dev
```

`pnpm infra:up` starts Postgres and Redis. `pnpm db:migrate` applies migrations and does not reset the database. `pnpm dev` starts the API on port 4000, the site on port 3000, and the agent on port 5055.

`pnpm dev` now starts the model runtime too. `scripts/agent-dev.sh` creates `apps/agent-runtime/.venv` on first run with any Python ≥ 3.11 it can find (the macOS system Python 3.9 is too old).

Open http://localhost:3000. You are sent to **/login**. In development, the first account claims localhost placeholder data and lands on **/start**. Hosted public registration never claims placeholder data.

`ENSEMBLE_DEV_AUTH_BYPASS=true` still gives the old no-login mode for scripts.

## Real today

### Accounts and sign-in
- Sign-up, sign-in, sign-out, profile editing, and password changes (Settings → Account). Passwords are scrypt-hashed; sessions are an httpOnly cookie whose SHA-256 is the only thing stored.
- Public signup remains open after the first account. `ENSEMBLE_SIGNUP_MODE` provides `open`, `allowlist` and `closed`. Google/GitHub/Microsoft identity login, 4-character email verification codes, password reset, linked login methods, account export and deletion are implemented in `routes/auth.ts` and `routes/auth-oauth.ts`; see [02 §16](02_MODULE_INTERACTION_HUB_UI.md#16-accounts-and-public-signup). Provider buttons require separate configured `AUTH_*` clients; email requires Resend and Turnstile. Microsoft email ownership is verified by Ensemble, not assumed from an email/username claim. Existing private password accounts are grandfathered as verified by the public-signup migration; existing onboarded accounts are grandfathered as profile-complete by the profile migration.
- Landing `/privacy` and `/terms` are starter policy pages, not a claim of legal review. Registration links no longer describe an invitation requirement; GitHub links are enabled for the now-public repository.
- Every API route requires a session, a personal token (`Authorization: Bearer ens_…`), or the internal token agent-runtime uses. CORS only answers the Hub's own origin.
- The live event stream uses a one-use ticket, because it connects to `127.0.0.1` and the cookie belongs to `localhost`.

### Models
- The model runtime (`apps/agent-runtime`) is the only process that holds model keys (docs/11 §5). hub-api sends the provider and model a tier names; the runtime resolves the key and calls that vendor.
- **Google Gemini**: live. Tested with `gemini-3.5-flash-lite` for chat with tool calls, plain completions, and JSON triage. It is the default on every tier because it is the cheapest; `gemini-2.5-flash-lite` is no longer offered to new keys. The request goes to Google's OpenAI-compatible endpoint with the key as a bearer token.
- **Cursor**: the key is validated and its models listed live (`api.cursor.com/v0/models`). Cursor runs agents, not a chat endpoint, so choosing it for the chat gives a clear error. It is meant for delegated runs (the next step).
- **OpenAI, OpenRouter, Ollama, Anthropic (native Messages API with tools), GitHub Copilot (token exchange)**: the adapters are written. They were not called live, because no keys for them were available.
- **Settings → Models**: paste a key per provider. It is checked against the provider before it is saved, then stored encrypted per account. A key you paste wins over the server's `.env` key. Hosted public accounts cannot borrow server env/CLI credentials or host Ollama; only verified exact `ENSEMBLE_OPERATOR_EMAILS` accounts can. Dev and desktop retain local fallback behavior. The model catalog is fetched live from each provider. There is a **Test** button per tier.
- The chat assistant uses the tier's provider. Verified: "add a todo…" produced a real `hub_create_tasks` call through Gemini, held for your approval because the write policy is "preview".

### Connectors (read-only)
Each one calls the real API; triage turns asks into **proposed todos** on Today.

| Source | How you connect | What it reads | Live-tested |
|---|---|---|---|
| Gmail | **Sign in with Google** (one approval also covers Calendar) | Messages since the last fetch (look-back window after a gap), minus promotions, social and forums. Quoted history stripped. | Up to the host’s one-time Google client. After that, the button is the whole flow. |
| Google Calendar | Same Google sign-in | Last week to three weeks out → the Today calendar | Same |
| GitHub | **Sign in with GitHub** (OAuth app) *or* paste a token; `gh auth token` fallback | Your open PRs, PRs waiting on your review, issues assigned to you. Review requests and assignments become proposals directly. | Token validation only: a bad token is rejected by GitHub. `gh` is not installed on this machine. |
| Slack | Paste a user token | DMs, group DMs, and channels you list in Settings | Token validation only |
| Linear | Paste a personal API key | Open issues assigned to you → proposals | Key validation only |
| Outlook, Outlook calendar, Teams | — | Marked "coming later" in the UI | — |

- **Triage** (the classifier prompt) runs on the low tier. Verified with Gemini: an email asking for load-test numbers "before Thursday" became "Send p95 load test numbers to Rahul", p1, due that Thursday, with the exact sentence quoted. A newsletter in the same batch was skipped. If no model is reachable, a conservative rule-based fallback runs instead, and the extraction row records which one decided.
- **Fetch now**, the per-source **Sync** button, **Sync calendar** on Today, and the assistant's `hub_fetch_now` tool all run the same sync.
- **Scheduled fetching** runs at the times set in Settings → Fetching, in your time zone, once per slot. It is an in-process scheduler in hub-api.
- People and repos are learned from what is read. Anything you deleted stays suppressed. Tokens and secret-looking strings are redacted before storage. Connector tokens are encrypted at rest.

### Needs me: a real router for other agents' permission prompts
- A hook in **Cursor** (shell commands and MCP calls), **Claude Code** (every permission prompt), or **VS Code Copilot agent** (tool calls that change things) holds the tool call open and posts it to Ensemble. The card appears on Needs me live. **Allow once**, **Allow for this session**, **Always allow**, or **Deny** (with a reason) goes back to that exact call, in each tool's own output format.
- Verified end to end with the real hook script and each editor's payload shape. Cursor received `{"permission":"allow"}`; the same command in the same session was then allowed at once by the rule. Claude Code received a `PermissionRequest` deny with the reason. Copilot received a `PreToolUse` allow. Read-only tools (read_file and the like) never prompt.
- If Ensemble is down, or nobody answers within 10 minutes, the editor shows its own prompt. **The hook never allows on its own.**
- Setup: Settings → Editors & agents → Create token, then run the one install command shown for each editor. `scripts/ensemble-hook.mjs install|uninstall` writes `~/.cursor/hooks.json`, `~/.claude/settings.json`, or `.github/hooks/ensemble.json` and keeps any hooks already there.
- Standing answers ("always allow `npm test`") are listed and removable in Settings.
- **Not yet tested inside the real editors on this machine.** Restart the editor after installing, and check its Hooks panel or output channel if a prompt does not arrive.

### Settings that now do something
- **Models, Connections, Editors & agents, Account**: as above.
- **Fetching**: the schedule runs; look-back and "propose todos" are honoured by sync and triage.
- **Data retention**: a daily pass at 03:30 local time purges soft-deleted rows older than the window, plus old notifications and answered decisions. The purge is recorded in the ledger.
- **Desktop reminders and quiet hours**: while a Ensemble tab is open, due reminders pop up as browser notifications, held during quiet hours. Editor decisions notify even in quiet hours, because a tool call is waiting.
- Appearance, the assistant's write policy and areas, terminal folders, and deleted items were already real.
- **Folders Code can use** is its own list, separate from the terminal's ([16 §1](16_CODE_TAB.md#folders-code-can-use)).

### Code on this computer
- **Assign to agent** creates a `WorkspaceJob` (`routes/agents.ts`). `startAgentQueue` in `index.ts` starts the queue. `worker.ts` claims a queued job and calls `executeJob` in `agent.ts`, which prepares the folder, calls agent-runtime for each model turn, and runs the tools. A job that was running when the process died is marked interrupted on the next launch.
- The sandbox is macOS-only (`sandboxAvailable` in `guard.ts`). On Linux and Windows the same job can run as "This machine", with the argument allow-list and the path jail, and without Seatbelt.
- `unattended` is stored per job: a local code job keeps the assigner's choice (`workspace/assign.ts`), and a job sent to a paired device is always `false`. `orchestration.runWithoutAsking` lets commands in a trusted folder run without a prompt (`silentWorkspace` in `workspace/trust.ts`).
- Choosing Cursor as the model for a local task is refused. Cursor's cloud agents are a different path.

## Cowork surfaces (feature-one)

In-app, not email. Schema change is `20260929180000_cowork_surfaces`.

- **Morning brief**: Settings → Morning brief (default 08:00, on). The scheduler writes one `notifications` row per local day (`kind: morning_brief`, `channel: hub`) from the same today briefing the Context Bridge uses. The bell shows it. Quiet hours do not send it as a desktop popup.
- **Quick capture**: `POST /api/capture`. Command-Control-Shift-U on macOS, Ctrl+Alt+Shift+U on Windows and Linux, also C in the Hub when you are not typing. The global hook is a Tauri shell at `apps/quick-capture` ([docs/20_QUICK_CAPTURE.md](20_QUICK_CAPTURE.md)). Parsing stays in hub-api.
- **Meetings**: ambient cards on Today (not a modal), keyboard notes, confirmation before attaching notes onto the calendar event stored in Ensemble. Declining keeps them under Meeting notes, with a cross-meeting question box. **Calendar connectors are still read-only**, so attach does not update Google or Outlook. Voice is a TODO; there is no microphone.
- **Ask Ensemble**: the bar in the top of every page. It searches with the existing Hub search and read helpers and links each source.
- **Weekly recap**: `/recap`, copy or download. Meeting rows are the per-meeting recap text.
- **Quiet nudges**: Settings → Quiet nudges, default 14 days. Keep, snooze (7 days), done, or Trash.
- **Shortcuts**: `packages/shared-types/src/shortcuts.ts` is the only binding list. The help sheet is `?`. Alt+Shift+T cycles starred code themes (not Ctrl+Alt+T).

## Code themes (feature-themes)

The code review space has a VS Code theme picker. Built-in themes live in `@ensemble/ide-theme`. Open VSX themes are fetched through hub-api (`/api/themes/search`, `/api/themes/openvsx`) and cached under `.theme-cache` (gitignored). The choice is `ideTheme` on the user settings document, so there is no database migration. Star up to three themes; Alt+Shift+T switches between them.

## Added since 27 Sep (read from the code on 5 Oct 2026)

These are on `main` and have their own docs. They were not re-tested live for this page.

- **Plots** (`/plots`): charts from uploaded tables with ECharts on screen and matplotlib for publication export. Export runs in agent-runtime (`ensemble_agent/plots/`) or, on desktop, the computer's own `python3`. See [20 · Plots](20_PLOTS_DESIGN.md).
- **Block diagrams** (`/diagrams`): a text DSL in `packages/block-diagrams`, revisions in `apps/hub-api/src/diagrams/`, and assistant tools to draw them. See [21](21_BLOCK_DIAGRAMS_DSL.md) and [22](22_BLOCK_DIAGRAMS_FOR_AGENTS.md).
- **Desktop app** (`apps/desktop`): a Tauri window with a static export of the site and a local hub-api sidecar on PGlite. No Docker. Model calls run in-process. See [DESKTOP.md](DESKTOP.md) and the [Mac checklist](desktop/MAC_CHECKLIST.md).
- **Remote tasks on your computer**: pair a computer under Settings → Devices (`/api/devices/*`), then choose it under *Run on* when assigning. The desktop app claims and runs the job and asks for approvals through Needs me (`apps/hub-api/src/remote/`, `src/devices/`). See [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md).
- **Templates, desks and marketplace**: role templates at signup, the Today desk widgets, and the marketplace (`/marketplace`, `apps/hub-api/src/marketplace/`, `src/layouts/`). See [`design/`](design/) and [DEMO_DATA.md](DEMO_DATA.md).
- **Hosting**: a VM deploy with Caddy and systemd (`infra/deploy/`) and production start-up checks (`apps/hub-api/src/lib/production.ts`).
- **CI and deploys** (added 5 Oct 2026): `.github/workflows/ci.yml` checks every pull request and push to `main`; `deploy.yml` then moves the `production` branch, the VM follows it (`infra/deploy/autodeploy.sh`), and the Hub and landing page are published on Vercel ([01 §8](01_TECH_STACK_AND_ENVIRONMENT.md#8-ci-and-deploys)). `ci.yml` passes on GitHub; the VM half of the deploy was run against a local git remote. `deploy.yml` has not run against a live VM or Vercel project yet.
- **Landing page** (`apps/landing`): a static one-page site for ensemblework.com that links to the hosted Hub. GitHub links stay hidden until `repoPublic` in `apps/landing/lib/site.ts` is true.

## Merged on 5 Oct 2026 (#88, #90, #92, #95, #89)

Checked on 5 Oct 2026 with the hub-api, hub-web and agent-runtime suites on a fresh migrated database. The assistant fixes were also run live against Gemini in an earlier recheck. Nothing here was re-tested in a browser for this page.

- **Standalone notes**: pages with no task, in the sidebar and at `/pages/[id]` ([02 §13](02_MODULE_INTERACTION_HUB_UI.md#standalone-notes)).
- **Code folders**: the Code tab's folder list is separate from the terminal's and is checked on add and on use ([16 §1](16_CODE_TAB.md#folders-code-can-use)).
- **Assistant errors**: a used-up quota is `model_quota_exceeded` with a reset time, with no silent retry or model switch. An unreachable model host is `model_unreachable` in both runtimes. Neither is saved as the reply. Stop works on the first message of a new chat ([11 §9](11_HOW_THE_ASSISTANT_WORKS.md#9-failure-modes-and-what-catches-them)).
- **Context graph**: labels no longer pile up; the camera fits the graph ([02 §13](02_MODULE_INTERACTION_HUB_UI.md#context-graph)).
- **Triage due times** are read in your time zone. A `due_time` wins; an ISO time with `Z` or an offset keeps that instant; no time means 17:00 (`apps/hub-api/src/connectors/triage.ts`). When the model's JSON cannot be read, triage logs a warning and the rule-based fallback runs.
- **Hosted plot exports**: a queued export waits at most 110 s before the busy reply, under Vercel's 120 s proxy cut, and the plot child's process group is killed at its time limit ([20](20_PLOTS_DESIGN.md)).

On this Mac, 15 agent-runtime plot-sandbox tests (17 after #89) fail with "The plot runtime is not available." on `main` as well. That is the Python 3.13 venv here, not these merges. Not checked on Linux for this page.

## Ensemble CLI and hosted MCP (6 Oct 2026)

Checked on 6 Oct 2026 on macOS (Apple Silicon) against a local hub-api and Hub with an isolated database ([26 §9](26_CLI.md#9-verified)).

- **`ensemble` CLI** (`apps/cli`): device login through `/link`, pairing this computer, sharing folders, the runner (a code task assigned from the hosted API finished on the Mac with the `mock` model), `ensemble mcp`, editor setup, status/doctor, logout (key revoked, device removed). Not run here: Windows and Linux archives (CI builds and smoke-tests them), `runner install` against real service managers, real editors other than an MCP SDK client.
- **Hosted MCP** at `POST /mcp` (`apps/hub-api/src/routes/mcp.ts`): same 17 tools as the local bridge, bearer `ens_` key only.
- **Installers**: Homebrew tap, Scoop bucket, `install.sh`, `install.ps1`, `.deb`/`.rpm` come from `.github/workflows/cli-release.yml`. winget, npm and AUR files are produced but not published ([26 §1](26_CLI.md#1-install)).
- **Guides**: `ensemblework.com/download`, Connect your apps (CLI, hosted URL, from source per editor and OS), Settings → Devices.

## Still a placeholder

- **Autonomy and Orchestration settings** are stored. The running queue uses `maxConcurrentJobs`, and a job uses its minute, turn and tool limits, the sandbox-network default, and `runWithoutAsking` (above). `defaultDelivery` only pre-selects the choice in the Assign dialog; the runner does not read it. Check the unattended rules in [doc 24](24_DESKTOP_SANDBOXING.md) against `workspace/trust.ts` before relying on them.
- **Context Bridge** (read-only MCP for editors) is built, locally (`ensemble mcp` or from source) and hosted at `/mcp`. Setup, tools, and the entities this schema does not have are in [CONTEXT_BRIDGE.md](CONTEXT_BRIDGE.md). It reads hub-api over HTTP. It does not write.
- **Skill mining**, **embeddings / semantic retrieval**, and **Metrics baselines**: unchanged.
- **Outlook, Outlook calendar, Teams**: deliberately later.
- **Sending** anything (mail replies, PR comments): drafts and approval cards exist, but no connector has write scope yet.

## One-time Google setup (whoever runs this Ensemble)

Gmail and Calendar share one **Sign in with Google** button. People using Ensemble never open Google Cloud. The host does this once. It is separate from the Gemini key.

The console is now **Google Auth Platform** (not the old “OAuth consent screen” menu).

1. [Audience](https://console.cloud.google.com/auth/audience): External, publishing status Testing.
2. Branding: app name, support email = your Gmail. Save before adding test users. If Google says an address is ineligible, Branding or Data Access was not saved yet.
3. Data Access: add scopes `gmail.readonly` and `calendar.readonly`. Enabling the APIs in the Library is not this step.
4. Clients → Web application. Redirect URI: `http://localhost:4000/api/connectors/google/callback`.
5. Paste the client ID and secret in **Settings → Connections → Set up once**, or set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env`.
6. Audience → Test users: add each Gmail that will press the button, including yours. While the app stays in Testing, Google blocks everyone else. Publishing Gmail access for the public needs Google’s own verification, which is a later step.

After that, each person presses **Sign in with Google** and allows read-only mail and calendar. Nobody else sees the secret.

GitHub sign-in works the same way with a GitHub OAuth App (callback `http://localhost:4000/api/connectors/github/callback`). A pasted fine-grained token needs no setup.

## Where things live

| Piece | Files |
|---|---|
| Accounts, sessions, tokens | `apps/hub-api/src/lib/auth.ts`, `routes/auth.ts`, `apps/hub-web/app/login`, `app/signup`, `app/(hub)/welcome` |
| Model runtime | `apps/agent-runtime/ensemble_agent/models.py`, `credentials.py`, `vault.py`, `main.py`; the desktop in-process path is `apps/hub-api/src/runtime/` |
| Connectors | `apps/hub-api/src/connectors/{google,github,slack,linear}.ts`, `oauth.ts`, `accounts.ts`, `ingest.ts`, `triage.ts`, `sync.ts`, `routes/connectors.ts` |
| Scheduler and retention | `apps/hub-api/src/jobs/scheduler.ts` |
| Decision router | `apps/hub-api/src/lib/decisions.ts`, `routes/decisions.ts`, `scripts/ensemble-hook.mjs`, `apps/hub-web/components/needs-me/editor-decisions.tsx` |
| Settings UI | `apps/hub-web/components/settings/setup.tsx` |
| Shared encryption key | `ENSEMBLE_SECRET_KEY`, or `.ensemble/secret.key` (git-ignored, created on first use) |
| Smoke test | `pnpm --filter @ensemble/hub-api exec tsx scripts/smoke-triage.ts` (two sample emails through live triage) |
