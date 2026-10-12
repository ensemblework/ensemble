# Connectors: what could come next

**Design note, not built.** Options for the owner to review after [31](../31_CONNECTORS_IN_USE.md) shipped on 12 Oct 2026. Each idea says what other AI apps do, what it would take here, and what it would cost on the current hosting (one small VM, Vercel Hobby). Nothing below is planned until it moves into the roadmap.

## 1. Hand an issue to Ensemble from the tracker itself

**What others do.** Cursor, Codex, Copilot and Devin appear as assignable "users" in Linear and Jira. Assigning an issue starts a run; progress posts back as activity on the issue; the run ends with a pull request and a comment ([Linear Agent API](https://linear.app/developers/agent-interaction), [Cursor + Linear](https://cursor.com/docs/integrations/linear)).

**Here.** Today the person adds the issue as a task and assigns it in Ensemble, then posts the update back (31 §2.4). An Ensemble agent in Linear would need a Linear OAuth app with the `app:assignable` actor, a public webhook endpoint (`/api/webhooks/linear`), and an "agent session" per delegated issue that mirrors the run's plan, questions and result. Jira's equivalent is a Forge app.

**Cost.** Webhooks scale with work, not users; small. The work is the session mapping and keeping the agent's identity separate from the person's own Linear token.

## 2. Start work from Slack or Teams

**What others do.** `@Claude`, `@ChatGPT`, `@Cursor` and `@Devin` in a thread start a run, post a plan, and reply with the result ([Claude Tag](https://claude.com/docs/claude-tag/overview.md), [Cursor + Slack](https://cursor.com/docs/integrations/slack)).

**Here.** A Slack app with the Events API and a bot, `@Ensemble add this as a task` / `@Ensemble ask the agent to…`, replying in the thread with a link to the task. Needs Slack app review for public distribution and a public events endpoint.

## 3. Keep imports in sync

**What others do.** Linear keeps Jira and GitHub imports syncing; ChatGPT's "synced" apps index ahead of time.

**Here.** Imports re-run on request and never duplicate ([27 §4](../27_IMPORTS.md)). A **Keep in sync** switch per import could re-run it when the person opens the Board (not on a timer, to keep server cost tied to use), or from vendor webhooks where they exist (Linear, GitHub, Trello, Asana, Jira all have them). Two-way sync (moving a card in Ensemble moves it in Trello) is a bigger promise: conflicts, field mapping back, and write scopes.

## 4. Refresh attached items

Attached items are copies (31 §7). Claude re-reads a Drive file on every message; its project copies refresh on "Sync now". Options: refresh when an agent run starts (one read per attached item, bounded), or show the item's age and a refresh button (built). Re-reading at run start is cheap and keeps agents current.

## 5. Per-tool permissions for MCP tools

Claude lets each tool be **Always allow / Needs approval / Blocked**; ChatGPT admins choose read-only or a custom action set. Ensemble has on/off per tool and Apply for every write. A three-way setting per tool (and "always allow this read-only tool without showing it") would match what people expect from Claude.

## 6. Interactive results (MCP Apps)

Claude and Cursor render a vendor's UI inside the chat (Asana, Figma, Slack drafts, Hex charts). Supporting the MCP Apps resource type in the assistant dock would let the person confirm or edit an action in the vendor's own widget. Needs a sandboxed iframe host and a review of each widget's capabilities.

## 7. Team connections

ChatGPT and Claude separate a person's own connections from a shared, admin-managed one (a service account for a channel or team). In an Ensemble space shared with others, the owner's connected apps are private today (31 §6). A space-level connection (for example one Linear workspace token for the team) would let guests' assistants and agents use it, with the owner's explicit choice.

## 8. Search across everything, with citations

ChatGPT's company knowledge, Notion AI and Glean answer from an index with citations. Ensemble stores synced and attached items (`artifacts`) and searches them by substring (`hub_search_context`). The `artifact_chunks` table and a `search_vector` column exist but are unused; filling them (Postgres full-text first, pgvector later) would give ranked results and quote previews. Cost is CPU at ingest and storage per person; it should stay opt-in per source.

## 9. Connectors still worth adding

From the directories reviewed on 12 Oct 2026, these need something Ensemble does not have yet:

| App | What blocks it |
|---|---|
| Figma MCP, Vercel MCP, Harvey | The vendor only accepts listed clients; apply to their programs (Ensemble uses Figma's and Vercel's REST APIs meanwhile) |
| Zendesk MCP | Announced, not released |
| Snowflake, Databricks, BigQuery, Google and Microsoft remote MCP servers | Per-account addresses plus an OAuth client the customer registers; the "your organisation's own app" path (Salesforce, Front) could cover them |
| Coda, ZoomInfo, Make, Aha! | Their sign-in requires a client secret even with dynamic registration; Ensemble's MCP client is public (PKCE only) |
| Atlassian, Datadog, incident.io, Ramp | Listed and working, but the customer's admin (or the vendor) must allow `api.ensemblework.com` as a sign-in address; worth asking Atlassian to add it to their default list |
| Shopify, Plaid, MongoDB Atlas, PagerDuty | Pre-registered clients or partner programs |
