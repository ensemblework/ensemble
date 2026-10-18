# 31 · Connectors in use

What Ensemble does with an app once it is connected, and the connector catalog. Connecting itself (OAuth apps, tokens, remote MCP, sync) is in [03 §2](03_MODULE_CONTEXT_ENGINE.md#2-connectors); imports are in [27](27_IMPORTS.md); the assistant's tools are in [11](11_HOW_THE_ASSISTANT_WORKS.md).

Implementation reviewed from current source; provider tests use mocked responses unless stated otherwise. This audit does not reauthorize live vendor accounts.

## 1. Connection is not acquisition

Code inspected 18 Oct 2026. Native item adapters, board/file importers and vendor MCP are separate capabilities. Connecting an app saves a grant; it does not index all its content. Search results remain transient until an explicit save/attach/import. Vendor availability and required plans can change independently of this code.

## 2. What Ensemble does with a connected app

Each connector's detail page (Settings → Connections → Browse connectors) lists these under **In Ensemble** (`connectorUses` in `apps/hub-web/components/connectors/catalog-view.ts`).

### 2.1 Sync people and explicit imports

Manual Sync people reads bounded contact metadata from supported mail/calendar/chat/GitHub sources, filters automated identities and saves real people. It stores no message bodies, Artifacts or proposed tasks and makes no model call. Generic scheduled fetch returns without provider reads. Meeting-note imports and requested action-item tasks are explicit separate operations. [03 §2](03_MODULE_CONTEXT_ENGINE.md#2-connectors).

### 2.2 The assistant

- **Built-in tools** for Google Workspace, Microsoft 365, Zoom, Docusign and Jira ([11 §8.2](11_HOW_THE_ASSISTANT_WORKS.md)).
- **`apps_search` and `apps_read`** search and read every connected app Ensemble can search itself (§2.3): Notion pages, GitHub repositories and issues, Linear issues, Jira issues and Confluence pages, Trello cards, Slack channels and people, Drive and OneDrive files, Zendesk tickets, Vercel deployments, and the rest in the table in §4. A pasted link (a GitHub URL, `ENG-42`, a Notion URL) finds that item. Offered only when one of those apps is connected (`apps/hub-api/src/assistant/tools/app-items.ts`).
- **`hub_search_context` and `hub_read_context`** search what Ensemble already keeps: explicitly saved mail/chat/event/issue content, imported meeting transcripts and attached items (`apps/hub-api/src/assistant/tools/context.ts`).
- **The vendor's own tools** through its remote MCP server (`mcp_<app>_<tool>`), with each tool switchable in the connector's detail page.
- **`apps_post_update`** posts a comment on the issue, card or ticket a task came from.
- **`hub_import_app_file`** saves a Drive, OneDrive, Dropbox or Box file, or a Gmail or Outlook attachment, in Files; **`hub_save_app_item_as_page`** saves an item as an Ensemble page that says where it came from and links back. Notion reads retain tables and collapsible Markdown structure; imports use native blocks. For Notion it imports the complete accessible child-page tree with native formatting, and databases become ordinary tables with linked row pages (`imports/api/notion.ts`, `imports/notion-content.ts`). Both take `source`, `kind` and `id` from an `apps_search` hit and run after Apply ([11 §8.4](11_HOW_THE_ASSISTANT_WORKS.md)).
- Everything that changes an outside app waits for **Apply** and is written to the ledger; app content is passed to the model as information, not instructions.

### 2.3 Attach items to a task or project

**From your apps** on a task page and a project page opens a picker: choose an app (or all of them), search, and attach. Ensemble reads the item once and keeps its text (up to 20,000 characters) as an `Artifact` linked to the task or project (`metadata.via = "app-item"`), with a link back. **Refresh** reads it again; **Remove** unlinks it. Attached items are also listed in Files → From your apps; removing one there takes it off every task and project, and attaching it again brings it back ([32 §11](32_FILES.md#11-connected-items-opened-explicitly)).

Who reads attached items:
- the assistant (`hub_search_context`, and on the task's page);
- **agents working on the task**: `brief()` in `apps/hub-api/src/workspace/agent.ts` adds up to 12,000 characters of attached text from the task and its project, marked as information rather than instructions. This covers Ensemble's own agent and Claude Code, Codex and Cursor engines;
- **runs on a paired computer**: the job claim (`POST /api/devices/self/claim`) appends the same context (up to 8,000 characters) to the task description it sends;
- editors through the Context Bridge (`ensemble_brief`, `ensemble_search`), which already read a task's artifacts.

Code: `apps/hub-api/src/connectors/items/` (one file per app in `sources/`, the service in `index.ts`), routes in `apps/hub-api/src/routes/app-items.ts`, web in `apps/hub-web/components/app-items/`.

### 2.4 Hand work to an agent, and report back

- **Add as task**: an issue, pull request, card, ticket, work item or conversation becomes an Ensemble task with the item attached and its link as the task's source. Adding the same item again updates that task (`external_source = app:<app>`). From the Board's **Add from apps**, or `POST /api/app-items/task`.
- **Repositories from GitHub**: the Assign dialog's **Pick from GitHub** lists the repositories the GitHub connection can reach. A clone with no Settings git token now uses the GitHub connection (an OAuth grant with `repo` scope, or a pasted token) before falling back to `gh` (`apps/hub-api/src/lib/git-auth.ts`). GitHub's own MCP server can sign in with the same connection.
- **Post an update**: when a task came from (or has attached) an issue, card or ticket in GitHub, Linear, Jira (API-token connections), Trello, Asana, Todoist, ClickUp, monday.com, Azure DevOps, Zendesk (an internal note), Front (an internal comment), HubSpot (a note on the record), Figma or Notion, the task page offers **Post an update to …**. Pressing Post is the approval; the comment is written to the ledger as `apps.post_update`. The assistant can propose the same with `apps_post_update`, which waits for Apply.

### 2.5 Import boards and pages

Imports from Notion, Linear, Jira, Trello, Asana, Todoist, ClickUp, monday.com, GitHub and spreadsheets are unchanged ([27](27_IMPORTS.md)), and now open from the Board (**Import**) and from Pages (**Import from Notion**) as well as Settings. Trello lists and Jira statuses each map to an Ensemble column in the review step, so differently named columns land where the person chooses.

### 2.5b Files from apps

Files themselves (a PDF in Drive, a spreadsheet attached to an email, a deck in OneDrive, Dropbox or Box) come into **Files** with **Add from your apps**, which explains per app what is connected and what permission is missing, then downloads through the person's own connection. Gmail and Outlook attachments are searched as items of kind `attachment`. Details in [32 §5](32_FILES.md#5-bringing-files-in-from-apps).

### 2.6 People

**Add people from …** on Context → People reads an app's members and adds them to People with their email or handle, so mail, chats, meetings and mentions point at the same person. It never merges two existing people; a clash becomes a merge suggestion. Apps: Slack, GitHub (organisation members), Linear, Jira, Notion, Asana, ClickUp, monday.com, HubSpot (owners), Zendesk (agents) and Front (teammates). People are matched by email or by the app's own handle (Slack user id, GitHub login, Atlassian account id); someone with neither is skipped, which is why Trello, whose API gives no emails, is not offered. `POST /api/app-items/people`, at most 500 people per run.

## 3. Ways to connect

| Way | Who sets it up | Used by |
|---|---|---|
| Sign in with the app (OAuth) | Whoever runs Ensemble registers one app per vendor, once (Settings → Connections → the connector → Set up once) | Google, Microsoft, GitHub, Linear, Notion, Atlassian, Slack, Zoom, Docusign, Dropbox, Box, Xero, Discord |
| Paste a token | The person | GitHub, Slack, Linear, Notion, Jira, Trello, Asana, Todoist, ClickUp, monday.com, Figma, Vercel, Azure DevOps, Zendesk, Front, HubSpot, meeting-note apps |
| Vendor MCP server, open sign-in (DCR or CIMD) | Nobody | Most MCP connectors |
| Vendor MCP server with a token | The person | Intercom, Render, Smartsheet, Wrike (token only); Cloudflare and Stripe (token as an alternative) |
| Vendor MCP server with your account's address | The person types it | Grafana Cloud (stack), AWS (Region) |
| Vendor MCP server with an app the operator registers | Whoever runs Ensemble, once | HubSpot, Asana, Slack, Dropbox |
| Vendor MCP server with your organisation's own app | The person's admin | Salesforce, Front |
| Vendor MCP server through an existing connection | Nobody | GitHub, Linear |
| Upload an export | The person | Imports |

The MCP variants are fields on the catalog entry's `mcp` (`packages/shared-types/src/connectors.ts`: `fields`, `token`, `client`, `ownClient`, `connection`) and are handled by `POST /api/mcp-connections` (`apps/hub-api/src/routes/mcp-connections.ts`) and `apps/hub-api/src/connectors/mcp/manager.ts`. A connection that signs in through another connection stores no token of its own; every call reads the current token of that connection.

## 4. Every connector

Every entry in the store can be connected; nothing is listed as coming soon. Logos are each vendor's own mark ([§5](#5-logos)).

`CONNECTOR_CATALOG` in shared types owns the entries and connection metadata. The table below is a connection/reference map; “MCP sign-in” means the vendor OAuth path supported by Ensemble. Vendor policy, scopes and workspace configuration can still be required. It does not promise automatic ingestion or a native importer for every app.

**Google & Microsoft**

| App | Connects by | In Ensemble |
|---|---|---|
| Google Workspace | sign in | explicit source reads / imports · attach files and conversations · assistant writes (Apply) |
| Microsoft 365 | sign in | explicit source reads / imports · attach files and conversations · assistant writes (Apply) |

**Mail & calendar**

| App | Connects by | In Ensemble |
|---|---|---|
| Calendly | MCP sign-in | assistant tools |
| Cal.com | MCP sign-in | assistant tools |

**Files & docs**

| App | Connects by | In Ensemble |
|---|---|---|
| Dropbox | sign in · MCP (operator registers an app) | attach files · assistant tools |
| Box | sign in | attach files |
| Egnyte | MCP sign-in | assistant tools |

**Projects & issues**

| App | Connects by | In Ensemble |
|---|---|---|
| Linear | sign in · token · MCP via your Linear connection | explicit source reads / imports · attach issues and projects · post updates · people · import · assistant tools |
| Jira & Confluence | sign in · token · MCP sign-in | attach issues, projects and pages · post updates · people · import · assistant tools |
| Trello | token · file | attach cards and boards · post updates · import |
| Asana | token · MCP (operator registers an app) · file | attach tasks and projects · post updates · people · import · assistant tools |
| Todoist | token · MCP sign-in · file | attach tasks and projects · post updates · import · assistant tools |
| ClickUp | token · MCP sign-in · file | attach tasks and projects · post updates · people · import · assistant tools |
| monday.com | token · MCP sign-in | attach tasks and boards · post updates · people · import · assistant tools |
| Airtable | MCP sign-in | assistant tools |
| CSV or spreadsheet | file | import |
| Shortcut | MCP sign-in | assistant tools |
| Basecamp | MCP sign-in | assistant tools |
| Productboard | MCP sign-in | assistant tools |
| Smartsheet | MCP with a token | assistant tools |
| Wrike | MCP with a token | assistant tools |

**Notes & wikis**

| App | Connects by | In Ensemble |
|---|---|---|
| Notion | sign in · token · MCP sign-in | attach pages and databases · post updates · people · import · assistant tools |
| Evernote | MCP sign-in | assistant tools |
| Readwise | MCP sign-in | assistant tools |
| Guru | MCP sign-in | assistant tools |

**Meetings**

| App | Connects by | In Ensemble |
|---|---|---|
| Granola | token · MCP sign-in | requested meeting-note import · optional requested tasks · assistant tools |
| Zoom | sign in | assistant meeting/summary/transcript/recording tools |
| Fireflies.ai | token · MCP sign-in | requested meeting-note import · optional requested tasks · assistant tools |
| Fathom | token · MCP sign-in | requested meeting-note import · optional requested tasks · assistant tools |
| tl;dv | token | requested meeting-note import · optional requested tasks |
| Krisp | token · MCP sign-in | requested meeting-note import · optional requested tasks · assistant tools |
| Jamie | token · MCP sign-in | requested meeting-note import · optional requested tasks · assistant tools |
| Otter.ai | token · MCP sign-in | requested meeting-note import · optional requested tasks · assistant tools |
| Read AI | MCP sign-in | assistant tools |
| Avoma | MCP sign-in | assistant tools |
| Gong | MCP sign-in | assistant tools |
| Grain | MCP sign-in | assistant tools |
| Fellow | MCP sign-in | assistant tools |
| Supernormal | MCP sign-in | assistant tools |
| MeetGeek | MCP sign-in | assistant tools |
| Bluedot | MCP sign-in | assistant tools |
| Tactiq | MCP sign-in | assistant tools |
| Loom | MCP sign-in | assistant tools |

**Chat**

| App | Connects by | In Ensemble |
|---|---|---|
| Slack | sign in · token · MCP (operator registers an app) | explicit source reads / imports · attach channels · people · assistant tools |
| WhatsApp Business | MCP sign-in | assistant tools |
| Discord | sign in | attach channels |

**Developer**

| App | Connects by | In Ensemble |
|---|---|---|
| GitHub | sign in · token · MCP via your GitHub connection | explicit source reads / imports · attach repositories, issues and pull requests · post updates · people · repositories for agents · import · assistant tools |
| Sentry | MCP sign-in | assistant tools |
| Supabase | MCP sign-in | assistant tools |
| Hugging Face | MCP sign-in | assistant tools |
| Zapier | MCP sign-in | assistant tools |
| Vercel | token | attach deployments and projects |
| Azure DevOps | token | attach work items, pull requests and repositories · post updates |
| GitLab | MCP sign-in | assistant tools |
| Netlify | MCP sign-in | assistant tools |
| Railway | MCP sign-in | assistant tools |
| Heroku | MCP sign-in | assistant tools |
| Neon | MCP sign-in | assistant tools |
| PlanetScale | MCP sign-in | assistant tools |
| Prisma Postgres | MCP sign-in | assistant tools |
| Postman | MCP sign-in | assistant tools |
| Context7 | MCP sign-in | assistant tools |
| Jam | MCP sign-in | assistant tools |
| Resend | MCP sign-in | assistant tools |
| incident.io | MCP sign-in | assistant tools |
| Render | MCP with a token | assistant tools |

**Design**

| App | Connects by | In Ensemble |
|---|---|---|
| Canva | MCP sign-in | assistant tools |
| Miro | MCP sign-in | assistant tools |
| Webflow | MCP sign-in | assistant tools |
| Figma | token | attach designs and projects · post updates |
| Gamma | MCP sign-in | assistant tools |
| Pitch | MCP sign-in | assistant tools |
| Wix | MCP sign-in | assistant tools |

**Sales & support**

| App | Connects by | In Ensemble |
|---|---|---|
| Stripe | MCP sign-in | assistant tools |
| HubSpot | token · MCP (operator registers an app) | attach deals, contacts, companies and tickets · post updates · people · assistant tools |
| Intercom | MCP with a token | assistant tools |
| Pipedrive | MCP sign-in | assistant tools |
| Attio | MCP sign-in | assistant tools |
| Close | MCP sign-in | assistant tools |
| Customer.io | MCP sign-in | assistant tools |
| Clay | MCP sign-in | assistant tools |
| Apollo.io | MCP sign-in | assistant tools |
| Klaviyo | MCP sign-in | assistant tools |
| Salesforce | MCP with your org’s app | assistant tools |
| Zendesk | token | attach tickets · post updates · people |
| Front | token · MCP with your org’s app | attach conversations · post updates · people · assistant tools |

**Analytics**

| App | Connects by | In Ensemble |
|---|---|---|
| PostHog | MCP sign-in | assistant tools |
| Mixpanel | MCP sign-in | assistant tools |
| Amplitude | MCP sign-in | assistant tools |
| Datadog | MCP sign-in | assistant tools |
| Hex | MCP sign-in | assistant tools |
| Typeform | MCP sign-in | assistant tools |

**Finance**

| App | Connects by | In Ensemble |
|---|---|---|
| QuickBooks | MCP sign-in | assistant tools |
| PayPal | MCP sign-in | assistant tools |
| Square | MCP sign-in | assistant tools |
| Ramp | MCP sign-in | assistant tools |
| Brex | MCP sign-in | assistant tools |
| Mercury | MCP sign-in | assistant tools |
| Paddle | MCP sign-in | assistant tools |
| Xero | sign in | attach invoices and contacts |

**Recruiting**

| App | Connects by | In Ensemble |
|---|---|---|
| Greenhouse | MCP sign-in | assistant tools |
| Ashby | MCP sign-in | assistant tools |
| Deel | MCP sign-in | assistant tools |

**Signatures**

| App | Connects by | In Ensemble |
|---|---|---|
| Docusign | sign in | assistant envelope/template tools |

**Cloud**

| App | Connects by | In Ensemble |
|---|---|---|
| Cloudflare | MCP sign-in | assistant tools |
| Grafana Cloud | MCP (your stack) | assistant tools |
| AWS Knowledge | MCP sign-in | assistant tools |
| AWS | MCP (your region) | assistant tools |

**Web & research**

| App | Connects by | In Ensemble |
|---|---|---|
| Exa | MCP sign-in | assistant tools |
| Perplexity | MCP sign-in | assistant tools |
| Tavily | MCP sign-in | assistant tools |
| Firecrawl | MCP sign-in | assistant tools |

## 5. Logos

Each connector shows its vendor's own logo. The files are in `apps/hub-web/components/connectors/brands/` with their source in `manifest.json` (the vendor's own site icon, or the Iconify "logos", "devicon" and "vscode-icons" sets, or Simple Icons in the brand colour). `node scripts/build-brand-logos.mjs` turns them into `brand-index.generated.ts` (names and fits, loaded with the page) and `brand-images.generated.ts` (data URIs, loaded once in a separate chunk when a logo is first shown). `--check` fails when the generated files are stale. Names and logos belong to their owners and identify the service being connected; the store shows a trademark notice.

## 6. API

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/app-items/sources` | → `{ sources: [{ id, name, logo, kinds, people, comments }] }`, the connected apps Ensemble can search |
| GET | `/api/app-items/search?source=&q=&kind=&limit=` | → `{ items: [{ source, kind, id, title, subtitle?, url?, updatedAt? }], errors: [{ source, message }] }`. Without `source`, every connected app at once; one failing app is reported in `errors` |
| POST | `/api/app-items/read` | `{ source, kind, id }` → `{ item }` with `text` (Markdown), `facts`, `people` |
| GET | `/api/app-items/attached?taskId=\|projectId=` | → `{ items }` |
| POST | `/api/app-items/attach` | `{ source, kind, id, taskId? , projectId? }` → `{ item }`; attaching again refreshes |
| POST | `/api/app-items/attached/:artifactId/refresh` | → `{ item }` |
| DELETE | `/api/app-items/attached/:artifactId?taskId=\|projectId=` | → 204 |
| POST | `/api/app-items/task` | `{ source, kind, id, projectId? }` → `{ taskId, created }` |
| POST | `/api/app-items/people` | `{ source }` → `{ seen, added, matched, skipped }` |
| GET | `/api/app-items/update-target?taskId=` | → `{ target: { source, kind, id, title, url? } \| null }` |
| POST | `/api/app-items/update` | `{ taskId, body }` → `{ source, url? }` |

All routes need a verified email on hosted servers, act only on the person's own connections, tasks and projects, and are rate limited per person (searches and reads 120 per 10 minutes, changes 60 per 10 minutes, people 10 per hour). In a space shared with someone, the owner's connected apps are never offered to a guest.

## 7. Limits

- Each app's search is what its API offers: Slack has no message search with the scopes Ensemble asks for (channels and people only), Google Drive with `drive.file` sees only files Ensemble created or the person picked, ClickUp has no full-text search (recent tasks are filtered by name), Figma has no file search (a link, or a team's projects when the team link was given).
- Attached text is a copy from when it was attached or refreshed. Nothing re-reads it on a schedule.
- An item attached to a second task moves to that task (one artifact per item).
- Posting updates to Linear needs a connection that may write comments: personal API keys can; OAuth connections made before 12 Oct 2026 asked only for `read` and must connect again. Jira OAuth connections are read only; an API-token connection can comment.
- Ideas that are not built are in [design/connectors-next.md](design/connectors-next.md).

## 8. Tests

- `apps/hub-api/src/routes/app-items.integration.test.ts`: sources per person, search with one failing app, a pasted link, attach / list / refresh / remove and isolation, an issue as a task (once), the update target and a posted comment with its ledger entry, people added and matched again, hosted verification.
- `apps/hub-api/src/routes/mcp-connections.integration.test.ts`: sign-in through an existing connection (no copied token, rotation and removal), address fields, missing operator apps and connection checks before any network call.
- `apps/hub-api/src/connectors/items/work-sources.test.ts` and `more-sources.test.ts`: each app's search, read, comment and people calls against recorded vendor shapes.
- `apps/hub-web/components/connectors/brand-logo.test.tsx`, `catalog-view.test.ts`: every catalog entry has its vendor's logo and a way in, and says what Ensemble does with it.
- `apps/hub-web/components/app-items/*.test.tsx`: the picker and the attached list.

Sign-in and AI provider/model marks share `components/connectors/provider-logo.tsx`; assets and their source attribution are in `apps/hub-web/public/providers/manifest.json`. Model marks identify the originating vendor even when a subscription or reseller supplies the model. Files home shows only stored documents; **Add from your apps** and the assistant provide explicit search/import.

## Contact sync and explicit saves

Generic manual sync now saves real contact metadata only (`connectors/people-sync.ts`); it does not invoke item adapters, download files or create artifacts/proposals. Existing explicit search, preview, Attach, import and refresh actions keep their current behavior and permissions. Search matches are transient until the person chooses a save/import/attach. Metadata rules filter automated senders before storage, without a model.

## Relationships from the assistant

`hub_list_app_relationships` and `hub_manage_app_relationship` in `assistant/tools/relationships.ts` now expose the same Attach, Remove, Refresh, Add as task, Add people, project source-link and explicit People merge operations as the app. They use the original authenticated request to call the existing scoped routes, retaining their permissions, verification, limits and deduplication. Changes wait for Apply. `hub_run_workflow` can link newly created records using earlier results. This adds no general email or chat-sending tools. Full action map: [34](34_ASSISTANT_ACTIONS.md).
