# 00 · Project Overview — Ensemble

> **Name:** **Ensemble**. An engineer and their agent, in the same key: stronger together.
>
> **Owner:** Akash Sharma
>
> **One-liner:** A persistent, context-rich home page where a software engineer and their personal agent share the same picture of the work — todos, deliverables, meetings, code, people — so the agent can do work autonomously, and help without being told the context every time.
>
> **What this is:** a **source-available, localhost-first** digital coworker (licensed [FSL-1.1-MIT](../LICENSE.md): free to use, including at work, but not to offer as a competing product; each release becomes MIT after two years). It started as a Microsoft Hackweek 2026 demo and is now built for anyone to run with their own accounts and model keys.

---

## Direction

These rules override any Microsoft-only, Dev-Box, or hackathon detail that still appears in the module docs.

1. **Source available.** The code is public under [FSL-1.1-MIT](../LICENSE.md). The module docs are implementation guidelines, not a description of a private demo.
2. **Localhost first.** Local development comes first. The VM deploy scripts are in `infra/deploy/`; the desktop app is in [DESKTOP.md](DESKTOP.md).
   The hosted Hub also accepts public per-user accounts; it is not an invite-only personal instance. Public users bring their own keys, and host execution/credentials are restricted to verified operators. See [02 §16](02_MODULE_INTERACTION_HUB_UI.md#16-accounts-and-public-signup).
3. **Connectors are pluggable, not Microsoft-shaped.** First wave: **Gmail + Outlook** (mail), **GitHub** (code — **no Azure DevOps**), **Teams** (messages / task context), plus calendar from the mail provider. Later: Notion, Linear, and office suites (Word / PPTX / Excel and Google Docs / Slides / Sheets). What is connected today is in [18](18_WHAT_IS_REAL.md#connectors-read-only).
4. **No M365 Copilot.** The hackathon used a paste/browser path because Teams/transcripts were blocked in that tenant. Ensemble connects sources directly.
5. **Many model providers.** GitHub Copilot remains one option. Also **Cursor, Gemini, Claude, OpenAI** (and later anything that speaks the same chat/tools contract). Complexity still picks a `{provider, model, effort?}` profile — the engineer is not locked to one vendor.
6. **UI starts Notion-like.** Pages, properties, and a kanban board. Refine the look as it matures.
7. **Future ideas stay out of the docs** until you lay them out. Do not invent a STATUS file, a remote-access guide, or a Copilot-API probe doc.

Module files contain *as-built* notes (paths, invariants, bugs we already paid for). Read those as **"this is how the hard parts were solved"**. [18 · What is real](18_WHAT_IS_REAL.md) says which parts run today.

---

## 1. The problem (why chat is the wrong primary interface)

Today an engineer's interaction with an agent looks like this:

```text
Engineer has a goal → opens chat → types a request (loses 80% of context)
        → Agent guesses intent → wrong output → re-explain context → wrong goal
        → (or: "forget it, I'll do it myself")
```

**Root causes:**

1. **Context starvation.** The agent doesn't know what I'm working on, why, with whom, or how I like it done. All of that already exists in mail, chat, meeting notes, calendar, issues and repos — but it is never assembled.
2. **Chat is pull-only and stateless.** I must remember to ask; the agent can't proactively surface *"here's what you owe from yesterday's design review."*
3. **No memory of my way of working.** Every PR description, commit message, email reply, or chat answer is re-generated from scratch in a generic style, so it needs rework.
4. **No shared workboard.** I can't see what the agent is doing, how far it is, what it plans next, or where it needs a decision from me.

**Thesis:** If engineers and agents had co-existed from day one, the interface would not be a chat box. It would be a **shared workspace**: a board of tasks, a live context model of the engineer, a library of personal skills, and a set of scheduled agent jobs — with chat demoted to one of several input channels.

---

## 2. The vision in one picture

```text
 Scheduled jobs (2 fetches a day + a button — see 05 §2)
 ┌──────────────────────────────────────────────────────────────────────┐
 │ Mail (Gmail / Outlook) · Chat (Teams, later more) · Calendar ·       │
 │ GitHub · (later: Notion, Linear, office docs)                        │
 └──────────────────────────────────┬───────────────────────────────────┘
                                    ▼
 ┌──────────────────────── ENSEMBLE HUB (the interaction page) ─────────────────────┐
 │  Today / Morning Briefing │ Task Board (Kanban: Me / Agent / Needs me) │       │
 │  Agent Run Timeline + Approvals │ Context Pane (people, repos, docs)           │
 │  Notion-like document pages                                                    │
 └───────────┬─────────────────────────┬──────────────────────────┬───────────────┘
             ▼                         ▼                          ▼
   Task Orchestrator            Skill Forge                 Context Engine
   (plans, runs, HITL gates)    (personal skills mined      (Engineer Graph: people,
                                 from history)               projects, repos, prefs)
                                                                  │
                    Connector plugins (OAuth per source) + model-provider plugins

 Surfaces: Coding Workspace (sandbox / native) · Hub assistant (every page) ·
           Context Bridge (read-only MCP for editors)
```

---

## 3. A day in the life (target experience)

**08:55 — Morning briefing (before I even ask).** I open the Hub. The agent has already:

- Read overnight mail (Gmail or Outlook) and chat, and turned 4 of them into proposed todos (*"Reply to Priya re: latency regression — she asked for numbers by EOD"*).
- Processed yesterday's *"Ranker design review"* notes: my action items are extracted, attributed (*"you agreed to write the ADR; Rahul owns the load-test"*), and linked to the source.
- Pulled my open GitHub PRs; flagged one PR with a stale review comment from 3 days ago.
- Drafted a plan for the day honouring my calendar (2 focus blocks, 3 meetings).

**09:00 — Triage in 2 minutes, not 20.** Each proposed todo has three buttons: **I'll do it · Agent does it · Later/Drop**. I assign:

- *"Reply to Priya with latency numbers"* → **Agent** (it knows which dashboard, knows my reply tone from 200 past replies).
- *"Write the ADR"* → **Me** (with the agent as a helper).
- *"Bump the retry lib in service-X"* → **Agent**, with the PR gated on my approval.

**09:05–11:30 — I code; the agent works in parallel.** The board shows agent tasks moving: *Gathering context → Drafting → Waiting for approval → Done*. When I click **"Help me"** inside my coding workspace, the agent already has: the ADR template I used last time, the design-review notes, the related PRs, and my writing-style skill. I never type a paragraph of context.

**11:30 — Control points.** Two cards wait in **Needs Me**: (1) the drafted reply to Priya (approve / edit / send), (2) a PR ready to open, with a description written in my PR style for that repo. I approve both in 40 seconds.

**Throughout — the Hub assistant.** A floating chat on every page that can operate the Hub: *"add a todo for the load test"*, *"what did Shachee ask me for?"*, *"sync my mail"*. It reads the same context the briefing does and writes through the same code paths the buttons use ([docs/11](11_HOW_THE_ASSISTANT_WORKS.md)). Side cards inside Teams/Outlook were tried and deleted — see [docs/06 §B](06_MODULE_WORKSPACE_AND_SURFACES.md#b-surface-assist--designed-built-then-deleted).

**17:30 — Wrap-up.** The agent posts a day summary to the Hub, notes what slipped, and pre-plans tomorrow. Every agent action is in an audit timeline with the inputs it used and the approvals it received.

---

## 4. Scope

| Tier | Scope | Goal |
|---|---|---|
| **P0 – Must** | Hub UI (Notion-like pages + Briefing + Task Board + Needs-Me + Run Timeline) · Context Engine with **Gmail, Outlook, GitHub, calendar** · Orchestrator with two daily fetches + a button and 2 autonomous task types (email reply, PR description/opening) · Skill Forge v1 (PR & commit style + email tone) · Audit log · Pluggable model providers (at least one of Copilot / OpenAI / Claude / Gemini / Cursor) | A stranger can clone, run on localhost, connect *their* mail + GitHub, and live a day in the product |
| **P1 – Should** | **Teams** messages · Hub assistant that operates the app · Coding-workspace "Help me" + sandbox execution · Context Bridge (read-only MCP for VS Code / Cursor / Copilot CLI) | Beyond chat, multi-surface, still local |
| **P2 – Could** | Notion / Linear import · Google Docs / Sheets / Slides and Word / PPTX / Excel as context · Skill Forge v2 (auto-discover skills) · Multi-agent split (Researcher / Drafter / Reviewer) · Production hosting | Useful for more of the public; still optional |

**Explicitly out of scope for now:** production multi-tenant SaaS, mobile, Azure DevOps, M365 Copilot, Dev Box / remote tunnels, Agent 365.

---

## 5. Modules (each has its own plan file)

| ID | Module | Plan file | Summary |
|---|---|---|---|
| M1 | Interaction Hub (UI) | [`02_MODULE_INTERACTION_HUB_UI.md`](02_MODULE_INTERACTION_HUB_UI.md) | The shared page: briefing, task board, approvals, agent timeline, context pane, coding-workspace entry. Notion-like document pages. |
| M2 | Context Engine | [`03_MODULE_CONTEXT_ENGINE.md`](03_MODULE_CONTEXT_ENGINE.md) | Pluggable connectors, normalization, the Engineer Graph, context-pack builder |
| M3 | Skill Forge | [`04_MODULE_SKILL_FORGE.md`](04_MODULE_SKILL_FORGE.md) | Mines historic artefacts to produce personal, versioned skills; skill router |
| M4 | Task Orchestrator | [`05_MODULE_TASK_ORCHESTRATOR.md`](05_MODULE_TASK_ORCHESTRATOR.md) | Scheduled jobs, todo proposal, task lifecycle, agent workers, planner/executor, HITL gates, retries |
| M5 | Coding Workspace | [`06_MODULE_WORKSPACE_AND_SURFACES.md`](06_MODULE_WORKSPACE_AND_SURFACES.md) | Agent workboard, durable queue, sandbox/native execution, verified PR/completion. Surface-assist cards were deleted — §B |
| M6 | Governance, Audit & Metrics | [`07_MODULE_GOVERNANCE_AUDIT_METRICS.md`](07_MODULE_GOVERNANCE_AUDIT_METRICS.md) | Identity, permission scopes, action policy, audit ledger, before/after measurement |
| M7 | Context Bridge | [`13_MODULE_CONTEXT_BRIDGE.md`](13_MODULE_CONTEXT_BRIDGE.md) | Read-only MCP so editors (VS Code, Cursor, Copilot CLI, …) retrieve the same briefs and skills |

Other documents:

| Topic | File | Summary |
|---|---|---|
| Tech stack | [`01_TECH_STACK_AND_ENVIRONMENT.md`](01_TECH_STACK_AND_ENVIRONMENT.md) | Languages, frameworks, services, local env, secrets, model providers |
| How the assistant works | [`11_HOW_THE_ASSISTANT_WORKS.md`](11_HOW_THE_ASSISTANT_WORKS.md) | Hub Action Layer: how a chat message becomes a row |
| Code tab | [`16_CODE_TAB.md`](16_CODE_TAB.md) | Review, rewrite, commit — and a guarded terminal |
| Repository structure | [`17_REPOSITORY_STRUCTURE.md`](17_REPOSITORY_STRUCTURE.md) | What lives where in this repo |
| What is real | [`18_WHAT_IS_REAL.md`](18_WHAT_IS_REAL.md) | Built and tested vs. still a placeholder |

---

## 6. Repository structure

Monorepo, **pnpm workspaces** for TS + a **Python service** for agent workers (Python has the richest agent SDKs; TypeScript owns the UI and the API).

The annotated tree lives in [`17_REPOSITORY_STRUCTURE.md`](17_REPOSITORY_STRUCTURE.md).

---

## 7. Core domain model (shared across modules)

Accounts are `User` rows scoped by `userId`, not organizations. `User.emailVerifiedAt` gates hosted agent/connector/model use. `Session` stores hashed browser-cookie tokens; `AuthIdentity` stores unique provider/subject login mappings (distinct from connector `AuthToken`), `EmailToken` stores hashed single-use verification/reset tokens, and `AuthFlow` stores short-lived PKCE/nonce state for browser-bound social login. Schema: `apps/hub-api/prisma/schema.prisma`.

The SQL migration `20261006010000_account_data_lifetime` adds cascading account-lifetime foreign keys to legacy `user_id` tables. They are `NOT VALID` so old placeholder/orphan data is preserved, but new writes require a live account. This stops in-flight work from recreating rows after account erasure; it is not row-level security. Dev bypass creates a real local placeholder account before handling requests.

```ts
// packages/shared-types/src/domain.ts (abridged — keep, then generalize source kinds)
type Task = {
  id: string; title: string; description: string;
  source: {
    kind: 'email' | 'chat' | 'meeting' | 'github' | 'manual' | 'notion' | 'linear' | 'other';
    provider?: string; // 'gmail' | 'outlook' | 'teams' | …
    ref: string; excerpt?: string;
  };
  owner: 'me' | 'agent' | 'unassigned';
  status: 'proposed' | 'todo' | 'in_progress' | 'waiting_approval' | 'blocked' | 'done' | 'dropped';
  priority: 'p0' | 'p1' | 'p2';
  due?: string; project?: string; people: string[]; repo?: string;
  agentPlan?: PlanStep[]; runIds: string[];
  createdBy: 'agent' | 'me'; createdAt: string; updatedAt: string;
};

type PlanStep = {
  id: string; title: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'needs_approval';
  toolCalls?: ToolCallRef[];
};

type Run = {
  id: string; taskId: string; worker: string; skillIds: string[]; contextPackId: string;
  steps: RunStep[]; approvals: Approval[]; startedAt: string; endedAt?: string;
  outcome?: 'success' | 'failed' | 'cancelled';
};

type Approval = {
  id: string; runId: string;
  kind: 'send_email' | 'open_pr' | 'post_chat' | 'other';
  preview: unknown;
  decision?: 'approved' | 'edited' | 'rejected'; decidedAt?: string; editedPayload?: unknown;
};

type ContextPack = {
  id: string; taskId?: string; summary: string; items: ContextItem[];
  skillsSuggested: string[]; builtAt: string;
};

type Skill = {
  id: string; name: string;
  scope: { repo?: string; channel?: string; person?: string };
  version: number; body: string /* SKILL.md */; evidence: string[]; confidence: number;
};
```

> **Fields added on top of the core model:**
>
> - **Task:** `complexity` (`easy | medium | high | max`) + `complexitySource` (05 §3), `notes` (Markdown body), `deliverableId`, `skillIds` (03 §12), `todayFocus` (`auto | keep | hidden`, 02 §3.1), `boardOrder` (02 §3.2), `blockedQuestion` (05 §12), `completedAt` / `deletedAt` (07 §1.1), `sourceRef`.
> - **Run:** `outcome` also allows `needs_info` and `waiting_approval` (05 §12); `complexity`, `requestedModel`, `skillSignatures` (id, version, SHA-256), `checkpoint` (04 §4, 04 §10); per-step `model` and `credits` (01 §6.3).

---

## 8. Product principles (what we will be judged on)

| Principle | How Ensemble demonstrates it |
|---|---|
| **Beyond chat** | The primary surface is a board + briefing + approvals; chat is one optional input. Agent completes tasks (sends reply, opens PR). |
| **Smart orchestration** | Scheduled jobs → todo proposals → planner → workers → HITL gates → mail/GitHub (and later other) actions. |
| **Measurable before/after** | Minutes to triage morning, context re-typing avoided, drafts accepted without edit, PRs opened by agent. |
| **Trustworthy by default** | Least-privilege OAuth per connector, per-action policy, tamper-evident audit ledger, replayable runs. No silent high-risk writes. |
| **Human-in-the-loop** | Explicit control points: task assignment, approval cards with preview, "pause agent", per-action risk levels, undo where possible. |
| **Works for anyone** | Localhost, your accounts, your model keys. Not a single-vendor tenant. |

---

## 9. Success metrics

- **Morning triage:** 20 min → < 3 min
- **Context re-typing before asking for help:** ~150 words typed → 0 (one click)
- **Agent-drafted replies/PR descriptions accepted with ≤ minor edits:** ≥ 70%
- **Meeting action items captured without manual note-taking:** ≥ 90% recall on test meetings
- **Every autonomous action:** 100% audited, 0 high-risk actions without approval

---

## 10. Reading order

1. `00_PROJECT_OVERVIEW.md` (this) — especially **Direction**
2. [`18_WHAT_IS_REAL.md`](18_WHAT_IS_REAL.md)
3. `01_TECH_STACK_AND_ENVIRONMENT.md`
4. `17_REPOSITORY_STRUCTURE.md`
5. `02`–`07` and `13` module plans
6. [`11_HOW_THE_ASSISTANT_WORKS.md`](11_HOW_THE_ASSISTANT_WORKS.md)
7. [`16_CODE_TAB.md`](16_CODE_TAB.md)

---

## 11. Feature index

Where each hard feature lives in this tree. Built-or-not status per feature is in [18](18_WHAT_IS_REAL.md).

| Feature | Doc | Code |
|---|---|---|
| Morning briefing (Today) | 02 §3.1 | `apps/hub-web/app/(hub)/today/`, `apps/hub-web/components/today/`, `apps/hub-api/src/routes/cowork.ts`, `apps/hub-api/src/cowork/` |
| Private reminders, desktop notifications, fixed snooze | 02 §14, 07 §1.2 | `apps/hub-api/src/routes/system.ts`, `apps/hub-api/src/routes/board.ts`, `apps/hub-api/src/assistant/tools/reminders.ts`, `apps/hub-web/components/shell/notifier.tsx` |
| Task board, triage, assignment | 02 §3 | `apps/hub-web/app/(hub)/board/`, `apps/hub-web/components/board/`, `apps/hub-api/src/routes/board.ts`, `apps/hub-api/src/routes/tasks.ts`, `apps/hub-api/src/connectors/triage.ts` |
| Approvals and blocked questions | 07 §2 | `apps/hub-web/app/(hub)/needs-me/`, `apps/hub-api/src/routes/misc.ts`, `apps/hub-api/src/routes/board.ts` |
| Editor permission prompts and exact-choice questions | 06 A5 | `apps/hub-api/src/lib/decisions.ts`, `apps/hub-api/src/routes/decisions.ts`, `apps/hub-web/components/needs-me/editor-decisions.tsx`, `scripts/ensemble-hook.mjs` |
| Agent run timeline, reasoning, cost | 05 §12 | `apps/hub-web/app/(hub)/runs/`, `apps/hub-api/src/routes/runs.ts` |
| Engineer Graph (people, projects, repos, preferences) | 03 | `apps/hub-web/app/(hub)/context/`, `apps/hub-web/components/context/`, `apps/hub-api/src/routes/context.ts`, `apps/hub-api/src/context/` |
| Interactive context graph | 02 §13 | `apps/hub-web/components/context/graph.tsx`, `apps/hub-web/lib/graph-layout.ts` |
| Skill library, editing, improvement | 04 | `apps/hub-web/app/(hub)/skills/`, `apps/hub-api/src/routes/skills.ts`, `apps/hub-api/src/assistant/tools/skills.ts` |
| Agent workboard and repository execution | 06 A1–A6 | `apps/hub-web/app/(hub)/workspace/`, `apps/hub-api/src/workspace/` |
| Code review tab, guarded terminal | 16 | `apps/hub-web/app/(hub)/code/`, `apps/hub-web/components/code/`, `apps/hub-api/src/routes/code.ts`, `apps/hub-api/src/routes/terminal.ts` |
| Metrics (before/after) | 07 §6 | `apps/hub-web/app/(hub)/metrics/`, `apps/hub-api/src/routes/runs.ts`, `apps/hub-api/src/lib/metrics.ts` |
| Settings: models, connectors, autonomy | 02, 01 §6 | `apps/hub-web/app/(hub)/settings/`, `apps/hub-web/components/settings/`, `apps/hub-api/src/routes/settings.ts`, `apps/hub-api/src/routes/connectors.ts` |
| Document pages, @ mentions as real links | 02 §13 | `apps/hub-web/components/editor/`, `apps/hub-web/components/task/task-page.tsx`, `apps/hub-api/src/pages/`, `apps/hub-api/src/routes/tasks.ts` |
| Selection comments and inline agent replies | 02 §13 | `apps/hub-web/components/comments/`, `apps/hub-api/src/routes/comments.ts` |
| Prompt transparency | 02 | Settings → Prompts (`apps/hub-web/components/settings/sections.tsx`), `GET /api/prompts` in `apps/hub-api/src/routes/system.ts` |
| Ensemble context inside an editor (M7) | 13 | `apps/context-bridge/`, `apps/hub-api/src/bridge/`, `apps/hub-web/components/connect/` |
| Hub assistant and the Action Layer | 11, 02 §10 | `apps/hub-api/src/assistant/`, `apps/hub-api/src/routes/assistant.ts`, `apps/hub-web/components/assistant/` |
| Undo / redo, including the agent's writes | 02 §11, 11 §6 | `apps/hub-api/src/lib/undo.ts`, `apps/hub-api/src/routes/misc.ts` |
| Completed/deleted retention and restore window | 07 §1.1 | `apps/hub-api/src/jobs/retention.ts`, `apps/hub-api/src/routes/system.ts`, `apps/hub-web/app/(hub)/trash/` |
| Three recent skill versions | 04, 13 §5.3 | `apps/hub-api/src/routes/skills.ts` (`KEEP_VERSIONS`). Skill Forge miners are not built (`apps/skill-forge` is a stub) |
| Context suppression (deletions survive a fetch) | 03 §4.6 | `apps/hub-api/src/connectors/ingest.ts` |
| Audit ledger (hash-chained, INSERT-only) | 07 §3 | `apps/hub-api/src/lib/ledger.ts`, `apps/agent-runtime/ensemble_agent/audit/ledger.py` |
| Scheduled fetching at set times plus a button | 05 §2 | `apps/hub-api/src/jobs/scheduler.ts`, `apps/hub-api/src/connectors/sync.ts` |
| Capability-aware model/thinking presets | 01 §6, 02 §13 | `apps/hub-api/src/lib/complexity.ts`, `apps/hub-api/src/runtime/models.ts`, `packages/shared-types/src/assistant.ts` |
| Waiting animations and motion styles | 02 §15 | `apps/hub-web/components/motion/`, `design/motion/` |
| GitHub via existing CLI login | 03 §10 | `apps/hub-api/src/connectors/accounts.ts` (`gh auth token`), `apps/hub-api/src/lib/git-auth.ts` |
| Plots | [20](20_PLOTS_DESIGN.md) | `apps/hub-web/app/(hub)/plots/`, `apps/hub-api/src/plots/`, `apps/agent-runtime/ensemble_agent/plots/` |
| Block diagrams | [21](21_BLOCK_DIAGRAMS_DSL.md), [22](22_BLOCK_DIAGRAMS_FOR_AGENTS.md) | `packages/block-diagrams/`, `apps/hub-web/app/(hub)/diagrams/`, `apps/hub-api/src/diagrams/` |
| Desktop app (local sidecar) | [DESKTOP](DESKTOP.md), [23](23_LOCAL_DESKTOP_DESIGN.md) | `apps/desktop/`, `apps/hub-api/src/desktop/` |
| Remote tasks on a paired computer | [25](25_REMOTE_TASKS_ON_YOUR_COMPUTER.md) | `apps/hub-api/src/remote/`, `apps/hub-api/src/devices/` |
| Templates, desks and marketplace | [design/](design/) | `apps/hub-web/app/(hub)/marketplace/`, `apps/hub-web/components/desk/`, `apps/hub-api/src/marketplace/`, `apps/hub-api/src/layouts/` |

**Verification:** isolate fixtures (safe databases, mocked external/model calls) from live checks. A fixture test does not claim that an external PR, model action or desktop notice was actually sent.
