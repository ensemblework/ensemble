# 28 · Ensemble spaces

A person can keep separate lines of work in separate **spaces**, for example a startup and personal chores. Spaces share nothing: no tasks, pages, people, graph, files, plots, diagrams, connected apps, assistant history, API keys for editors, or settings, unless the person chooses to share settings.

A space can also be shared with other people, whole or one item at a time. That is [29 · Sharing](29_SHARING.md).

Read from the code and checked with the HTTP suite and headless browser runs on 8 Oct 2026 (see [18](18_WHAT_IS_REAL.md)).

## 1. How a space is stored

A space is a row in `users` whose `owner_id` is the signed-in account (migration `apps/hub-api/prisma/migrations/20261008120000_ensemble_spaces`). The account row is itself the first space. Every table in Ensemble is scoped by `user_id`, so a space is isolated by the same filters that already isolate two accounts. No query had to learn about spaces.

| Column | On | Meaning |
|---|---|---|
| `owner_id` | space | The account that owns it. Null on the account. `ON DELETE CASCADE`. |
| `space_name`, `space_icon`, `space_position` | both | Label, optional emoji, order in the switcher. The account's name defaults to "‹first name›'s space". |
| `space_settings_sync` | account | Settings are mirrored to every space (§4). |
| `last_space_id` | account | The space a new sign-in opens. |

A space row has an undeliverable `space-…@spaces.ensemble.invalid` email and no password or linked login, so it can never be signed in to directly. Name, profession, profile completion, email verification and the tester flag are copied from the account when the space is created and again after every profile or verification change (`mirrorAccount` in `apps/hub-api/src/spaces/store.ts`). Hosted access checks (`lib/hosted-access.ts`) resolve a space to its owner, so verification and operator status are the account's.

## 2. Which space a request uses

`identify()` (`apps/hub-api/src/lib/auth.ts`) reads the httpOnly `ensemble_space` cookie for browser sign-ins (session, local bypass, desktop). It switches `request.userId` to that space only when the row's `owner_id` is the signed-in account, or when the account is a member of it (`space_members`, [29](29_SHARING.md)); otherwise the cookie is ignored. A forged cookie can at most pick another space you may open. `request.access` says whether you own the open space or are a member, and with what role. `request.accountId` holds the account; code reads it through `accountIdOf(request)`, which falls back to `request.userId` where nothing set it (service calls and the small Fastify apps in integration tests).

- **Personal API tokens, CLI keys and service calls ignore the cookie.** A token belongs to the space it was created in, so an editor connected from a space reads only that space. `ensemble login` approved inside a space gives the CLI that space.
- **Account routes use `request.accountId`:** `/api/auth/me`, profile, password, email verification, linked sign-in methods, export, account deletion, OAuth linking, and terminal passkey enrolment.
- `/api/shell` returns the account as `user` and the open space as `space: { id, name, icon, primary, members, collaborators, shared }`. `shared` is set in a space someone shared with you.
- Signing in sets the cookie to `last_space_id` when that space still exists and you may still open it. Signing out clears it.

## 3. Routes

All are browser-only (`requireBrowserSession`; tokens get 403) and limited to the account's own spaces (404 otherwise). Owned by `apps/hub-api/src/spaces/routes.ts`; checked in `apps/hub-api/src/spaces/spaces.integration.test.ts`.

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/spaces` | → `{ activeId, account: { sync, role }, spaces: [{ id, name, icon, primary, role, templateId, createdAt }] }` |
| POST | `/api/spaces` | `{ name, icon?, templateId, settings: { mode: "fresh" \| "copy" \| "sync", from? } }` → `201 { space, activeId }`. The template must be for the account's signup role. `from` must be one of the account's spaces; with mode `fresh` it is ignored and, when sync is on, the open space is the source. Applies the template with the same code as signup (`applyOnboarding`), opens the space (sets the cookie), and records it as the last space. At most 12 spaces per account. A failure removes the half-made space. |
| POST | `/api/spaces/:id/switch` | → `{ activeId }`, sets or clears the cookie |
| PATCH | `/api/spaces/:id` | `{ name?, icon? }`. `icon` is one emoji or null; letters are refused |
| DELETE | `/api/spaces/:id` | `{ confirmation: "‹space name›" }` → 204. The first space cannot be deleted (delete the account instead). Refuses with 409 while an agent run is active in the space, before anything is changed; otherwise revokes the space's paired devices and removes its rows with `deleteAccountData`. Clears the cookie when it was open. |
| POST | `/api/spaces/settings/copy` | `{ from }`: one-time copy of another space's settings into the open one |
| PUT | `/api/spaces/settings/sync` | `{ on, from? }`: turning it on copies `from` (default: the open space) to every other space |

Ledger actions: `space.create`, `space.delete`, `space.settings.copy`, `space.settings.sync`, written on the account.

## 4. Settings: separate, copied, or synced

By default each space keeps its own settings. `copySettings` copies:

- the `hub.settings` document, except `connections`, `connectorProducts`, `code` (folders on disk) and `assistant.actAs` (the tone the space's template set);
- model API keys (`model_credentials`), except the paired-device token and the GitHub clone token;
- `ui.*` preferences, such as keyboard shortcuts.

Connected apps never copy or sync. They bring a space its data, and sharing them would share context.

With sync on, `mirrorSettings` copies the writing space's settings to every other space after `PATCH /api/settings`, `PUT`/`DELETE /api/model-keys/:provider`, and `PUT`/`DELETE /api/preferences/ui.*`. A mirror failure is logged and never fails the write.

## 5. Deleting and exporting

`deleteAccountData` deletes an account's spaces first, each the same way, then the account. `DELETE /api/auth/account` refuses while an agent run is active in any space and revokes every space's devices. `GET /api/auth/export` returns the account's data with a `spaces` array holding each space's export.

## 6. The Hub

- **Switcher** (`components/shell/space-switcher.tsx`): the top of the sidebar shows the open space's icon and name. The menu lists every space with its template, a check on the open one, spaces **shared with you** (with the owner's avatar), **Share ‹space›…**, **New space** and **Manage spaces**. In the collapsed rail it is the icon alone. The command palette has "Switch to ‹space›" and "New space"; the avatar menu has Spaces.
- **Switching** (`lib/spaces.ts`): calls the switch route, shows the existing splash, and reloads into Today (the board, for a space shared with you) so nothing from the old space stays on screen. Other open tabs hear it on a `BroadcastChannel`, clear their per-tab caches, and reload, because the cookie is shared. Deleting the open space announces the first space the same way. The per-tab module and plots caches are keyed by space.
- **New space** (`/spaces/new`, full screen like `/start`): name with role-based suggestions and an emoji; a template from the six for the account's signup role, previewed live as Today, Board and Context with the shared picker (`components/onboarding/template-picker.tsx`, also used by `/start`); then settings: bring a copy from another space (default), keep every space in sync, or start fresh. A note lists what always stays separate. Accounts without a signup role pick one there.
- **Settings → Spaces** (`components/settings/tab-spaces.tsx`): rename in place, change the icon, open, delete (type the name), the sync switch, and a one-time copy into the open space.

## 7. Limits

- Switching is per browser, not per tab. Every tab follows the last switch.
- Hosted caps (`ENSEMBLE_MAX_JOBS_PER_DAY`, dataset and document bytes, connected accounts) are the account's: usage is summed over every space, the quota lock is on the account row, and the daily job counter is stored on the account, so deleting a space does not reset it (`quotaScope` in `apps/hub-api/src/lib/hosted-limits.ts`). Request rate limits are counted per space.
- Space ids are not assumed to be UUIDs: the local and desktop account id is `local`.
- A connector, a paired computer, or an editor key set up in one space serves only that space; set it up again in another.
- Plot spaces ([20](20_PLOTS_DESIGN.md)) are groups of charts inside one Ensemble space, not a kind of Ensemble space.
