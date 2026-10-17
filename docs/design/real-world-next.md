# Real-world testing: follow-on designs

These are **planned designs, not implemented features**. The current code and remaining decisions were reviewed on 17 Oct 2026. The implemented Context, contact-sync and run-panel changes are documented in [18](../18_WHAT_IS_REAL.md).

## Skill mining

The existing lifecycle in `apps/hub-api/src/jobs/skill-mining.ts` and `jobs/retention.ts` gives notice at least 24 hours before older completed work is mined with the person's High model. Pinned and active work is excluded; failed mining keeps work in Completed. Current mining applies validated skill changes as part of retention. The next design changes that last step to explicit review.

1. Select at most 50 completed tasks and 50 completed deliverables after the person's history window. Never mine another person's space, connector credentials, deleted content or unfinished work. Read task instructions, accepted edits, final results and explicit run feedback; distinguish the person's instructions from generated text. One-off names, dates, secrets and project facts are excluded from reusable guidance.
2. Record a bounded batch with source IDs, content hashes, model and existing skill versions. Deduplicate by source hash and batch ID. Show a notice with Review sources, Exclude and Skip; skipping must not silently enable later mining of the same batch.
3. Use High once per bounded batch. Suggest a new skill or a small addition to an existing skill, with evidence excerpts and a reason. Treat supplied records as data. Never weaken existing permissions or alter the morning-brief skill. No supported reusable pattern produces no proposal.
4. Save proposals separately from active skills. Notify the person and show a “Suggested” view in Skills with a diff, source links, model cost and Accept/Edit/Reject. Nothing changes the agent's instructions before acceptance. Rejecting records the source hashes to prevent repeated suggestions.
5. Accept checks that the target skill version still matches; a conflict asks for another review. One transaction writes the skill version and decision. Undo restores the prior version. Archive only after the batch is reviewed or deliberately skipped; never make retention depend on buying model access. Offer an explicit keep/export/archive choice when mining cannot run.

Open decisions: whether auto-accept may ever be an opt-in; how long rejected proposal evidence is retained; a spending cap per batch; the response to deleted evidence before approval. Acceptance tests must cover duplicate schedules, stale versions, absent keys, prompt injection, cross-space isolation and rejection followed by another retention pass.

## Connector fetching

Current manual sync (`connectors/people-sync.ts`) reads contact metadata only. Search and save remain explicit actions through `connectors/items`, assistant tools and Files. No automatic artifact ingestion or model triage runs from `/api/fetch` or `/api/connections/:id/sync`.

| Connection | Manual people sync | Explicit request |
| --- | --- | --- |
| Gmail | Bounded sender/recipient headers; no body or subject | Search/read a named message; save or attach the chosen item |
| Outlook | Sender/recipient names, addresses, dates and bulk headers | Search/read a chosen message or attachment |
| Google/Outlook calendar | Attendee names and addresses | Find an event, save it or use it for a chosen meeting note |
| Slack | Non-bot workspace member metadata | Search/read a chosen message or thread |
| Teams | Chat member metadata, no message content | Find/read a chosen chat or message |
| GitHub | Followed real users, no repository/PR content | Find a repository, PR or issue and save the selected item |
| Drive, OneDrive, SharePoint, Notion and document apps | None | Search first; download/save the selected file only |
| Linear, Jira and other work trackers | None by generic sync; explicit supported People import remains available | Search and attach/convert the selected issue |
| Zoom and other meeting sources | None by generic sync | Import a selected transcript or summary |
| Remote MCP | None | Run an enabled read tool on request; writes use the existing approval gate |

Next: add provider-specific pagination with a visible “Load more contacts”, cancellation, per-connection watermarks and scope-aware unavailable states. Contacts use normalized addresses and provider identities; identical names alone never merge. Fixed address/domain/bulk rules precede storage; removal tombstones prevent resurrection. Add an explicit “Add this real person anyway” override with its own audit record rather than disabling the filter globally.

Search results are transient. Preview/read alone should not save every result. A request to keep/find a particular file should offer the matched item and a clear Save or Attach action; uploads are explicit. Saving records source ID/version and deduplicates the chosen copy. Refresh is manual and shows a diff for edited local copies. Connector content never runs instructions or expands permissions. No background scheduler downloads mail, files, transcripts or issues. Future scheduled fetching would require a separate explicit opt-in and a new design review.

## Change profession once

Proposed Settings → Account → Change profile opens a preview of the full consequences, then onboarding (name, profession, template). It is allowed once per account, across owned spaces and devices; creating a space does not grant another change. Do not ship this action before the decisions below are resolved.

Kept: account ID, owned/shared spaces and access, tasks, pages, boards, projects, files, history, settings, connectors and their grants. Existing specialized records remain stored and exportable even if a new profile hides their tab. Universal settings stay; old layout and optional-tab preferences are archived by role. New profile defaults and its own optional choices become active.

Reset: active personal skills return to the new profile defaults, with old versions archived for export/recovery and excluded from model context. Revoke model keys, computer/device pairings, bridge/CLI tokens, terminal unlocks and pending sign-in codes. Cancel queued runs; ask the person to finish or stop active runs first. Never revoke keys while a run can still use them.

A server-side transaction locks the account, checks the unused allowance, stores a migration record, applies the role/template and revokes sessions/tokens. Persist a recoverable checkpoint before any external cleanup. All web sessions, CLI runners and native sessions are signed out, including the initiating surface; completion offers a fresh sign-in. Local-only desktop must retain its workspace and create a local recovery snapshot before resetting its own credentials. Synced desktops must acknowledge disconnection; offline devices are rejected on their next request. Do not erase files on the person's computer.

Open decisions: define “profile” vs profession for multi-space users; treatment of developer bypass accounts and local workspaces without an account; whether changing to the same role consumes the allowance; recoverability of reset skills; custom templates and their module settings; active collaboration during the transaction; retention of cached attachments on revoked computers; shared devices; connector credentials in a local-only workspace; accessibility and translated confirmations. Test transaction retries, partial cleanup, offline clients, stale tokens, active jobs, shared-space ownership and account restoration before exposing the control.

## One permissions and requests flow

Keep existing enforcement in `workspace/tools`, remote leases, sharing policy and assistant Apply. Add one presentation and decision contract over them; changing presentation must never broaden authority.

Each request has a stable ID, account/space, originating run/turn, actor and tool, plain action summary, exact target, bounded preview/diff, requested scope, expiry and server-side continuation. Group related writes only when the combined action is understandable. Needs me, run sheets, chat, CLI and native show the same wording and decision state.

Allow once is the default. Optional “For this task” names its limits; “Always” is offered only for rules the enforcement layer supports, never publishing, account deletion, arbitrary commands or credential disclosure. Deny includes an optional reason. Questions offer real choices and free text. A decision is consumed once by the exact checkpoint, not by re-planning a different action. Stale target/version or changed permissions invalidates approval and asks again. Device identity and space membership are checked again on execution.

Use SSE updates and an atomic decision endpoint; two surfaces racing must produce one decision. Offline CLI/native can display cached requests but cannot fabricate approval. Show expiry, cancellation and actionable reconnect states. Keep a minimal decision log (actor, scope, target IDs, outcome); redact secrets and avoid logging full private documents. Test replay, tampered previews, changed files, revoked access, unattended mode, keyboard navigation and simultaneous decisions.

## Meeting notes: next improvements

Current notes, source attribution, transcript import and gated action-item creation live in `connectors/meetings/`, `routes/meetings*` and `assistant/skills/meeting-notes.md`.

1. A single meeting workspace combines user notes, decisions, transcript references and proposed actions; preserve the original transcript as a read-only source and keep personal edits separate.
2. Import only a meeting the person selects. Deduplicate with provider meeting ID plus occurrence time. Handle recurring meetings, changed titles and overlapping calendars without matching by title alone.
3. Put speaker labels and source timestamps beside extracted decisions/actions. Unknown speaker stays unknown. Let the person correct attribution without rewriting the source.
4. Review action items in one shared composer with owner, due date, destination project and source excerpt. Apply creates tasks once; dismissing or re-importing must not recreate them.
5. Support incremental transcript chunks, cancellation, retry and model-cost previews. A partial extraction must never appear complete; summarizing again compares against existing decisions instead of replacing edited notes.
6. Improve mobile reading, keyboard navigation, attendee matching, time-zone labels and “Today/Yesterday” timestamps. A compact recap can be copied or exported before any sharing action.
7. Give imported sources explicit refresh/remove controls with a preview of linked tasks that remain. Keep deletions/restores consistent with Trash and sharing.

Dependencies: the unified requests contract, deterministic contact matching and explicit connector reads. Acceptance covers repeated imports, missing transcript permissions, disconnected providers, incomplete recordings, altered source text, ambiguous attendees, cross-space shares and inaccessible mobile controls.
