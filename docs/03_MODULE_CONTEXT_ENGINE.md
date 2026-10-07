# 03 · Module M2 — Context Engine (connectors, Engineer Graph, context packs)

**Purpose:** Continuously assemble everything the agent needs to understand my work without being told: who I work with, on what, what I owe, what changed, and how the pieces connect. Exposes a **Context Pack API** that every worker and the "Help me" surface consume.

---

## 1. Responsibilities

1. **Ingest** from pluggable connectors: Gmail, Outlook, Teams, calendar, GitHub, local workspace — later Notion, Linear, and office docs. **No Azure DevOps. No M365 Copilot.**
2. **Normalize** into a common `Artifact` shape with people, time, project and repo links.
3. **Extract** commitments, asks, decisions, action items, deadlines (LLM, structured output).
4. **Maintain the Engineer Graph** — a small personal knowledge graph: People, Projects, Repos, WorkItems, Meetings, Threads, Preferences — with evidence and confidence.
5. **Build Context Packs** on demand for a task, a meeting, a chat, or a coding session (bounded, ranked, cited).
6. **Emit deltas** ("what changed") to the orchestrator for todo proposals.

---

## 2. Connectors

**First wave** (see [00](00_PROJECT_OVERVIEW.md#direction)). What is connected today is in [18](18_WHAT_IS_REAL.md#connectors-read-only): sync from Gmail, Google Calendar, Outlook mail, Outlook calendar, Teams chats, GitHub, Slack and Linear (`apps/hub-api/src/connectors/`), meeting notes from Fireflies, Fathom, Granola, tl;dv, Krisp, Jamie and Otter (§2.3), and accounts for Notion, Atlassian (Jira), Trello, Asana, Todoist, ClickUp, monday.com, Zoom and Docusign that imports and assistant tools use through `tokens.ts`.

Hosted public accounts must verify email before connecting, syncing or using a connector token (`requireVerifiedUser`). Any verified person can connect their own accounts through the instance's OAuth apps or a pasted token. Only two things stay operator-only: saving an instance OAuth app (`PUT /api/connectors/apps/:provider`) and the host credential fallbacks (`GITHUB_TOKEN`, `SLACK_USER_TOKEN`/`SLACK_BOT_TOKEN`, `LINEAR_API_KEY`, `gh auth token`; `canUseHostCredentials`). Login OAuth is identity-only: signing in never stores a connector token, although connectors may borrow the same OAuth client (§2.1). The scheduler and enrichment worker skip unverified users. Local and desktop behavior is unchanged.

Uploaded document originals have a separate hosted per-user cap, `ENSEMBLE_MAX_DOCUMENT_BYTES` (100 MiB by default). `createCappedDocument` in `lib/hosted-limits.ts` admits under the user-row transaction lock; exact-threshold concurrent tests ensure an excess upload leaves no original/artifact. Soft-deleted originals count until physically purged. This upload cap does not prevent unverified accounts from storing their own notes/documents; model enrichment still requires verification.

| Connector | Source / API | Wave | Data pulled |
|---|---|---|---|
| `gmail` | Gmail API (history/delta) | P0 | subject, from/to/cc, body, thread, labels |
| `outlook-mail` | Graph `/me/messages` delta *(old `mail` connector)* | P0 | same shape as Gmail, normalized |
| `google-calendar` / `outlook-calendar` | Calendar API / Graph `calendarView` | P0 | events, attendees, all-day/cancelled, joinUrl |
| `github` | GitHub REST (or MCP): PRs, reviews, commits, issues | P0 | my PRs, review comments, CI, history |
| `teams-chat` | Graph chats/channels *(old Teams connectors)* | P1 | 1:1, group, channel posts, mentions |
| `workspace` | Local FS + git | P0 | branch, diff, TODOs, failing tests |
| `notion` / `linear` | Official APIs | P2 | pages, issues — import, then sync |
| `office-docs` | Word / PPTX / Excel · Google Docs / Slides / Sheets | P2 | referenced files as artifacts (reuse §13 parser) |

**Out of scope:** Azure DevOps, M365 Copilot paste, fabricated seed tenants.

Microsoft 365 as built (`apps/hub-api/src/connectors/microsoft.ts`, Graph v1.0, `$select`ed fields, `@odata.nextLink` paging that never leaves `graph.microsoft.com`):

| Source id | Graph call | Data pulled |
|---|---|---|
| `outlook` | `/me/mailFolders/inbox/messages` and `/sentitems/messages`, filtered by date since the last sync (or `fetch.lookbackDays`), up to 100 per folder, text bodies via `Prefer: outlook.body-content-type="text"` | subject, from/to/cc, body with quoted history removed, conversationId, webLink. Drafts and Focused Inbox "Other" are skipped. Mail from others goes to triage like Gmail. |
| `outlook_calendar` | `/me/calendarView` from a week ago to three weeks out, times in UTC | subject, attendees, organizer, all-day, location, Teams join link. Cancelled and declined events are skipped; events gone from the window are soft-deleted. |
| `teams` | `/me/chats` (newest first, members expanded, up to 40 one-to-one and group chats) and `/me/chats/{id}/messages` changed since the last sync | chat messages as `chat_msg` artifacts. Messages from others in one-to-one chats, and messages that @mention you in group chats, go to triage; todos are titled "Answer … on Teams". Channel posts and meeting chats are not read. Work or school accounts only. |

> **Cadence:** scheduled fetching is paused product-wide until routines replace it. `startScheduler` skips the fetch slots unless `ENSEMBLE_SCHEDULED_FETCH=on`, whatever `settings.fetch.scheduled` says (default `false`). *Fetch now* (`POST /api/fetch`) and per-source *Sync* (`POST /api/connections/:id/sync`) work as before. See [05 §2](05_MODULE_TASK_ORCHESTRATOR.md#2-scheduled-work-two-fetches-a-day).

### 2.1 Connector store, OAuth apps, products and tokens

The store lists every app in `CONNECTOR_CATALOG` (`packages/shared-types/src/connectors.ts`). `GET /api/connectors/catalog` (`src/connectors/catalog.ts`) adds each person's state: `connected` and `account` from their own `oauth_tokens` row, `appReady` (the operator set up what the entry needs, or it can connect by token, MCP or file), `oauthReady`, `products` (saved toggles over the catalog defaults), `needsConsent` (products that are on but not granted yet), `sources` (`settings.connections` plus `sync_state` last sync and error), and `mcp` (status, tool count and last error from `mcp_connections`).

**OAuth apps.** `oauthApp` in `src/connectors/accounts.ts` picks, in order: the connector's own `<PROVIDER>_CLIENT_ID`/`_SECRET`, an app the operator saved in Settings → Connections (`connector_apps`, encrypted), and for Google, Microsoft and GitHub the sign-in app (`AUTH_GOOGLE_*`, `AUTH_MICROSOFT_*`, `AUTH_GITHUB_*`). The redirect URI is `${HUB_API_PUBLIC_URL}/api/connectors/<provider>/callback`; a borrowed sign-in app needs that URI added (a GitHub OAuth App allows one callback, so set it to `${HUB_API_PUBLIC_URL}/api` to cover both sign-in and connector callbacks). Flows in `src/connectors/oauth.ts` use a 10-minute in-memory state (one API process) and PKCE S256 for Google, Microsoft, GitHub, Linear, Zoom and Docusign. On hosted servers each flow is bound to the browser that pressed Connect (RFC 6749 §10.12): `/start` sets an HttpOnly, SameSite=Lax `ensemble_connect_<provider>` cookie (on `ENSEMBLE_COOKIE_DOMAIN` like the session), and the callback exchanges the code only when that cookie matches and the browser's Ensemble session is the account that started. Anything else redirects back with an error and saves nothing. Desktop and local runs skip this check; the system browser there has no Ensemble session.

| Provider | Authorize / token | Scopes asked | Saved with the token |
|---|---|---|---|
| `google` | accounts.google.com, `access_type=offline`, `include_granted_scopes=true` | `openid email profile` plus the products that are on (below) | email |
| `microsoft` | login.microsoftonline.com/`common` v2.0 | `openid email profile offline_access User.Read` plus products | mail or UPN, Graph user id |
| `github` | github.com OAuth App | `repo read:user read:org` | login |
| `linear` | linear.app / api.linear.app | `read` | email, `auth: bearer` |
| `notion` | api.notion.com, `owner=user`, JSON exchange with HTTP Basic | none | workspace name, `workspaceId`, `botId` |
| `atlassian` | auth.atlassian.com, `audience=api.atlassian.com`, `prompt=consent` | `read:jira-work read:jira-user offline_access` | `cloudId`, `site`, `siteName` from accessible-resources, `auth: bearer` |
| `slack` | slack.com/oauth/v2, `user_scope` | `channels:history groups:history im:history mpim:history users:read users:read.email` (user token from `authed_user`) | `user @ team` |
| `zoom` | zoom.us, HTTP Basic exchange; scopes come from the app | `user:read:user meeting:read:list_meetings cloud_recording:read:list_user_recordings cloud_recording:read:meeting_transcript meeting:read:summary` | email |
| `docusign` | account-d.docusign.com (`DOCUSIGN_ENV=demo`, default) or account.docusign.com | `signature` | email, default account `accountId`, `baseUri` |

**Products.** Google Workspace and Microsoft 365 are suites (`src/connectors/products.ts`). Connect asks only for the base scopes and the scopes of the products that are on: `GET /api/connectors/:provider/start?products=a,b` takes an explicit list, otherwise the saved toggles in `settings.connectorProducts`. `PUT /api/connectors/:id/products` saves toggles; switching a product off applies at once (its sync sources switch off), and switching on a product whose scopes the stored token lacks returns `{ reconnect: true, url }` so the person approves only the new access. The toggle is saved when the callback comes back with that scope granted (Google lets people untick a permission on its consent screen).

| Suite product | Scopes | Feeds |
|---|---|---|
| `gmail` | `gmail.readonly` (restricted) | `gmail` |
| `calendar` | `calendar.events` (sensitive; read, create and update events with invites), `calendar.calendarlist.readonly` | `google_calendar` |
| `drive_docs` (on by default) | `drive.file` (non-sensitive; files the person picks or Ensemble creates; Docs, Sheets, Slides) | Google Picker, assistant tools |
| `drive_search` (off by default) | `drive.readonly` (restricted: public servers need Google verification) | assistant tools |
| `outlook_mail` | `Mail.Read` | `outlook` |
| `outlook_calendar` | `Calendars.ReadWrite` | `outlook_calendar` |
| `teams` (off by default) | `Chat.Read` (work or school accounts) | `teams` |
| `onedrive` | `Files.Read` | assistant tools |
| `office` | `Files.ReadWrite` (Word, Excel, PowerPoint; covers OneDrive read) | assistant tools |

Google Calendar sync reads the calendars shown in Google Calendar (`calendarList`, up to 10) when the list scope is granted, otherwise `primary`. Tokens granted the older `calendar.readonly` keep working.

**Tokens for code.** Tools, importers and syncs get tokens only through `src/connectors/tokens.ts`: `providerAccessToken` refreshes tokens within a minute of expiry (Google, Microsoft, Atlassian, Zoom, Docusign, and Linear or Slack when they issue refresh tokens), saves rotated refresh tokens, and returns `extra` with the saved details (Atlassian `site`/`cloudId`/`auth`, Trello `key`, Docusign `accountId`/`baseUri`). Scope checks (`hasScopes`, `requireProviderToken`) ignore case and Graph's `https://graph.microsoft.com/` prefix, and accept broader grants (`Files.ReadWrite` covers `Files.Read`).

**Pasted tokens.** `POST /api/connectors/:provider/token` checks the token once before storing it (`src/connectors/token-providers.ts`):

| Provider | Body | Check |
|---|---|---|
| `github` | `{ token }` | `GET api.github.com/user` |
| `slack` | `{ token }` (user token) | `auth.test` |
| `linear` | `{ token }` (personal API key) | GraphQL `viewer` |
| `notion` | `{ token }` (internal integration secret) | `GET /v1/users/me`, `Notion-Version: 2025-09-03` |
| `atlassian` | `{ email, token, site }` | `GET https://<site>/rest/api/3/myself` with Basic auth; only `*.atlassian.net` and `*.jira.com` sites. Stored as `email:token` with `{ site, auth: "basic" }`. |
| `trello` | `{ key, token }` | `GET /1/members/me`; the key is saved in `meta` |
| `asana` | `{ token }` | `GET /api/1.0/users/me` |
| `todoist` | `{ token }` | `GET https://api.todoist.com/api/v1/user` |
| `clickup` | `{ token }` | `GET /api/v2/user` |
| `monday` | `{ token }` | GraphQL `{ me { name } }` |
| `fireflies`, `fathom`, `granola`, `tldv`, `krisp`, `jamie`, `otter` | `{ token }` (personal API key) | the vendor's own check in `src/connectors/meetings/<vendor>.ts` (§2.3) |

**Disconnect.** `DELETE /api/connectors/:provider` revokes at the provider for OAuth grants where an endpoint exists (Google, GitHub, Linear, Slack, Zoom; pasted tokens are left alone), deletes the token, and switches that provider's sources off. With `?deleteData=1` it also deletes the artifacts those sources stored and their `sync_state`, and for meeting-notes sources their meeting notes (`src/connectors/forget.ts`); todos already created from them stay. Checked with mocked provider responses on 7 Oct 2026 (`src/routes/connectors.integration.test.ts`); not yet run against the live providers.

**Connector rules:**

- Each connector implements `fetch_delta(cursor) -> (artifacts[], cursor)`, is **idempotent**, respects provider throttling (429 + `Retry-After`), and writes `context.sync_state`.
- Bodies are stored **redacted-on-write** for known secret patterns (tokens, connection strings).
- Connector attachments store only metadata + links, not attachment bytes. Documents explicitly uploaded by the engineer are a separate, private, bounded store with downloadable originals (see §13).

### 2.2 Remote MCP connectors

Catalog entries with an `mcp` URL in `packages/shared-types/src/connectors.ts` (49 marked ready on 7 Oct 2026: work tools such as Notion, Linear, Atlassian, Todoist, ClickUp, monday.com and Airtable; meeting recorders such as Granola, Fireflies, Fathom and Otter; and Canva, Miro, Calendly, Cal.com, Pipedrive, Attio, PostHog, Mixpanel, QuickBooks, Greenhouse and others) and any remote MCP URL a person pastes connect to the vendor's own hosted MCP server. The operator registers nothing per vendor: Ensemble introduces itself to each vendor's authorization server. The assistant then gets that server's tools.

Code: `apps/hub-api/src/connectors/mcp/` (`manager.ts` connect/callback/calls, `provider.ts` the SDK `OAuthClientProvider` backed by the row, `url-guard.ts`, `store.ts`, `schema.ts`, `config.ts`), routes in `src/routes/mcp-connections.ts` ([02 §6](02_MODULE_INTERACTION_HUB_UI.md#6-api-contract-hub-api--ui-abridged)), assistant tools in `src/assistant/mcp-tools.ts`. It uses the `@modelcontextprotocol/sdk` client (`auth()`, `StreamableHTTPClientTransport`, and `SSEClientTransport` when a server answers 404 or 405 to Streamable HTTP). One row per person and server in `mcp_connections`; the OAuth client, cached discovery and tokens are encrypted with `lib/secrets.ts`, and tokens are never returned or logged.

**Connecting** (`POST /api/mcp-connections`, `{ serverId }` or `{ url, name? }`):

1. Ensemble sends `initialize` with no credentials. If the server answers, it is connected with no sign-in and its tools are listed (Hugging Face does this; its public tools work without an account).
2. On a 401 it reads Protected Resource Metadata (RFC 9728) from the `WWW-Authenticate: Bearer resource_metadata=…` header or `/.well-known/oauth-protected-resource`, then the authorization server's metadata (RFC 8414 or OpenID discovery).
3. The authorization server must list `S256` in `code_challenge_methods_supported`. Otherwise Ensemble stops (`MCP_PKCE_UNSUPPORTED`). With no OAuth metadata at all it answers `MCP_TOKEN_REQUIRED`.
4. The client, in this order: a client the person registered with the vendor (`clientId`, optional `clientSecret`); a Client ID Metadata Document when the server sets `client_id_metadata_document_supported` and `HUB_API_PUBLIC_URL` is https (the `client_id` is `${HUB_API_PUBLIC_URL}/api/mcp-client-metadata.json`, served publicly by hub-api); otherwise Dynamic Client Registration (RFC 7591). Ensemble registers as a public client (`token_endpoint_auth_method: none`, `client_name` "Ensemble", redirect `${HUB_API_PUBLIC_URL}/api/mcp-connections/callback`). An authorization server that lists no `none` method gets a confidential registration, and its client secret is stored encrypted. If none of these exist (no DCR, no CIMD) the answer is `MCP_TOKEN_REQUIRED` and the person can paste a token instead.
5. The authorize URL carries a PKCE S256 challenge, `resource` (RFC 8707, the server's resource from its metadata), a scope only when the server names one (`WWW-Authenticate` scope or `scopes_supported`), and a 32-byte state stored on the row for 10 minutes. The route returns `{ id, status: "pending", authorizeUrl }`.
6. `GET /api/mcp-connections/callback` is public (listed in `lib/auth-public.ts`); the single-use state ties it to the connection. On hosted the browser must also have an Ensemble session (`SameSite=Lax`, so it arrives with the vendor's redirect) for the person who started the connection. Otherwise nothing is exchanged or saved, the state is spent, and the person sees "Sign in to Ensemble in this browser" or "started from a different Ensemble account". This stops someone sending their own sign-in link to another person to collect that person's tokens. Local and desktop skip the session check. The callback exchanges the code with the verifier and `resource`, lists tools (all pages, up to 200), caches them, and redirects to `${HUB_WEB_ORIGIN}${returnTo}` with `mcp=connected` or `mcp=error&mcpError=<message>`. A refusal at the vendor (for example Atlassian's domain allowlist) is shown in the vendor's own words and saved as `lastError`.

**Tokens instead of sign-in.** `{ url, name, token }` or `{ serverId, token }` sends the token as `Authorization: Bearer`. Ensemble lists the server's tools with it first, so a refused token is a 400 (`MCP_TOKEN_REFUSED`) and nothing is saved. Use this for GitHub's MCP server (`https://api.githubcopilot.com/mcp/`, no dynamic registration; paste a personal access token), Hugging Face or Zapier keys, and private servers.

**What the person sees.** Connect opens the vendor's approval page; afterwards Settings shows the server as connected with its tools, each of which can be switched off (`PATCH /api/mcp-connections/:id { disabledTools }`). A whole server can be switched off and on (`status`). `POST /api/mcp-connections/:id/refresh-tools` lists tools again. `DELETE` revokes the tokens at the vendor when its metadata has a `revocation_endpoint`, then deletes the row. Ledger actions: `mcp.connect`, `mcp.enable`, `mcp.disable`, `mcp.disconnect`.

**In the assistant.** `mcpToolsForUser` turns the cached tools of connected servers (minus switched-off tools) into Hub tools in the `apps` area. Names are `mcp_<server>_<tool>`, at most 64 characters of `[a-zA-Z0-9_-]`: `<server>` is the catalog id, or the pasted server's name plus a short hash; a tool name that had to be changed or shortened gets a hash suffix, so names stay unique and stable between a proposal and Apply (`resolveMcpTool`). A tool marked `readOnlyHint: true` is a read; everything else is a write (`destructiveHint: true` is high risk), so it waits for Apply. The description starts with the server's name. The input passes the server's own JSON Schema through to the model (cleaned in `schema.ts`: object at the top, no OpenAPI-only keywords, cut down past 12,000 characters). Each server offers at most 40 tools and all servers together 80; the first tool of a trimmed server lists what was hidden. Every call opens a short-lived client, refreshes the access token a minute before it expires and once more on a 401, and times out after 60 seconds. Results are cut to 4,500 characters of text, and `structuredContent` is kept only up to 1,200 characters. When a refresh is refused the connection turns to `error` with "Reconnect <name> …" and its tools leave the assistant until the person connects again.

**Limits and safety.**

- Hosted: verified accounts only (`requireVerifiedUser`). Pasted URLs must be https, and their host must resolve only to public addresses. Private, loopback, link-local, carrier-grade NAT, cloud metadata and the matching IPv6 ranges are refused (`isBlockedAddress` from `plots/ssrf.ts` plus IPv6-mapped forms). The check runs on every request and every redirect hop, including the authorization server, token and revocation endpoints. `Authorization` is dropped when a redirect leaves the origin. On hosted every request goes through `pinnedFetch` (`url-guard.ts`): node `http`/`https` agents whose `lookup` resolves the host, refuses the connection if any address is private, and hands the socket only the checked addresses. A host that changes its DNS answer after the first check still cannot reach a private address. TLS SNI, certificate checks and `Host` use the URL's hostname. Local and desktop: https anywhere, plain http only to `localhost`, through the normal `fetch`.
- Per person: 30 connections, 20 connect attempts and 30 tool refreshes per 10 minutes. Per address: 60 callbacks per 10 minutes. These are in-process counters, like the other API rate limits.
- Desktop and localhost have no https public URL, so they always use dynamic registration, never CIMD.

**Vendor notes.** Discovery ran against every catalog URL on 7 Oct 2026 without signing in. Connect ran as far as the authorize URL for Notion, Linear, monday.com, Miro and Canva (CIMD). Token exchange, refresh and tool calls have only been checked against the in-process mock server in `src/routes/mcp-connections.integration.test.ts`.

| Server | What happens |
|---|---|
| Notion, Linear, Atlassian, Todoist, Airtable, Granola, Canva, Sentry, Hugging Face | Offer CIMD; hosted (https) uses it, desktop uses DCR |
| ClickUp, monday.com, Miro, Webflow, Stripe, Supabase, Zapier | DCR. monday.com, Miro and Supabase take only confidential clients, so they get a stored client secret |
| Atlassian (Rovo) | A site admin may need to allow Ensemble's domain (`api.ensemblework.com` on the hosted service) for the Rovo MCP server; the refusal is shown as it comes back |
| Asana (`mcp.asana.com/v2`) | No DCR and no CIMD: Connect answers `MCP_TOKEN_REQUIRED`. Use a client the person registered in Asana's developer console (`clientId`/`clientSecret`) |
| Hugging Face | Connects without a sign-in (public tools only). Paste a Hugging Face token for account tools |
| Figma, Dropbox, Vercel | Listed as coming soon: their MCP servers accept only clients they approved |

### 2.3 Meeting-notes sources

Meeting tools with a personal API key sync into Meeting notes (`apps/hub-api/src/connectors/meetings/`). Each is a token connector (group `notes`) in `src/connectors/base.ts`, a `ConnectorId` in `packages/shared-types/src/assistant.ts`, and a `CONNECTOR_CATALOG` entry in category `meetings`. Scheduled fetching stays paused; *Sync now* (`POST /api/fetch`) and `POST /api/connections/:id/sync` run them. Each sync reads at most 20 meetings changed since the last sync (or `fetch.lookbackDays`).

| Source id | API (checked against the vendor docs on 7 Oct 2026) | Key and plan |
|---|---|---|
| `fireflies` | GraphQL `api.fireflies.ai/graphql`: `transcripts(fromDate)` with sentences, attendees, `summary.overview` and `summary.action_items` | Integrations → Fireflies API. The free plan's API allowance is small. |
| `fathom` | `GET api.fathom.ai/external/v1/meetings?created_after&include_transcript&include_summary&include_action_items`, `X-Api-Key` | Settings → API Access; the free plan has a key |
| `granola` | `GET public-api.granola.ai/v1/notes?updated_after`, then `/v1/notes/{id}?include=transcript` (a 413 keeps the summary only) | Settings → Connectors → API keys; Business plan. Granola's MCP server is separate (§2.2). |
| `tldv` | `GET pasta.tldv.io/v1alpha1/meetings?from`, `/meetings/{id}/transcript`, `/meetings/{id}/notes`, `x-api-key` | The meeting organiser needs Pro or Business |
| `krisp` | `GET meeting-api.krisp.ai/v1/meetings?from`, `/meetings/{id}?fields=…,transcript,notes` (409 while processing is skipped) | Integrations → API (`krsp_u_…`); Core or Advanced |
| `jamie` | `GET beta-api.meetjamie.ai/v1/me/meetings.list` and `meetings.get` (`input={"json":…}`), `x-api-key` | Personal key (`jk_…`); Pro, Team or Enterprise |
| `otter` | `GET api.otter.ai/v1/conversations`, `/conversations/{id}?include=action_items,transcript,outline` | Integrations → Developer; Enterprise workspaces only |

Read AI (OAuth only, no personal keys), Avoma, Gong, Grain, Fellow, Supernormal, MeetGeek, Bluedot and Tactiq are MCP-only catalog entries, and so are the MCP sides of Fireflies, Fathom, Krisp, Jamie and Otter. Loom is listed as coming soon: it has no public transcript API.

Every vendor maps its response into one `MeetingRecord` (`meetings/types.ts`); `meetings/ingest.ts` then does the same for all of them:

1. **Transcript** → `Artifact(kind transcript, externalId "<vendor>:<id>")`: speaker lines with timestamps, trimmed to 18,000 characters with a note to open the rest in the vendor; metadata keeps the vendor id, end time, duration, summary and action items. Secrets are redacted as for every artifact.
2. **People**: attendees and speakers with an address go through `upsertPerson` (§4.7) and become the note's `personIds`. A speaker with only a name is linked to an existing person of exactly that full name, never created.
3. **Calendar match** (`meetings/match.ts`): the vendor's calendar event id wins when it names a stored event (Google event id, or the Graph id behind `outlook:<id>`). Otherwise an event within 12 hours must fit in time (at least half of the shorter of the two overlaps, or it starts within 10 minutes) and is scored `0.5·time + 0.3·shared attendees (not counting me) + 0.2·title words`. The best event also needs a shared attendee, a title overlap of 0.3, or to be the only close fit. If the runner-up is within 0.1 the meeting stays unmatched (ambiguous). Notes from the last 14 days that are still unmatched are tried again on the next sync, once the calendar has caught up.
4. **Meeting note**: one `MeetingNote` per `(user, external_source, external_id)` with `source = "connector"`, the vendor summary as `answer`, `event_artifact_id`, `transcript_artifact_id`, and `extraction = { via, summary, decisions, actionItems, waitingOn, eventMatch }`. Decisions come from the vendor where it has them, plus bullets under a "Decisions"/"Agreed" heading of the summary. A note the person deleted stays deleted.
5. **Action items**: an item is mine when its assignee's address is one of mine (the account email, `settings.email`, connected-account emails, the vendor account), or, with no address, when the name is my full name or my first name alone. Fireflies' grouped text and Markdown "Action items"/"Next steps" sections are parsed for owners (`**Name**` groups, `Name:` prefixes). My open items become proposed todos (`sourceKind meeting`, `meeting_note_id`, excerpt, the vendor's link to that moment or the meeting, else the calendar event), keyed `meeting:<vendor>:<id>:<hash>` so a re-sync, or a todo the person dismissed, never proposes the same item again. Everyone else's open items are kept on the note as `waitingOn`.

Disconnect with *delete what was read* removes the transcripts and the meeting notes from that source; todos stay. Checked with mocked vendor responses on 7 Oct 2026 (`src/connectors/meetings/meetings.test.ts`, `src/routes/connected-data.integration.test.ts`); not yet run against live vendor accounts.

---

## 3. Normalized model

```ts
type Artifact = {
  id: string;
  kind: 'email' | 'chat_msg' | 'channel_msg' | 'event' | 'transcript' | 'transcript_segment'
      | 'file' | 'pr' | 'pr_comment' | 'commit' | 'workitem' | 'issue';
  externalId: string; url?: string; ts: string;
  actor?: PersonRef; participants: PersonRef[];
  title?: string;
  text: string;                    // cleaned text
  threadId?: string;               // conversation / PR / meeting grouping
  parentId?: string;
  projectIds: string[]; repoId?: string; workItemIds: string[];
  meta: Record<string, unknown>;
  chunks?: { idx: number; text: string; embedding?: number[] }[];
};

type Extraction = {
  artifactId: string;
  items: Array<
    | { type: 'ask';         who: PersonRef; toMe: boolean; text: string; due?: string; confidence: number }
    | { type: 'commitment';  byMe: boolean; text: string; due?: string; confidence: number }
    | { type: 'decision';    text: string; owners: PersonRef[]; confidence: number }
    | { type: 'action_item'; owner: PersonRef; text: string; due?: string; sourceSpan: [number, number]; confidence: number }
    | { type: 'fyi';         text: string }
  >;
};
```

> Later kinds referenced elsewhere: `meeting_note` (saved M365 answers, [13 §11.1](13_MODULE_CONTEXT_BRIDGE.md#111-saved-m365-answers-and-renames-2026-09-23)); `Extraction.method: 'manual'` with empty items for notes and uploaded documents (§12, §13).

**Engineer Graph nodes/edges** (Postgres tables, not a graph DB — small scale):

- `Person(id, upn, name, role, team, relationshipWeight, typicalResponseHours, lastInteraction)`
- `Project(id, name, summary, notes, status, aliases[], workItemRoot?, createdBy)` — a page, see §8
- `Repo(id, fullName, provider: 'github' | 'ado', url, description, defaultBranch, tracked, myRole, languages[], prStats, codeownersPaths[])`
- `Deliverable(id, projectId, title, status: 'upcoming' | 'completed', due?, owner?, sourceRef?)`
- `ProjectPerson(projectId, personId, role?)` • `ProjectRepo(projectId, repoId)` — the edges that make a project page
- `Preference(key, value, evidence[], confidence)` — e.g. `working_hours`, `focus_block_pref`, `email_tone`, `pr_size_pref`, `review_turnaround`
- **Edges:** `works_with(person, project, weight)`, `mentions(artifact, node)`, `owns(person, repo/path)`, `derived_from(node, artifact)`

Inferred fields still carry **evidence and confidence in the database**, and a correction sets `confidence = 1.0, source = 'user'`. **Neither is shown in the UI.** They describe how a row got here rather than what it says; on the cards they appeared as a percentage badge and "inferred from 1 artifacts" on every node of every kind, and no decision was ever made from either.

---

## 4. Pipelines

### 4.1 Ingest → Normalize → Chunk → Embed

```text
connector.fetch_delta
  → normalizer.<kind>()
  → linker   (resolve people via UPN/email/display name;
              link repos via URLs / org/repo#123 patterns;
              link work items via AB#1234, #1234, ADO URLs;
              link projects via alias dictionary + embedding similarity)
  → chunker  (~400 tokens, overlap 40)
  → embedder
  → upsert
```

### 4.2 Extract (LLM, `gpt-4.1-mini`, structured output)

Runs per new artifact (or per thread when a thread updates). Prompt receives: artifact text, the *my identity* block (name, UPN, aliases, team), thread summary so far, and the list of known projects/people for grounding. Outputs `Extraction`. Anything `toMe && type in (ask, action_item, commitment)` with `confidence ≥ 0.5` is emitted as a **TodoCandidate** to the orchestrator.

### 4.3 Meeting processing (most valuable, do it well)

1. Event ends → fetch transcript VTT → segments with speaker.
2. Speaker → Person resolution (attendee list + name matching).
3. Chunk by topic (silence gaps / topic shift via embedding drift).
4. Per meeting produce `MeetingRecap(summary, decisions[], actionItems[(owner, text, due, timestamp, quote)], openQuestions[], myCommitments[])`.
5. Each action item owned by me → TodoCandidate with `source = { kind: 'meeting', ref: eventId, excerpt: quote, timestamp }`.
6. Link the recap to the Project (attendees ∩ project people, title keywords).

### 4.4 Graph maintenance (runs with the afternoon fetch)

- Recompute `relationshipWeight` (interaction frequency × recency × directness).
- Infer projects: cluster artifacts (embeddings + shared people + shared repos/WIs) → propose Project nodes; UI can rename/merge.
- Update preferences: working hours from send-time histogram; response times; tone notes come from Skill Forge.
- Skip anything the engineer deleted — see §4.6.

### 4.5 Delta emitter

Publishes to Redis stream `context.deltas`: `{ type: 'new_ask' | 'pr_comment' | 'wi_state_change' | 'meeting_recap' | 'deadline_near', artifactId, summary }` — consumed by the orchestrator's todo proposer and the UI's *What changed*.

User-uploaded documents are **not** inputs to this extraction/proposal pipeline. They publish real text and an empty manual extraction atomically, never a delta. Their optional enrichment only summarises and matches existing entities (§13).

### 4.6 Deletion, and why it needs its own table

Every card in the Context explorer has a delete button, and it has **no confirmation dialog**. This is inferred data, the engineer is the one who knows it is wrong, and the right answer to *"that mailing list is not a colleague"* is for it to disappear.

**Deleting the row is not enough.** Everything in the graph is derived from artifacts that are still there, so the next fetch recreates it and the button becomes a lie. `context_suppressions` records the **natural identity** the extractors key on — a person's UPN, a repo's full name, a project's name, a preference key — and **every creation path checks it first**:

| Path | Where the check lives |
|---|---|
| Graph ingest | `scripts/ingest-real.ts` → `upsertPeople` |
| Copilot bridge | `scripts/copilot-sync.ts` → `ingestPeople`, `upsertPerson` |
| File import | `scripts/import-files.ts` → `upsertPeople` |
| Preference inference | `context/graph.ts` → `inferPreferences` |

A suppression is a **statement about what the engineer wants**, not a tombstone on a row. The row is not gone the moment you press delete: since soft delete landed, deleting sets `deleted_at`, the row leaves every ordinary query, and it is restorable from *Settings → Deleted items* for the configured 15, 30, 45 or 60 days (default 30) before durable daily cleanup removes eligible rows (`lib/retention.ts`, [docs/07 §1.1](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#11-completed-and-deleted-data-retention)). The suppression is the other half and is **unconditional** — it stops the next fetch from recreating what you removed, whether or not the row itself has been purged yet. `DELETE /api/context/suppressions/:id` forgets the deletion if they ever want the node back. Both the deletion and the suppression are written to the audit ledger.

### 4.7 One person across sources (identities)

`person_identities` (`PersonIdentity`) holds every address and handle a person is known by: `kind` (`email`, `slack`, `github`, `linear`, `jira`, `teams`, `zoom`, `phone`, `name`), a normalised lowercase `value`, the `source` that saw it first, and `verified`; `(user, kind, value)` is unique. The migration `20261007140000_identities_links_meetings` backfilled emails from `people.email`/`upn` and handles from `slack:`/`teams:` upns.

`upsertPerson` in `src/connectors/ingest.ts` (all mail, calendar, chat, GitHub, Linear and meeting syncs) resolves a person by email first, then handles (`src/people/identity.ts`); names never resolve on their own. It records every identity it saw with the person: Gmail/Outlook addresses, Slack and Teams user ids with their emails, GitHub logins of PR and issue authors, Linear issue creators (email and user id), calendar attendees and meeting speakers. **It never merges two existing people.** When an identity of one person shows up next to another person's address, the identity stays where it is and `suggested_person_id` records the other person.

`GET /api/people/identity-suggestions` lists probable pairs, computed on read: seen together at ingest, the same full name, or a handle that equals another person's email local part. `POST /api/people/identity-suggestions/dismiss` stores the pair as a `person-merge` suppression so it does not come back. `POST /api/people/:id/merge { otherId }` keeps `:id` and, in one transaction, moves identities (including the other's legacy upn and email), task `people` (ids, and the other's name on older rows), `meeting_notes.person_ids`, `meeting_sessions.person_ids`, document person tags, project membership, artifact `actor_id` and attendance marks, then deletes the other person. Both are written to the ledger.

### 4.8 Project links

`project_links` (`ProjectLink`) maps a source container to a project once: `(user, source, container_id) → project`, with `container_name` and `created_by` (`me` or `import`). Containers are Slack channel ids, GitHub `owner/repo` (lowercase), Linear project and team ids, Jira project ids, Notion database ids, Trello board ids and the other importers' project ids (`src/projects/links.ts`).

- **At ingest** a connector passes `containers` to `upsertArtifact` (Slack channels, GitHub repos, Linear project then team). They are stored as `metadata.containers`, and the first container with a link sets `artifacts.project_id`. `createProposals` gives each proposed todo its artifact's project unless the proposal names one.
- **Imports** (`src/imports/apply.ts` → `ensureProject`) use an existing link to a live project before making a new one, and remember the container of every project they create or reuse. The migration linked projects earlier imports had created (CSV excepted).
- **Routes**: `GET /api/project-links?projectId=`, `POST /api/project-links { projectId, source, containerId, containerName? }` (also moves items that already arrived from that container and have no project, and their proposed todos), `DELETE /api/project-links/:id`, and `GET /api/project-links/containers?source=` (containers seen in synced artifacts, imported projects and existing links, with counts and the linked project). The project page shows them as *Linked sources* (`apps/hub-web/components/project/linked-sources.tsx`).

---

## 5. Context Pack builder (the API everyone calls)

```python
def build_context_pack(intent: Intent, budget_tokens: int = 6000) -> ContextPack: ...

# Intent examples:
TaskIntent(task_id)                              # → for a worker or "Help me"
MeetingPrepIntent(event_id)                      # → prep card
ChatComposeIntent(chat_id)                       # → Teams compose assist
CodingIntent(repo, branch, file?, symbol?)       # → workspace help
```

**Algorithm:**

1. **Seed** from intent: the task's source artifact(s), linked people/repo/WI/project.
2. **Expand:** same thread (full), same project (last 7 days), same repo (open PRs I own + recent review comments), same people (last 5 exchanges), meetings with those people (recaps).
3. **Retrieve:** hybrid search (pgvector cosine + BM25 via `tsvector`) using task title + description, top-k 40.
4. **Rank:** `score = 0.4·semantic + 0.25·recency + 0.2·graph_proximity + 0.15·source_priority` (`meeting_action_item > direct_ask > cc`).
5. **Compress:** full text for top items; LLM one-line summaries for the tail; keep per-item citation (`artifactId`, `url`, `excerpt`).
6. **Suggest skills:** Skill Router returns skills whose scope matches (repo, channel, person, task type).
7. **Assemble** `ContextPack(summary (5 lines), items[], skillsSuggested[], people[], openQuestions[])` and **persist** (for audit + replay).

The pack is shown to the user as **chips** in the UI (editable: remove an item, pin an item) — the human can correct the context before the agent uses it.

---

## 6. "Who I am" block (identity prompt fragment)

Generated daily from the graph and prepended to every worker prompt:

```text
You are acting for Mira Chen (mira@fieldnote.example), Software Engineer, Fieldnote, Bengaluru (IST).
Works most with: Priya Nair (eng), Rahul Mehta (eng), Alex Chen (design).
Owns repos: fieldnote/relay (maintainer). Current sprint: S42 (ends Fri).
Active deliverables: retry-policy rollout (due today), partner webhook docs, load-test report.
Working hours 09:30–18:30 IST; prefers focus blocks 11–13. Tone: concise, friendly, no fluff.
```

---

## 7. Meeting context — from connectors, not a Copilot paste

**Not a Copilot paste:** in the Hackweek tenant, Teams/transcript Graph scopes were admin-only, so the demo drove M365 Copilot in a browser and asked the engineer to paste the answer into *Context → M365*. That path is **retired**. Ensemble connects mail, calendar, and Teams (and later other meeting sources) directly.

The **extract → review → apply** pipeline below is still the right shape for *any* meeting-shaped text (a connector recap, a pasted note, an uploaded transcript). Keep the invariants; drop the Copilot-specific UI and `m365_copilot_ask`.

### 7.1 Extract is not a formality

A meeting recap (from a connector or a human note) is prose: headings, hedging, *"I found 11 matching calendar entries"*. Useful to read, useless to store. The extractor keeps only what belongs somewhere — people, project, repo, todos, dates — and is told **never to invent a fact the source did not say**. An invented deadline is worse than a missing one, because a missing one is visible.

It runs at **high** complexity. This is the step that decides what lands on the board, and a cheap model that drops a date costs far more than the difference in credits.

### 7.2 The same thing works in the assistant

The assistant can take the same recap. A **file this as source material** flag (old name: `M365_DIGEST_DIRECTIVE`) treats the turn as something to extract, not a question to answer. The flag is **the engineer's assertion, never inferred**. Guessing "digest" from ordinary chat would file todos out of a sentence.

### 7.3 Extract and apply are separate

`POST /api/meetings/:id/extract` produces a proposal; `POST /api/meetings/:id/apply` is what writes it. They were deliberately two presses.

Extraction is no longer one of them. It now **runs automatically** as soon as the answer lands, because an answer nobody extracted is prose in a box — the "decision" only ever had one answer. **Applying stays manual**, because that one has a real second answer.

Everywhere else in Ensemble the input is the engineer's own mail or calendar. Here it is a summary of a meeting that was itself never transcribed — two steps from the source — and the failure mode is a confident, plausible task nobody ever agreed to. So the extraction is shown in full, with the sentence each todo came from, and nothing moves until the engineer says so.

Applying twice is safe; tasks are deduped on `sourceRef = meeting:<id>` plus title.

### 7.4 What it will and will not create

| Thing | Behaviour |
|---|---|
| **Todos** | Created as *proposed*, owned by nobody, with the evidence sentence as the excerpt |
| **Project** | Matched by name or alias; created at confidence 0.6 if genuinely new |
| **Repository** | Matched, or created only if it looks like `owner/name`. A local path (`~/dev/thing`) or a bare word is refused |
| **People** | **Matched only, never created.** A Person row invented from "Karthik" pollutes the relationship weighting that decides whose message matters |
| **Deleted nodes** | Respected. A project or repo in `context_suppressions` is not recreated (§4.6) |

---

## 8. Project pages

A project is the unit of context in Ensemble, so it gets a page: `/projects/<id>`, served by `routes/projects.ts`.

### 8.1 What is on it

Everything already linked to the project, in one place:

| Section | Source |
|---|---|
| Name, one-line summary, status, notes | The page's own columns. Notes are the engineer's, and go into exported context |
| Repos (optional, many) | `project_repos` → `repos`. Paste a URL to link one; it is fetched from the provider before the row is written |
| People (tags) | `project_people` → `people`. Matched against the graph, never invented from a string |
| Deliverables (upcoming / completed) | `deliverables`. A row, not a string, because "is it done" and "when is it due" need somewhere to live |
| Tasks | `tasks.projectId` |
| Meetings | `meeting_notes.projectId` |
| Recent activity | `artifacts.projectId` |

Nothing else. The card used to carry aliases, channels, a confidence badge and an evidence count behind a disclosure triangle — four fields, three of them string arrays nobody edited, and a percentage that changed no decision. Aliases survive as a hidden matching aid for the linker; channels are gone.

### 8.2 People are tags, not pages

Every colleague could have had a page. None does. "Who is on this" is a property of the work, and a page per person is filing for its own sake — the Context explorer's people list already answers the questions anyone asks of it.

### 8.3 Projects can be created by hand

The graph infers projects from what it has read, which is useful and always incomplete: the thing you started this morning has no artifacts yet. A hand-made project is `createdBy: "me"`, and **creating one clears any earlier suppression** — deleting a project meant *stop inferring this*, not *never let me have it*.

### 8.4 Applying a meeting fills the page in

`POST /api/meetings/:id/apply` no longer only writes tasks. It also tags the matched people onto the project, links the repo, and records the extracted deliverables. That is the point of having pages: the next time the project is opened, the context is already there rather than sitting inside one note.

Every write is **idempotent** — upserts for the links, a title match for the deliverables — because re-extracting after a comment is a normal thing to do.

---

## 9. Storage & performance

- Tables in schema `context` *(as built: `context_`-prefixed tables in `public`, see [01 §5](01_TECH_STACK_AND_ENVIRONMENT.md#5-data-storage-design-postgres))*; `artifact_chunks` with HNSW (`vector_cosine_ops`) *(not possible at 3072-d — see §10)*, `tsvector` GIN index.
- **Retention is per user:** 15/30/45/60 days, default 30, for deleted context and completed work. Live people, repositories, preferences, skills, artifacts and documents do not expire from inactivity. PII: only the user's own mailbox/chats via delegated scopes.
- **Targets:** new email → todo candidate in < 60 s; context pack build < 2 s (cached expansions).

---

## 10. Dev checklist

> Unchecked means not re-verified against this tree. [18](18_WHAT_IS_REAL.md) records what is.

- [ ] `connectors/mail.py|ts` with delta + HTML→text (`html-to-text`)
- [ ] `connectors/teams_chat`, `connectors/calendar`, `connectors/transcripts` (VTT parser + speaker resolution)
- [ ] `connectors/github` via GitHub MCP; `connectors/ado` via ADO MCP (feature-flagged)
- [ ] Linker with people/repo/WI/project resolution + unit tests on fixtures
- [ ] Extractor prompt + JSON schema + 20 golden emails/transcripts in `eval/extraction/`
- [ ] `meeting_recap` pipeline on 3 seeded meetings
- [ ] Graph tables + nightly job + corrections API
- [ ] `context_pack.build()` + cache + UI chips
- [ ] Deltas stream → orchestrator

### Notes from the earlier prototype

These notes describe how an earlier prototype met the checklist. Most of the files they name are not in this tree; [17](17_REPOSITORY_STRUCTURE.md) and [18](18_WHAT_IS_REAL.md) describe what is.

| Item | Where | Notes |
|---|---|---|
| Connectors | `apps/hub-api/src/connectors/` | Mail, Teams, calendar, GitHub, ADO over REST. Every body is cleaned (HTML→text, quoted history stripped) and secret-redacted on write — a token in the store becomes a token in a prompt. |
| Auth for dev tools | `connectors/cli-auth.ts` *(inferred from 00 §11)* | GitHub and ADO borrow the sign-in you already have: `gh auth token`, and `az account get-access-token` for ADO's resource id. No PAT to mint, paste or rotate, and nothing written to disk. An explicit `GITHUB_TOKEN`/`ADO_PAT` still wins — an explicit choice should. |
| Tracked repos | `context/repos.ts` + `connectors/devtools.ts` | Paste a URL: it is parsed, fetched from the provider, and only then written. A row that cannot be fetched is worse than none — the connector would retry it forever and the graph would show a live repo as dormant. Local paths like `~/dev/thing` are refused (6 tests). Tracked repos contribute PRs, issues and 14 days of commits on every fetch. |
| Transcripts | `connectors/vtt.ts` + `transcripts.ts` | Parsing is split from fetching so VTT handling is unit-testable without a tenant (19 tests). Cues are merged into speaker turns, because raw VTT fragments are useless as evidence. Ambiguous speakers are left unresolved rather than guessed — mis-attributing an action item is worse than leaving it unowned. |
| Linker | `context/linker.ts` | 17 tests. Conservative by design: full names only (a bare first name is too collision-prone), and `#1234` counts as a work item only outside a repo context, where it means an issue. |
| Extractor | `context/extractor.ts` | Two paths behind one shape: LLM structured output, and a cue-phrase fallback that works with no credential. The fallback is the demo path today and the regression baseline the LLM must beat. |
| Golden set | `eval/extraction/golden.json` | 20 labelled cases scored by property, not string match. Heuristic baseline: 19/20 (95%); the one gap (an ask aimed at someone else in a CC'd thread) is marked `knownGap` and scored separately rather than quietly relaxed. |
| Retrieval | `context/pack.ts` | Hybrid: Postgres `tsvector` (weighted title/body, GIN) plus the documented ranking `0.4·semantic + 0.25·recency + 0.2·proximity + 0.15·source_priority`. The pgvector half is wired but dark until Azure OpenAI is configured. |
| Graph | `context/graph.ts` | `relationshipWeight = directness × recency`, so a daily pair outranks a distant manager. Inference never overwrites a user correction (`source = 'user'` wins), and never recreates a node the engineer deleted (§4.6). |
| Deletion | `context/suppression.ts` | `context_suppressions` keyed by the identity the extractors use. Loaded once per ingest pass; a list that cannot be read degrades to "suppress nothing" rather than failing the sync — a resurrected node is an annoyance, a failed sync is a silent outage. |
| Deltas | `context/pipeline.ts` | Redis **stream**, not pub/sub, so a restarted consumer replays instead of dropping a day of asks. |

**MCP note.** GitHub and ADO ingestion uses their REST APIs directly rather than the MCP servers. Read-side ingestion needs two endpoints; adding two MCP server processes (and two more packages through a restricted registry) bought nothing. MCP remains the plan for agent tool calls, where the uniform interface is the point — see [docs/01 §1](01_TECH_STACK_AND_ENVIRONMENT.md#1-stack-at-a-glance).

**pgvector index.** `text-embedding-3-large` is 3072-d, above pgvector's 2000-d index limit, so **no HNSW index is created**. The column is queryable by exact scan, which is comfortably inside the 2 s budget at demo scale. The migration documents how to enable the index with a ≤ 2000-d model.

---

## 11. Seed data: opt-in only

A fresh database is empty, and the Hub stays empty until you add a task or connect a source. Sample data is never written by `pnpm dev` or `pnpm db:migrate`.

Two seeds exist for trying the product and for screenshots. Both are run by hand:

| Command | Script | What it writes |
|---|---|---|
| `pnpm db:seed` | `apps/hub-api/prisma/seed.ts` | Sample people, tasks, documents and decisions for `ENSEMBLE_DEV_USER_ID`, plus five local checkouts under `ENSEMBLE_WORKSPACE_ROOT/samples` |
| `pnpm seed:demo` | `apps/hub-api/prisma/demo-branch.ts` | The Branch desk demo ([DEMO_DATA.md](DEMO_DATA.md)). `-- --remove` takes it out again |

Each seed marks what it writes (`seed:` / `demo:` source refs, `Seed:` / `Sample:` title prefixes) and re-running replaces only rows with those markers — **never heuristically**, because deleting real context for mentioning a word would be a far worse failure than leaving a demo row behind. Do not mix seeded rows with real mail in a database you rely on: a card citing a sample repository is indistinguishable, at a glance, from one citing a repository that exists.

---

## 12. Task pages and connected notes

Tasks now hold a Markdown **notes** body, optional `deliverableId`, explicit `skillIds`, and their existing project/repo/people references. The task editor validates every selected relationship against the current user's data. The detail endpoint resolves all linked people, not only the first page of the Context list. Legacy IDs whose people were deleted are flagged for review and can be cleared explicitly: **saving notes never recreates a suppressed person**.

`context/notes.ts` mirrors task, project and deliverable notes into ordinary file artifacts with stable `ensemble:*:notes` identities. Task note artifacts have a real task foreign key, project/repo references, and the selected people as participants. Explicit task people are also linked to the project. Saves and mirrors occur **in the same transaction**, are secret-redacted, and clear the mirror when the notes are emptied. An empty manual extraction prevents a note from being re-proposed as another inbox task.

`buildContextPack(taskId)` now resolves the task's actual relationships itself. It prioritizes its saved notes, project notes/people/repos/deliverables and linked deliverable notes before ordinary lexical retrieval, including short notes that the old 40-character substance filter would have discarded. These remain bounded context excerpts, not an unlimited copy of every page. Explicit task skills rank first and still respect the global enabled switch.

Delegated jobs and Help/workspace context use this same builder. The planner receives the selected source bodies, not merely the sentence saying how many sources were assembled, and the run records the context-pack ID. Board list responses omit note bodies so adding long notes does not bloat every board load.

### Structured task documents

`GET /api/tasks/:id/page` returns `TaskPageContent`. A task without a document has revision `0`, null content/update time and its existing Markdown notes. `PUT` accepts only `SaveTaskPage`: the expected revision, expected notes, optional restricted document JSON and source-bound human annotations.

- Requests are limited to **1 MiB** in total, and the rendered notes to **100,000 characters**.
- Revision conflicts, and notes conflicts on a supplied root body, return **409**, never a last-writer-wins overwrite.
- Ordered-list `start` and `type` attributes, including `type: null`, round-trip unchanged in page and annotation JSON. The shared Markdown helper produces canonical numbered-list syntax for the root notes mirror.

The additive `task_pages` row and normalized `task_page_mentions` identities cascade with the task. They are not included in board/list responses. Document saves lock the task, redact text before storing JSON, and mirror changed root instructions using the existing transactional note-artifact path. A secret split across separate blocks or mention markup is **explicitly refused** if it cannot be redacted without changing the document's meaning. Annotation-only and no-op saves do not update task notes, their mirror or `task.updatedAt`. An external notes edit sets `notesChangedExternally`; unchanged rich text is never copied over those newer notes. A merged root edit must acknowledge the current notes through `expectedNotes`.

**Omitting `content` is the explicit annotation-only signal**; `content: null` is not a write instruction. No root Markdown conversion runs on this path. The first annotation can create a page with null content while preserving legacy notes byte-for-byte, including CRLF, spacing and trailing paragraphs, even during an active workspace job. Existing root JSON and note snapshots are retained. The revision is still checked, but a newer external notes value cannot block an annotation-only save because that request cannot write notes; the response carries the actual notes and external-change flag. A client must retain its imported local document when the returned content is null. Sending a full canonicalized body remains an instruction edit and still receives the normal workspace 409; annotations never turn that failure into success.

Annotations retain their original run/workspace job, source hash and anchor. Every source must belong to the task and user, and an existing annotation ID cannot be rebound to different output. No result/evidence is writable here. **Live workspace jobs block changed instructions with a clear 409**, while human annotations remain editable. Assignment and page writes share the same workspace queue lock so a racing assignment cannot bypass that check.

`GET /api/page-mentions?kind=&search=&offset=&limit=` supports people, project, repo, task, deliverable and skill lookups. It is user-scoped, substring-searched and deterministically ordered; default limit is 20, maximum 100. Returned IDs, canonical labels and local links resolve actual entities. A new missing or foreign ID is rejected. Previously saved deleted references stay unavailable without recreating entities or changing primary task relationships. Date mentions accept only calendar-valid `YYYY-MM-DD` or offset ISO datetimes and never set a due date.

One page save creates **one transactional undo entry**, including root JSON, annotations, mention identities and changed notes/mirrors. Journal failure rolls the save back. Undo/redo also respects external edits and workspace locks, and advances the revision rather than reviving an old optimistic token.

After selecting the intended `DATABASE_URL`, deployment is coordinated explicitly; tests do not migrate the application database:

```powershell
pnpm --filter @ensemble/shared-types build
pnpm --filter @ensemble/hub-api exec prisma generate
pnpm --filter @ensemble/hub-api exec prisma migrate deploy
pnpm --filter @ensemble/hub-api typecheck
```

Migration: `20260919190000_task_pages`. Focused verification:

```powershell
pnpm --filter @ensemble/hub-api exec vitest run src\pages\content.test.ts src\pages\store.test.ts src\lib\undo.test.ts
$env:ENSEMBLE_PAGE_INTEGRATION = "1"
pnpm --filter @ensemble/hub-api exec vitest run src\pages\pages.integration.test.ts
```

The opt-in integration suite uses `DATABASE_URL` (or the root `.env`) only to create a unique `ensemble_pages_test_*` database. It deploys migrations there, uses synthetic users and an in-process Fastify app with a stub queue and refused fetch calls, then disconnects and drops that database. It starts no workers, uses no live model/connector or Redis, and changes no real user rows. The database role needs permission to create/drop that isolated test database.

---

## 13. Independent document context: Artifacts & sync

*Context → Artifacts & sync* accepts dropped or chosen documents. This is **reference ingestion**, not meeting extraction and not a new way to propose work.

Uploading, parsing, enrichment, retry, cancellation, tagging and removal **never create** tasks, todos, work items, projects, people, repos or deliverables. The separate *Sync connected sources now* button retains the ordinary connector pipeline and can propose inbox todos; uploading never invokes it.

### Formats and honest limits

| Format | Local extraction |
|---|---|
| DOCX | Document paragraphs/tables, headers, footers, footnotes and endnotes |
| PPTX | Slides in presentation relationship order, including speaker notes |
| PDF | Existing text only: **no OCR** |
| MD/Markdown, TXT/Text | UTF-8 (optional BOM), or UTF-16 with BOM |
| CSV, TSV, JSON/JSONL, YAML/YML, LOG, RST, ADOC, INI, TOML, CFG/CONF, VTT, SRT | Decoded text, not executed or interpreted as actions |
| HTM/HTML, XML, RTF | Text extraction; HTML scripts/styles excluded, XML entities/DTDs refused, RTF code pages decoded |

**Limits:**

- Upload limit **20 MiB**; extracted text limited to **2,000,000 characters**.
- Office archives allow at most **2,048 entries**, **64 MiB** expanded content and **16 MiB per XML part**; highly compressed large entries, duplicate or unsafe paths, encrypted archives, and external/entity XML declarations are refused. No archive is extracted to disk.
- The parser runs in a short-lived process with a **512 MiB** memory cap and a **30-second** timeout, with at most **two** parser processes admitted by the runtime.
- PDFs and presentations are limited to **500 pages/slides**.

Empty, invalid, encrypted, scanned-only, unsupported, oversized or unreadable files report a **specific error**. There is no filename-as-content fallback, no synthetic summary and no placeholder body. Mixed text/image PDFs and slides carry missing-text warnings into the UI, retrieval and enrichment. Legacy DOC/PPT files require export to a supported format. Originals may contain active content, so downloads are **attachment-only with `nosniff`**, never an inline preview.

### Persistence and isolation

`POST /api/artifacts/documents` accepts a multipart file and optional JSON options (`{ enrich: true, manualTags: {} }` by default). It returns **202** after saving the original, filename, SHA-256, size and processing state in `context_documents`. It does not wait for parsing or a model. The upload intent is **audited before work is queued**: an audit failure cannot return a failed upload while leaving a billable enrichment job behind.

The database-backed worker runs independently of the browser. Refreshing or closing the page does not cancel accepted work. **Compare-and-set leases and a generation fence** prevent two workers, or a late result after cancellation, from publishing the same attempt. Queued work survives a service restart; expired in-flight leases become an explicit *interrupted* error, not an automatic potentially billable replay. The engineer can retry deliberately.

Successful parsing atomically writes a normal file `Artifact` and an empty `Extraction(method: 'manual', items: [])`. This is the existing connected-notes pattern: the generic extractor has nothing pending and the proposer has no candidates. The upload remains `authoredByMe: false`; importing somebody else's document must not teach Skill Forge that it is the engineer's writing. Extracted text is secret-redacted using the existing import/connector helper. The original bytes stay separate and are **never sent to enrichment**.

Every list, tag lookup, metadata/body read, original download and mutation is **partitioned by the authenticated user**. User filenames are never filesystem paths. Filenames with path separators, control characters or reserved device names are rejected; original downloads use an encoded attachment filename.

Removing a document removes its original and mirrored Artifact, not any of the existing entities it was tagged with. Uploads persist until explicitly removed; connector retention does not silently discard their originals. Deletion first hides both rows. At the retention cutoff cleanup deletes the private `context_documents.original` database bytes and the corresponding `ensemble:document:<id>` Artifact, chunks and extraction. It does not unlink an arbitrary path or remove a workspace checkout. Meeting, task, project and deliverable note mirrors are removed with their source, including legacy mirrors found by their stable external IDs. Saved context packs, undo snapshots, mentions and tag links referring to purged records are removed or unlinked. Live task context, leased document work and pending approvals defer deletion.

### Optional manual tags; bounded enrichment by default

Tags select existing projects, repositories, people, tasks/todos, ingested work-item/issue Artifacts and deliverables belonging to the same user. A tag category omitted from `manualTags` allows model matches. A supplied array, including `[]`, **pins the user's choice** over every later model result. `PATCH …/:id` accepts `manualTags: null` to unpin a category. New references are validated, while a deleted old reference is shown as unavailable rather than recreating its entity.

By default the worker asks the user's configured approved **easy** model for one brief summary and existing-entity IDs. It uses `/api/chat/tools` with no tools, `userId`, `activityId`, and an **8,000-output-token cap**. The cap includes provider-native reasoning tokens, so a small reasoning-model budget must not consume the entire response before producing summary JSON. At most the first **16,000 text characters** and a bounded existing-entity catalogue are supplied; the complete prompt is capped at **32,000 characters**. Exact entity-name matches in the excerpt are preferred before a small fallback catalogue. Matching is best-effort; manual search/pagination is not limited to that catalogue.

The returned JSON can contain **only a summary and matched tag IDs**. Empty model text, unknown entities, action/tool requests, invalid shapes and provider errors fail the attempt without applying model tags and **without automatic model retries**. Manual choices are re-read under a row lock when a successful response is saved, so edits made during a request still win. Parsed text stays usable when enrichment is disabled, paused, failed or cancelled.

The runtime's shared `model_control.py` enforces global pause, cancellation and the three-call concurrency limit. Queued enrichment waits during pause; in-flight stop aborts the request and fences its result. An already sent request may still be billed. Returned usage is kept even when Stop wins just after the response.

`Document.modelUsage` stores per-attempt token counts, estimated credits, and verbatim provider `copilot_usage`, `usage` and token details metadata when present. Reported total `nano_aiu` is not converted into guessed billed credits.

### Retrieval, reading and integration

All workers already using `buildContextPack` see these Artifacts. Explicit task, deliverable and work-item links seed a pack; project, repo and people tags expand it, including secondary tags and documents older than the connector seven-day window. Full-text search indexes the real redacted body. Document excerpts can come from the matching passage rather than always the first page. **Every excerpt is labelled and JSON-quoted as untrusted source data**, not authorization for actions, tools, network or filesystem access. Only an actual user request and the normal action gates authorize work.

The read-only assistant tools `hub_list_documents` and `hub_read_document` are included in `contextTools`. The latter accepts the document ID or an Artifact ID returned by `hub_search_context`, and returns bounded text pages, original metadata, warnings and `nextOffset`.

**HTTP access:**

| Endpoint | Purpose |
|---|---|
| `POST /api/artifacts/documents` | Multipart upload; returns 202 |
| `GET /api/artifacts/documents?search=&cursor=&limit=` | Private metadata/status list; no original bytes or full bodies |
| `GET /api/artifacts/document-tags?kind=&search=&offset=&limit=` | Existing entity choices, optionally resolved by ids |
| `GET /api/artifacts/documents/:id` | Status, tags, summary, source and usage metadata |
| `GET …/:id/body?offset=&limit=` | Unicode-character pagination; default 6,000, maximum 12,000 characters |
| `GET …/:id/original` | Owner-only original download |
| `PATCH …/:id` | Manual tag overrides |
| `POST …/:id/retry` | Explicit (`{ stage: "parse" \| … }`) retry |
| `POST …/:id/cancel` | Durable cancellation of pending processing |
| `DELETE …/:id` | Remove original and parsed Artifact |

**Integration is deliberately narrow:**

- Export `packages/shared-types/src/artifacts.ts` from the shared-types barrel and rebuild that package.
- Apply `20260919183000_context_documents` and regenerate Prisma.
- In `buildServer`, after Prisma/Redis/auth, call `registerDocuments(app, { startWorkers: options.startWorkers })` from `documents/init.ts`. It registers the routes and closes its worker on `preClose`; `startWorkers: false` registers routes only.
- Include `ensemble_agent.documents_router.router` in the agent-runtime FastAPI app. Its only operation is a bounded local parser; it is not an action tool or a fabricated MCP server. It honours `ENSEMBLE_INTERNAL_TOKEN`.
- Install the manifest/lock changes through the configured corporate package feeds, then reload the updated services. No real model is needed for the local format, pipeline, failure or cancellation tests.

**Tests:** `tests/test_documents.py` generates every advertised format locally. The artifact-specific API unit/integration checks use generated files, an in-process API, a disposable database and isolated Redis user keys. They never start normal workers, invoke real models, sync connectors or modify existing user tasks.

Run the opt-in database check with `pnpm --filter @ensemble/hub-api verify:artifacts`. It needs the configured local database role to create/drop its uniquely named disposable database and a reachable Redis. Ordinary unit-test runs skip that integration suite unless `ENSEMBLE_DOCUMENT_INTEGRATION=1` is explicitly set. The isolated browser flow is:

```powershell
uv run --project apps/agent-runtime --no-sync python apps/hub-web/scripts/verify-artifacts-ui.py
```

It renders the real panel against synthetic intercepted responses (no normal services), and checks choose/drop, manual tags, refresh, reading, downloads, cancellation, visible failures and a 390-pixel layout.
