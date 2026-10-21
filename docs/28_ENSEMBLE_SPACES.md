# 28 · Ensemble spaces

A person can keep separate lines of work in separate **spaces**, for example a startup and personal chores. Each space has its own tasks, pages, people, graph, files, plots, diagrams, connected apps and assistant history. Settings and eligible credentials can be copied or synced explicitly (§4); identity, quotas and included credits stay account-wide.

Sharing a space with other people, whole or one item at a time, is [29 · Sharing](29_SHARING.md). Overall capability: [00](00_PROJECT_OVERVIEW.md).

## 1. How a space is stored

A space is a row in `users` whose `owner_id` is the signed-in account (migration `apps/hub-api/prisma/migrations/20261008120000_ensemble_spaces`). The account row is itself the first space. Space-owned content uses the same `user_id` filters as account content. Identity, usage/quotas, model keys and sharing handle account versus space explicitly; not every table is per space.

| Column | On | Meaning |
|---|---|---|
| `owner_id` | space | The owning account. Null on the account. `ON DELETE CASCADE`. |
| `space_name`, `space_icon`, `space_position` | both | Label, optional emoji, order in the switcher. The account's name defaults to "‹first name›'s space" and is stored, so renaming the profile does not rename it. |
| `space_settings_sync` | account | Settings are mirrored to every space (§4). |
| `last_space_id` | account | The space a new sign-in opens. |

A space row has an undeliverable `space-…@spaces.ensemble.invalid` email and no password or linked login, so nobody can sign in to it directly. Name, profession, profile completion, email verification and the tester flag are copied from the account at creation and after every profile or verification change (`mirrorAccount` in `apps/hub-api/src/spaces/store.ts`). Hosted access checks (`lib/hosted-access.ts`) resolve a space to its owner, so verification and operator status are the account's.

## 2. Which space a request uses

`identify()` (`apps/hub-api/src/lib/auth.ts`) reads the httpOnly `ensemble_space` cookie for browser sign-ins (session, local bypass, desktop). It switches `request.userId` to that space only if the row's `owner_id` is the signed-in account or the account is a member (`space_members`, [29](29_SHARING.md)); otherwise the cookie is ignored, so a forged cookie can only pick a space you may open anyway. `request.access` says whether you own the open space or are a member, and with what role. `request.accountId` holds the account; code reads it with `accountIdOf(request)`, which falls back to `request.userId` where nothing set it (service calls, small Fastify apps in integration tests).

- **Personal API tokens, CLI keys and service calls ignore the cookie.** A token belongs to the space it was created in, so an editor connected from a space reads only that space. `ensemble login` approved inside a space gives the CLI that space.
- **Account routes use `request.accountId`:** `/api/auth/me`, profile, password, email verification, linked sign-in methods, export, account deletion, OAuth linking and terminal passkey enrolment.
- `/api/shell` returns the account as `user` and the open space as `space: { id, name, icon, primary, members, collaborators, shared }`; `shared` is set in a space someone shared with you.
- Signing in sets the cookie to `last_space_id` if that space still exists and you may open it. Signing out clears it.

## 3. Routes

All are browser-only (`requireBrowserSession`; tokens get 403) and limited to the account's own spaces (404 otherwise). Code: `apps/hub-api/src/spaces/routes.ts`; tests: `apps/hub-api/src/spaces/spaces.integration.test.ts`.

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/spaces` | → `{ activeId, account: { sync, role }, spaces: [{ id, name, icon, primary, role, templateId, createdAt }], shared }` (`shared`: spaces shared with you) |
| POST | `/api/spaces` | `{ name, icon?, templateId, settings: { mode: "fresh" \| "copy" \| "sync", from? } }` → `201 { space, activeId }`. The template must match the account's signup role. `from` must be one of the account's spaces; with `fresh` it is ignored, and when sync is on the open space is the source. Applies the template with the signup code (`applyOnboarding`), opens the space (sets the cookie) and records it as the last space. At most 12 spaces per account. A name the account already uses (case-insensitive, Unicode NFKC, whitespace collapsed, the first space included) gets 409 "You already have a space called …"; the check and insert lock the account row, so two identical requests make one space. A failure removes the half-made space. |
| POST | `/api/spaces/:id/switch` | → `{ activeId }`, sets or clears the cookie |
| PATCH | `/api/spaces/:id` | `{ name?, icon? }`. `icon` is one emoji or null; letters are refused. A duplicate name gets 409, as on create |
| DELETE | `/api/spaces/:id` | `{ confirmation: "‹space name›" }` → 204. The first space cannot be deleted (delete the account instead). Refuses with 409 while an agent job is running, claimed, stopping or waiting for approval in the space, before changing anything; otherwise revokes the space's paired devices and removes its rows with `deleteAccountData`. Clears the cookie if it was open. |
| POST | `/api/spaces/settings/copy` | `{ from }`: one-time copy of another space's settings into the open one |
| PUT | `/api/spaces/settings/sync` | `{ on, from? }`: turning it on copies `from` (default: the open space) to every other space |

Ledger actions, written on the account: `space.create`, `space.delete`, `space.settings.copy`, `space.settings.sync`.

## 4. Settings: separate, copied, or synced

By default each space keeps its own settings. `copySettings` copies:

- the `hub.settings` document, except `connections`, `connectorProducts`, `code` (folders on disk) and `assistant.actAs` (the tone the space's template set);
- model API keys (`model_credentials`), except the paired-device token and the GitHub clone token;
- `ui.*` preferences such as keyboard shortcuts, except `ui.onboarding-tour` (each space keeps its own tour progress).

The color palette (`appearance.colorTheme`) and preset/custom accent are part of `hub.settings`, so they copy and sync. The shell applies the open space's palette and accent; light/dark/system mode, font, text size and motion are per browser (`components/shell/notifier.tsx`).

Connected apps never copy or sync: they bring a space its data, and copying them would share context.

With sync on, `mirrorSettings` copies the writing space's settings to every other space after `PATCH /api/settings`, `PUT`/`DELETE /api/model-keys/:provider` and `PUT`/`DELETE /api/preferences/ui.*`. Tour progress writes do not trigger it. A mirror failure is logged and never fails the write.

## 5. Deleting and exporting

`deleteAccountData` deletes an account's spaces first, each the same way, then the account. `DELETE /api/auth/account` refuses while an agent run is active in any space and revokes every space's devices. `GET /api/auth/export` returns the account's data with a `spaces` array holding each space's export.

## 6. The Hub

- **Switcher** (`components/shell/space-switcher.tsx`): the top of the sidebar shows the open space's icon and name. The menu lists every space with its template and a check on the open one, spaces **shared with you** (with the owner's avatar; same-named spaces from different owners are told apart by owner), **Share ‹space›…**, **New space** and **Manage spaces**. In the collapsed rail it is the icon alone. A space without an emoji shows the first letter or digit of its name, skipping a leading emoji; when the icon is the emoji the name starts with, the name is shown without it (`spaceInitial`, `spaceLabel` in `lib/spaces.ts`), so "🚀 Launch" never shows the rocket twice. The command palette has "Switch to ‹space›" and "New space"; the avatar menu has Spaces.
- **Switching** (`lib/spaces.ts`): calls the switch route, shows the splash, and reloads into Today (the board, for a space shared with you) so nothing from the old space stays on screen. Other open tabs hear it on a `BroadcastChannel`, clear their per-tab caches and reload, because the cookie is shared. Deleting the open space announces the first space the same way. Per-tab module and plots caches are keyed by space.
- **New space** (`/spaces/new`, full screen like `/start`): a name with role-based suggestions and an emoji (a name you already use is flagged and Continue stays off); a template from the six for the account's signup role, previewed live as Today, Board and Context with the shared picker (`components/onboarding/template-picker.tsx`, also used by `/start`); then settings: copy from another space (default), keep every space in sync, or start fresh, with a note on what always stays separate. Accounts without a signup role pick one there. *Create ‹name›* disables after the first click and stays off while the new space opens, so a double click makes one space.
- The new space opens on Today with a contained walkthrough of the template and its features, using fictional sample data; it leaves the real route and scroll position alone. Completion and dismissal belong to that space; owners can replay it from the account menu ([02 §16](02_MODULE_INTERACTION_HUB_UI.md#16-accounts-and-public-signup)).
- **Settings → Spaces** (`components/settings/tab-spaces.tsx`; `/spaces` redirects to `/settings?tab=spaces`): rename in place, change the icon, open, delete (type the name), the sync switch and a one-time copy into the open space. Its description says spaces never share anything with each other and a space stays yours until you share it, with a link to Settings → Sharing ([29](29_SHARING.md)).
- Transferring ownership of a space ([29](29_SHARING.md)) gives it an unused numbered name ("Name (2)") if the new owner already has that name.

## 7. Limits

- Switching is per browser, not per tab: every tab follows the last switch.
- Hosted caps (`ENSEMBLE_MAX_JOBS_PER_DAY`, dataset and document bytes, connected accounts) are the account's: usage is summed over every space, the quota lock is on the account row, and the daily job counter is stored on the account, so deleting a space does not reset it (`quotaScope` in `apps/hub-api/src/lib/hosted-limits.ts`). Request rate limits count per space.
- Space ids are not assumed to be UUIDs: the local and desktop account id is `local`.
- A connector, paired computer or editor key set up in one space serves only that space; set it up again in another.
- Plot spaces ([20](20_PLOTS_DESIGN.md)) are groups of charts inside one Ensemble space, not Ensemble spaces.
