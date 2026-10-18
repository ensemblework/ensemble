# 03 · Context, connectors and saved relationships

Context is the work a person explicitly keeps in Ensemble: people, projects, repositories, preferences, pages, meetings and saved source content. Shared retrieval and agent briefs use this stored context; connected-app tools can read live content separately.

**Code inspected 18 Oct 2026.** The earlier automatic mail-to-proposal graph/ranking design is not the current implementation. [31](31_CONNECTORS_IN_USE.md) describes app operations; [27](27_IMPORTS.md) board/page imports; [32](32_FILES.md) originals and extracted text.

## 1. Responsibilities

- Keep content and relationships scoped to the open space and sharing permissions.
- Normalize explicitly saved source items with provenance and stable external IDs.
- Maintain conservative person identities and project/container links.
- Provide bounded retrieval, task briefs, source citations and saved entity/mention links.
- Preserve user removals through soft deletion and relevant suppression/identity tombstones.

There is no background graph crawler, automatic nightly relationship inference or implemented semantic context-pack ranker. Schema fields and legacy helpers do not establish a running pipeline.

## 2. Connectors

Manual **Sync people** (`POST /api/fetch`, `POST /api/connections/:id/sync`) calls `connectors/people-sync.ts`. It stores real contact metadata only, without message bodies, artifacts, proposals or model triage. Connecting an app itself saves no content. Scheduled fetch calls return without reading providers, even when an older deployment retains the fetch environment setting.

| Source | Metadata read on manual sync |
| --- | --- |
| Gmail | At most 100 recent message IDs, then From/To and bulk-mail headers with `format=metadata`; no subject, snippet or body |
| Outlook | At most 100 inbox and 100 sent metadata rows: sender/recipients, dates, draft state, bulk headers |
| Google Calendar / Outlook calendar | At most 100 events' attendee names and addresses; no event artifacts |
| Slack | At most 200 non-bot, non-deleted member profiles |
| Teams | At most 50 chats' member profiles, without messages |
| GitHub | At most 100 followed real user handles |
| Other apps and meeting sources | No content read through generic sync; use explicit search/import tools |

`people/filter.ts` uses fixed domain, local-address and bulk/list header rules. Removed people remain removed through identity tombstones and suppressions. Exact addresses and provider-confirmed Slack/Teams/Linear user IDs reuse/merge existing identities; names alone never cause an automatic merge. Manual contact sync requires a verified account and granted product scopes. Provider errors do not erase previously saved people.

Files and artifacts enter through an explicit upload, import, attach/save operation or an assistant action the person requested. Search results are transient; reading a result does not save every match. Existing saved artifacts remain available. `connectors/items` and the connected-app assistant tools use the person's own refreshed grants; login alone never grants connector access. See [31](31_CONNECTORS_IN_USE.md), [32](32_FILES.md) and the [fetching design](design/real-world-next.md#connector-fetching).

### 2.1 Connector store, OAuth apps, products and tokens

The store lists the apps in `CONNECTOR_CATALOG` (`packages/shared-types/src/connectors.ts`). `GET /api/connectors/catalog` (`src/connectors/catalog.ts`) adds each person's state: `connected` and `account` from their own `oauth_tokens` row, `appReady` (the operator set up what the entry needs, or it can connect by token, MCP or file), `oauthReady`, `products` (saved toggles over the catalog defaults), `needsConsent` (products that are on but not granted yet), `sources` (`settings.connections` plus `sync_state` last sync and error), and `mcp` (status, tool count and last error from `mcp_connections`).

**OAuth apps.** `oauthApp` in `src/connectors/accounts.ts` picks, in order: the connector's own `<PROVIDER>_CLIENT_ID`/`_SECRET`, an app the operator saved in Settings → Connections (`connector_apps`, encrypted), and for Google, Microsoft and GitHub the sign-in app (`AUTH_GOOGLE_*`, `AUTH_MICROSOFT_*`, `AUTH_GITHUB_*`). The redirect URI is `${HUB_API_PUBLIC_URL}/api/connectors/<provider>/callback`; a borrowed sign-in app needs that URI added. Register the exact login and connector callback paths required by the configured provider/client. A broad `/api` callback is not a substitute; use separate clients when the provider registration cannot serve both flows. Flows in `src/connectors/oauth.ts` use a 10-minute in-memory state (one API process) and PKCE S256 for Google, Microsoft, GitHub, Linear, Zoom and Docusign. On hosted servers each flow is bound to the browser that pressed Connect (RFC 6749 §10.12): `/start` sets an HttpOnly, SameSite=Lax `ensemble_connect_<provider>` cookie (on `ENSEMBLE_COOKIE_DOMAIN` like the session), and the callback exchanges the code only when that cookie matches and the browser's Ensemble session is the account that started. Anything else redirects back with an error and saves nothing. Desktop and local runs skip this check; the system browser there has no Ensemble session.

| Provider | Authorize / token | Scopes asked | Saved with the token |
|---|---|---|---|
| `google` | accounts.google.com, `access_type=offline`, `include_granted_scopes=true` | `openid email profile` plus the products that are on (below) | email |
| `microsoft` | login.microsoftonline.com/`common` v2.0 | `openid email profile offline_access User.Read` plus products | mail or UPN, Graph user id |
| `github` | github.com OAuth App | `repo read:user read:org` | login |
| `linear` | linear.app / api.linear.app | `read comments:create` (comments only for "Post an update") | email, `auth: bearer` |
| `notion` | api.notion.com, `owner=user`, JSON exchange with HTTP Basic | none | workspace name, `workspaceId`, `botId` |
| `atlassian` | auth.atlassian.com, `audience=api.atlassian.com`, `prompt=consent` | `read:jira-work read:jira-user offline_access` | `cloudId`, `site`, `siteName` from accessible-resources, `auth: bearer` |
| `slack` | slack.com/oauth/v2, `user_scope` | `channels:history groups:history im:history mpim:history channels:read groups:read users:read users:read.email` (user token from `authed_user`; the two `:read` scopes let "Add from apps" list channels) | `user @ team` |
| `zoom` | zoom.us, HTTP Basic exchange; scopes come from the app | `user:read:user meeting:read:list_meetings cloud_recording:read:list_user_recordings cloud_recording:read:meeting_transcript meeting:read:summary` | email |
| `docusign` | account-d.docusign.com (`DOCUSIGN_ENV=demo`, default) or account.docusign.com | `signature` | email, default account `accountId`, `baseUri` |
| `dropbox` | dropbox.com/oauth2, `token_access_type=offline`, PKCE | `account_info.read files.metadata.read files.content.read` | email |
| `box` | account.box.com / api.box.com; scopes come from the app; refresh tokens are single use and the rotated one is saved | none | login |
| `xero` | login.xero.com / identity.xero.com, HTTP Basic exchange | `openid profile email offline_access accounting.invoices.read accounting.contacts.read` (`XERO_SCOPES` for older apps) | first organisation's `tenantId`, `tenantName` |
| `discord` | discord.com/oauth2, bot install (`permissions=66560`: view channels, read message history) | `identify guilds bot` | username, the servers the bot was added to (`guilds`; a second install adds to the list). Channels are read with the operator's `DISCORD_BOT_TOKEN`, only for those servers |

**Products.** Google Workspace and Microsoft 365 are suites (`src/connectors/products.ts`). Connect asks only for the base scopes and the scopes of the products that are on: `GET /api/connectors/:provider/start?products=a,b` takes an explicit list, otherwise the saved toggles in `settings.connectorProducts`. `PUT /api/connectors/:id/products` saves toggles; switching a product off applies at once (its sync sources switch off), and switching on a product whose scopes the stored token lacks returns `{ reconnect: true, url }` so the person approves only the new access. The toggle is saved when the callback comes back with that scope granted (Google lets people untick a permission on its consent screen).

| Suite product | Scopes | Feeds |
|---|---|---|
| `gmail` | `gmail.readonly` (restricted) | `gmail` |
| `calendar` | `calendar.events`, `calendar.calendarlist.readonly`; optional additional `calendar.freebusy` on new consent | `google_calendar` |
| `drive_docs` (on by default) | `drive.file` (non-sensitive; files the person picks or Ensemble creates; Docs, Sheets, Slides) | Google Picker, assistant tools |
| `drive_search` (off by default) | `drive.readonly` (restricted: public servers need Google verification) | assistant tools |
| `outlook_mail` | `Mail.Read` | `outlook` |
| `outlook_calendar` | `Calendars.ReadWrite` | `outlook_calendar` |
| `teams` (off by default) | `Chat.Read` (work or school accounts) | `teams` |
| `onedrive` | `Files.Read` | assistant tools |
| `office` | `Files.ReadWrite` (Word, Excel, PowerPoint; covers OneDrive read) | assistant tools |

Explicit calendar reads use the person’s granted calendars. Generic Sync people reads only attendee metadata. Tokens with older supported calendar read grants retain their permitted reads; writing and availability require their own grants.

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

- Manual metadata sync is bounded and records its last successful read in `sync_state`; explicit content search/import uses the per-provider item implementation.
- Bodies are stored **redacted-on-write** for known secret patterns (tokens, connection strings).
- Connector attachments store only metadata + links, not attachment bytes. Documents explicitly uploaded by the engineer are a separate, private, bounded store with downloadable originals (see §13).

### 2.2 Remote MCP connectors

Catalog entries with an `mcp` URL in `packages/shared-types/src/connectors.ts` (work tools such as Notion, Linear, Atlassian, Asana, Todoist, ClickUp, monday.com, Airtable, Shortcut, Basecamp and Productboard; meeting recorders such as Granola, Fireflies, Fathom and Otter; developer and cloud services such as GitHub, GitLab, Sentry, Netlify, Cloudflare, Grafana Cloud, AWS and Datadog; and Canva, Miro, HubSpot, Salesforce, Intercom, Calendly, QuickBooks, Greenhouse and others; the full list is in [31 §4](31_CONNECTORS_IN_USE.md#4-every-connector)) and any remote MCP URL a person pastes connect to the vendor's own hosted MCP server. For most of them the operator registers nothing: Ensemble introduces itself to each vendor's authorization server. The assistant then gets that server's tools.

Code: `apps/hub-api/src/connectors/mcp/` (`manager.ts` connect/callback/calls, `provider.ts` the SDK `OAuthClientProvider` backed by the row, `url-guard.ts`, `store.ts`, `schema.ts`, `config.ts`), routes in `src/routes/mcp-connections.ts` ([02 §6](02_MODULE_INTERACTION_HUB_UI.md#6-api-contract-hub-api--ui-abridged)), assistant tools in `src/assistant/mcp-tools.ts`. It uses the `@modelcontextprotocol/sdk` client (`auth()`, `StreamableHTTPClientTransport`, and `SSEClientTransport` when a server answers 404 or 405 to Streamable HTTP). One row per person and server in `mcp_connections`; the OAuth client, cached discovery and tokens are encrypted with `lib/secrets.ts`, and tokens are never returned or logged.

**Connecting** (`POST /api/mcp-connections`, `{ serverId }` or `{ url, name? }`):

1. Ensemble sends `initialize` with no credentials. If the server answers, it is connected with no sign-in and its tools are listed (Hugging Face does this; its public tools work without an account).
2. On a 401 it reads Protected Resource Metadata (RFC 9728) from the `WWW-Authenticate: Bearer resource_metadata=…` header or `/.well-known/oauth-protected-resource`, then the authorization server's metadata (RFC 8414 or OpenID discovery).
3. The authorization server must list `S256` in `code_challenge_methods_supported`. Otherwise Ensemble stops (`MCP_PKCE_UNSUPPORTED`). With no OAuth metadata at all it answers `MCP_TOKEN_REQUIRED`.
4. The client, in this order: a client the person registered with the vendor (`clientId`, optional `clientSecret`); a Client ID Metadata Document when the server sets `client_id_metadata_document_supported` and `HUB_API_PUBLIC_URL` is https (the `client_id` is `${HUB_API_PUBLIC_URL}/api/mcp-client-metadata.json`, served publicly by hub-api); otherwise Dynamic Client Registration (RFC 7591). Ensemble registers as a public client (`token_endpoint_auth_method: none`, `client_name` "Ensemble", redirect `${HUB_API_PUBLIC_URL}/api/mcp-connections/callback`). An authorization server that lists no `none` method gets a confidential registration, and its client secret is stored encrypted. If none of these exist (no DCR, no CIMD) the answer is `MCP_TOKEN_REQUIRED` and the person can paste a token instead.
5. The authorize URL carries a PKCE S256 challenge, `resource` (RFC 8707, the server's resource from its metadata), a scope only when the server names one (`WWW-Authenticate` scope or `scopes_supported`), and a 32-byte state stored on the row for 10 minutes. The route returns `{ id, status: "pending", authorizeUrl }`.
6. `GET /api/mcp-connections/callback` is public (listed in `lib/auth-public.ts`); the single-use state ties it to the connection. On hosted the browser must also have an Ensemble session (`SameSite=Lax`, so it arrives with the vendor's redirect) for the person who started the connection. Otherwise nothing is exchanged or saved, the state is spent, and the person sees "Sign in to Ensemble in this browser" or "started from a different Ensemble account". This stops someone sending their own sign-in link to another person to collect that person's tokens. Local and desktop skip the session check. The callback exchanges the code with the verifier and `resource`, lists tools (all pages, up to 200), caches them, and redirects to `${HUB_WEB_ORIGIN}${returnTo}` with `mcp=connected` or `mcp=error&mcpError=<message>`. A refusal at the vendor (for example Atlassian's domain allowlist) is shown in the vendor's own words and saved as `lastError`.

**Tokens instead of sign-in.** `{ url, name, token }` or `{ serverId, token }` sends the token as `Authorization: Bearer`. Ensemble lists the server's tools with it first, so a refused token is a 400 (`MCP_TOKEN_REFUSED`) and nothing is saved. Use this for Hugging Face or Zapier keys and private servers. Catalog entries with `mcp.token` offer it up front (`only: true` for servers that take nothing else from Ensemble yet: Intercom until its redirect allowlist includes Ensemble, Render, Smartsheet, Wrike).

**Other ways a catalog server signs in** (fields of the entry's `mcp`; [31 §3](31_CONNECTORS_IN_USE.md#3-ways-to-connect)):

- `fields`: the address has `{placeholders}` the person fills in (Grafana Cloud's `{stack}`, AWS's `{region}`). Each value must match the field's `pattern`, a pasted URL or a repeated suffix is trimmed (`fieldnote.grafana.net` → `fieldnote`), and a reconnect reuses the values the stored address was built from (`fillMcpUrl`, `mcpFieldsFromUrl` in `src/routes/mcp-connections.ts`). Anything else is a 400 `MCP_FIELD` before any network call.
- `client`: the server accepts only clients registered with the vendor (HubSpot, Asana, Slack, Dropbox). Whoever runs Ensemble registers one per server, once, and saves it like a sign-in app under the key in `client.app` (`hubspot_mcp`, `asana_mcp`, `slack_mcp`, `dropbox_mcp`; steps in `src/connectors/mcp/client-apps.ts`, redirect URI = the MCP callback). Connect sends it as the pre-registered client; without it the route answers 409 `MCP_APP_MISSING` and the catalog state has `mcpReady: false`.
- `ownClient`: each organisation registers its own app (Salesforce's External Client App, Front's developer app) and the person pastes its client ID and secret, as with a custom server.
- `connection`: the server takes the person's existing connection to that app as a bearer token (GitHub's MCP server takes the GitHub connection; Linear's takes the Linear connection). `{ serverId, useConnection: true }` stores no token: the row's envelope says `auth: "connection"` and names the provider, and every call reads the current token through `providerAccessToken`, so a reconnected or rotated GitHub token is used at once and a removed one turns the MCP connection to "reconnect".

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
| Asana (`mcp.asana.com/v2`), HubSpot (`mcp.hubspot.com`), Slack (`mcp.slack.com/mcp`), Dropbox (`mcp.dropbox.com/mcp`) | No DCR and no CIMD: they use the operator's registered client (`mcp.client`). Slack's MCP server only accepts Slack apps published in the Marketplace or used inside their own workspace; Dropbox needs production approval after 50 linked people |
| GitHub (`api.githubcopilot.com/mcp/`), Linear | Sign in with the person's GitHub or Linear connection (`mcp.connection`); organisations that restrict OAuth apps may need to approve Ensemble's GitHub app |
| Salesforce, Front | Each organisation's own app (`mcp.ownClient`) |
| Grafana Cloud, AWS (your account) | DCR and CIMD on an address with the person's stack or Region. Grafana needs Grafana Assistant on and the Cloud MCP User role; AWS needs the `AWSMCPSignInOAuthAccessPolicy` policy and its sign-ins last 12 hours |
| AWS Knowledge | Open, no sign-in |
| Cloudflare, Stripe | DCR or CIMD, or a pasted Cloudflare API token / Stripe agent key |
| Intercom | DCR only for allowlisted redirect URIs, so the catalog asks for an access token (`token.only`) until Intercom allowlists Ensemble's callback |
| Loom | Through Atlassian's Rovo MCP server (same address as the Jira entry); the Loom workspace must be linked to an Atlassian site |
| Datadog, incident.io, Ramp | DCR, but the customer's admin (or the vendor) must allow Ensemble's callback address |
| Hugging Face | Connects without a sign-in (public tools only). Paste a Hugging Face token for account tools |
| Figma, Vercel | Their MCP servers accept only clients they approved, so Figma and Vercel connect with a pasted token to their REST APIs instead ([31](31_CONNECTORS_IN_USE.md)) |

### 2.3 Meeting-notes sources

Meeting tools with a personal API key have explicit import adapters for Meeting notes (`apps/hub-api/src/connectors/meetings/`). Each is a token connector (group `notes`) in `src/connectors/base.ts`, a `ConnectorId` in `packages/shared-types/src/assistant.ts`, and a `CONNECTOR_CATALOG` entry in category `meetings`. Generic Sync people does not run these transcript adapters. `hub_import_meeting_notes` saves a requested batch (up to 20 meetings since a date) after Apply; it proposes action-item tasks only when explicitly requested. Specific single-meeting reads remain available through supported app tools. The legacy adapter bounds a requested batch to 20 meetings.

| Source id | Implemented API requests | Access |
|---|---|---|
| `fireflies` | GraphQL `api.fireflies.ai/graphql`: `transcripts(fromDate)` with sentences, attendees, `summary.overview` and `summary.action_items` | Personal API key; vendor access required. |
| `fathom` | `GET api.fathom.ai/external/v1/meetings?created_after&include_transcript&include_summary&include_action_items`, `X-Api-Key` | Personal API key; vendor access required. |
| `granola` | `GET public-api.granola.ai/v1/notes?updated_after`, then `/v1/notes/{id}?include=transcript` (a 413 keeps the summary only) | Personal API key; Granola MCP is separate (§2.2). |
| `tldv` | `GET pasta.tldv.io/v1alpha1/meetings?from`, `/meetings/{id}/transcript`, `/meetings/{id}/notes`, `x-api-key` | Personal API key; vendor access required. |
| `krisp` | `GET meeting-api.krisp.ai/v1/meetings?from`, `/meetings/{id}?fields=…,transcript,notes` (409 while processing is skipped) | Personal API key; vendor access required. |
| `jamie` | `GET beta-api.meetjamie.ai/v1/me/meetings.list` and `meetings.get` (`input={"json":…}`), `x-api-key` | Personal API key; vendor access required. |
| `otter` | `GET api.otter.ai/v1/conversations`, `/conversations/{id}?include=action_items,transcript,outline` | Personal API key; vendor access required. |

Read AI (OAuth only, no personal keys), Avoma, Gong, Grain, Fellow, Supernormal, MeetGeek, Bluedot and Tactiq are MCP-only catalog entries, and so are the MCP sides of Fireflies, Fathom, Krisp, Jamie and Otter. Loom has no public transcript API; its catalog entry connects Atlassian's Rovo MCP server, whose Loom tools return a video's transcript, comments and AI summary when the Loom workspace is linked to an Atlassian site.

Every vendor maps its response into one `MeetingRecord` (`meetings/types.ts`); `meetings/ingest.ts` then does the same for all of them:

1. **Transcript** → `Artifact(kind transcript, externalId "<vendor>:<id>")`: speaker lines with timestamps, trimmed to 18,000 characters with a note to open the rest in the vendor; metadata keeps the vendor id, end time, duration, summary and action items. Secrets are redacted as for every artifact.
2. **People**: attendees and speakers with an address go through `upsertPerson` (§4.7) and become the note's `personIds`. A speaker with only a name is linked to an existing person of exactly that full name, never created.
3. **Calendar match** (`meetings/match.ts`): the vendor's calendar event id wins when it names a stored event (Google event id, or the Graph id behind `outlook:<id>`). Otherwise an event within 12 hours must fit in time (at least half of the shorter of the two overlaps, or it starts within 10 minutes) and is scored `0.5·time + 0.3·shared attendees (not counting me) + 0.2·title words`. The best event also needs a shared attendee, a title overlap of 0.3, or to be the only close fit. If the runner-up is within 0.1 the meeting stays unmatched (ambiguous). Notes from the last 14 days that are still unmatched are tried again on a subsequent requested import, when matching saved events are available.
4. **Meeting note**: one `MeetingNote` per `(user, external_source, external_id)` with `source = "connector"`, the vendor summary as `answer`, `event_artifact_id`, `transcript_artifact_id`, and `extraction = { via, summary, decisions, actionItems, waitingOn, eventMatch }`. Decisions come from the vendor where it has them, plus bullets under a "Decisions"/"Agreed" heading of the summary. A note the person deleted stays deleted.
5. **Action items**: an item is mine when its assignee's address is one of mine (the account email, `settings.email`, connected-account emails, the vendor account), or, with no address, when the name is my full name or my first name alone. Fireflies' grouped text and Markdown "Action items"/"Next steps" sections are parsed for owners (`**Name**` groups, `Name:` prefixes). When the explicit import requests `proposeTasks`, my open items become proposed todos (`sourceKind meeting`, `meeting_note_id`, excerpt, the vendor's link to that moment or the meeting, else the calendar event), keyed `meeting:<vendor>:<id>:<hash>` so a re-sync, or a todo the person dismissed, never proposes the same item again. Everyone else's open items are kept on the note as `waitingOn`.

Disconnect with *delete what was read* removes the transcripts and the meeting notes from that source; todos stay. Checked with mocked vendor responses on 7 Oct 2026 (`src/connectors/meetings/meetings.test.ts`, `src/routes/connected-data.integration.test.ts`); not yet run against live vendor accounts.

---

## 3. Normalized model

The authoritative shapes are `apps/hub-api/prisma/schema.prisma` and shared domain types. An `Artifact` is stored source/reference content with kind, external ID, title/text, URL/time, metadata and relationship IDs. Uploaded files have separate original bytes plus a text Artifact; a source URL alone is not an uploaded file.

| Entity | Current role |
| --- | --- |
| Person and PersonIdentity | A saved person and their normalized email/handle/provider identities |
| Project / Deliverable | Editable work context, notes, relationships, status and linked milestones |
| Repo | A saved/tracked repository reference; code reads/execution use their own authorization |
| Preference | Keyed user or feature state; not every preference is an inferred personal habit |
| Artifact / Extraction | Saved content and its explicit extraction metadata |
| ContextSuppression | Natural identity a user removed and does not want recreated |
| TaskPage / mention index | Structured writing and typed references used by views/search/briefs |
| MeetingSession / MeetingNote | Manual meeting writing and saved/imported source notes |

Graph views derive edges from these records and mentions; they do not require a separate graph database. Confidence/evidence metadata is not a measured correctness guarantee.

## 4. Content and relationship pipelines

### 4.1 Explicit content ingestion

`connectors/items`, requested meeting imports, file uploads/imports and board importers have separate entry points. `connectors/ingest.ts` supplies common redaction/suppression helpers where used. Generic `sync.ts` calls `syncPeople`, not the legacy body-reading adapters. A transient live search is not a workspace-wide save.

### 4.2 Extraction and proposals

`connectors/triage.ts` can classify requested/selected source content. Explicit meeting import proposes tasks only when `proposeTasks` is requested. Assistant-created action items use the note's actual owners/dates and normal write policy. Contact sync creates no artifacts or proposals and spends no model tokens. There is no active `context.deltas` → Todo Proposer service in the current normal flow.

### 4.3 Meeting processing

API adapters normalize to `MeetingRecord`, then `meetings/ingest.ts` stores transcript/source metadata, matches existing saved calendar events conservatively and records source-attributed notes. Ambiguous calendar matches remain unmatched. A transcript excerpt is bounded; the source link is required for more. Manual notes and imported notes retain different editing rights (§7).

### 4.4 Graph maintenance

`routes/context.ts`, `context/people-view.ts`, `people/identity.ts` and `projects/links.ts` provide current views/relationships. User corrections and hiding a tab do not launch a provider fetch. Profile records have their own route/service types; do not treat every record as a generic graph node.

### 4.5 Changes and live views

Writes publish scoped SSE invalidations for affected UI data. The database remains authoritative. The old Redis-stream delta/ranking architecture is not the current acquisition path.

### 4.6 Deletion and suppressions

Soft deletion hides a record immediately while retaining recovery through Trash. `context_suppressions` records relevant natural identities so a later ingest does not recreate what the person removed. Person identity tombstones also guard metadata sync. Purge uses `jobs/retention.ts`; it is separate from display windows.

Saved app Artifact removal (`DELETE /api/artifacts/:id`) records an artifact suppression. Explicit reattachment can clear it and restore the source row. Uploaded-file text follows its Document and must be removed through the file operation, not by independently deleting its Artifact. [32](32_FILES.md#11-connected-items-opened-explicitly).

Suppressions are operation-specific; inspect the actual creation path before promising that every legacy helper observes the same rule. Current helper paths are `connectors/ingest.ts`, `context/artifacts.ts`, `people/identity.ts` and the relevant import writer, not the removed prototype scripts.

### 4.7 One person across sources (identities)

`PersonIdentity` stores normalized kind/value/source and verification metadata; the same space/kind/value is unique. Exact addresses and provider-confirmed stable IDs can reuse/merge existing identities. A display name alone never causes an automatic person merge. Conflicts produce merge suggestions; user-approved merging moves related IDs through the existing people routes. Removed identities are not automatically restored by generic sync.

### 4.8 Project links

`projects/links.ts` maps a source container to a saved project. `LINK_SOURCES` and provider item-search source IDs are distinct namespaces (for example Jira item search uses Atlassian connection metadata). A model must use the actual returned source/container IDs, not invent them from display names.

The assistant's `hub_list_app_relationships` lists sources, attachments, links, containers and merge suggestions. `hub_manage_app_relationship` performs supported attach/detach/refresh/add-as-task/people import/link/unlink/merge operations after Apply. These are explicit relationship changes, not continuous bidirectional sync.

## 5. Shared retrieval and briefs

`bridge/service.ts` implements bounded task/project/people/skill search and reads. Search uses case-insensitive matching on stored fields. `Artifact.searchVector`, `ArtifactChunk.embedding` and `ContextPack` schema do not imply a working embed/rank/compress pipeline: no semantic retrieval is wired into the current bridge.

Workspace briefs (`workspace/agent.ts`, `pages/agent-context.ts`) assemble the assigned task, its page, linked context, selected skills, attached items and file excerpts under explicit limits. Source citations retain IDs/URLs. Tools can read longer content in parts. The assistant separately starts with a small snapshot and uses its typed readers. These consumers share data/access rules, not one universal persisted context-pack algorithm.

## 6. Profile and preferences in context

Profile, timezone, profession and selected personal instructions inform applicable requests. The implementation does not generate the old daily “Who I am” paragraph containing inferred colleagues, sprint ownership and tone for every worker. Settings and personal skill bodies remain the explicit authority for declared preferences.

## 7. Meeting context

`routes/cowork.ts` serves `/api/meetings/sessions` (manual notes), their end/attach/recap actions and `/api/meetings/summarize`. `routes/meeting-notes.ts` serves `/api/meetings/imported` and `/api/meetings/notes/:id`. The old `/api/meetings/:id/extract` and `/apply` examples are not current endpoints.

Manual notes use the page editor, saved `content` plus Markdown `notes`, and attendee/event links. Imported source notes are read-only. Summaries, decisions and tasks must be grounded in the selected note. No microphone recording, audiovisual understanding or Copilot-paste bridge is implemented. The assistant can read notes, explicitly import a bounded batch, create/edit manual notes and propose tasks when asked. See [34](34_ASSISTANT_ACTIONS.md).

## 8. Project pages

Projects keep name, summary/notes, status, people/repository relationships and linked work. Their page assembles saved related tasks/deliverables/files/source items. Relationships can be edited manually or through supported assistant tools. People remain identity/context records; adding an attendee is not an automatic invented-person workflow.

## 9. Storage & performance

Prisma manages ordinary tables in PostgreSQL's `public` schema; desktop uses the compatible embedded store. Logical areas such as context/audit are not separate Prisma database schemas. Retrieval is bounded; no HNSW/full-text performance claim is made for unused schema columns. Live records do not expire from inactivity. Completed/Trash/history retention have separate settings ([07](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#11-completed-and-deleted-data-retention)).

## 10. Verification and known limits

Use connector/item/identity/import HTTP tests and the shared retrieval suites for their contracts. Mocks establish request handling, not current vendor plan entitlement, consent readiness or production token access. Catalog endpoint definitions and OAuth scopes must be checked against code before changes. Operator registration steps live in the ignored private runbooks.

`bridge/gaps.ts` still contains old missing-connector/redaction diagnostics. Those strings lag the current source; this documentation pass does not change runtime code. Retrieval's semantic-ranking gap and read-only bridge boundary remain real.

## 11. Seed data: opt-in only

A fresh database is empty. `pnpm dev` and `pnpm db:migrate` never seed sample work. `pnpm db:seed` and `pnpm seed:demo` are explicit fixture/demo commands. [DEMO_DATA](DEMO_DATA.md) describes what they write and how demo reset is scoped.

## 12. Task pages and connected notes

`pages/store.ts`, `markdown.ts`, `agent-context.ts` and the shared page schema own structured documents, Markdown projections and mention indexes. Documents are read on demand, not included in every board response. Task notes mirrored as reference content remain distinct from immutable run evidence.

Task page API saves use revision/expected-notes checks; changed instructions are blocked during live workspace work while source-bound human annotations can remain editable. Live collaboration reconciles external writes through its authority. A mention references a real same-space entity; a date mention does not itself set the task's due date. The editor, history, conversion and comment behavior is documented once in [02 §13](02_MODULE_INTERACTION_HUB_UI.md#13-document-style-pages).

## 13. Files as context

Original bytes, format previews, extraction and caps are owned by [32](32_FILES.md). A readable file has a bounded text Artifact (`file:<documentId>`), redacted by the file pipeline. Scanned PDFs can have no text; there is no OCR. Search, assistant readers, agent briefs and the bridge read supported extracted text rather than arbitrary original bytes.

Uploading/importing a file does not create people, projects, repos or todos. Optional enrichment summarizes existing extracted text and matches existing tags; `ENSEMBLE_DOCUMENT_ENRICHMENT=off` disables it. Explicit tags can link tasks/projects/people/repos. Deletion/restoration follows the Document and its text together.

Notion page import preserves supported native blocks/rich text, nested pages and ordinary editable tables; it does not create a new Ensemble database or turn every table into a task board. Whole-board imports use their separate preview/mapping workflow ([27](27_IMPORTS.md)).
