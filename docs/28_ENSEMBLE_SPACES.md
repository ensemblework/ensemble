# 28 · Ensemble spaces

Use **spaces** to keep different lines of work apart, such as a startup and personal chores. Each space has its own tasks, pages, people, graph, files, plots, diagrams, connected apps and assistant history. Settings and eligible credentials can be copied or synced explicitly (§4); identity, quotas and included credits stay account-wide.

Sharing a space with other people, whole or one item at a time, is [29 · Sharing](29_SHARING.md). Overall capability: [00](00_PROJECT_OVERVIEW.md).

## 6. The Hub

Open the space menu at the top of the sidebar to switch spaces, create one or manage the spaces you own. It shows the current space's icon and name. In the collapsed sidebar, open the icon.

### Create a space

1. Choose **New space** in the space menu or command palette.
2. Enter a name and an emoji. Suggestions follow your role. If you already use the name, change it before choosing **Continue**.
3. Choose one of the six templates for your signup role. Preview it in Today, Board and Context. If your account has no signup role, choose that first.
4. Choose settings: **copy from another space** is the default. You can instead keep all spaces in sync or start fresh. The page explains what stays separate.
5. Choose **Create ‹name›** once. It stays disabled while the space opens, so a double click creates only one space.

The new space opens on Today. Its walkthrough uses fictional sample data to show the template and its features, without changing the real route or scroll position. Completion and dismissal are saved for that space. Owners can replay it from the account menu ([02 §16](02_MODULE_INTERACTION_HUB_UI.md#16-accounts-and-public-signup)).

### Switch or manage spaces

The space menu lists each space with its template and marks the open one. **Shared with you** lists shared spaces with their owner's avatar; the owner distinguishes spaces that have the same name. The menu also offers **Share ‹space›…** and **Manage spaces**. You can use **Switch to ‹space›** in the command palette or **Spaces** in the avatar menu.

Switching reloads Today, or the board for a shared space. Every open tab follows the switch and clears its cached content. Deleting the open space returns the tabs to your first space.

Open **Settings → Spaces** to rename a space, change its icon, open it or delete it by typing its name. You can also turn on settings sync or copy settings into the open space once. Spaces keep their content separate; a space stays yours until you share it. **Settings → Sharing** manages sharing ([29](29_SHARING.md)).

A space without an emoji uses the first letter or digit in its name, skipping any leading emoji. If the selected emoji also starts the name, the menu shows it only once. For example, “🚀 Launch” does not show two rockets.

Transferring ownership ([29](29_SHARING.md)) assigns an unused numbered name, such as “Name (2)”, if the new owner already has a space with that name.

## 4. Settings: separate, copied, or synced

By default each space keeps its own settings. `copySettings` copies:

- the `hub.settings` document, except `connections`, `connectorProducts`, `code` (folders on disk) and `assistant.actAs` (the tone the space's template set);
- model API keys (`model_credentials`), except the paired-device token and the GitHub clone token;
- `ui.*` preferences such as keyboard shortcuts, except `ui.onboarding-tour` (each space keeps its own tour progress).

The color palette (`appearance.colorTheme`) and preset/custom accent are part of `hub.settings`, so they copy and sync. The shell applies the open space's palette and accent; light/dark/system mode, font, text size and motion are per browser (`components/shell/notifier.tsx`).

Connected apps never copy or sync: they bring a space its data, and copying them would share context.

With sync on, `mirrorSettings` copies the writing space's settings to every other space after `PATCH /api/settings`, `PUT`/`DELETE /api/model-keys/:provider` and `PUT`/`DELETE /api/preferences/ui.*`. Tour progress writes do not trigger it. A mirror failure is logged and never fails the write.

## 7. Limits

- Switching is per browser, not per tab: every tab follows the last switch.
- Hosted caps (`ENSEMBLE_MAX_JOBS_PER_DAY`, dataset and document bytes, connected accounts) are the account's: usage is summed over every space, the quota lock is on the account row, and the daily job counter is stored on the account, so deleting a space does not reset it (`quotaScope` in `apps/hub-api/src/lib/hosted-limits.ts`). Request rate limits count per space.
- Space ids are not assumed to be UUIDs: the local and desktop account id is `local`.
- A connector or paired computer set up in one space serves only that space; set it up again in another. An editor key reaches the account's own spaces when a call names one (§2).
- Plot spaces ([20](20_PLOTS_DESIGN.md)) are groups of charts inside one Ensemble space, not Ensemble spaces.

## 5. Deleting and exporting

`deleteAccountData` deletes an account's spaces first, each the same way, then the account. `DELETE /api/auth/account` refuses while an agent run is active in any space and revokes every space's devices. `GET /api/auth/export` returns the account's data with a `spaces` array holding each space's export.

## In the code

The space switcher is `components/shell/space-switcher.tsx`. `spaceInitial` and `spaceLabel` in `lib/spaces.ts` choose the displayed icon and label. Switching calls the switch route, shows the splash and reloads; a `BroadcastChannel` tells other tabs to clear their per-tab caches and reload because the cookie is shared. Per-tab module and plots caches are keyed by space.

`/spaces/new` is full screen like `/start`. Both use `components/onboarding/template-picker.tsx`. Space settings are in `components/settings/tab-spaces.tsx`; `/spaces` redirects to `/settings?tab=spaces`.

### 1. How a space is stored

A space is a row in `users` whose `owner_id` is the signed-in account (migration `apps/hub-api/prisma/migrations/20261008120000_ensemble_spaces`). The account row is itself the first space. Space-owned content uses the same `user_id` filters as account content. Identity, usage/quotas, model keys and sharing handle account versus space explicitly; not every table is per space.

| Column | On | Meaning |
|---|---|---|
| `owner_id` | space | The owning account. Null on the account. `ON DELETE CASCADE`. |
| `space_name`, `space_icon`, `space_position` | both | Label, optional emoji, order in the switcher. The account's name defaults to "‹first name›'s space" and is stored, so renaming the profile does not rename it. |
| `space_settings_sync` | account | Settings are mirrored to every space (§4). |
| `last_space_id` | account | The space a new sign-in opens. |

A space row has an undeliverable `space-…@spaces.ensemble.invalid` email and no password or linked login, so nobody can sign in to it directly. Name, profession, profile completion, email verification and the tester flag are copied from the account at creation and after every profile or verification change (`mirrorAccount` in `apps/hub-api/src/spaces/store.ts`).

Hosted access checks (`lib/hosted-access.ts`) resolve a space to its owner, so verification and operator status are the account's.

### 2. Which space a request uses

`identify()` (`apps/hub-api/src/lib/auth.ts`) reads the httpOnly `ensemble_space` cookie for browser sign-ins (session, local bypass, desktop).

It switches `request.userId` to that space only if the row's `owner_id` is the signed-in account or the account is a member (`space_members`, [29](29_SHARING.md)); otherwise the cookie is ignored, so a forged cookie can only pick a space you may open anyway. `request.access` says whether you own the open space or are a member, and with what role.

`request.accountId` holds the account; code reads it with `accountIdOf(request)`, which falls back to `request.userId` where nothing set it (service calls, small Fastify apps in integration tests).

- **Personal API tokens, CLI keys and service calls ignore the cookie.** A token belongs to the space it was created in, and `ensemble login` approved inside a space gives the CLI that space. A `bridge` or `full` key also records the account that made it (`api_tokens.account_id`) and acts in another space that account owns when a request names it with `x-ensemble-space` (`keyIdentity` in `lib/auth.ts`, checked with `openedSpace()`); a space shared with the account answers 403, one it cannot open 404, and a key with no recorded account made inside a space stays there ([CONTEXT_BRIDGE §4](CONTEXT_BRIDGE.md#4-token)).
- **An Ensemble Node names the space on each request** it makes for its owner (`x-ensemble-space`, with the internal token, `x-ensemble-node-account` and `x-ensemble-node`). `openedSpace()` in `lib/auth.ts`, the same check the cookie gets, allows it only while the owner owns that space or is a member of it; otherwise every route answers 404. Nothing falls back to another space ([29 §2](29_SHARING.md#2-how-access-works), [35 §5.4](35_ENSEMBLE_NODE.md#54-every-space-its-owner-can-open)).
- **Account routes use `request.accountId`:** `/api/auth/me`, profile, password, email verification, linked sign-in methods, export, account deletion and OAuth linking.
- `/api/shell` returns the account as `user` and the open space as `space: { id, name, icon, primary, members, collaborators, shared }`; `shared` is set in a space someone shared with you.
- Signing in sets the cookie to `last_space_id` if that space still exists and you may open it. Signing out clears it.

### 3. Routes

All are browser-only (`requireBrowserSession`; tokens get 403) and limited to the account's own spaces (404 otherwise). Code: `apps/hub-api/src/spaces/routes.ts`; tests: `apps/hub-api/src/spaces/spaces.integration.test.ts`.

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/spaces` | → `{ activeId, account: { sync, role }, spaces: [{ id, name, icon, primary, role, templateId, createdAt }], shared }` (`shared`: spaces shared with you) |
| POST | `/api/spaces` | `{ name, icon?, templateId, settings: { mode: "fresh" \| "copy" \| "sync", from? } }` → `201 { space, activeId }`. The template must match the account's signup role. `from` must be one of the account's spaces; with `fresh` it is ignored, and when sync is on the open space is the source. Applies the template with the signup code (`applyOnboarding`), opens the space (sets the cookie) and records it as the last space. At most as many spaces as the account allows itself (`spaces` in Settings › Sharing › Limits: 12 by default, its own space included, up to 100; [29](29_SHARING.md) §1). A name the account already uses (case-insensitive, Unicode NFKC, whitespace collapsed, the first space included) gets 409 "You already have a space called …"; the check and insert lock the account row, so two identical requests make one space. A failure removes the half-made space. |
| POST | `/api/spaces/:id/switch` | → `{ activeId }`, sets or clears the cookie |
| PATCH | `/api/spaces/:id` | `{ name?, icon? }`. `icon` is one emoji or null; letters are refused. A duplicate name gets 409, as on create |
| DELETE | `/api/spaces/:id` | `{ confirmation: "‹space name›" }` → 204. The first space cannot be deleted (delete the account instead). Refuses with 409 while an agent job is running, claimed, stopping or waiting for approval in the space, before changing anything; otherwise revokes the space's paired devices and removes its rows with `deleteAccountData`. Clears the cookie if it was open. |
| POST | `/api/spaces/settings/copy` | `{ from }`: one-time copy of another space's settings into the open one |
| PUT | `/api/spaces/settings/sync` | `{ on, from? }`: turning it on copies `from` (default: the open space) to every other space |

Ledger actions, written on the account: `space.create`, `space.delete`, `space.settings.copy`, `space.settings.sync`.

An Ensemble Node room can make a space for its work: `PUT /api/node/rooms/:id/space {create: true, name?}` makes one for the room's creator, named after the room unless named, with the account's settings copied and no template, under the same name rule and space count ([35 §12.11](35_ENSEMBLE_NODE.md)). It is an ordinary space of theirs; the room only links it.
