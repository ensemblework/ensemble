# 03 · Context, connectors and saved relationships

Context is the work a person explicitly keeps in Ensemble: people, projects, repositories, preferences, pages, meetings and saved source content. Shared retrieval and agent briefs read this stored context; connected-app tools read live content separately. App operations: [31](31_CONNECTORS_IN_USE.md). Board/page imports: [27](27_IMPORTS.md). Originals and extracted text: [32](32_FILES.md).

## 1. Responsibilities

- Keep content and relationships scoped to the open space and sharing permissions.
- Normalize explicitly saved source items with provenance and stable external IDs.
- Keep conservative person identities and project/container links.
- Provide bounded retrieval, task briefs, source citations and saved entity/mention links.
- Keep removals removed through soft deletion, suppressions and identity tombstones.

No background graph crawler, nightly relationship inference or semantic ranker runs. Schema fields alone do not mean a pipeline exists.

## 2. Connectors

Manual **Sync people** (`POST /api/fetch`, `POST /api/connections/:id/sync`) calls `connectors/people-sync.ts`. It stores contact metadata only: no message bodies, artifacts, proposals or model triage. Connecting an app saves no content. Scheduled fetches read nothing: `fetchAll` (`connectors/sync.ts`) returns at once for a scheduled call, even with `ENSEMBLE_SCHEDULED_FETCH=on`.

| Source | Metadata read on manual sync |
| --- | --- |
| Gmail | Up to 100 recent message IDs, then From/To and bulk-mail headers with `format=metadata`; no subject, snippet or body |
| Outlook | Up to 100 inbox and 100 sent rows: sender/recipients, dates, draft state, bulk headers |
| Google Calendar / Outlook calendar | Up to 100 events' attendee names and addresses |
| Slack | Up to 200 non-bot, non-deleted member profiles |
| Teams | Up to 50 chats' member profiles, without messages |
| GitHub | Up to 100 followed user handles |
| Other apps and meeting sources | Nothing; use explicit search/import tools |

`people/filter.ts` applies fixed domain, local-address and bulk/list header rules. Removed people stay removed (identity tombstones and suppressions). Exact addresses and provider-confirmed Slack/Teams/Linear user IDs reuse or merge identities; names alone never merge. Sync needs a verified account and granted product scopes. Provider errors never erase saved people.

Files and artifacts enter only through an explicit upload, import, attach/save or an assistant action the person asked for. Search results are transient; reading one saves nothing else. `connectors/items` and the connected-app assistant tools use the person's own refreshed grants; signing in with a provider never grants connector access. See [31](31_CONNECTORS_IN_USE.md), [32](32_FILES.md).

### 2.1 Connector store, OAuth apps, products and tokens

The store lists `CONNECTOR_CATALOG` (`packages/shared-types/src/connectors.ts`). `GET /api/connectors/catalog` (`src/connectors/catalog.ts`) adds each person's state: `connected` and `account` from their `oauth_tokens` row, `appReady` (the operator set up what the entry needs, or it connects by token, MCP or file), `oauthReady`, `mcpReady`, `products` (saved toggles over catalog defaults), `needsConsent` (products on but not granted), `sources` (`settings.connections` plus `sync_state` last sync and error) and `mcp` (status, tool count, last error, `auth`, `account` from `mcp_connections`).

**OAuth apps.** `oauthApp` (`src/connectors/accounts.ts`) picks, in order: the connector's own `<PROVIDER>_CLIENT_ID`/`_SECRET`; an app the operator saved in Settings → Connections (`connector_apps`, encrypted; `GET /api/connectors/apps`, `PUT /api/connectors/apps/:provider`); for Google, Microsoft and GitHub, the sign-in app (`AUTH_GOOGLE_*`, `AUTH_MICROSOFT_*`, `AUTH_GITHUB_*`). The redirect URI is `${HUB_API_PUBLIC_URL}/api/connectors/<provider>/callback`; a borrowed sign-in app needs that exact URI registered too (a broad `/api` callback does not work). Flows in `src/connectors/oauth.ts` keep a 10-minute in-memory state (one API process) and use PKCE S256 for Google, Microsoft, GitHub, Linear, Zoom, Docusign and Dropbox. On hosted servers a flow is bound to the browser that pressed Connect: `/start` sets an HttpOnly, SameSite=Lax `ensemble_connect_<provider>` cookie (on `ENSEMBLE_COOKIE_DOMAIN`), and the callback exchanges the code only if that cookie matches and the browser's session is the starting account; otherwise it redirects with an error and saves nothing. Desktop and local skip this check (the system browser has no Ensemble session).

| Provider | Authorize / token | Scopes | Saved with the token |
|---|---|---|---|
| `google` | accounts.google.com, `access_type=offline`, `prompt=consent`, `include_granted_scopes=true` | `openid email profile` plus enabled products | email |
| `microsoft` | login.microsoftonline.com/`common` v2.0 | `openid email profile offline_access User.Read` plus products | mail or UPN, Graph user id |
| `github` | github.com OAuth App | `repo read:user read:org` | login |
| `linear` | linear.app / api.linear.app | `read comments:create` (comments only for "Post an update") | email, `auth: bearer` |
| `notion` | api.notion.com, `owner=user`, JSON exchange with HTTP Basic | none | workspace name, `workspaceId`, `botId` |
| `atlassian` | auth.atlassian.com, `audience=api.atlassian.com`, `prompt=consent` | `read:jira-work read:jira-user offline_access` | `cloudId`, `site`, `siteName` from accessible-resources, `auth: bearer` |
| `slack` | slack.com/oauth/v2, `user_scope` | `channels:history groups:history im:history mpim:history channels:read groups:read users:read users:read.email` (user token from `authed_user`; `channels:read` and `groups:read` let "Add from apps" list channels) | `user @ team` |
| `zoom` | zoom.us, HTTP Basic exchange; scopes come from the app | `user:read:user meeting:read:list_meetings cloud_recording:read:list_user_recordings cloud_recording:read:meeting_transcript meeting:read:summary` | email |
| `docusign` | account-d.docusign.com (`DOCUSIGN_ENV=demo`, default) or account.docusign.com | `signature` | email, default account `accountId`, `baseUri` |
| `dropbox` | dropbox.com/oauth2, `token_access_type=offline` | `account_info.read files.metadata.read files.content.read` | email |
| `box` | account.box.com / api.box.com; scopes from the app; single-use refresh tokens, the rotated one is saved | none | login |
| `xero` | login.xero.com / identity.xero.com, HTTP Basic exchange | `openid profile email offline_access accounting.invoices.read accounting.contacts.read` (`XERO_SCOPES` overrides) | first organisation's `tenantId`, `tenantName` |
| `discord` | discord.com/oauth2, bot install (`permissions=66560`: view channels, read message history) | `identify guilds bot` | username and the servers the bot was added to (`guilds`; another install adds to the list). Channels are read with the operator's `DISCORD_BOT_TOKEN`, only for those servers |

**Products.** Google Workspace and Microsoft 365 are suites (`src/connectors/products.ts`). Connect asks for the base scopes plus those of the products that are on: `GET /api/connectors/:provider/start?products=a,b` takes an explicit list, otherwise the saved toggles in `settings.connectorProducts`. `PUT /api/connectors/:id/products` saves toggles. Switching a product off applies at once (its sync sources switch off); switching on one whose scopes the token lacks returns `{ reconnect: true, url }` so the person approves only the new access, and the toggle is saved when the callback returns with that scope granted (Google lets people untick a permission).

| Suite product | Scopes | Feeds |
|---|---|---|
| `gmail` | `gmail.readonly` (restricted) | `gmail` |
| `calendar` | `calendar.events`, `calendar.calendarlist.readonly`; `calendar.freebusy` also requested on new consent | `google_calendar` |
| `drive_docs` (on by default) | `drive.file` (non-sensitive; files the person picks or Ensemble creates; Docs, Sheets, Slides) | Google Picker, assistant tools |
| `drive_search` (off by default) | `drive.readonly` (restricted: public servers need Google verification) | assistant tools |
| `outlook_mail` | `Mail.Read` | `outlook` |
| `outlook_calendar` | `Calendars.ReadWrite` | `outlook_calendar` |
| `teams` (off by default) | `Chat.Read` (work or school accounts) | `teams` |
| `onedrive` | `Files.Read` | assistant tools |
| `office` | `Files.ReadWrite` (Word, Excel, PowerPoint; covers OneDrive read) | assistant tools |

Explicit calendar reads use the person's granted calendars; Sync people reads attendee metadata only. A token with a narrower calendar read grant keeps its permitted reads; writing and availability need their own grants.

**Tokens for code.** Tools, importers and syncs get tokens only through `src/connectors/tokens.ts`. `providerAccessToken` requires a verified account, refreshes a token within a minute of expiry when the provider issued a refresh token (otherwise an expired token asks the person to connect again), saves rotated refresh tokens, and returns `extra` with saved details (Atlassian `site`/`cloudId`/`auth`, Trello `key`, Docusign `accountId`/`baseUri`). Scope checks (`hasScopes`, `requireProviderToken`) ignore case and Graph's `https://graph.microsoft.com/` prefix, and accept broader grants (`Files.ReadWrite` covers `Files.Read`).

**Pasted tokens.** `POST /api/connectors/:provider/token` checks the token once before storing it (`validateToken` in `src/connectors/token-providers.ts`). The body is `{ token, email?, site?, key? }`.

| Provider | Input | Check |
|---|---|---|
| `github` | token | `GET api.github.com/user` |
| `slack` | user OAuth token | `auth.test` |
| `linear` | personal API key | GraphQL `viewer` |
| `notion` | internal integration secret | `GET /v1/users/me`, `Notion-Version: 2025-09-03` |
| `atlassian` | `email`, token, `site` | `GET https://<site>/rest/api/3/myself` with Basic auth; only `*.atlassian.net` and `*.jira.com`. Stored as `email:token` with `{ site, auth: "basic" }` |
| `trello` | `key` (API key) and token (`ATTA…`, from the Token link) | `GET /1/members/me` with `OAuth oauth_consumer_key, oauth_token`; the key is saved in `meta`. A token in the key field, or the API key in the token field, is refused before calling Trello. A 401 for a 64-hex token says it looks like the Power-Up's Secret (pre-`ATTA` tokens are 64 hex too, so Trello decides first); any other 401 says the key and token don't belong together |
| `asana` | token | `GET /api/1.0/users/me` |
| `todoist` | token | `GET https://api.todoist.com/api/v1/user` |
| `clickup` | token | `GET /api/v2/user` |
| `monday` | token | GraphQL `{ me { name } }` |
| `figma` | token, optional team link in `site` | `GET api.figma.com/v1/me` (`X-Figma-Token`); with a team, `GET /v1/teams/<id>/projects` must succeed. Saves `teamId`, `teamName` |
| `vercel` | token | `GET api.vercel.com/v2/user`, then up to 20 teams from `/v2/teams` saved in `meta` |
| `azure_devops` | PAT, organization in `site` | `GET dev.azure.com/<org>/_apis/projects` and `connectionData` with Basic auth |
| `zendesk` | `email`, API token, subdomain in `site` | `GET https://<host>/api/v2/users/me.json`; only `*.zendesk.com`; end-user logins are refused |
| `front` | token | `GET api2.frontapp.com/me` |
| `hubspot` | token | `GET api.hubapi.com/account-info/v3/details` |
| `zotero` | API key (zotero.org/settings/keys) | `GET https://api.zotero.org/keys/current` with `Zotero-API-Key`, `Zotero-API-Version: 3`; 401/403 is "Zotero didn't accept that API key", and a key that reads neither the personal library nor a group is refused. Saves `userID`, `username`, the key's `library`/`notes`/`write` access and up to 10 readable groups (`{ id, name, write }`) |
| `fireflies`, `fathom`, `granola`, `tldv`, `krisp`, `jamie`, `otter` | personal API key | the vendor's check in `src/connectors/meetings/<vendor>.ts` (§2.3) |

**Disconnect.** `DELETE /api/connectors/:provider` revokes the OAuth grant at the provider where an endpoint exists (Google, GitHub, Linear, Slack, Zoom, Dropbox, Box, Xero, Discord; pasted tokens are left alone), deletes the token and switches that provider's sources off. `?deleteData=1` also deletes the artifacts those sources stored, their `sync_state` and, for meeting-notes sources, their meeting notes (`src/connectors/forget.ts`); todos made from them stay. Tests use mocked provider responses (`src/routes/connectors.integration.test.ts`).

**Stored content.**

- Manual metadata sync records its last successful read in `sync_state`; content search/import uses the per-provider item code.
- `upsertArtifact` in `connectors/ingest.ts` (meeting imports and other ingest writers) redacts known secret patterns (private keys; GitHub, Slack, OpenAI-style, Google, AWS and Linear tokens; `password=`/`secret:`/`token:` values) in title and text and caps text at 20,000 characters.
- Attaching an app item (`connectors/items`) stores its title, text (up to 20,000 characters), link and metadata, not file bytes. Uploaded documents are a separate store with downloadable originals (§13).

### 2.2 Remote MCP connectors

Catalog entries with an `mcp` URL in `packages/shared-types/src/connectors.ts` (the full list is in [31 §4](31_CONNECTORS_IN_USE.md#4-every-connector)), and any remote MCP URL a person pastes, connect to the vendor's own hosted MCP server. For most of them the operator registers nothing: Ensemble introduces itself to each vendor's authorization server, and the assistant then gets that server's tools.

Code: `apps/hub-api/src/connectors/mcp/` (`manager.ts` connect/callback/calls, `provider.ts` the SDK `OAuthClientProvider` backed by the row, `url-guard.ts`, `store.ts`, `schema.ts`, `config.ts`, `account.ts` for whose account a token is, `client-apps.ts`), routes in `src/routes/mcp-connections.ts`, assistant tools in `src/assistant/mcp-tools.ts`. It uses the `@modelcontextprotocol/sdk` client (`auth()`, `StreamableHTTPClientTransport`, and `SSEClientTransport` when a server answers 404 or 405 to Streamable HTTP). There is one `mcp_connections` row per person and server; the OAuth client, cached discovery and tokens are encrypted with `lib/secrets.ts` and never returned or logged.

**Connecting** (`POST /api/mcp-connections`, `{ serverId }` or `{ url, name? }`):

1. Ensemble sends `initialize` with no credentials. If the server does not ask for sign-in:
   - a pasted server, or a catalog server public by design (`mcp.open`: AWS Knowledge, Context7, Exa), is connected with `auth: "none"`;
   - any other catalog server holds the person's data, so Ensemble runs sign-in anyway (steps 2–5) and returns its `authorizeUrl`. Only if the server offers no usable sign-in (no OAuth metadata, no PKCE S256, refused registration) is it saved with `auth: "none"` and `publicOnly: true` (reason logged), shown as **Connected · public data only** with sign-in and token still offered (`startConnection`, `offerSignIn` in `manager.ts`).
2. On a 401 it reads Protected Resource Metadata (RFC 9728) from the `WWW-Authenticate` header or `/.well-known/oauth-protected-resource`, then the authorization server's metadata (RFC 8414 or OpenID discovery).
3. The authorization server must list `S256` in `code_challenge_methods_supported`, otherwise Ensemble stops (`MCP_PKCE_UNSUPPORTED`). With no OAuth metadata at all it answers `MCP_TOKEN_REQUIRED`.
4. The client, in order: one the person registered with the vendor (`clientId`, optional `clientSecret`); a Client ID Metadata Document when the server sets `client_id_metadata_document_supported` and `HUB_API_PUBLIC_URL` is https (`client_id` = `${HUB_API_PUBLIC_URL}/api/mcp-client-metadata.json`, public); otherwise Dynamic Client Registration (RFC 7591) as a public client (`token_endpoint_auth_method: none`, `client_name` "Ensemble", redirect `${HUB_API_PUBLIC_URL}/api/mcp-connections/callback`), or a confidential one with an encrypted secret when the server lists no `none` method. With neither DCR nor CIMD: `MCP_TOKEN_REQUIRED` (paste a token).
5. The authorize URL carries a PKCE S256 challenge, `resource` (RFC 8707, from the server's metadata), a scope only when the server names one (`WWW-Authenticate` scope or `scopes_supported`), and a 32-byte state stored on the row for 10 minutes. The route returns `{ id, status: "pending", authorizeUrl }`.
6. `GET /api/mcp-connections/callback` is public (`lib/auth-public.ts`); the single-use state ties it to the connection. On hosted the browser must also carry the starting person's Ensemble session (`SameSite=Lax`, so it arrives with the vendor's redirect); otherwise nothing is saved, the state is spent, and the person sees "Sign in to Ensemble in this browser" or "started from a different Ensemble account". This stops a sign-in link sent to someone else from collecting their tokens. Local and desktop skip the session check. The callback exchanges the code with the verifier and `resource`, caches the tools (all pages, up to 200) and redirects to `${HUB_WEB_ORIGIN}${returnTo}` with `mcp=connected` or `mcp=error&mcpError=<message>`. A vendor refusal (such as Atlassian's domain allowlist) is shown in the vendor's words and saved as `lastError`.

**Tokens instead of sign-in.** `{ url, name, token }` or `{ serverId, token }` sends `Authorization: Bearer`. Ensemble lists tools with it first, so a refused token is a 400 `MCP_TOKEN_REFUSED` and nothing is saved. Where the vendor has an account API (`connectors/mcp/account.ts`: Hugging Face's `GET https://huggingface.co/api/whoami-v2`), the token is checked there too (401 → `MCP_TOKEN_REFUSED`) and the account name is kept in the sealed envelope and returned as `account` ("Connected as mira-chen"); the same lookup runs after an OAuth sign-in. Catalog entries with `mcp.token` offer a token up front; `only: true` (Intercom, Render, Smartsheet, Wrike) offers nothing else.

**Other ways a catalog server signs in** (fields of the entry's `mcp`; [31 §3](31_CONNECTORS_IN_USE.md#3-ways-to-connect)):

- `fields`: the address has `{placeholders}` the person fills in (Grafana Cloud's `{stack}`, AWS's `{region}`). Each value must match the field's `pattern`; a pasted URL or repeated suffix is trimmed (`fieldnote.grafana.net` → `fieldnote`), and a reconnect reuses the stored values (`fillMcpUrl`, `mcpFieldsFromUrl` in `routes/mcp-connections.ts`). Anything else is a 400 `MCP_FIELD` before any network call.
- `client`: the server accepts only clients registered with the vendor (HubSpot, Asana, Slack, Dropbox). The operator registers one per server and saves it like a sign-in app under `client.app` (`hubspot_mcp`, `asana_mcp`, `slack_mcp`, `dropbox_mcp`; steps in `connectors/mcp/client-apps.ts`, redirect URI = the MCP callback). Without it the route answers 409 `MCP_APP_MISSING` and the catalog state has `mcpReady: false`.
- `ownClient`: each organisation registers its own app (Salesforce's External Client App, Front's developer app) and the person pastes its client ID and secret.
- `connection`: the server takes the person's existing connection as a bearer token (GitHub, Linear). `{ serverId, useConnection: true }` stores no token: the envelope says `auth: "connection"` and names the provider, and every call reads the current token through `providerAccessToken`, so a reconnected token is used at once and a removed one turns the MCP connection to "reconnect".

**What the person sees.** Connect opens the vendor's approval page. Settings then shows the server with its tools (and "Connected as <account>" where known; `GET /api/mcp-connections` and the catalog state carry `auth` and `account`). Tools can be switched off (`PATCH /api/mcp-connections/:id { disabledTools }`), and the whole server switched off/on (`status`). `POST /api/mcp-connections/:id/refresh-tools` lists tools again. `DELETE` revokes tokens at the vendor when its metadata has a `revocation_endpoint`, then deletes the row. Ledger actions: `mcp.connect`, `mcp.enable`, `mcp.disable`, `mcp.disconnect`.

**In the assistant.** `mcpToolsForUser` turns connected servers' cached tools (minus switched-off ones) into Hub tools in the `apps` area, named `mcp_<server>_<tool>` (at most 64 characters of `[a-zA-Z0-9_-]`; `<server>` is the catalog id or the pasted server's name plus a short hash; changed or shortened tool names get a hash suffix, so names stay stable between proposal and Apply, `resolveMcpTool`). `readOnlyHint: true` makes a read; everything else is a write that waits for Apply (`destructiveHint: true` is high risk). Descriptions start with the server's name. The server's JSON Schema is passed to the model after cleaning in `schema.ts` (object at the top, no OpenAPI-only keywords, cut down past 12,000 characters). Limits: 40 tools per server, 80 in total (the first tool of a trimmed server lists what was hidden); a 60-second timeout per call; results cut to 4,500 characters of text and `structuredContent` kept only up to 1,200. Each call opens a short-lived client and refreshes the token a minute before expiry and once more on a 401. A refused refresh sets the connection to `error` ("Reconnect <name> …") and removes its tools.

**Limits and safety.**

- Hosted: verified accounts only (`requireVerifiedUser`). Pasted URLs must be https and resolve only to public addresses; private, loopback, link-local, carrier-grade NAT, cloud metadata and matching IPv6 ranges are refused (`isBlockedAddress` from `plots/ssrf.ts` plus IPv6-mapped forms). The check covers every request and redirect hop (at most 4), including authorization, token and revocation endpoints; `Authorization` is dropped when a redirect leaves the origin. Hosted requests use `pinnedFetch` (`url-guard.ts`), whose agents resolve the host, refuse private addresses and connect only to the checked ones, so DNS rebinding cannot reach a private address; SNI, certificate checks and `Host` use the URL's hostname. Local and desktop: https anywhere, plain http only to `localhost`.
- Per person: 30 connections, 20 connect attempts and 30 tool refreshes per 10 minutes. Per address: 60 callbacks per 10 minutes. These are in-process counters.
- Desktop and localhost have no https public URL, so they always use DCR, never CIMD.
- Every request to an MCP server, its metadata and its authorization server sends `User-Agent: Ensemble/<version> (+https://ensemblework.com)` (`MCP_USER_AGENT` in `config.ts`, set in `guardedFetch`); some sign-in servers (Meta's `www.facebook.com`) return a web page without one.
- HTML where JSON was expected (a `text/html` 2xx from a sign-in step, or any `text/html` answer to a registration or token POST), an unparseable body, or metadata that fails the OAuth schema stops with 502 `MCP_BAD_RESPONSE` ("<App>'s sign-in returned a web page instead of data (<host>). …", or "<App>'s MCP server returned …"); the address is logged without its query string (`unreadableFailure`). The MCP address's own error statuses still reach the SDK, so a 401 starts sign-in and a 404/405 tries SSE.
- If sign-in fails for a connection saved without an account, the connection is restored as it was rather than marked broken.

Token exchange, refresh and tool calls are tested against an in-process mock server (`src/routes/mcp-connections.integration.test.ts`); Hugging Face sign-in/token paths, the public-data-only rule, the User-Agent and the WhatsApp web-page errors against in-process fakes (`src/routes/mcp-sign-in.integration.test.ts`).

**Vendor notes.**

| Server | What happens |
|---|---|
| Notion, Linear, Atlassian, Todoist, Airtable, Granola, Canva, Sentry, Hugging Face | Offer CIMD; hosted (https) uses it, desktop uses DCR |
| ClickUp, monday.com, Miro, Webflow, Stripe, Supabase, Zapier | DCR. monday.com, Miro and Supabase take only confidential clients, so they get a stored client secret |
| Atlassian (Rovo) | A site admin may need to allow Ensemble's domain (`api.ensemblework.com` on the hosted service); the refusal is shown as returned |
| Asana (`mcp.asana.com/v2`), HubSpot (`mcp.hubspot.com`), Slack (`mcp.slack.com/mcp`), Dropbox (`mcp.dropbox.com/mcp`) | No DCR or CIMD: the operator's registered client (`mcp.client`). Slack's MCP server accepts only Marketplace-published apps or apps used inside their own workspace; Dropbox needs production approval after 50 linked people |
| GitHub (`api.githubcopilot.com/mcp/`), Linear | Use the person's GitHub or Linear connection (`mcp.connection`); organisations that restrict OAuth apps may need to approve Ensemble's GitHub app |
| Salesforce, Front | Each organisation's own app (`mcp.ownClient`) |
| Grafana Cloud, AWS (your account) | DCR and CIMD on an address with the person's stack or Region. Grafana needs Grafana Assistant on and the Cloud MCP User role; AWS needs the `AWSMCPSignInOAuthAccessPolicy` policy, and its sign-ins last 12 hours |
| AWS Knowledge, Context7, Exa | Public (`mcp.open`): connected with no sign-in |
| Cloudflare, Stripe | DCR or CIMD, or a pasted Cloudflare API token / Stripe agent key |
| Intercom | DCR only for allowlisted redirect URIs, so the catalog asks for an access token (`token.only`). EU workspaces add `https://mcp.eu.intercom.com/mcp` as a custom server |
| Loom | Through Atlassian's Rovo MCP server (same address as Jira); the Loom workspace must be linked to an Atlassian site |
| Datadog, incident.io, Ramp | DCR, but the customer's admin (or the vendor) must allow Ensemble's callback address |
| Hugging Face | Never connected anonymously. The catalog address is `https://huggingface.co/mcp?login`: with `?login` and no token the server answers 401, so **Sign in with Hugging Face** runs OAuth and later calls use the same address with the bearer. **Paste an access token** (huggingface.co/settings/tokens; Read to search and read, Write to let the assistant create repos) is checked with `tools/list` and `whoami-v2`. Both show "Connected as <username>". A pasted `https://huggingface.co/mcp` is the same entry. A connection saved without an account shows as public data only, with both upgrades offered |
| WhatsApp Business | Meta's protected-resource metadata points at `www.facebook.com/whatsapp_business_tools`, with DCR at `mcp.facebook.com/.well-known/register/whatsapp_business_tools`. A web page from Meta's sign-in is reported as such (see Limits) |
| Wispr Flow | `https://api.wisprflow.ai/connect/mcp`, exactly (no trailing slash); browser sign-in with the Wispr Flow account, no API key. Read only. The account needs Notetaker and MCP access (Wispr Flow → Settings → MCP); an active HIPAA BAA or an organisation policy turns MCP off |
| Figma, Vercel | Their MCP servers accept only approved clients, so they connect with a pasted token to their REST APIs ([31](31_CONNECTORS_IN_USE.md)) |

### 2.3 Meeting-notes sources

Meeting tools with a personal API key have import adapters in `apps/hub-api/src/connectors/meetings/`. Each is a token connector (group `notes`) in `src/connectors/base.ts`, a `ConnectorId` in `packages/shared-types/src/assistant.ts` and a `CONNECTOR_CATALOG` entry in category `meetings`. Sync people does not run them. `hub_import_meeting_notes` saves a requested batch (up to 20 meetings since a date) after Apply and proposes action-item tasks only when asked (`proposeTasks`). Single-meeting reads go through the app tools.

| Source id | API requests (personal API key) |
|---|---|
| `fireflies` | GraphQL `api.fireflies.ai/graphql`: `transcripts(fromDate)` with sentences, attendees, `summary.overview` and `summary.action_items` |
| `fathom` | `GET api.fathom.ai/external/v1/meetings?created_after&include_transcript&include_summary&include_action_items`, `X-Api-Key` |
| `granola` | `GET public-api.granola.ai/v1/notes?updated_after`, then `/v1/notes/{id}?include=transcript` (a 413 keeps the summary only). Granola's MCP server is separate (§2.2) |
| `tldv` | `GET pasta.tldv.io/v1alpha1/meetings?from`, `/meetings/{id}/transcript`, `/meetings/{id}/notes`, `x-api-key` |
| `krisp` | `GET meeting-api.krisp.ai/v1/meetings?from`, `/meetings/{id}?fields=…,transcript,notes` (409 while processing is skipped) |
| `jamie` | `GET beta-api.meetjamie.ai/v1/me/meetings.list` and `meetings.get` (`input={"json":…}`), `x-api-key` |
| `otter` | `GET api.otter.ai/v1/conversations`, `/conversations/{id}?include=action_items,transcript,outline` |

Read AI (OAuth only), Avoma, Gong, Grain, Fellow, Supernormal, MeetGeek, Bluedot, Tactiq and Wispr Flow (read only) are MCP-only catalog entries, as are the MCP sides of Fireflies, Fathom, Krisp, Jamie and Otter. Loom has no public transcript API; its entry connects Atlassian's Rovo MCP server, whose Loom tools return a video's transcript, comments and AI summary when the Loom workspace is linked to an Atlassian site.

Each vendor maps its response to one `MeetingRecord` (`meetings/types.ts`); `meetings/ingest.ts` then handles all of them:

1. **Transcript** → `Artifact(kind transcript, externalId "<vendor>:<id>")`: speaker lines with timestamps, trimmed to 18,000 characters (`TRANSCRIPT_CAP`) with a note to open the rest in the vendor; metadata keeps the vendor id, end time, duration, summary and action items. Secrets are redacted (§2.1).
2. **People**: attendees and speakers with an address go through `upsertPerson` (§4.7) and become the note's `personIds`. A speaker with only a name links to an existing person with exactly that full name, never a new one.
3. **Calendar match** (`meetings/match.ts`): the vendor's calendar event id wins when it names a stored event (Google event id, or the Graph id behind `outlook:<id>`). Otherwise an event within 12 hours must fit in time (overlap of at least half the shorter one, or a start within 10 minutes) and is scored `0.5·time + 0.3·shared attendees (not me) + 0.2·title words`. The best event also needs a shared attendee, a title overlap of 0.3, or to be the only close fit; if the runner-up is within 0.1 the meeting stays unmatched. Unmatched notes from the last 14 days are retried on the next requested import.
4. **Meeting note**: one `MeetingNote` per `(user, external_source, external_id)` with `source = "connector"`, the vendor summary as `answer`, `event_artifact_id`, `transcript_artifact_id`, and `extraction = { via, summary, decisions, actionItems, waitingOn, eventMatch }`. Decisions come from the vendor where it has them, plus bullets under a "Decisions"/"Agreed" heading of the summary. A note the person deleted stays deleted.
5. **Action items**: an item is mine when its assignee's address is one of mine (account email, `settings.email`, connected-account emails, the vendor account), or, with no address, when the name is my full name or first name alone. Fireflies' grouped text and Markdown "Action items"/"Next steps" sections are parsed for owners (`**Name**` groups, `Name:` prefixes). With `proposeTasks`, my open items become proposed todos (`sourceKind meeting`, `meeting_note_id`, excerpt, the vendor's link to that moment or the meeting, else the calendar event), keyed `meeting:<vendor>:<id>:<hash>` so a re-import, or a dismissed todo, never proposes the same item again (`connectors/triage.ts` `createProposals`). Others' open items stay on the note as `waitingOn`.

Disconnect with *delete what was read* removes that source's transcripts and meeting notes; todos stay. Tests use mocked vendor responses (`src/connectors/meetings/meetings.test.ts`, `src/routes/connected-data.integration.test.ts`).

---

## 3. Normalized model

The shapes are in `apps/hub-api/prisma/schema.prisma` and the shared domain types. An `Artifact` is stored source/reference content: kind, external ID, title/text, URL/time, metadata and relationship IDs. An uploaded file has original bytes plus a text Artifact; a source URL alone is not an uploaded file.

| Entity | Role |
| --- | --- |
| Person and PersonIdentity | A saved person and their normalized email/handle/provider identities |
| Project / Deliverable | Editable work context, notes, relationships, status and linked milestones |
| Repo | A saved repository reference; code reads and execution have their own authorization |
| Preference | Keyed user or feature state, not necessarily an inferred habit |
| Artifact / Extraction | Saved content and its explicit extraction metadata |
| ContextSuppression | A natural identity the user removed and does not want recreated |
| TaskPage / mention index | Structured writing and typed references used by views, search and briefs |
| MeetingSession / MeetingNote | Manual meeting writing and saved/imported source notes |

Graph views derive edges from these records and mentions; there is no separate graph database. Confidence/evidence metadata is not a correctness guarantee.

## 4. Content and relationship pipelines

### 4.1 Explicit content ingestion

`connectors/items`, requested meeting imports, file uploads/imports and board importers are separate entry points. `connectors/ingest.ts` provides shared redaction, suppression and people linking where used. `connectors/sync.ts` runs `syncPeople` only. A live search saves nothing.

### 4.2 Extraction and proposals

`connectors/triage.ts` creates proposals for a requested meeting import (only with `proposeTasks`); its prompt is listed in prompt transparency (`routes/system.ts`). Assistant-created action items use the note's actual owners and dates and the normal write policy. Contact sync creates no artifacts or proposals and spends no model tokens. No background service turns new content into todo proposals.

### 4.3 Meeting processing

Adapters normalize to `MeetingRecord`; `meetings/ingest.ts` stores the transcript and source metadata, matches saved calendar events conservatively (ambiguous stays unmatched) and records source-attributed notes (§2.3). Transcript excerpts are bounded; the source link has the rest. Manual and imported notes have different editing rights (§7).

### 4.4 Graph maintenance

`routes/context.ts`, `context/people-view.ts`, `people/identity.ts` and `projects/links.ts` provide the views and relationships. User corrections and hiding a tab never start a provider fetch. Profile records have their own routes and types; not every record is a generic graph node.

### 4.5 Changes and live views

Writes publish scoped SSE invalidations for the affected UI data. The database is authoritative.

### 4.6 Deletion and suppressions

Soft deletion hides a record at once and keeps it recoverable in Trash. `context_suppressions` records natural identities so a later ingest does not recreate what the person removed; deleted people's identities also block re-creation by sync. Purge runs in `jobs/retention.ts`, separate from display windows.

Removing a saved app Artifact (`DELETE /api/artifacts/:id`) records an artifact suppression; explicitly attaching the item again clears it and restores the row. Uploaded-file text follows its Document and is removed through the file operation, not by deleting its Artifact ([32 §11](32_FILES.md#11-connected-items-opened-explicitly)).

Each write path applies its own suppression check: `connectors/ingest.ts`, `context/artifacts.ts`, `people/identity.ts` and the relevant import writer.

### 4.7 One person across sources (identities)

`PersonIdentity` stores normalized kind/value/source and verification; space + kind + value is unique. Exact addresses and provider-confirmed stable IDs reuse or merge identities; a display name alone never merges people. Conflicts become merge suggestions; an approved merge moves related IDs through the people routes (`POST /api/people/:id/merge`). Generic sync does not restore removed identities.

### 4.8 Project links

`projects/links.ts` maps a source container to a saved project. `LINK_SOURCES` and item-search source IDs are separate namespaces (Jira item search uses the Atlassian connection's metadata). A model must use the returned source/container IDs, never invent them from display names.

`hub_list_app_relationships` lists sources, attachments, links, containers and merge suggestions. `hub_manage_app_relationship` performs attach/detach/refresh/add-as-task/people import/link/unlink/merge after Apply. These are explicit changes, not continuous two-way sync.

## 5. Shared retrieval and briefs

`bridge/service.ts` implements bounded task/project/people/skill search and reads using case-insensitive matching on stored fields. `Artifact.searchVector`, `ArtifactChunk.embedding` and `ContextPack` exist in the schema but nothing fills or queries them: there is no semantic retrieval.

Workspace briefs (`workspace/agent.ts`, `pages/agent-context.ts`) assemble the task, its page, linked context, selected skills, attached items and file excerpts under fixed limits. Citations keep IDs/URLs, and tools read longer content in parts. The assistant starts from a small snapshot and uses its typed readers. These consumers share data and access rules, not one context-pack algorithm.

`bridge/gaps.ts` (`DATA_GAPS`, returned by the bridge) is out of date: it still reports redaction, Outlook, Teams and Microsoft 365 as missing. Its semantic-retrieval gap is accurate.

## 6. Profile and preferences in context

Profile, timezone, profession and selected personal instructions inform requests where they apply. No inferred "who I am" profile paragraph is generated. Settings and personal skill bodies are the authority for declared preferences.

## 7. Meeting context

`routes/cowork.ts` serves manual notes: `GET/POST /api/meetings/sessions`, `GET/PATCH/DELETE /api/meetings/sessions/:id`, `/end`, `/attach`, `/decline`, `/recap`, plus `GET /api/meetings/cues` (saved calendar events from 48 hours back to 24 hours ahead, with their sessions) and `POST /api/meetings/summarize`. `routes/meeting-notes.ts` serves `GET /api/meetings/imported` and `GET /api/meetings/notes/:id`.

Manual notes use the page editor, with saved `content` plus Markdown `notes`, and attendee/event links. Attaching notes to an event saves the link inside Ensemble only; calendar apps are not written. Imported notes are read-only. Summaries, decisions and tasks must come from the selected note. There is no microphone recording or audio/video understanding. The assistant can read notes, import a bounded batch, create/edit manual notes and propose tasks when asked ([34](34_ASSISTANT_ACTIONS.md)).

## 8. Project pages

Projects keep name, summary/notes, status, people/repository relationships and linked work. Their page assembles related tasks, deliverables, files and source items. Relationships are edited manually or through assistant tools. Adding an attendee never invents a person.

## 9. Storage & performance

Prisma manages ordinary tables in PostgreSQL's `public` schema; desktop uses the compatible embedded store. Logical areas such as context/audit are not separate database schemas. Retrieval is bounded. Live records do not expire from inactivity; Completed, Trash and history retention have their own settings ([07 §1.1](07_MODULE_GOVERNANCE_AUDIT_METRICS.md#11-completed-and-deleted-data-retention)).

## 10. Tests and known limits

Connector, item, identity and import HTTP tests and the shared retrieval suites cover these contracts. Mocks show request handling, not a vendor's current plan entitlement, consent readiness or production token access; check catalog endpoints and OAuth scopes in code before changing them. Operator registration steps are in the git-ignored private runbooks.

## 11. Seed data: opt-in only

A fresh database is empty. `pnpm dev` and `pnpm db:migrate` never seed sample work. `pnpm db:seed` and `pnpm seed:demo` are explicit fixture/demo commands; [DEMO_DATA](DEMO_DATA.md) describes what they write and how demo reset is scoped.

## 12. Task pages and connected notes

`pages/store.ts`, `markdown.ts`, `agent-context.ts` and the shared page schema own structured documents, Markdown projections and mention indexes. Documents load on demand, not in every board response. Task notes mirrored as reference content stay distinct from immutable run evidence.

Task page saves check revision/expected notes; changed instructions are blocked during live workspace work, while source-bound human annotations stay editable. Live collaboration reconciles external writes. A mention references a real same-space entity; a date mention does not set the due date. Editor, history, conversion and comments: [02 §13](02_MODULE_INTERACTION_HUB_UI.md#13-document-style-pages).

## 13. Files as context

Original bytes, previews, extraction and caps: [32](32_FILES.md). A readable file has a bounded text Artifact (`file:<documentId>`), redacted by the file pipeline. Scanned PDFs may have no text; there is no OCR. Search, assistant readers, agent briefs and the bridge read extracted text, not original bytes.

Uploading or importing a file creates no people, projects, repos or todos. Optional enrichment summarizes existing extracted text and matches existing tags; `ENSEMBLE_DOCUMENT_ENRICHMENT=off` disables it. Explicit tags link tasks, projects, people and repos. Deletion and restore move the Document and its text together.

Notion page import keeps supported native blocks, rich text, nested pages and ordinary tables; it creates no Ensemble database and does not turn tables into task boards. Whole-board imports use their own preview/mapping flow ([27](27_IMPORTS.md)).
