# 31 · Connectors in use

What Ensemble does with an app once it is connected, and the connector catalog. Connecting itself (OAuth apps, tokens, remote MCP, sync) is in [03 §2](03_MODULE_CONTEXT_ENGINE.md#2-connectors); imports are in [27](27_IMPORTS.md); the assistant's tools are in [11](11_HOW_THE_ASSISTANT_WORKS.md) and [34](34_ASSISTANT_ACTIONS.md). Provider tests use mocked vendor responses.

## 1. Connecting is not importing

Connecting an app saves a grant; it indexes nothing. Native item adapters, board and file importers, and vendor MCP servers are separate capabilities. Search results are transient until the person saves, attaches or imports something. Vendor availability, plans, scopes and workspace settings can still limit what a connection reaches.

## 2. What Ensemble does with a connected app

Each connector's detail page (Settings → Connections → Browse connectors) lists these under **In Ensemble** (`connectorUses` in `apps/hub-web/components/connectors/catalog-view.ts`).

### 2.1 Sync people

**Sync people** is manual. It reads bounded contact metadata from Gmail, Outlook, Google Calendar, Outlook Calendar, Slack, Teams and GitHub, filters automated senders by rule (no model), and saves real people (`connectors/people-sync.ts`). It stores no message bodies, artifacts or proposed tasks and does not call item adapters or download files. Scheduled fetch reads nothing from providers. Meeting-note imports and action-item tasks are separate, explicit operations.

### 2.2 The assistant

Each turn's prompt lists the apps connected in the open space by catalog name, how each is connected (sign-in, token, MCP sign-in, MCP token, or MCP without sign-in, which sees only public data), the account label (for a Vercel token, the username) and which tools reach it (`assistant/connections.ts`). Apps not listed are not connected in this space. `hub_list_connections` gives the same list in detail and never returns a token. A message naming a connected app loads the connected-apps playbook ([11 §3](11_HOW_THE_ASSISTANT_WORKS.md#3-context-and-prompt-size)). In a space shared with you the owner's connections are neither listed nor reachable.

**Scope rule** (`assistant/apps.ts`, repeated in `apps_search`'s description): any connected-app read, remote MCP tools included, waits for an explicit request for that app's content, a request to search connected apps, or a link to an item. A connection, the app list, an open picker or a general file question is not permission. Saved Ensemble files and stored Hub context are the default; if the source is unclear the assistant asks. This holds whether app writes are on or off. The composer's **Attach file** picks saved Files only (`components/files/add-to-message.tsx`) and never searches apps.

| Tool | What it does |
|---|---|
| Built-in tools | Google Workspace, Microsoft 365, Zoom, Docusign and Jira |
| `apps_search`, `apps_read` | Search and read every app with an item adapter (§4). A pasted link (a GitHub URL, `ENG-42`, a Notion URL, a zotero.org or `zotero://select/…` link, a DOI) finds that item. An empty query lists recent items (Vercel: projects and latest deployments; Todoist: today and overdue; Linear, Jira, Azure DevOps, Zendesk: open work assigned to you; GitHub: open issues and PRs involving you); so does a query that only names a kind and the app ("all my Vercel deployments"), which also sets the kind (`listingRequest` in `assistant/tools/app-items.ts`; the picker still searches the typed words). Figma without a saved team link lists nothing for an empty query. Offered only when such an app is connected; item tools come before MCP tools |
| `hub_search_context`, `hub_read_context` | What Ensemble already keeps: explicitly saved mail, chat, event and issue content, imported transcripts, attached items (`assistant/tools/context.ts`) |
| `mcp_<app>_<tool>` | The vendor's own tools through its remote MCP server; each tool can be switched off on the detail page |
| `apps_post_update` | Comments on the issue, card or ticket a task came from |
| `hub_import_meeting_notes` | Imports up to 20 recent notes from Fireflies, Fathom, Granola, tl;dv, Krisp, Jamie or Otter (API-key connections) into Meetings; action items become proposed tasks only if asked. Through MCP these apps are searched live instead |
| `hub_import_app_file` | Saves a Drive, OneDrive, Dropbox or Box file, or a Gmail or Outlook attachment, in Files |
| `hub_save_app_item_as_page` | Saves an item as a page that names and links its source. Notion reads keep tables and collapsible sections; a Notion import brings the whole accessible child-page tree with native blocks, and databases become tables with linked row pages (`imports/api/notion.ts`, `imports/notion-content.ts`) |
| `hub_list_app_relationships`, `hub_manage_app_relationship` | Attach, remove, refresh, add as task, add people, project source links and People merges, through the same scoped routes, permissions, limits and deduplication as the Hub (`assistant/tools/relationships.ts`); `hub_run_workflow` can link records made earlier in a workflow |

The two import tools take `source`, `kind` and `id` from an `apps_search` hit. Everything that changes an outside app, and every relationship change, waits for **Apply**; outside changes are written to the ledger. App content is passed to the model as information, not instructions. The relationship tools send no email or chat.

### 2.3 Attach items to a task or project

**From your apps** on a task or project page opens a picker: choose an app (or all), search, attach. Ensemble reads the item once and keeps up to 20,000 characters as an `Artifact` on the task or project (`metadata.via = "app-item"`) with a link back. **Refresh** reads it again; **Remove** unlinks it. Attached items also appear in Files → From your apps; removing one there takes it off every task and project, and attaching it again brings it back ([32 §11](32_FILES.md#11-connected-items-opened-explicitly)).

Readers of attached text:

- the assistant (`hub_search_context`, and on the task's page);
- agents on the task: `brief()` in `apps/hub-api/src/workspace/agent.ts` adds up to 12,000 characters from the task and its project, marked as information (Ensemble's agent, Claude Code, Codex, Cursor);
- runs on a paired computer: the claim (`POST /api/devices/self/claim`) appends up to 8,000 characters to the task description;
- editors through the Context Bridge (`ensemble_brief`, `ensemble_search`).

Code: `apps/hub-api/src/connectors/items/` (`index.ts`, one file per app in `sources/`), `apps/hub-api/src/routes/app-items.ts`, `apps/hub-web/components/app-items/`.

### 2.4 Tasks, repositories and updates

- **Add as task**: an issue, pull request, card, task, ticket, work item, conversation, Zotero reference or page becomes a task with the item attached and its link as the source. A Zotero reference becomes "Read: ‹title›" with authors, year, venue and DOI. Adding it again updates the same task (`external_source = app:<app>`). From the Board's **Add from apps** or `POST /api/app-items/task`.
- **Repositories from GitHub**: the Assign dialog's **Pick from GitHub** lists repositories the connection reaches. Without a Settings git token, clones use the GitHub connection (OAuth with `repo` scope, or a pasted token), then `gh` (`apps/hub-api/src/lib/git-auth.ts`). GitHub's MCP server can sign in with the same connection.
- **Post an update**: when a task came from (or has attached) an item in GitHub, Linear, Jira (API-token connections), Trello, Asana, Todoist, ClickUp, monday.com, Azure DevOps, Zendesk (internal note), Front (internal comment), HubSpot (note on the record), Zotero (child note), Figma or Notion, the task page offers **Post an update to …**. Pressing Post is the approval; the ledger records `apps.post_update`.

### 2.5 Imports and files

Imports from Notion, Linear, Jira, Trello, Asana, Todoist, ClickUp, monday.com, GitHub and spreadsheets ([27](27_IMPORTS.md)) open from the Board (**Import**), Pages (**Import from Notion**) and Settings. Trello lists and Jira statuses map to Ensemble columns in the review step.

Files (a PDF in Drive, an email attachment, a deck in OneDrive, Dropbox or Box) come into Files with **Add from your apps**, which explains per app what is connected and which permission is missing, then downloads through the person's connection; Gmail and Outlook attachments are items of kind `attachment` ([32 §5](32_FILES.md#5-bringing-files-in-from-apps)). Files home lists only stored documents.

### 2.6 People

**Add people from …** on Context → People adds an app's members with their email or handle, so mail, chats, meetings and mentions point at one person. It never merges existing people; a clash becomes a merge suggestion. Apps: Slack, GitHub (organisation members), Linear, Jira, Notion, Asana, ClickUp, monday.com, HubSpot (owners), Zendesk (agents) and Front (teammates). Matching is by email or the app's handle (Slack user id, GitHub login, Atlassian account id); people with neither are skipped, so Trello (no emails) is not offered. `POST /api/app-items/people`, at most 500 people per run.

## 3. Ways to connect

| Way | Who sets it up | Used by |
|---|---|---|
| Sign in with the app (OAuth) | Whoever runs Ensemble registers one app per vendor (Settings → Connections → the connector → Set up once) | Google, Microsoft, GitHub, Linear, Notion, Atlassian, Slack, Zoom, Docusign, Dropbox, Box, Xero, Discord |
| Paste a token | The person | GitHub, Slack, Linear, Notion, Jira, Trello, Asana, Todoist, ClickUp, monday.com, Figma, Vercel, Azure DevOps, Zendesk, Front, HubSpot, Zotero, meeting-note apps |
| Vendor MCP, open sign-in (DCR or CIMD) | Nobody | Most MCP connectors |
| Vendor MCP with a token | The person | Intercom, Render, Smartsheet, Wrike (token only); Cloudflare, Stripe, Hugging Face (instead of signing in) |
| Vendor MCP needing no account | Nobody | AWS Knowledge, Context7, Exa (`mcp.open`). Another catalog server that answers without an account is sent to its sign-in, or shown as **Connected · public data only** if it has none |
| Vendor MCP at your account's address | The person types it | Grafana Cloud (stack), AWS (Region) |
| Vendor MCP with an operator-registered app | Whoever runs Ensemble | HubSpot, Asana, Slack, Dropbox |
| Vendor MCP with your organisation's app | The person's admin | Salesforce, Front |
| Vendor MCP through an existing connection | Nobody | GitHub, Linear |
| Upload an export | The person | Imports |

The MCP variants are fields on the catalog entry's `mcp` (`packages/shared-types/src/connectors.ts`: `fields`, `token`, `client`, `ownClient`, `connection`, `open`), handled by `POST /api/mcp-connections` (`apps/hub-api/src/routes/mcp-connections.ts`) and `apps/hub-api/src/connectors/mcp/manager.ts`. A connection that signs in through another connection stores no token; each call reads that connection's current token.

**Guides.** Every way has plain step-by-step guidance on the detail page (`packages/shared-types/src/connector-guides.ts`). `CONNECTOR_GUIDES` has a written guide for every pasted-credential connector and every MCP server taking a token, an address or the organisation's app; `connectorGuide(entry, way)` adds short guides for sign-in and plain MCP sign-in. Each guide names the credential with the vendor's word (`term`), matching the form's label. `connector-guides.test.ts`, `catalog-view.test.ts` and `token-providers-more.test.ts` check coverage and that links are `https://`. Guides follow vendor docs and are not re-checked against live vendor pages.

**Trello** needs an API key and a token from the Power-Up admin page (`https://trello.com/power-ups/admin`): open or create a Power-Up, copy the API key, then use the Token link beside it (or **Get a token** in Ensemble, which opens `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=Ensemble&key=<key>`), Allow, and copy the token (starts with `ATTA`). Write scope lets Ensemble comment on cards. The Power-Up's Secret is not a token: when Trello refuses a 64-character hex value, Ensemble says it looks like the Secret. A one-off import needs no key: upload the board's JSON export (board menu → Print, export and share → Export as JSON).

## 4. Every connector

`CONNECTOR_CATALOG` (`packages/shared-types/src/connectors.ts`) owns every entry and its connection metadata; every entry can be connected, none is "coming soon". The tables say how an app connects and what Ensemble does with it, not that its content is ingested automatically. "MCP" means the vendor's remote MCP server and "assistant tools" its tools.

**Apps with native features**

| App (store group) | Connects by | In Ensemble |
|---|---|---|
| Google Workspace, Microsoft 365 (Google & Microsoft) | sign in | Sync people · attach files, conversations and attachments · import files · assistant reads and writes (Apply) |
| Dropbox (Files) | sign in · MCP (operator app) | attach and import files · assistant tools |
| Box (Files) | sign in | attach and import files |
| Linear (Projects) | sign in · token · MCP via your Linear connection | attach issues and projects · post updates · people · import · assistant tools |
| Jira & Confluence (Projects) | sign in · token · MCP | attach issues, projects and pages · post updates · people · import · assistant tools |
| Trello (Projects) | token · file | attach cards and boards · post updates · import |
| Asana (Projects) | token · MCP (operator app) · file | attach tasks and projects · post updates · people · import · assistant tools |
| Todoist (Projects) | token · MCP · file | attach tasks and projects · post updates · import · assistant tools |
| ClickUp (Projects) | token · MCP · file | attach tasks and projects · post updates · people · import · assistant tools |
| monday.com (Projects) | token · MCP | attach tasks and boards · post updates · people · import · assistant tools |
| CSV or spreadsheet (Projects) | file | import |
| Notion (Notes) | sign in · token · MCP | attach pages and databases · post updates · people · import · assistant tools |
| Granola, Fireflies.ai, Fathom, Krisp, Jamie, Otter.ai (Meetings) | token · MCP | meeting-note import on request · action-item tasks on request · assistant tools |
| tl;dv (Meetings) | token | meeting-note import on request · action-item tasks on request |
| Zoom (Meetings) | sign in | assistant tools for meetings, recordings, summaries and transcripts |
| Slack (Chat) | sign in · token · MCP (operator app) | Sync people · attach channels · people · assistant tools |
| Discord (Chat) | sign in | attach channels |
| GitHub (Developer) | sign in · token · MCP via your GitHub connection | Sync people · attach repositories, issues and pull requests · post updates · people · repositories for agents · import · assistant tools |
| Vercel (Developer) | token | attach deployments and projects |
| Azure DevOps (Developer) | token | attach work items, pull requests and repositories · post updates |
| Figma (Design) | token | attach designs and projects · post updates |
| HubSpot (Sales & support) | token · MCP (operator app) | attach deals, contacts, companies and tickets · post updates · people · assistant tools |
| Zendesk (Sales & support) | token | attach tickets · post updates · people |
| Front (Sales & support) | token · MCP (your org's app) | attach conversations · post updates · people · assistant tools |
| Xero (Finance) | sign in | attach invoices and contacts |
| Docusign (Signatures) | sign in | assistant envelope and template tools |
| Zotero (Web & research) | token | attach references (APA citation, abstract, notes) and collections (reading lists the assistant can save as a page) · references as reading tasks · post notes |

**Assistant tools only, through the vendor's MCP server** (open sign-in unless §3 lists another way):

| Store group | Apps |
|---|---|
| Mail & calendar | Calendly, Cal.com |
| Files & docs | Egnyte |
| Projects & issues | Airtable, Shortcut, Basecamp, Productboard, Smartsheet (token), Wrike (token) |
| Notes & wikis | Evernote, Readwise, Guru |
| Meetings | Read AI, Avoma, Gong, Grain, Fellow, Supernormal, MeetGeek, Bluedot, Tactiq, Loom, Wispr Flow (read only; the account needs Notetaker and MCP access) |
| Chat | WhatsApp Business (sending needs a verified Meta business account; Meta enables access per business) |
| Developer | Sentry, Supabase, Hugging Face (sign-in or access token, never anonymous), Zapier, GitLab, Netlify, Railway, Heroku, Neon, PlanetScale, Prisma Postgres, Postman, Context7 (no account), Jam, Resend, incident.io, Render (token) |
| Design | Canva, Miro, Webflow, Gamma, Pitch, Wix |
| Sales & support | Stripe (or token), Intercom (token), Pipedrive, Attio, Close, Customer.io, Clay, Apollo.io, Klaviyo, Salesforce (your org's app) |
| Analytics | PostHog, Mixpanel, Amplitude, Datadog, Hex, Typeform |
| Finance | QuickBooks, PayPal, Square, Ramp, Brex, Mercury, Paddle |
| Recruiting | Greenhouse, Ashby, Deel |
| Cloud | Cloudflare (or token), Grafana Cloud (your stack), AWS Knowledge (no account), AWS (your Region) |
| Web & research | Exa (no account), Perplexity, Tavily, Firecrawl |

## 5. Logos

Each connector shows its vendor's logo. Files are in `apps/hub-web/components/connectors/brands/`, with sources in its `manifest.json` (the vendor's site icon, the Iconify "logos", "devicon" and "vscode-icons" sets, or Simple Icons in the brand colour). `node scripts/build-brand-logos.mjs` writes `apps/hub-web/components/connectors/brand-index.generated.ts` (names and fits, loaded with the page) and `brand-images.generated.ts` (data URIs, loaded lazily in a separate chunk); `--check` fails when they are stale. `zotero.svg` (a red "Z") and `wisprflow.svg` (a "W" on a dark tile) are placeholder lettermarks, marked as such in the manifest. The store shows a trademark notice (`TRADEMARK_NOTICE` in `brand-logo.tsx`).

Sign-in and AI provider/model marks use `components/connectors/provider-logo.tsx`, with assets and attribution in `apps/hub-web/public/providers/manifest.json`. A model mark shows the model's originating vendor even when a subscription or reseller supplies it.

## 6. API

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/app-items/sources` | → `{ sources: [{ id, name, logo, kinds, people, comments }] }`, connected apps Ensemble can search |
| GET | `/api/app-items/search?source=&q=&kind=&limit=` | → `{ items: [{ source, kind, id, title, subtitle?, url?, updatedAt? }], errors: [{ source, message }] }`. Without `source`, all connected apps; a failing app is reported in `errors`. `limit` default 10, max 25 |
| POST | `/api/app-items/read` | `{ source, kind, id }` → `{ item }` with `text` (Markdown), `facts`, `people` |
| GET | `/api/app-items/attached?taskId=\|projectId=` | → `{ items }` |
| POST | `/api/app-items/attach` | `{ source, kind, id, taskId?, projectId? }` → `{ item }`; attaching again refreshes |
| POST | `/api/app-items/attached/:artifactId/refresh` | → `{ item }` |
| DELETE | `/api/app-items/attached/:artifactId?taskId=\|projectId=` | → 204 |
| POST | `/api/app-items/task` | `{ source, kind, id, projectId? }` → `{ taskId, created }` |
| POST | `/api/app-items/people` | `{ source }` → `{ seen, added, matched, skipped }` |
| GET | `/api/app-items/update-target?taskId=` | → `{ target: { source, kind, id, title, url? } \| null }` |
| POST | `/api/app-items/update` | `{ taskId, body }` (up to 20,000 characters) → `{ source, url? }` |

All routes need a verified email on hosted servers, act only on the person's own connections, tasks and projects, and are rate limited per person: searches and reads 120 per 10 minutes, changes 60 per 10 minutes, people 10 per hour. A guest in a shared space is never offered the owner's apps.

## 7. Limits

- Search is what each API offers: Slack has no message search with Ensemble's scopes (channels and people only); Google Drive with `drive.file` sees only files Ensemble created or the person picked; ClickUp has no full-text search (recent tasks are matched by name); Figma has no file search (a link, or a team's projects when the team link was given).
- Attached text is a copy from when it was attached or refreshed; nothing re-reads it on a schedule.
- An item is one artifact with one task and one project: attaching it to a second task moves it there.
- Zotero is read through its web API, so Ensemble sees what Zotero has synced to zotero.org. Searches cover the person's library and the first five group libraries the key can read (up to ten are saved at connect). A group link that names the group only by name (`zotero.org/groups/<name>/items/<key>`) is looked up in those groups. Attachments are listed by name, without files. A collection reads its first 50 items.
- Confluence pages need Jira connected with an API token; Atlassian OAuth grants Jira scopes only and is read-only, so posting updates also needs an API-token connection.
- Linear OAuth asks for `read` and `comments:create`; a Linear connection without comment permission must connect again to post updates. Personal API keys can comment.

## 8. Tests

- `apps/hub-api/src/routes/app-items.integration.test.ts`: sources per person, search with a failing app, pasted links, attach / list / refresh / remove and isolation, an issue as a task (once), update target and posted comment with its ledger entry, a Zotero reference as a "Read:" task with a note posted back, people added and re-matched, hosted verification.
- `apps/hub-api/src/routes/mcp-connections.integration.test.ts`: sign-in through an existing connection (no copied token, rotation, removal), address fields, missing operator apps, and checks before any network call.
- `apps/hub-api/src/connectors/items/work-sources.test.ts`, `more-sources.test.ts`: each app's search, read, comment and people calls against recorded vendor shapes. The Zotero cases (and its key check in `token-providers-more.test.ts`) follow the Zotero Web API v3 documentation and are not run against zotero.org.
- `apps/hub-api/src/routes/mcp-sign-in.integration.test.ts`, with in-process vendor fakes: Hugging Face sign-in on `?login`, a pasted token checked with whoami and shown as the account, an anonymous connection kept when an upgrade fails, sign-in started for a catalog server that answered without an account, public-data-only when it has no sign-in, open servers left alone, Ensemble's User-Agent on every request, Meta's web pages reported by host.
- `apps/hub-web/components/connectors/mcp-way.test.tsx`: Hugging Face offers **Sign in with Hugging Face** and **Paste an access token** (no anonymous Connect); a public-only connection says so and offers both; store labels ("Connected as …", "Connected · public data only").
- `apps/hub-web/components/connectors/brand-logo.test.tsx`, `catalog-view.test.ts`: every entry has its vendor's logo, a way in, and says what Ensemble does with it.
- `apps/hub-web/components/app-items/*.test.tsx`: the picker and the attached list.
