# Marketplace and per-persona templates

Design only. Nothing in this document is built yet. It sits on top of the widget canvas and the 25 signup templates in `docs/design/widgets-and-templates-plan.md`, and on the Context board in `docs/design/context-ui.md`. Reuse those. Do not add a second layout engine, a second persona system, or a second home page.

Ensemble is the planner between a task list and an IDE. The thing people pay for is the Context graph. A template is a resolved view of that graph for one person: which modules exist, what the chrome calls them, which widgets sit on which page, and how `@ensemble` speaks. It is not a theme pack and it is not a plugin.

## What this workstream is

Polish the widgets, then add a hidden template store at `/marketplace`. Applying a template changes the whole app for that user and survives the next login. A Default template, which is the app as it is today, is always one click away. A template may remove a module. Removal is enforced on the server. The page and its API do not run. Data is kept.

Onboarding-by-usage is out of this workstream. The apply call is the same one a later wizard would use.

## What we already have

| Piece | Where | What it does today |
|---|---|---|
| 21 widgets, sizes S–XL, 12 per surface, 16 KB documents | `packages/shared-types/src/widgets.ts` | Today, Context (`?view=widgets`), and an optional board strip. Config is only `wipCap` and `graphNodeCap`. One instance of each type. |
| 25 signup templates, 5 roles | `packages/shared-types/src/templates/` | Role wizard at `/start`. Writes layouts, starter rows (`sourceRef`), and `assistant.actAs`. Does not turn modules off. `POST /api/onboarding` is 409 once completed. |
| Act-as | `ActAs` in `packages/shared-types/src/assistant.ts` | `general`, `student`, `engineer`, `teacher`, `lawyer`. Tone and at most four prompts. It does not change tools. |
| Shell | `components/shell/sidebar.tsx`, `command-palette.tsx` | Fixed nav. Palette is two static arrays plus tasks. |
| Gate | `apps/hub-web/middleware.ts`, `identify()` in `apps/hub-api/src/lib/auth.ts` | Cookie `ensemble_session` is an opaque token. The session row stores `userId` and expiry, nothing else. Middleware calls `/api/auth/me` and knows onboarding and accent. Every API route then checks `userId`. Nothing checks a module. |
| Closest precedent | `assistant.allowedWriteAreas` | Filters assistant write tools only. Not routes. |
| Account shape | `User` in `schema.prisma` | No org and no shared workspace. `onboardingRole`, `onboardingTemplateId`, `onboardingCompletedAt`. "Workspace" in the product is the agent queue (`/workspace`), not a tenancy. |
| Undo | `apps/hub-api/src/lib/undo.ts` | Layout writes stay off the content undo stack. Keep that. |

Signup templates stay. They are a first layout for a new account, with every module still on. Marketplace templates are a second catalog. They can change the module set. Mixing the two catalogs would put "remove Code" into a wizard that a new account cannot undo by accident, and would force all 25 previews to learn about modules.

## Research

### How other galleries behave

| Product | What they do | Take | Leave |
|---|---|---|---|
| [Notion template gallery](https://www.notion.com/help/guides/the-ultimate-guide-to-notion-templates) and [Marketplace](https://www.notion.com/help/finding-templates-on-marketplace) | Sidebar entry. Search, Work / Life / School, a deep category tree (thousands of templates per category on [the category index](https://www.notion.com/templates/category)), creator pages, ratings, "what this uses". Duplicate into a chosen workspace. Paid templates take billing and can email the buyer. | A card that says what it contains before you commit. Duplicate is explicit. | A public store, creators, payments, ratings, and a category tree. Duplicate copies drift from the original and leave "No access" blocks ([duplicate help](https://www.notion.com/help/duplicate-public-pages)). |
| [Coda Gallery](https://help.coda.io/hc/en-us/articles/39560548159629-Discover-docs-and-Packs-in-the-Gallery) | Docs and Packs. Search, categories, Copy doc into the workspace. Packs are installable capabilities, separate from docs. | Keep "a template" and "a module" as different ideas. Copy is a verb with a destination. | A maker community and a Pack runtime. Packs are code. |
| [ClickUp Template Center](https://help.clickup.com/hc/en-us/articles/6326080034199-Find-a-template) | Types (Space, List, Doc, …), complexity, use case, tags, creator. [Space apply](https://help.clickup.com/hc/en-us/articles/6309379377303-Use-Space-templates) asks import-everything, remap dates, and whether to bring archived tasks. | Show the blast radius before apply. | A settings dialog that is longer than the template. Date remapping. |
| [monday.com Template center](https://support.monday.com/hc/en-us/articles/360001362625-monday-com-templates) | Boards, docs, and bundles. Use template picks a workspace. Saving a workspace as a template removes it from the sidebar. | A bundle can describe several pages at once. | Saving-as-template must not hide the live work. We never move the user's data into the gallery. |
| [Obsidian Community](https://obsidian.md/blog/future-of-plugins/) | Plugins and themes. Search, categories, screenshots, a safety scorecard. Plugins are code, reviewed because they run. | Screenshots on the detail page. A clear line between data and code. | User-supplied code. Restricted mode. We do not need a scorecard if a template cannot run a script. |
| [Raycast Store](https://manual.raycast.com/extensions) | One list. Open a listing, see commands and screenshots, press Return, it is installed. Only compatible extensions are shown. AI tools from an extension are listed and can be turned off. | The apply action is one control. The listing says exactly which capabilities appear. Incompatible items are absent, not disabled-looking. | A public directory and install counts. |
| [Framer plugins](https://www.framer.com/marketplace/plugins/) and [Webflow Marketplace](https://webflow.com/marketplace) | Framer is trending / latest and one click. Webflow splits apps, libraries, templates, partners, and inspiration into five stores. | A short shelf beats five stores. | Partners, hiring, and a made-in community. Those are businesses, not a layout. |
| [Linear](https://linear.app/docs/dashboards) | Dashboards are personal lenses over issues, not a theme gallery. The product is already fast and quiet. | A template should feel like Linear's restraint: few objects, each one opens the real row. | A chart product. |

Mistakes we are designing out:

- A gallery that is easier to browse than to undo.
- Apply that copies a second workspace and leaves the old one behind.
- Templates that are secretly plugins.
- Filters (complexity, creator, price) for a catalog of eight.
- Hiding a nav link and calling the feature gone.

### What each persona actually does

The widgets below are lenses on people, projects, tasks, deliverables, reminders, artifacts, meetings, and the graph. They are not new apps.

| Persona | Their day | Tools they already trust | What Ensemble should add |
|---|---|---|---|
| Researcher | Reading queue, claims tied to sources, experiments, a deadline for a draft or a grant. | Zotero is the library. Plugins such as [Ze Notes](https://github.com/frianasoa/Ze-Notes) and [zotero-skr](https://github.com/WilliamsLiang/zotero-skr) exist because the review is a table of claims, not a task list. [Research Pilot](https://github.com/qzhang2111/research-pilot) stores sources, experiments, and "what changed in my understanding" beside the paper. | Do not replace Zotero. A paper is an artifact, a claim is a task page `@ensemble` can cite, an experiment is a task on the same project. The graph is the part Zotero does not have. |
| Student | Timetable, assignments, an exam date, a group, notes to revise. | The 25 signup templates already cover semester, exam week, group, reading, and applications. Notion's gallery is full of student dashboards ([category index](https://www.notion.com/templates/category)); they are databases the student maintains by hand. | Two variants, not five more databases. Semester is courses and people. Exam sprint is dates and a quiz page. Flashcards are not a new store: `@ensemble` quizzes from a task page that already exists. |
| Developer | Reviews, failing checks, incidents, repos, who knows the code. | The current app. GitHub is the forge. The known gap stands: repo cards do not show pull-request or issue counts. | Branch desk keeps Code. A review widget appears only when Code is on, and it reads `/api/code/reviews`. It does not invent counts. |
| Teacher | Today's class, a lesson page, a marking pile, who to check on. | The teacher signup templates (lessons, check-ins, marking, office hours, course hub). | Rename chrome to Classes. Code, Workspace, Runs, Metrics, and Skills go away. Attendance is the people on the course project plus open check-in tasks, not a register product. |
| Lawyer | Matters, a limitation date, clauses, time to bill, a document to read. | Clio keeps a limitation date on the matter, pulls dates out of uploaded documents, and tracks time entries against that matter ([LawWorks Clio guide](https://www.lawworks.org.uk/sites/default/files/files/CLIO%20User%20Guide.pdf), [Clio calendaring](https://www.clio.com/features/legal-calendaring-software/), [time entries](https://help.clio.com/hc/en-150/articles/9289741706779-Time-Entries)). | Projects stay projects in the database and read as Matters in the chrome. Limitation dates are reminders that must stay visible when empty. We do not calculate court rules. `@ensemble` already extracts obligations; the widget shows the dates that extraction created. |
| Non-dev engineer | A spec, a drawing or a BOM, a test log, a change request. | The work is a trail of revisions against a physical design, not a pull request. | Same graph, different words (Spec, Change, Test). Code and the agent queue are off. A change request is a task linked to the spec artifact. |
| Manager | 1:1s, who is overloaded, OKRs, decisions, blockers. | [emOS](https://github.com/trustmaster/emos) is the shape: 1:1 notes, OKRs, a decision log, incidents, written so an agent can file them. | People and meetings lead. Decisions are tasks of a known type so `@ensemble` can list them. No status-report wizard. |
| Aspirant | Syllabus coverage, mock scores, what to revise today, a daily target, current affairs. | A long prep cycle: subjects, sectional tests, then full mocks, with news beside the syllabus. The product they lack is a single place that ties a mock to the topic it exposed. | Subjects are projects. A mock is a task on that project. Revision is a due date, not an SM-2 engine. Current affairs are artifacts the person saves, not a feed we crawl. |

Personas we are not adding a template for yet: clinicians, founders, designers. The model can hold them later. Shipping a template we have not watched anyone use is how Notion's category tree happened.

## Decisions

1. **Per user.** There is no org. Applying a template writes the user row. The next login on any device shows it, because every live session is updated in the same transaction. Team templates wait until a tenancy exists.
2. **Default is the current app.** Every module on, today's nav words, the layouts the account already has if they have never applied a marketplace template. Settings → Account has "Use Default". That control does not link to `/marketplace`.
3. **Signup and marketplace are different catalogs.** The 25 templates keep doing what they do. Marketplace ids never collide with them (`mkt.*` versus the existing ids).
4. **A template is data.** Zod-validated JSON in the repo. No script, no HTML, no arbitrary URL. The client cannot submit a template body. Apply takes an id.
5. **Removal is fail-closed.** A removed module is 404 on the page and on the API. Data stays. It comes back when a template that includes the module is applied, including Default.
6. **The module set rides the session row.** `identify()` already loads the session by primary key. Add the set to that row. No second query and no cache.
7. **Content undo is not template undo.** Apply and revert are their own history, capped, and they do not push layout edits onto the task undo stack.
8. **Onboarding plugs in later** by calling the same apply. This workstream does not change `/start`.

## Template model

A marketplace template is a module in `packages/shared-types/src/marketplace/`. The web imports a manifest (id, persona, name, blurb, image, modules removed, widget names). The API imports the full document to apply it. Starter rows never ship to the browser.

```text
{
  id: "mkt.chambers",          // stable, ^mkt\.[a-z0-9-]{1,40}$
  version: 1,                  // bump when we ship a new body; never auto-applied
  persona: "lawyer",
  name: "Chambers",
  blurb: "…",                  // ≤ 140 chars
  accent: "brass",             // optional, one of ACCENT_PRESETS, never a custom hex
  actAs: "lawyer",
  highlights: ["…"],           // ≤ 4, existing cap
  modules: ["meetings"],       // optional modules turned on; core is always on
  labels: { project: "Matter", projects: "Matters", deliverable: "Filing" },
  lens: { groupBy: "project", kinds: ["people", "projects", "artifacts"] },
  expiresInDays: null,         // or 14 for a season; see time-boxed mode
  layouts: { today, context, board? },
  starters: { … }              // same shape as signup, tighter caps below
}
```

| Piece | Rule |
|---|---|
| Modules | A subset of the optional set. Core modules are always on and are not listed. Unknown ids fail validation. |
| Nav | Order is the shell order, filtered to modules that are on, with `labels` applied. The template does not invent pages. |
| Layouts | Same `LayoutDocument` as today, version 2 once instance config exists. v1 documents still read. |
| Widget config | Per placement, ≤ 512 bytes. See the widget section. |
| Starters | ≤ 2 projects, ≤ 12 tasks, ≤ 4 deliverables, ≤ 4 people, ≤ 2 task pages. `sourceRef` `mkt:<id>:<slug>`. Placeholder people have no email. No fake repos. |
| Act-as | An `ActAs` value. New values are tone only. |
| Accent | A preset id, or omitted. Omitted leaves the user's accent alone. |
| Labels | ≤ 8 keys from a fixed set: `project`, `projects`, `task`, `tasks`, `deliverable`, `deliverables`, `board`, `people`. Each value ≤ 24 characters. The database stays `Project`. |
| Lens | Written to `hub.context.board` on apply. This is the one marketplace write that preference key accepts. Signup reset still does not touch it. |
| Version | The user stores `appliedVersion`. A newer version is a line on the detail page, not a silent migrate. |

Serialised template ≤ 32 KB. Catalog ≤ 32 templates. Zod rejects the rest.

Layout document v2, still ≤ 16 KB, still ≤ 12 placements:

```text
{
  v: 2,
  placements: [
    { type: "limitation", slot: 0, size: "m", config: { horizonDays: 14 } }
  ]
}
```

`slot` is 0 or 1. A second slot is legal only when the widget says `repeatable`. v1 placements are read as slot 0 and empty config.

### What apply writes

One transaction:

1. Insert a history row with the previous template id, version, module set, the three layout documents, the lens preference, labels, and act-as.
2. Upsert the three `widget_layouts` rows from the template. Instance config included.
3. Set `users.active_template_id`, `applied_version`, `module_set`, and `assistant.actAs`.
4. Set labels on a small `users.chrome_labels` JSON.
5. If the template has an accent and the user has no custom hex, set the preset. A custom hex is left alone.
6. Replace `hub.context.board` lens fields. Do not wipe a manual lane order; store it in the history row and restore it on revert.
7. Insert starter rows whose `sourceRef` is absent, including rows in trash. Never delete or rewrite a row that exists.
8. Set `modules` on every `Session` for that user.

If any step fails, the transaction rolls back. The button does not navigate until the response returns.

Revert is the same transaction in the other direction, from the newest history row. It does not delete starter rows. One step. It is not Ctrl+Z.

History is capped at 20 rows per user. The oldest snapshot is deleted in the same transaction. Snapshots hold chrome, not task bodies.

### Default

`id` is `default`, version 1, not in the marketplace grid.

- Optional modules: all of them.
- Labels: none (the words in the sidebar today).
- Act-as: leave the current value. Default does not reset a persona the person chose in Settings.
- Layouts: if a history row has the layouts from before the first marketplace apply, restore those. Otherwise leave the current layout rows. Default never means "wipe my Today".
- Starters: none.
- Sessions: full module set.

That is why it is instant. There is no seed and no image. Target: the transaction returns in under 150 ms, and the shell updates on the next request.

Switching Default does not delete the Chambers tasks. It makes `/code` load again.

## Feature registry

### Modules

Core, always on, not a template choice:

| Module | Pages | Why it stays |
|---|---|---|
| Today | `/today` | Home. |
| Board | `/board` | The task canvas. |
| Needs me | `/needs-me` | The decision queue. |
| Context | `/context`, `/projects`, `/projects/[id]` | The product. `/projects` already redirects to Context. |
| Tasks | `/tasks/[id]` | A row, not a product surface. |
| Meetings | `/meetings` | Notes. Cues on Today link here. |
| Recap | `/recap` | One weekly document. |
| Completed | `/completed` | Retention window. |
| Trash | `/trash` | Restore. Hiding trash is how people lose work. |
| Connect | `/connect`, `/connect/[app]` | Sources. |
| Settings | `/settings` | Account, including Use Default. |
| Search and capture | palette, quick capture, ask | Chrome. The palette drops entries whose module is off. |

Optional:

| Id | Pages | API prefixes | Also refuses |
|---|---|---|---|
| `code` | `/code`, `/code/review` | `/api/code/*`, `/api/terminal/*` | `@ensemble` surface `code`. Agent-runtime tools `workspace.fs.*`, `workspace.repo.*`, `github.*` when this and `workspace` are both off. `github.*` is refused with `code`. |
| `workspace` | `/workspace` | `/api/workspace/*`, `/api/agent/*` | Bridge is unchanged (it is read-only and has no workspace tool). |
| `runs` | `/runs` | `/api/runs`, `/api/runs/:id` | |
| `metrics` | `/metrics` | `/api/metrics/*`, `/api/ledger/verify` | Validator: a template may not enable `metrics` unless `runs` or `workspace` is on. |
| `skills` | `/skills` | `/api/skills/*` | Context Bridge tool `ensemble_skills`. Assistant skill tools. |

Dependencies are only that one validator rule, plus "terminal belongs to code". Turning Code off leaves Workspace available for a template that wants agents without the editor. None of the launch templates do that. They turn Code, Workspace, Runs, Metrics, and Skills off together, except Branch desk, which leaves them all on.

`/api/activity/:id/stop` is `workspace`. A notification whose `url` starts with a removed prefix is omitted from `GET /api/notifications`. The row stays. Creating a new notification into a removed module is skipped.

### Enforcement

The check is one function, `moduleForPath(path) → id | null`, shared by the web (a tiny generated map) and the API (the same map in `shared-types`). Null means core or unknown. Unknown API paths keep today's 404. A known optional path whose id is absent from the session set is 404 with `{ error: "Not part of this template." }`. No 403. A 403 admits the route exists.

| Layer | How | When it runs |
|---|---|---|
| Session | `Session.modules` text, sorted ids joined by commas, ≤ 64 chars. Copied at login and rewritten on apply. | `identify()` reads it off the row it already loads. |
| API token | The token query joins `user.module_set` in that same `findUnique`. Tokens are not the page hot path. | Every Bearer `ens_` request. |
| Internal | `x-ensemble-internal` loads `user.module_set` by id. One primary-key read this path does not do today. Required so the runtime cannot call `/api/code` for a person who removed Code. | Internal calls only. |
| `onRequest` | After `identify`, before the route handler. | Every non-public API request. |
| Middleware | `/api/auth/me` already returns on this hop. Add `modules`. HTML navigation to a removed page is rewritten to `/unavailable` with status 404. | Document requests. RSC and prefetch of a removed path get the same 404, so the page chunk is not requested. |
| Shell | Sidebar, palette, and `prefetchHref` filter with the shell payload, which includes `modules`. | Render. This is convenience. The server is the gate. |
| `@ensemble` | `POST /api/ensemble/invoke` rejects surface `code` when `code` is off. Other surfaces stay. | Invoke. |
| Assistant | `toolsFor` also drops tools whose area maps to a removed module. Same idea as `allowedWriteAreas`, and it does not replace that list. | Each turn. |
| Agent runtime | The job payload includes the module set from the user row at start. The planner does not receive tools the set excludes. The hub still refuses the HTTP call if the planner is wrong. | Job start. |
| Context Bridge | `ensemble_skills` returns the same 404 body. Other bridge tools stay; they read core data. | Tool call. |
| Deep links | Task pages, project pages, and Today hashes are core. A link to `/code/review` 404s. | Navigation. |
| Notifications | Filtered on read, as above. | List. |
| Command palette search | Pages array filtered. Task search stays. | Open. |

There is no cache. A process-local cache would be stale on the instance that did not handle the apply, and Redis would be a second store to invalidate. The session read is already paid for. Apply updates every session row for that user (a person has a handful), so the next request on each device sees the new set. An in-flight request that identified before commit keeps the old set for that one call. That race is acceptable.

Fail closed: a session with a null `modules` column is treated as no optional modules, not as all of them. The migration backfills every session to the full set before this code serves traffic.

### Page code

Next still builds `/code` into the deployment. Per-user tree-shaking at build time is not real. What "does not load" means:

- Middleware rewrites before the code route's server component runs.
- The browser does not request that route's RSC payload or its client chunk.
- The shell does not import the code page. It already does not. Keep it that way. No shared component may import `app/(hub)/code/**`.
- Widget chunks that call `/api/code/*` are behind `next/dynamic` and are not registered in the gallery when `code` is off, so they are not downloaded either.

`/unavailable` is a small page inside the hub shell. Copy: "This isn't part of your template." Actions: Use Default, and the text path `/marketplace` written as text the person already knows, not as a nav item. Status 404.

### Why this stays fast

`GET /api/auth/me` and `GET /api/shell` grow by one short string. Middleware does not gain a second fetch. The API hook is a string split and a set lookup, not a policy engine.

## Apply flow

From the detail page:

1. **Diff.** The server returns it from `GET /api/marketplace/templates/:id`. Modules that will turn off, labels that change, widgets added and removed per surface, act-as change, accent change, lens change. The client renders that list. It does not compute the authority.
2. **Preview.** "See it with your work" dynamic-imports the Today canvas in read-only mode and feeds it the template layout plus the existing `GET /api/today/home` payload. No write. Widgets whose data is not in that payload show their empty state with the person's real empty, not fixture names. Preview is skipped on a 390-wide screen in favour of the static shots plus the diff; the canvas is the wrong chunk to pull onto a phone gallery. A "Preview" control still loads it if they ask.
3. **Apply.** `POST /api/marketplace/apply { id }`. Atomic, as above. Response is the new shell summary. The client invalidates the shell query and routes to `/today`.
4. **After.** Settings shows the template name. Use Default is enabled. History lists the previous name.

Existing data in a module that just turned off stays in Postgres. Tasks, runs, skills, and repos are not deleted, exported, or trashed. They are unreachable until a template turns the module back on. Starter rows from the new template are added beside the person's real rows, idempotently.

Apply is not offered again for the id and version already applied. The button reads "Applied".

Undo of apply is Revert on the detail page and on Settings, for the latest history row only. Revert to Default is the same endpoint with `id: "default"`.

### Per user, not per workspace

`WorkspaceSession` is an agent job, scoped by `userId`. A template must not write it. Two people do not share an account today, so "the workspace" and "the user" are the same human. When an org exists, templates become a user choice inside it, not a switch that edits colleagues. That is why team templates are later and not sketched as a flag on this table.

## Marketplace UX

Hidden means:

- No sidebar item, no palette entry, no link from Today, Context, Settings, or `/start`.
- No sitemap. There is no sitemap today; do not add one.
- `robots.txt` does not list the URL as an allow. Add `Disallow: /marketplace` and `X-Robots-Tag: noindex, nofollow` on the response. The app is authenticated either way.
- Reachable only by typing `/marketplace`.

Authenticated, onboarding complete, same shell as the rest of the hub. The route is not public.

### Index

One search field. It filters the manifest in the browser. Eight cards do not need a search service.

Filters, as chips, not a sidebar of categories: persona, and "Removes Code". That is the only use-case filter that changes someone's day. No complexity, no price, no creator.

A card is the dark preview image (the signup pipeline already makes WebPs; reuse `scripts/render-template-previews.mjs`), the name, the persona, one line, and a short list of modules removed. Images are decorative. The name is the accessible name. Fixed aspect ratio so the grid does not shift. Lazy-load below the first row.

Empty search says "Nothing matches" and clears in one control.

### Detail

`/marketplace/[id]`.

- Name, blurb, persona.
- Three shots: Today, Context, the phone Today. Static files, dark, because dark is the default. Light files exist for a light-mode user, same as signup.
- Two lists: widgets included, modules removed. Modules removed are named in full sentences ("Code, Workspace, Runs, Metrics, and Skills will not open.").
- The diff against this account.
- Preview, then Apply. Apply is a primary button. It is not the first thing a keyboard user hits; the diff is.
- Use Default sits on the page as a quiet button, so the store itself is not a trap.

### Visual

The Context board is the reference: hairline borders, one display face, kind colour as a pip not a rainbow, `--elev-1` for resting cards, the existing ease. Cards do not jiggle. Reduced motion turns the hover lift off. This page should not look like a chat transcript or a template marketplace with a hero illustration.

### 390

One column. Search and the two chips wrap. Cards are full width. The detail stacks: shot, diff, Apply pinned to the bottom of the viewport with padding so it does not cover the last line. Preview is opt-in, as above. No horizontal page scroll.

### Bundle

The gallery imports the manifest and the images, not the widget canvas, not `@dnd-kit`, not CodeMirror. Preview is `next/dynamic`. Target: marketplace page JS ≤ 8 kB, first load ≤ 120 kB (the shell is 104 kB). CLS under 0.05, same bar as Context.

## Widget system

### Customisation

Sizes S / M / L / XL stay, with the same span table. New, per placement:

| Setting | Values | Notes |
|---|---|---|
| Title | ≤ 40 chars, optional | Falls back to the registry label. Shown in the tile header. |
| Density | `comfortable` (default) or `compact` | Compact tightens row padding. It does not load more rows. |
| Accent | a kind token (`people`, `project`, `repo`, `note`, `deliverable`) or `accent` | A pip and a wash, using existing CSS variables. Not a colour picker. |
| Filter | a per-widget object | `projectId` must be a project the user owns at save time. `horizonDays` is 1, 7, 14, or 30. `taskType` is a short enum the widget declares, ≤ 24 chars, stored on the existing `task.taskType`. |
| Source | an enum the widget declares | Example: reading queue reads tasks or artifacts, not both at once. |

Edit mode gains a settings button on the tile, next to Remove. The size handle stays the size handle. Settings open a small popover, not a modal that covers the board.

The add control becomes a gallery: a filter field, the template's widgets first, then shared, then the other personas. A widget whose module is off is absent, not greyed out. One instance per type per surface, except widgets marked `repeatable` (two slots). The 12-placement cap stays. Duplicate types in a v1 document still fail.

Growing a tile still only reveals rows already loaded. Shrinking still clips with "N more". Empty meeting cues and stale nudges still collapse. A limitation widget does not collapse: an empty docket has to say so.

### Query cost

A widget makes at most one request, with `take` ≤ 12, or it reads `GET /api/today/home` and makes none. No widget fans out per row. The gallery and the registry are code-split: Today downloads the chunks for the placements on screen, not the catalog. Each new widget chunk is aimed at ≤ 4 kB. A template fails the budget if its Today first load exceeds 159 kB, Context 129 kB, or Board 162 kB.

`Task.measure` is the one new column. Nullable integer, 0–100000. The widget config says the unit (`minutes` or `score`). It is not a time tracker and not a gradebook. Tasks without it render as rows with no number.

### Shared widgets

Existing 21 stay (`orbit` through `week-done`). These are new and persona-agnostic. Any template may place them.

| Id | Shows | Reads | Empty | Bound |
|---|---|---|---|---|
| `countdown` | The next due deliverable and the day count | Deliverables already on the home payload, else one query `take 1` | "Nothing dated." Link to add a deliverable. | 1 row |
| `reading-queue` | Titles still open | Tasks `taskType=reading`, or artifacts if source is artifacts | "Nothing in the pile." | 8 |
| `decisions` | Decision titles and the day | Tasks `taskType=decision` | "No decisions yet." | 8 |
| `open-questions` | Unanswered questions | Tasks `taskType=question` | "No open questions." | 8 |
| `person-load` | People with the most open tasks | Tasks grouped by person, the people already on the project | "No one is on this yet." | 8 people |
| `quiz-pile` | Headings from one task page, and Ask | One page, the template's starter page or the filter | "Add a page of prompts." Does not create a card store. | 10 headings |

### Persona widgets

Unique means the gallery ranks them first for that persona. They are still just registry entries. A lawyer can add a reading queue.

| Id | Persona | Shows | Reads | Empty |
|---|---|---|---|---|
| `timetable` | Student, teacher | Next events | Calendar events, `take 8` | "Nothing on the timetable." |
| `assignment-countdown` | Student | Nearest coursework | Deliverables `taskType=course`, `take 5` | "No assignment dated." |
| `exam-countdown` | Student, aspirant | One date, large | The soonest deliverable `taskType=exam` | "No exam date." Does not collapse. |
| `group-load` | Student | Open tasks by teammate | `person-load` scoped to one project | "Add the group as people." |
| `lesson-next` | Teacher | The next lesson and its page | Next task `taskType=lesson` | "No lesson this week." |
| `grading-queue` | Teacher | Sets still to mark | Tasks `taskType=marking`, `take 8` | "Nothing to mark." |
| `class-list` | Teacher | People on the course | People on the filtered project, `take 12` | "Add the class as people." |
| `matter-dates` | Lawyer | Filings and reminders | Deliverables and reminders on matter projects, `take 8` | "No date on this matter." |
| `limitation` | Lawyer | Limitation dates | Reminders `taskType=limitation`, `take 5` | "No limitation date." Does not collapse. We do not compute court rules. |
| `clause-pair` | Lawyer | Two latest drafts and Compare | Two artifacts, `take 2`. Compare opens `@ensemble` with both ids. | "Add the two drafts." |
| `time-week` | Lawyer, engineer | Minutes this week | Tasks `taskType=time` with `measure` as minutes, `take 20`, sum in the client | "No time noted." |
| `syllabus` | Aspirant, student | Done against all on one project | Project progress the board already stores | "Name the subject." |
| `mock-log` | Aspirant | Recent scores | Tasks `taskType=mock`, `measure` as score, `take 8` | "No mock yet." |
| `revision-due` | Aspirant, student | What is due to revise | Tasks `taskType=revision` inside the horizon, `take 8` | "Nothing due to revise." |
| `daily-target` | Aspirant | Done today against a number | Completions today from the home payload. Config `target` 1–50, default 20. | Shows 0 of N. Never a blank. |
| `affairs` | Aspirant | What they saved recently | Artifacts `taskType` is not on artifacts; use tasks `taskType=affairs` updated in 2 days, `take 5` | "Nothing saved." We do not fetch news. |
| `spec-register` | Engineer | Specs and drawings | Artifacts, `take 8` | "No spec yet." |
| `change-requests` | Engineer | Open changes | Tasks `taskType=change`, `take 8` | "No open change." |
| `test-log` | Engineer | Recent tests | Tasks `taskType=test`, `take 8` | "No test logged." |
| `one-on-ones` | Manager | Latest note per person | Meeting notes, `take 6` | "No 1:1 notes." |
| `okr-strip` | Manager | Objectives | Deliverables `taskType=okr`, `take 4` | "No objectives." |
| `incident-now` | Manager, developer | What is blocked or marked incident | Tasks in `blocked` or `taskType=incident`, `take 5` | Hidden when empty, like stale nudges. |
| `review-queue` | Developer | Open reviews | `/api/code/reviews`, `take 8`. Registered only when `code` is on. | "Nothing to review." |

That is 6 shared and 23 persona widgets, 29 new, on top of the 21 that exist.

`@ensemble` on a tile keeps the existing anchor `widget:<id>`. Highlights from the template still cap at four and still do not grant tools. A lawyer's highlights stay the clause, obligation, compare, and risky-wording prompts. New act-as values get the same treatment.

### New act-as values

`researcher`, `manager`, `aspirant`, `maker`. `maker` is the non-dev engineer. They are entries in `ActAs`, `personaBlock`, and `quickActions` only. `personaBlock` still must not mention the tool registry. Developer stays `engineer`. Vibe coder is untouched and is not a marketplace template.

### Graph lenses

A lens is a filter on the Context board that already exists: which kinds show, and whether group-by is kind or project. It is not a new simulation. Researcher: artifacts and people, grouped by project. Lawyer: people, projects, artifacts, grouped by project. Manager: people and projects. Aspirant: projects as subjects. Student: people and artifacts. Developer: repos, people, projects. Teacher: people and artifacts, grouped by project.

## Launch templates

Default is not in this list. It is the app today: every module, the words in the sidebar now, the layouts the account already has.

Wide (12-column) order. The same placements reflow at 1024, 768, and 390 under the existing span rules. "Row" is not a stored coordinate.

Starter people are placeholders with no email.

### 1. Semester desk — student

Code, Workspace, Runs, Metrics, and Skills off. Accent left alone. Act-as `student`. Labels: none.

| | |
|---|---|
| Today | `timetable` M, `assignment-countdown` M, Focus L, `reading-queue` M, Calendar M |
| Context | People M, Artifacts L, `group-load` M |
| Lens | People and artifacts, group by project |
| Starter | Project "This semester". Tasks: "Read the brief", "List what the rubric grades". Deliverable "Essay draft" in two weeks. Person "Instructor". |
| Highlights | The existing student four. |
| Better than a Notion student hub | The essay, the instructor, and the date are one graph. The template does not add a second calendar. |

### 2. Exam sprint — student

Same modules off. Act-as `student`. `expiresInDays: 14`, then revert to the previous template (or Default if there is no history). This is the second student variant: a season, not a second dashboard.

| | |
|---|---|
| Today | `exam-countdown` L, `revision-due` L, `quiz-pile` M, Reminders M |
| Context | Artifacts M, `reading-queue` M |
| Lens | Artifacts, group by project |
| Starter | Project "Exam". Deliverable "Final" `taskType=exam` in five days. Task page of ten prompts. Tasks: "Practice set 1", "Weak spots". |
| Highlights | "Quiz me from my notes", "What am I weak on?", "Split this into tasks", "Check the citations". |

### 3. Literature desk — researcher

Same five modules off. Act-as `researcher`. Accent `tide`.

| | |
|---|---|
| Today | `reading-queue` L, Focus L, `countdown` S, `open-questions` M |
| Context | Artifacts L, graph M, `decisions` M |
| Lens | Artifacts and people, group by project |
| Starter | Project "Paper". Tasks: "Source A notes", "The claim", both `taskType=reading`, each with a page (claim, quote, page). Deliverable "Draft" in three weeks. |
| Highlights | "What does this source actually say?", "Where is this claim supported?", "What is still open?", "Summarise the experiment". |
| Better than Zotero alone | Zotero keeps the library. The claim and the experiment are tasks on the paper's project, so the graph can show which source a sentence depends on. |

### 4. Chambers — lawyer

Same five modules off. Act-as `lawyer`. Accent `brass`. Labels: project "Matter", projects "Matters", deliverable "Filing", board "Matters".

| | |
|---|---|
| Today | `limitation` L, `matter-dates` L, Focus M, `time-week` S |
| Context | People M, Artifacts L, `clause-pair` M |
| Lens | People, projects, artifacts, group by project |
| Starter | Project "Matter". Person "Client". Deliverable "Filing". Reminder with `taskType=limitation` in ten days. Two short task pages, "Draft A" and "Draft B". |
| Highlights | The existing lawyer four. |
| Why the empty state is loud | A missing limitation date is the failure mode Clio's matter field exists to prevent. The tile stays on screen and says so. |

### 5. Bench — non-dev engineer

Same five modules off. Act-as `maker`. Labels: deliverable "Spec", task "Change", board "Changes".

| | |
|---|---|
| Today | `change-requests` L, `test-log` M, `spec-register` M, Focus M |
| Context | Artifacts L, People S, `decisions` M |
| Lens | Artifacts and projects, group by project |
| Starter | Project "Bench". Artifact "Spec". Tasks: "Change: tolerance", "Test: first run". |
| Highlights | "What changed since the last spec?", "List the open changes", "Summarise the test", "Who needs to see this?". |

### 6. Staff week — manager

Same five modules off. Act-as `manager`. Accent `ember`.

| | |
|---|---|
| Today | `one-on-ones` L, `person-load` L, `incident-now` M, Calendar M |
| Context | People L, `decisions` M, `okr-strip` M, Meetings M |
| Lens | People and projects, group by project |
| Starter | Project "Team". People "Teammate". Tasks: "1:1 notes", "Decision: ship date" (`taskType=decision`). Deliverable "Objective" `taskType=okr`. |
| Highlights | "Who is overloaded?", "What did we decide?", "Draft the 1:1", "What is blocked?". |
| Better than a status doc | The decision is a task `@ensemble` can retrieve. The load widget is a count of real open tasks, not a column someone colours in. |

### 7. Prelims season — aspirant

Same five modules off. Act-as `aspirant`. `expiresInDays: 90`, then revert. Accent `rose`.

| | |
|---|---|
| Today | `daily-target` S, `revision-due` L, `mock-log` M, `syllabus` M, `affairs` S |
| Context | `syllabus` L, Artifacts M, `exam-countdown` S |
| Lens | Projects, group by project |
| Starter | Projects "Polity" and "Economy". Tasks: "Revise fundamental rights" (`revision`, due tomorrow), "Mock 1" (`mock`). Deliverable "Prelims" `taskType=exam`. |
| Highlights | "What should I revise today?", "Which topic did the mock miss?", "Quiz me on this", "What did I save this week?". |
| Not in this template | A news crawler, a spaced-repetition algorithm, a leaderboard. |

### 8. Branch desk — developer

Every module on. Act-as `engineer`. This is the marketplace form of the signup template, for someone who applied Chambers and wants the editor back without hunting Default's layout.

| | |
|---|---|
| Today | Focus L, `review-queue` M, Calendar M, `needs-me` S, Repos M |
| Context | Repos L, People M, graph L |
| Board strip | Column summary, WIP cap 3, Blocked |
| Lens | Repos, people, projects |
| Starter | Project "Current work". Tasks: "Open the review", "Write the test". No invented repo. |
| Highlights | The existing engineer four. |

Teacher is Chambers-shaped and is template 9, because the brief names teachers and the five modules they do not need are the same cut.

### 9. This week's classes — teacher

Same five modules off. Act-as `teacher`. Labels: project "Class", board "Classes".

| | |
|---|---|
| Today | `timetable` L, `lesson-next` L, `grading-queue` M, Calendar M |
| Context | `class-list` L, Artifacts M, Meetings M |
| Lens | People and artifacts, group by project |
| Starter | Project "This week". Deliverable "Worksheet". Tasks: "Draft the lesson" (`lesson`), "Mark set 1" (`marking`). Person "Student". |
| Highlights | The existing teacher four. |

Nine launch templates plus Default. The minimum was six. The extra three are the personas the brief named that six cannot cover, including the second student variant.

## Ideas, ranked

Value is how much it changes someone's week. Effort is files and risk, not a schedule.

| Rank | Idea | Value | Effort | When |
|---|---|---|---|---|
| 1 | Preview against real data, and a diff, before apply | High. This is the difference between Notion's duplicate and a mistake. | Medium. Read-only canvas, already specified above. | In the apply flow. |
| 2 | Graph lens per template | High. It is the product, pointed at the persona. | Low. A filter on the board that exists. | In apply. |
| 3 | Template-aware `@ensemble` | High. Tone and four prompts, tools still gated by modules. | Low. New `ActAs` values plus the existing highlight path. | In apply. |
| 4 | Time-boxed season | High for exam sprint and prelims. Dangerous if it reverts silently. | Medium. A date on the user. | When the date passes, a banner offers one click to switch back. Nothing reverts on its own. |
| 5 | Save my layout as a personal template | High once people edit. | Medium. A user-owned row, not a marketplace entry. It stores layouts and labels. It cannot turn a module on. Module changes stay on shipped ids. | After apply is boringly solid. Not this first build. |
| 6 | Remix a shipped template | Medium. It is "duplicate, then edit", which is how galleries get messy. | Medium. Same as 5, seeded from a shipped id. | Same phase as 5. The result is personal and is not listed at `/marketplace`. |
| 7 | Team templates | High later, when an org exists. | High. There is no tenancy to hang them on. | Not designed past this paragraph. |
| 8 | Community submissions | Low for us, high risk. | High. That is a plugin store. | Out. Templates stay data we ship. |

## Security

- The client sends `{ id }`. The server loads the template from the catalog. A body with layouts or modules is 400.
- Zod on the catalog at boot. A template that fails validation prevents the process from serving apply. Better than applying a partial.
- No HTML in blurbs, labels, titles, or highlights. Reject `<`, `>`, and any URL that is not a relative path on the allow-list (`/today`, `/board`, `/context`, `/meetings`, `/tasks/`, `/projects/`).
- Size caps above. History cap 20. Placements cap 12. Config cap 512 bytes. `measure` cap 100000.
- Path gate runs for cookie, Bearer token, bridge token, and internal header. Dev auth bypass still loads that user's module set.
- Re-enabling Code is only by applying a catalog id that includes it, or Default. There is no `PATCH /api/modules`.
- Starter text is plain. It does not contain instructions that the assistant treats as higher trust than the user's pages. The existing bridge rule for untrusted text still applies.
- `/marketplace` is not a secret. Obscurity is not the gate. The gate is the session, and apply re-checks the catalog id.
- The gate normalises the path before matching: decode until stable, lowercase, collapse slashes, drop dot segments, matrix parameters, and a trailing slash. A malformed percent-encoding is 400. Each gated plugin also checks the session module set in its own preHandler, against the matched route pattern, so the raw URL is not the only barrier.

### Gating audit

Endpoints that can return data from an optional module, and how they are closed. A removed module is omitted or 404 with `Not part of this template.` Data stays in Postgres.

| Surface | Module | Closure |
|---|---|---|
| `/code`, `/api/code/*`, `/api/terminal/*` | code | Path gate, and `declareModule` on the code and terminal plugins |
| `/workspace`, `/api/workspace/*`, `/api/agent/*`, `/api/activity/:id` | workspace | Path gate, and `declareModule` on the agent plugin |
| `/runs`, `/api/runs/*` | runs | Path gate, and a preHandler on the runs plugin |
| `/metrics`, `/api/metrics/*`, `/api/ledger/*` | metrics | Path gate, and the same runs-plugin preHandler (it serves both) |
| `/skills`, `/api/skills/*`, `/api/bridge/skills*` | skills | Path gate, and `declareModule` on the skills plugin |
| `GET /api/bridge/read?kind=skill` | skills | Handler returns not-found when skills is off. The body is never read |
| `GET /api/bridge/search` | skills | Skill rows are not queried |
| `GET /api/bridge/brief` | skills, workspace | Skill text is omitted. Branch jobs and sessions are omitted when workspace is off |
| `POST /api/ask` (search) | skills | Uses the same search, with the user's module set |
| `GET /api/entities` | skills | Skill mentions are omitted |
| `GET /api/context/graph` | skills | Skill nodes and their edges are omitted |
| `GET /api/deleted` and restore | skills | Trashed skills are hidden, and restoring one is 404 |
| `GET /api/tasks/:id/runs` | runs | Returns an empty list |
| `POST /api/internal/runs/:id/steps` | runs | 404 when runs is off |
| `GET /api/notifications` | any | A notification whose url is a removed path is omitted |
| Assistant tools | skills, runs | `toolsFor` drops those areas. `hub_delete_entity` / `hub_restore_entity` refuse kind `skill` |
| Assistant snapshot and open page | skills | Skill bodies and names are not loaded |
| Workspace agent brief | skills | Skill text is not inserted when skills is off |
| Page middleware | code, workspace, runs, metrics, skills | Same normaliser. Encoded page paths rewrite to the in-shell 404. Client navigations redirect so the address bar shows `/unavailable` |

Repos, tasks, people, and projects stay. They are core Context, not the Code module.

## Performance

| Budget | Number |
|---|---|
| Context first load | ≤ 129 kB |
| Today first load | ≤ 159 kB, including a launch template's placements |
| Board first load | ≤ 162 kB |
| Marketplace page JS | ≤ 8 kB |
| Marketplace first load | ≤ 120 kB |
| Each new widget chunk | ≤ 4 kB, loaded only if placed |
| CLS | < 0.05 on Today, Context, Board, and `/marketplace` |
| Apply transaction | < 400 ms server time, excluding nothing on the client but the round trip. Default < 150 ms. |
| Module check | No query beyond the session, token, or internal read already specified. No cache. |
| Preview | Does not run on the gallery index. |

Images stay under about 80 KB each, the signup cap. The index reserves the card box before the image arrives.

New widgets must not add a poll. They use the react-query keys the pages already use, so a task edit still refreshes the tile without a second protocol.

## Migration

1. Add `users.active_template_id` (nullable text), `users.applied_version` (int, default 0), `users.module_set` (text, default the full optional set), `users.chrome_labels` (json, default `{}`), `users.template_expires_at` (nullable timestamp).
2. Add `sessions.modules` (text). Backfill from `users.module_set`.
3. Add `template_applications` (id, user_id, template_id, version, snapshot jsonb, created_at). Snapshot ≤ 64 KB. Index `(user_id, created_at desc)`.
4. Add `tasks.measure` nullable int.
5. Do not change `onboarding_template_id`. Existing accounts keep their signup template and gain the full module set. Nothing disappears on deploy.
6. Ship the migration before the hook that fail-closes a null `modules` column.
7. Layout readers accept v1 and v2. Writers for marketplace templates emit v2. The signup path keeps writing v1 until it is touched on purpose.
8. No backfill of widgets onto existing Todays. Their layout rows stay.

`dump.rdb` and any local redis snapshot are not part of this.

## Tests

Unit, the same `node --test` runner as hub-api:

- Catalog: every launch template parses, stays under 32 KB, uses known widgets, respects size ranges, and obeys the metrics dependency.
- Zod: 13th placement rejected, unknown module rejected, script-like blurb rejected, config over 512 bytes rejected, `measure` out of range rejected.
- `moduleForPath` for every prefix in the registry, including `/code/review` and `/api/terminal/run`.
- History cap drops the oldest. Revert restores modules and layouts and does not delete a starter `sourceRef`. A second apply does not duplicate a slug that is in the trash.
- `personaBlock` for the four new act-as values does not mention tools. Highlights stay at four.
- A layout PUT still creates no `UndoEntry`. An apply creates no `UndoEntry` either.

API, one test per gated prefix, as the user who applied Chambers (or any template with the five modules off), and again as Default:

- Cookie, Bearer token, and internal header.
- `GET` and one write where the route has a write.
- Expect 404 and the stable error string.
- A core route (`/api/today/home`, `/api/tasks`, `/api/context/board`) still 200.
- `ensemble_skills` and surface `code` follow the module.
- A notification whose url is `/code` is absent from the list and still in the database.
- Cross-user: another user's apply does not change this session.

Playwright, at 1440 and 390:

- `/marketplace` is not in the sidebar or the palette. Typing the URL opens it.
- Search and the Removes-Code chip filter the eight-plus cards.
- Detail shows modules removed. Apply on Exam sprint, reload, Today shows the exam countdown, `/code` is the unavailable page, `/api/code/reviews` is 404.
- Use Default, reload, `/code` loads and the previous Today layout is back.
- Revert from history does the same.
- A swipe or a crafted location change to `/code/review` does not render the diff.
- CLS on the gallery and on Today after apply stays under 0.05.
- Keyboard: the diff is reachable before Apply. Escape leaves the detail page.

Perf: `next build` fails the phase if the caps in the table move the wrong way. Marketplace is measured on its own.

## Build order

Each phase can ship alone. None of them starts until this document is accepted. Sizes are scope, not dates.

| Phase | What | Scope | Leaves the app |
|---|---|---|---|
| 0 | This document. | Docs only. | Unchanged. |
| 1 | Registry, session column, API hook, middleware rewrite, `/unavailable`. Default set is everyone. | Small. One hook, one map, tests for every prefix. | No visible change if the migration backfills the full set. |
| 2 | Apply, revert, history, Use Default on Settings. No gallery UI. A test can post an id. | Medium. The transaction and the session fan-out. | Still no nav. |
| 3 | Layout v2, tile settings, gallery picker, the six shared widgets, lazy chunks. | Medium. The risky part is the Today bundle. | Edit layout grows a picker. Old layouts still read. |
| 4 | `/marketplace` index and detail, static shots, diff, preview. Wire the nine templates' chrome and layouts. Starters included. | Medium. Mostly web, plus the catalog. | Hidden URL works. |
| 5 | Persona widgets, four act-as values, lenses, `Task.measure`, time-boxed revert on the existing scheduler tick. | The large one. Mostly widgets and copy. | Exam sprint and prelims can expire. |
| 6 | Personal "save my layout", still unable to grant modules. | Medium, later. | Not required for the store to be real. |

Onboarding-by-usage is not a phase. When it is designed, it calls `POST /api/marketplace/apply` and reads the same manifest. It does not get a second seed path.

## Open questions

1. HTML for a removed module: a 404 page inside the shell, as written, or a redirect to Today?
2. May a template set an accent preset, or should appearance never change on apply?
3. Is one nullable `Task.measure` acceptable for minutes and mock scores, or should those widgets show titles only and add no column?
4. When a season ends, should the scheduler revert on its own, or only raise a banner the person confirms?
5. Should `/start` keep the 25 templates forever, with the marketplace as a later switch, as written?
6. Is `maker` the right act-as name for a non-dev engineer?
